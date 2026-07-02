const socket = io();
let roomCode = null;
let artists = []; // [{ name, count }]
let selectedArtists = new Set();

// --- stan integracji Spotify ---
let spotifyConnected = false;
let spotifyPlayer = null;
let spotifyDeviceId = null;
let spotifyPauseTimer = null;
let lastRoundWasSpotify = false;
const spotifyArtistsAdded = new Map(); // artistId -> { name, trackCount }
let spotifyPoolSize = 0;

const el = (id) => document.getElementById(id);
const show = (id) => {
  ["lobbyView", "prepView", "roundView", "resultView", "endView"].forEach(
    (v) => (el(v).style.display = v === id ? "block" : "none")
  );
};
const escapeHtml = (str) => {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
};
// Mały okrągły awatar gracza; jeśli folder public/avatars jest pusty,
// serwer zwraca avatar=null - wtedy pokazujemy inicjał imienia zamiast obrazka.
const avatarImg = (avatar, name) => {
  if (avatar) return `<img class="avatar" src="${avatar}" alt="" />`;
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return `<span class="avatar avatar-fallback">${escapeHtml(initial)}</span>`;
};

// --- Tworzenie pokoju przy wejściu na stronę ---
socket.emit("host:create_room", {}, ({ code }) => {
  roomCode = code;
  el("roomCode").textContent = code;
  loadArtists();
});

// --- Wybór aktywnych artystów - odpowiednik artist_selection_menu() z mp.py ---
function loadArtists() {
  socket.emit("host:get_artists", {}, (list) => {
    artists = list;
    selectedArtists = new Set(artists.map((a) => a.name)); // domyślnie wszyscy aktywni
    renderArtists();
  });
}

function renderArtists() {
  el("artistsList").innerHTML = artists
    .map(
      (a) => `
      <div class="artist-chip ${selectedArtists.has(a.name) ? "active" : ""}" data-name="${a.name}">
        ${a.name}<span class="count">(${a.count})</span>
      </div>`
    )
    .join("");

  document.querySelectorAll(".artist-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const name = chip.dataset.name;
      if (selectedArtists.has(name)) selectedArtists.delete(name);
      else selectedArtists.add(name);
      renderArtists();
    });
  });

  const totalSongs = artists
    .filter((a) => selectedArtists.has(a.name))
    .reduce((sum, a) => sum + a.count, 0);
  el("artistsSummary").textContent =
    `Wybrano ${selectedArtists.size} artystów, ${totalSongs} utworów`;
}

el("selectAllBtn").addEventListener("click", () => {
  selectedArtists = new Set(artists.map((a) => a.name));
  renderArtists();
});
el("selectNoneBtn").addEventListener("click", () => {
  selectedArtists = new Set();
  renderArtists();
});

// --- Przełącznik źródła muzyki: lokalna biblioteka / Spotify ---
el("zrodlo").addEventListener("change", () => {
  const val = el("zrodlo").value;
  el("localSourcePanel").style.display = val === "lokalne" ? "block" : "none";
  el("spotifySourcePanel").style.display = val === "spotify" ? "block" : "none";
});

// --- Logowanie do Spotify w osobnym oknie (popup), żeby NIE przeładować
// tej karty i nie stracić trwającego pokoju/socketu ---
el("spotifyConnectBtn").addEventListener("click", () => {
  window.open("/auth/spotify/login", "spotify-auth", "width=480,height=720");
});

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === "spotify-auth-success") {
    onSpotifyConnected();
  }
});

// Sprawdź od razu przy wczytaniu strony, czy host jest już zalogowany
// (np. wraca po odświeżeniu strony albo ma jeszcze ważną sesję sprzed chwili)
(async function checkExistingSpotifySession() {
  try {
    await fetchSpotifyToken();
    onSpotifyConnected();
  } catch {
    // brak aktywnej sesji - trzeba się zalogować, to normalny stan początkowy
  }
})();

function onSpotifyConnected() {
  if (spotifyConnected) return; // już zainicjalizowane, nie rób tego drugi raz
  spotifyConnected = true;
  el("spotifyStatus").textContent = "Połączono ✓";
  el("spotifyConnectBtn").textContent = "Połączono ze Spotify";
  el("spotifyConnectBtn").disabled = true;
  el("spotifySearchRow").style.display = "flex";
  initSpotifyPlayer();
}

