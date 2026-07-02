const { customAlphabet } = require("nanoid");
const { prepareRounds, clearClips } = require("./audioService");
const { prepareSpotifyRounds } = require("./spotifyRounds");
const { randomAvatar } = require("./avatarService");

const genCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 5);

// Domyślne ustawienia - 1:1 odpowiednik `settings` z mp.py
function defaultSettings() {
  return {
    zrodlo: "lokalne", // "lokalne" | "spotify"
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

    // Pula utworów Spotify zebrana przez hosta (patrz spotifyCatalog.js)
    this.spotifyArtists = new Map(); // artistId -> { name, trackCount }
    this.spotifyTrackPool = []; // [{ id, uri, name, durationMs, artistId }, ...]
  }

  addPlayer(socketId, name) {
    this.players.set(socketId, { name, score: 0, avatar: randomAvatar() });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  publicPlayerList() {
    return [...this.players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score,
      avatar: p.avatar,
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

    if (room.settings.zrodlo === "spotify") {
      const artistNames = new Map(
        [...room.spotifyArtists.entries()].map(([id, a]) => [id, a.name])
      );
      room.preparedRounds = prepareSpotifyRounds(room.settings, room.spotifyTrackPool, artistNames);
    } else {
      room.preparedRounds = await prepareRounds(room.settings, (i, total) => {
        this.io.to(room.code).emit("game:prepare_progress", { i, total });
      });
    }

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

    const basePayload = {
      roundIndex: room.currentRoundIndex,
      total: room.preparedRounds.length,
      options: round.options,
      timeLimit: room.settings.czasNaOdpowiedz,
    };

    // Host dostaje dane do odtworzenia audio (plik lokalny albo utwór Spotify)
    const hostPayload =
      round.source === "spotify"
        ? {
            ...basePayload,
            source: "spotify",
            spotifyUri: round.spotifyUri,
            startPositionMs: round.startPositionMs,
            clipDurationMs: Math.round(room.settings.czasOdtwarzania * 1000),
          }
        : {
            ...basePayload,
            source: "lokalne",
            clipUrl: `/clips/${round.clipFile}`,
          };

    this.io.to(room.hostSocketId).emit("round:start_host", hostPayload);

    // Gracze dostają tylko opcje (bez audio, bez poprawnej odpowiedzi)
    for (const socketId of room.players.keys()) {
      this.io.to(socketId).emit("round:start_player", basePayload);
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
        avatar: player.avatar,
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

  // --- Powrót do lobby po zakończonej grze - TEN SAM pokój i gracze,
  // punkty wyzerowane. Celowo nie tworzy nowego pokoju: dzięki temu host nie
  // musi przeładowywać strony (co niszczyłoby połączenie Spotify Web Playback
  // SDK i wymuszało ponowne logowanie), a gracze nie muszą wpisywać kodu od nowa. ---
  resetRoom(room) {
    if (room.roundTimer) clearTimeout(room.roundTimer);
    room.preparedRounds = [];
    room.currentRoundIndex = -1;
    room.answers.clear();
    room.roundStartedAt = null;
    room.roundTimer = null;
    room.status = "lobby";
    for (const player of room.players.values()) {
      player.score = 0;
    }
  }
}

module.exports = { GameManager, defaultSettings };
