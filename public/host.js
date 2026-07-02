const socket = io();
let roomCode = null;
let artists = []; // [{ name, count }]
let selectedArtists = new Set();

const el = (id) => document.getElementById(id);
const show = (id) => {
  ["lobbyView", "prepView", "roundView", "resultView", "endView"].forEach(
    (v) => (el(v).style.display = v === id ? "block" : "none")
  );
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

// --- Aktualizacja listy graczy w lobby ---
let currentPlayers = []; // [{ id, name, score }] - potrzebne też podczas rundy
socket.on("room:players_updated", (players) => {
  currentPlayers = players;
  el("playersList").innerHTML = players
    .map((p) => `<div class="player-chip">${p.name}</div>`)
    .join("");
});

// --- Start gry ---
el("startBtn").addEventListener("click", () => {
  const iloscRund = Number(el("iloscRund").value);
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
  el("startError").textContent = "";

  const settings = {
    tryb: el("tryb").value,
    iloscRund,
    czasOdtwarzania: Number(el("czasOdtwarzania").value),
    iloscOdpowiedzi: Number(el("iloscOdpowiedzi").value),
    czasNaOdpowiedz: Number(el("czasNaOdpowiedz").value),
    aktywniArtysci: [...selectedArtists],
  };
  socket.emit("host:update_settings", { code: roomCode, settings });
  show("prepView");
  socket.emit("host:start_game", { code: roomCode });
});

socket.on("game:prepare_progress", ({ i, total }) => {
  el("prepStatus").textContent = `Przygotowywanie rund... ${i}/${total}`;
});

// --- Rozpoczęcie rundy (host widzi opcje + odtwarza audio) ---
socket.on("round:start_host", ({ roundIndex, total, clipUrl, options, timeLimit }) => {
  show("roundView");
  el("roundLabel").textContent = `Runda ${roundIndex + 1} / ${total}`;

  const audio = el("clipAudio");
  audio.src = clipUrl;
  audio.play().catch(() => {}); // autoplay może wymagać interakcji użytkownika

  el("hostOptions").innerHTML = options
    .map((opt, i) => `<div class="option-btn" data-i="${i}">${opt}</div>`)
    .join("");

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
      return `<div class="player-chip ${done ? "answered" : "pending"}">${p.name}${done ? " ✓" : ""}</div>`;
    })
    .join("");
}

// --- Wynik rundy ---
socket.on("round:result", ({ correct, correctIndex, results, leaderboard }) => {
  show("resultView");
  el("correctAnswer").textContent = correct;

  // podświetlenie poprawnej opcji na ekranie rundy (widoczne chwilę przed przejściem)
  document.querySelectorAll(".option-btn").forEach((btn) => {
    if (Number(btn.dataset.i) === correctIndex) btn.classList.add("correct");
  });

  // lista graczy pokolorowana: zielony = dobrze, czerwony = źle, szary = brak odpowiedzi
  el("roundResultsList").innerHTML = results
    .map((r) => {
      const cls = !r.answered ? "no-answer" : r.isCorrect ? "correct-answer" : "wrong-answer";
      const mark = !r.answered ? "…" : r.isCorrect ? "✓" : "✗";
      return `<div class="player-chip ${cls}">${r.name} ${mark}</div>`;
    })
    .join("");

  el("leaderboard").innerHTML = leaderboard
    .map(
      (p, rank) =>
        `<div class="leaderboard-row"><span>${rank + 1}. ${p.name}</span><span>${p.score} pkt</span></div>`
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
        `<div class="leaderboard-row"><span>${rank + 1}. ${p.name}</span><span>${p.score} pkt</span></div>`
    )
    .join("");
});

socket.on("game:error", (msg) => {
  alert(msg);
});
