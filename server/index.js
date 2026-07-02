const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { GameManager } = require("./gameManager");
const { getArtists, getSongsByArtist, CLIPS_DIR } = require("./audioService");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/clips", express.static(CLIPS_DIR)); // serwowanie wyciętych fragmentów audio

const gameManager = new GameManager(io);

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
