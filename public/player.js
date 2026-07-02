const socket = io();
let hasAnswered = false;

const el = (id) => document.getElementById(id);
const show = (id) => {
  ["joinView", "waitView", "answerView", "resultView", "endView"].forEach(
    (v) => (el(v).style.display = v === id ? "block" : "none")
  );
};
const escapeHtml = (str) => {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
};
const avatarImg = (avatar, name) => {
  if (avatar) return `<img class="avatar" src="${avatar}" alt="" />`;
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return `<span class="avatar avatar-fallback">${escapeHtml(initial)}</span>`;
};

el("joinBtn").addEventListener("click", () => {
  const code = el("codeInput").value.trim().toUpperCase();
  const name = el("nameInput").value.trim() || "Gracz";
  if (!code) return;

  socket.emit("player:join_room", { code, name }, (res) => {
    if (res.error) {
      el("joinError").textContent = res.error;
      return;
    }
    show("waitView");
  });
});

socket.on("round:start_player", ({ roundIndex, total, options, timeLimit }) => {
  hasAnswered = false;
  show("answerView");
  el("roundLabel").textContent = `Runda ${roundIndex + 1} / ${total}`;
  el("answerStatus").textContent = "";

  el("playerOptions").innerHTML = options
    .map(
      (opt, i) =>
        `<button class="option-btn" data-i="${i}">
          <span class="opt-title">${escapeHtml(opt.title)}</span>
          <span class="opt-artist">${escapeHtml(opt.artist)}</span>
        </button>`
    )
    .join("");

  document.querySelectorAll(".option-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (hasAnswered) return;
      hasAnswered = true;
      const i = Number(btn.dataset.i);
      socket.emit("player:answer", { optionIndex: i });
      document.querySelectorAll(".option-btn").forEach((b) => (b.disabled = true));
      btn.style.outline = "3px solid white";
      el("answerStatus").textContent = "Odpowiedź wysłana! Czekaj na wynik...";
    });
  });
});

socket.on("round:result", ({ correct, results }) => {
  show("resultView");
  const mine = results.find((r) => r.playerId === socket.id);
  const msg = el("resultMsg");
  if (mine?.isCorrect) {
    msg.textContent = "✅ Dobrze!";
    msg.style.color = "var(--correct-green)";
    el("scoreMsg").textContent = `+${mine.pointsEarned} pkt (razem: ${mine.totalScore})`;
  } else {
    msg.textContent = `❌ Poprawna odpowiedź: ${correct.title} - ${correct.artist}`;
    msg.style.color = "var(--wrong-red)";
    el("scoreMsg").textContent = mine ? `Razem: ${mine.totalScore} pkt` : "";
  }
});

socket.on("game:end", ({ leaderboard }) => {
  show("endView");
  el("finalLeaderboard").innerHTML = leaderboard
    .map(
      (p, rank) =>
        `<div class="leaderboard-row"><span>${rank + 1}. ${avatarImg(p.avatar, p.name)}${escapeHtml(p.name)}</span><span>${p.score} pkt</span></div>`
    )
    .join("");
});

// Host wrócił do ekranu głównego - my wracamy do czekania na kolejną rundę,
// bez konieczności ponownego wpisywania kodu pokoju.
socket.on("room:reset", () => {
  hasAnswered = false;
  show("waitView");
});

socket.on("game:error", (msg) => {
  alert(msg);
});
