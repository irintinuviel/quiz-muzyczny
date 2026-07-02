const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { GameManager } = require("./gameManager");
const { getArtists, getSongsByArtist, CLIPS_DIR } = require("./audioService");
const spotifyAuth = require("./spotifyAuth");
const spotifyCatalog = require("./spotifyCatalog");
const { parseCookies } = require("./cookies");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/clips", express.static(CLIPS_DIR)); // serwowanie wyciętych fragmentów audio

const gameManager = new GameManager(io);

// ---------- SPOTIFY OAUTH (logowanie hosta, wymagane do odtwarzania) ----------
// Flow działa w osobnym oknie popup (patrz host.js), żeby NIE przeładowywać
// głównej karty hosta i nie tracić trwającego pokoju/socketu.

// Adres przekierowania wykrywany z tego, skąd host faktycznie korzysta z
// aplikacji (localhost, adres Tailscale, cokolwiek) - dzięki temu popup
// logowania zawsze wraca na TEN SAM origin co główne okno, niezależnie jak
// aplikacja została otwarta. SPOTIFY_REDIRECT_URI (jeśli ustawiony) nadpisuje
// to wykrywanie - przydatne za reverse proxy, gdzie host/protokół request
// mogą być inne niż to, co faktycznie widzi przeglądarka.
function getRedirectUri(req) {
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
  return `${req.protocol}://${req.get("host")}/auth/spotify/callback`;
}

app.get("/auth/spotify/login", (req, res) => {
  try {
    res.redirect(spotifyAuth.buildAuthorizeUrl(getRedirectUri(req)));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/auth/spotify/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Błąd logowania Spotify: ${error}`);
  if (!spotifyAuth.isValidState(state)) {
    return res.status(400).send("Nieprawidłowy stan OAuth (state) - spróbuj zalogować się ponownie.");
  }
  try {
    const tokens = await spotifyAuth.exchangeCodeForTokens(code, getRedirectUri(req));
    const sessionId = spotifyAuth.createSession(tokens);
    res.setHeader(
      "Set-Cookie",
      `mq_spotify_session=${sessionId}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`
    );
    // Ta strona żyje w popupie - powiadamia okno główne i się zamyka,
    // dzięki czemu host nigdy nie traci trwającej sesji gry.
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#071022;color:#eafcff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>Połączono ze Spotify. To okno zamknie się automatycznie...</p>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: "spotify-auth-success" }, window.location.origin);
    window.close();
  }
</script>
</body></html>`);
  } catch (err) {
    res.status(500).send(`Błąd logowania Spotify: ${err.message}`);
  }
});