async function fetchSpotifyToken() {
  const res = await fetch("/api/spotify/token");
  if (!res.ok) throw new Error((await res.json()).error || "Brak aktywnej sesji Spotify");
  const data = await res.json();
  return data.access_token;
}

// --- Inicjalizacja Web Playback SDK - przeglądarka hosta staje się
// urządzeniem Spotify Connect, na którym faktycznie leci muzyka ---
function initSpotifyPlayer() {
  window.onSpotifyWebPlaybackSDKReady = () => {
    spotifyPlayer = new Spotify.Player({
      name: "MusicQuiz Host",
      getOAuthToken: (cb) => fetchSpotifyToken().then(cb).catch(() => {}),
      volume: 0.8,
    });

    spotifyPlayer.addListener("ready", ({ device_id }) => {
      spotifyDeviceId = device_id;
      el("spotifyStatus").textContent = "Połączono ✓ (urządzenie gotowe)";
    });
    spotifyPlayer.addListener("not_ready", () => {
      el("spotifyStatus").textContent = "Urządzenie offline";
    });
    spotifyPlayer.addListener("initialization_error", ({ message }) =>
      alert("Błąd inicjalizacji Spotify SDK: " + message)
    );
    spotifyPlayer.addListener("authentication_error", ({ message }) =>
      alert("Błąd autoryzacji Spotify: " + message)
    );
    spotifyPlayer.addListener("account_error", ({ message }) =>
      alert("To konto nie ma Spotify Premium (wymagane do odtwarzania): " + message)
    );

    spotifyPlayer.connect();
  };

  if (!document.getElementById("spotify-sdk-script")) {
    const script = document.createElement("script");
    script.id = "spotify-sdk-script";
    script.src = "https://sdk.scdn.co/spotify-player.js";
    document.head.appendChild(script);
  }
}

// --- Wyszukiwanie artysty w katalogu Spotify ---
el("spotifySearchBtn").addEventListener("click", doSpotifySearch);
el("spotifyArtistQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSpotifySearch();
});

function doSpotifySearch() {
  const query = el("spotifyArtistQuery").value.trim();
  if (!query) return;
  socket.emit("host:spotify_search_artist", { query }, (res) => {
    if (!res.ok) {
      alert(res.error);
      return;
    }
    el("spotifySearchResults").innerHTML = res.results
      .map(
        (a) =>
          `<div class="artist-chip" data-id="${a.id}" data-name="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>`
      )
      .join("");
    document.querySelectorAll("#spotifySearchResults .artist-chip").forEach((chip) => {
      chip.addEventListener("click", () => addSpotifyArtist(chip.dataset.id, chip.dataset.name));
    });
  });
}

function addSpotifyArtist(artistId, artistName) {
  if (spotifyArtistsAdded.has(artistId)) return;
  const count = Number(el("spotifyTrackCount").value) || 20;
  const mode = el("spotifyTrackMode").value;
  socket.emit("host:spotify_add_artist", { code: roomCode, artistId, artistName, count, mode }, (res) => {
    if (!res.ok) {
      alert(res.error);
      return;
    }
    spotifyArtistsAdded.set(artistId, { name: artistName, trackCount: res.trackCount });
    spotifyPoolSize = res.poolSize;
    renderSpotifyArtists();
  });
}

function removeSpotifyArtist(artistId) {
  socket.emit("host:spotify_remove_artist", { code: roomCode, artistId }, (res) => {
    spotifyArtistsAdded.delete(artistId);
    spotifyPoolSize = res?.poolSize ?? 0;
    renderSpotifyArtists();
  });
}

function renderSpotifyArtists() {
  el("spotifyAddedArtists").innerHTML = [...spotifyArtistsAdded.entries()]
    .map(
      ([id, a]) =>
        `<div class="artist-chip active" data-id="${id}">${escapeHtml(a.name)} (${a.trackCount}) ✕</div>`
    )
    .join("");
  document.querySelectorAll("#spotifyAddedArtists .artist-chip").forEach((chip) => {
    chip.addEventListener("click", () => removeSpotifyArtist(chip.dataset.id));
  });
  el("spotifyPoolSummary").textContent =
    `Dodanych artystów: ${spotifyArtistsAdded.size}, utworów w puli: ${spotifyPoolSize}`;
}

