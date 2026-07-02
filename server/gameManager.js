const { customAlphabet } = require("nanoid");
const { prepareRounds, clearClips } = require("./audioService");

const genCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 5);

// Domyślne ustawienia - 1:1 odpowiednik `settings` z mp.py
function defaultSettings() {
  return {
    tryb: "losowy_fragment", // "losowy_fragment" | "poczatek"
    iloscRund: 5,
    czasOdtwarzania: 3, // sekundy (fragment audio - w web wygodniej dłuższy niż 0.1s)
    iloscOdpowiedzi: 4,
    aktywniArtysci: [],
    czasNaOdpowiedz: 10, // sekundy - limit czasu na rundę (nowość vs. mp.py)
  };
}

class Room {
  constructor(code, hostSocketId) {
    this.code = code;
    this.hostSocketId = hostSocketId;
    this.players = new Map(); // socketId -> { name, score }
    this.settings = defaultSettings();
    this.preparedRounds = [];
    this.currentRoundIndex = -1;
    this.answers = new Map(); // socketId -> { optionIndex, timeMs }
    this.roundStartedAt = null;
    this.roundTimer = null;
    this.status = "lobby"; // lobby | preparing | playing | finished
  }

  addPlayer(socketId, name) {
    this.players.set(socketId, { name, score: 0 });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  publicPlayerList() {
    return [...this.players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score,
    }));
  }

  currentRound() {
    return this.preparedRounds[this.currentRoundIndex];
  }
}

class GameManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> Room
  }

  createRoom(hostSocketId) {
    let code;
    do {
      code = genCode();
    } while (this.rooms.has(code));
    const room = new Room(code, hostSocketId);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code);
  }

  destroyRoom(code) {
    const room = this.rooms.get(code);
    if (room?.roundTimer) clearTimeout(room.roundTimer);
    this.rooms.delete(code);
  }

  // --- Przygotowanie rund: odpowiednik prepare_rounds() ---
  async prepareRoundsForRoom(room) {
    room.status = "preparing";
    room.preparedRounds = await prepareRounds(room.settings, (i, total) => {
      this.io.to(room.code).emit("game:prepare_progress", { i, total });
    });
    room.currentRoundIndex = -1;
    room.status = room.preparedRounds.length ? "playing" : "lobby";
    return room.preparedRounds;
  }

  // --- Start kolejnej rundy: odpowiednik pętli w game_loop() ---
  startNextRound(room) {
    room.currentRoundIndex += 1;
    const round = room.currentRound();

    if (!round) {
      this.endGame(room);
      return;
    }

    room.answers.clear();
    room.roundStartedAt = Date.now();

    // Host dostaje ścieżkę do klipu audio (odtwarza je lokalnie na ekranie/TV)
    this.io.to(room.hostSocketId).emit("round:start_host", {
      roundIndex: room.currentRoundIndex,
      total: room.preparedRounds.length,
      clipUrl: `/clips/${round.clipFile}`,
      options: round.options,
      timeLimit: room.settings.czasNaOdpowiedz,
    });

    // Gracze dostają tylko opcje (bez audio, bez poprawnej odpowiedzi)
    for (const socketId of room.players.keys()) {
      this.io.to(socketId).emit("round:start_player", {
        roundIndex: room.currentRoundIndex,
        total: room.preparedRounds.length,
        options: round.options,
        timeLimit: room.settings.czasNaOdpowiedz,
      });
    }

    room.roundTimer = setTimeout(
      () => this.finishRound(room),
      room.settings.czasNaOdpowiedz * 1000
    );
  }

  // --- Zapisanie odpowiedzi gracza ---
  submitAnswer(room, socketId, optionIndex) {
    if (room.answers.has(socketId)) return; // już odpowiedział
    room.answers.set(socketId, {
      optionIndex,
      timeMs: Date.now() - room.roundStartedAt,
    });

    // Powiadom hosta na żywo, kto już odpowiedział - bez ujawniania CO
    // odpowiedział, żeby nie dało się podpowiadać innym graczom
    this.io.to(room.hostSocketId).emit("round:answer_update", {
      answeredIds: [...room.answers.keys()],
      totalPlayers: room.players.size,
    });

    // jeśli wszyscy odpowiedzieli, kończymy rundę wcześniej
    if (room.answers.size >= room.players.size) {
      clearTimeout(room.roundTimer);
      this.finishRound(room);
    }
  }

  // --- Rozliczenie rundy: punktacja + wynik, odpowiednik result_message w mp.py ---
  finishRound(room) {
    const round = room.currentRound();
    if (!round) return;
    const correctIndex = round.options.indexOf(round.correct);

    const results = [];
    for (const [socketId, player] of room.players.entries()) {
      const answer = room.answers.get(socketId);
      const isCorrect = answer && answer.optionIndex === correctIndex;
      let pointsEarned = 0;
      if (isCorrect) {
        // szybsza poprawna odpowiedź = więcej punktów (jak w Kahoot/Jackbox)
        const speedBonus = Math.max(
          0,
          1 - answer.timeMs / (room.settings.czasNaOdpowiedz * 1000)
        );
        pointsEarned = Math.round(500 + 500 * speedBonus);
        player.score += pointsEarned;
      }
      results.push({
        playerId: socketId,
        name: player.name,
        answered: !!answer,
        isCorrect,
        pointsEarned,
        totalScore: player.score,
      });
    }

    this.io.to(room.code).emit("round:result", {
      correct: round.correct,
      correctIndex,
      results,
      leaderboard: room.publicPlayerList().sort((a, b) => b.score - a.score),
    });
  }

  endGame(room) {
    room.status = "finished";
    this.io.to(room.code).emit("game:end", {
      leaderboard: room.publicPlayerList().sort((a, b) => b.score - a.score),
    });
    clearClips(); // sprzątanie, odpowiednik clear_temp_files()
  }
}

module.exports = { GameManager, defaultSettings };