app.get("/api/spotify/token", async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.mq_spotify_session;
  if (!sessionId) return res.status(401).json({ error: "Brak sesji Spotify - zaloguj się." });
  try {
    const accessToken = await spotifyAuth.getValidAccessToken(sessionId);
    if (!accessToken) return res.status(401).json({ error: "Sesja Spotify wygasła - zaloguj się ponownie." });
    res.json({ access_token: accessToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

io.on("connection", (socket) => {
  // ---------- HOST ----------
  socket.on("host:create_room", (_, cb) => {
    const room = gameManager.createRoom(socket.id);
    socket.join(room.code);
    socket.data.role = "host";
    socket.data.roomCode = room.code;
    cb({ code: room.code, settings: room.settings });
  });

  socket.on("host:update_settings", ({ code, settings }) => {
    const room = gameManager.getRoom(code);
    if (!room || room.hostSocketId !== socket.id) return;
    room.settings = { ...room.settings, ...settings };
    io.to(code).emit("room:settings_updated", room.settings);
  });

  socket.on("host:get_artists", (_, cb) => {
    const artists = getArtists().map((a) => ({
      name: a,
      count: getSongsByArtist(a).length,
    }));
    cb(artists);
  });

  // --- Spotify: wyszukiwanie artysty (działa na tokenie aplikacji, bez logowania) ---
  socket.on("host:spotify_search_artist", async ({ query }, cb) => {
    try {
      const results = await spotifyCatalog.searchArtist(query);
      cb({ ok: true, results });
    } catch (err) {
      cb({ ok: false, error: "Błąd wyszukiwania Spotify: " + err.message });
    }
  });

  // --- Spotify: dodanie artysty do puli utworów pokoju ---
  socket.on("host:spotify_add_artist", async ({ code, artistId, artistName, count, mode }, cb) => {
    const room = gameManager.getRoom(code);
    if (!room || room.hostSocketId !== socket.id) return cb({ ok: false, error: "Brak dostępu." });
    try {
      const tracks = await spotifyCatalog.getArtistTracks(artistId, {
        limit: Math.min(Math.max(Number(count) || 20, 1), 100),
        mode: mode === "popularne" ? "popularne" : "losowe",
      });
      const tagged = tracks.map((t) => ({ ...t, artistId }));
      room.spotifyArtists.set(artistId, { name: artistName, trackCount: tracks.length });
      const existingIds = new Set(room.spotifyTrackPool.map((t) => t.id));
      room.spotifyTrackPool.push(...tagged.filter((t) => !existingIds.has(t.id)));
      cb({ ok: true, trackCount: tracks.length, poolSize: room.spotifyTrackPool.length });
    } catch (err) {
      cb({ ok: false, error: "Błąd pobierania utworów: " + err.message });
    }
  });

  // --- Spotify: usunięcie artysty z puli ---
  socket.on("host:spotify_remove_artist", ({ code, artistId }, cb) => {
    const room = gameManager.getRoom(code);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ poolSize: 0 });
    room.spotifyArtists.delete(artistId);
    room.spotifyTrackPool = room.spotifyTrackPool.filter((t) => t.artistId !== artistId);
    cb?.({ poolSize: room.spotifyTrackPool.length });
  });

  socket.on("host:start_game", async ({ code }) => {
    const room = gameManager.getRoom(code);
    if (!room || room.hostSocketId !== socket.id) return;
    try {
      await gameManager.prepareRoundsForRoom(room);
      if (!room.preparedRounds.length) {
        io.to(code).emit("game:error", "Nie udało się przygotować rund.");
        return;
      }
      gameManager.startNextRound(room);
    } catch (err) {
      io.to(code).emit("game:error", err.message);
    }
  });

  socket.on("host:next_round", ({ code }) => {
    const room = gameManager.getRoom(code);
    if (!room || room.hostSocketId !== socket.id) return;
    gameManager.startNextRound(room);
  });

  // Powrót do ekranu głównego po zakończonej grze - ten sam pokój, zerowanie
  // punktów, bez tworzenia nowego kodu i bez przeładowania strony hosta.
  socket.on("host:reset_room", ({ code }) => {
    const room = gameManager.getRoom(code);
    if (!room || room.hostSocketId !== socket.id) return;
    gameManager.resetRoom(room);
    io.to(code).emit("room:reset", {
      settings: room.settings,
      players: room.publicPlayerList(),
    });
  });

  // ---------- PLAYER ----------
  socket.on("player:join_room", ({ code, name }, cb) => {
    const room = gameManager.getRoom(code);
    if (!room) return cb({ error: "Nie znaleziono pokoju o tym kodzie." });
    if (room.status !== "lobby") return cb({ error: "Gra już się rozpoczęła." });

    room.addPlayer(socket.id, name || "Gracz");
    socket.join(code);
    socket.data.role = "player";
    socket.data.roomCode = code;

    io.to(room.hostSocketId).emit("room:players_updated", room.publicPlayerList());
    cb({ ok: true, code });
  });

  socket.on("player:answer", ({ optionIndex }) => {
    const code = socket.data.roomCode;
    const room = gameManager.getRoom(code);
    if (!room || room.status !== "playing") return;
    gameManager.submitAnswer(room, socket.id, optionIndex);
  });

  // ---------- WSPÓLNE ----------
  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const room = gameManager.getRoom(code);
    if (!room) return;

    if (socket.data.role === "host") {
      io.to(code).emit("game:error", "Host opuścił grę.");
      gameManager.destroyRoom(code);
    } else if (socket.data.role === "player") {
      room.removePlayer(socket.id);
      io.to(room.hostSocketId).emit("room:players_updated", room.publicPlayerList());
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MusicQuiz Online działa na porcie ${PORT}`);
  console.log(`Lokalnie: http://localhost:${PORT}`);
  console.log(`W sieci Tailscale: http://<tailscale-ip-lub-magicdns>:${PORT}`);
});