// --- Odtwarzanie fragmentu przez Spotify Web API (SDK steruje samym
// urządzeniem, ale start/stop z konkretnej pozycji idzie przez Web API) ---
async function playSpotifyClip(uri, positionMs, durationMs) {
  clearTimeout(spotifyPauseTimer);
  if (!spotifyDeviceId) {
    el("spotifyNowPlaying").textContent = "Urządzenie Spotify jeszcze się nie połączyło...";
    return;
  }
  try {
    const token = await fetchSpotifyToken();
    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [uri], position_ms: positionMs }),
    });
    el("spotifyNowPlaying").textContent = "♫ Odtwarzanie przez Spotify...";
    spotifyPauseTimer = setTimeout(pauseSpotify, durationMs);
  } catch (err) {
    el("spotifyNowPlaying").textContent = "Błąd odtwarzania Spotify: " + err.message;
  }
}

async function pauseSpotify() {
  clearTimeout(spotifyPauseTimer);
  if (!spotifyDeviceId) return;
  try {
    const token = await fetchSpotifyToken();
    await fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${spotifyDeviceId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // cicho pomijamy - runda i tak dobiegła końca
  }
}

// --- Aktualizacja listy graczy w lobby ---
let currentPlayers = []; // [{ id, name, score }] - potrzebne też podczas rundy
socket.on("room:players_updated", (players) => {
  currentPlayers = players;
  el("playersList").innerHTML = players
    .map((p) => `<div class="player-chip">${avatarImg(p.avatar, p.name)}${escapeHtml(p.name)}</div>`)
    .join("");
});

// --- Start gry ---
el("startBtn").addEventListener("click", () => {
  const zrodlo = el("zrodlo").value;
  const iloscRund = Number(el("iloscRund").value);

  if (zrodlo === "spotify") {
    if (!spotifyConnected) {
      el("startError").textContent = "Połącz się najpierw ze Spotify.";
      return;
    }
    if (spotifyPoolSize < iloscRund) {
      el("startError").textContent =
        `Za mało utworów w puli Spotify (${spotifyPoolSize}) na ${iloscRund} rund - dodaj więcej artystów.`;
      return;
    }
  } else {
    const totalSongs = artists
      .filter((a) => selectedArtists.has(a.name))
      .reduce((sum, a) => sum + a.count, 0);
    if (selectedArtists.size === 0) {
      el("startError").textContent = "Wybierz przynajmniej jednego artystę.";
      return;
    }
    if (totalSongs < iloscRund) {
      el("startError").textContent =
        `Za mało utworów (${totalSongs}) na ${iloscRund} rund - wybierz więcej artystów albo zmniejsz ilość rund.`;
      return;
    }
  }
  el("startError").textContent = "";

  const settings = {
    zrodlo,
    tryb: el("tryb").value,
    iloscRund,
    czasOdtwarzania: Number(el("czasOdtwarzania").value),
    iloscOdpowiedzi: Number(el("iloscOdpowiedzi").value),
    czasNaOdpowiedz: Number(el("czasNaOdpowiedz").value),
  };
  if (zrodlo === "lokalne") settings.aktywniArtysci = [...selectedArtists];

  socket.emit("host:update_settings", { code: roomCode, settings });
  show("prepView");
  socket.emit("host:start_game", { code: roomCode });
});

socket.on("game:prepare_progress", ({ i, total }) => {
  el("prepStatus").textContent = `Przygotowywanie rund... ${i}/${total}`;
});

// --- Rozpoczęcie rundy (host widzi opcje + odtwarza audio) ---
socket.on("round:start_host", (data) => {
  show("roundView");
  el("roundLabel").textContent = `Runda ${data.roundIndex + 1} / ${data.total}`;

  el("hostOptions").innerHTML = data.options
    .map(
      (opt, i) =>
        `<div class="option-btn" data-i="${i}">
          <span class="opt-title">${escapeHtml(opt.title)}</span>
          <span class="opt-artist">${escapeHtml(opt.artist)}</span>
        </div>`
    )
    .join("");

  lastRoundWasSpotify = data.source === "spotify";

  if (lastRoundWasSpotify) {
    el("clipAudio").style.display = "none";
    el("clipAudio").pause();
    el("spotifyNowPlaying").style.display = "block";
    playSpotifyClip(data.spotifyUri, data.startPositionMs, data.clipDurationMs);
  } else {
    el("spotifyNowPlaying").style.display = "none";
    const audio = el("clipAudio");
    audio.style.display = "block";
    audio.src = data.clipUrl;
    audio.play().catch(() => {}); // autoplay może wymagać interakcji użytkownika
  }

  renderAnsweredPanel([]); // na start rundy nikt jeszcze nie odpowiedział
});

// --- Kto już odpowiedział (na żywo, bez ujawniania treści odpowiedzi) ---
socket.on("round:answer_update", ({ answeredIds }) => {
  renderAnsweredPanel(answeredIds);
});

function renderAnsweredPanel(answeredIds) {
  el("answeredCount").textContent = answeredIds.length;
  el("totalPlayersCount").textContent = currentPlayers.length;
  el("answeredList").innerHTML = currentPlayers
    .map((p) => {
      const done = answeredIds.includes(p.id);
      return `<div class="player-chip ${done ? "answered" : "pending"}">${avatarImg(p.avatar, p.name)}${escapeHtml(p.name)}${done ? " ✓" : ""}</div>`;
    })
    .join("");
}

// --- Wynik rundy ---
socket.on("round:result", ({ correct, correctIndex, results, leaderboard }) => {
  show("resultView");
  el("correctAnswer").textContent = `${correct.title} - ${correct.artist}`;

  if (lastRoundWasSpotify) {
    pauseSpotify();
  } else {
    el("clipAudio").pause();
  }

  // podświetlenie poprawnej opcji na ekranie rundy (widoczne chwilę przed przejściem)
  document.querySelectorAll(".option-btn").forEach((btn) => {
    if (Number(btn.dataset.i) === correctIndex) btn.classList.add("correct");
  });

  // lista graczy pokolorowana: zielony = dobrze, czerwony = źle, szary = brak odpowiedzi
  el("roundResultsList").innerHTML = results
    .map((r) => {
      const cls = !r.answered ? "no-answer" : r.isCorrect ? "correct-answer" : "wrong-answer";
      const mark = !r.answered ? "…" : r.isCorrect ? "✓" : "✗";
      return `<div class="player-chip ${cls}">${avatarImg(r.avatar, r.name)}${escapeHtml(r.name)} ${mark}</div>`;
    })
    .join("");

  el("leaderboard").innerHTML = leaderboard
    .map(
      (p, rank) =>
        `<div class="leaderboard-row"><span>${rank + 1}. ${avatarImg(p.avatar, p.name)}${escapeHtml(p.name)}</span><span>${p.score} pkt</span></div>`
    )
    .join("");
});

el("nextBtn").addEventListener("click", () => {
  socket.emit("host:next_round", { code: roomCode });
});

// --- Koniec gry ---
socket.on("game:end", ({ leaderboard }) => {
  show("endView");
  el("finalLeaderboard").innerHTML = leaderboard
    .map(
      (p, rank) =>
        `<div class="leaderboard-row"><span>${rank + 1}. ${avatarImg(p.avatar, p.name)}${escapeHtml(p.name)}</span><span>${p.score} pkt</span></div>`
    )
    .join("");
});

// Powrót do ekranu głównego - BEZ przeładowania strony (window.location.reload
// zerwałoby połączenie Spotify Web Playback SDK i wymusiło ponowne logowanie)
el("backToLobbyBtn").addEventListener("click", () => {
  socket.emit("host:reset_room", { code: roomCode });
});

socket.on("room:reset", ({ players }) => {
  currentPlayers = players;
  el("playersList").innerHTML = players
    .map((p) => `<div class="player-chip">${avatarImg(p.avatar, p.name)}${escapeHtml(p.name)}</div>`)
    .join("");
  show("lobbyView");
});

socket.on("game:error", (msg) => {
  alert(msg);
});
