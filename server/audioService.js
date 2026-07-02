const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const MUSIC_DIR = process.env.MUSIC_DIR || path.join(__dirname, "..", "library");
const SUPPORTED_EXTENSIONS = [".mp3", ".wav", ".ogg", ".flac", ".m4a"];
const CLIPS_DIR = path.join(__dirname, "..", "clips");

if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

// --- odpowiednik get_artists() ---
function getArtists() {
  return fs
    .readdirSync(MUSIC_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// --- odpowiednik get_songs_by_artist() ---
function getSongsByArtist(artist) {
  const folder = path.join(MUSIC_DIR, artist);
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((f) => SUPPORTED_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .map((f) => path.join(folder, f));
}

// --- odpowiednik get_all_songs() ---
function getAllSongs(activeArtists) {
  const songs = [];
  for (const artist of activeArtists) {
    songs.push(...getSongsByArtist(artist));
  }
  return songs;
}

function extractTitle(songPath) {
  return path.basename(songPath, path.extname(songPath));
}

function probeDuration(songPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(songPath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration * 1000); // ms
    });
  });
}

// --- Detekcja ciszy - odpowiednik pydub.silence.detect_nonsilent() ---
// Uruchamia ffmpeg z filtrem silencedetect (próg -40dB, min. 50ms ciszy,
// dokładnie jak min_silence_len=50, silence_thresh=-40 w mp.py) i parsuje
// linie "silence_start"/"silence_end" z jego stderr.
function detectSilenceIntervals(songPath) {
  const nullOutput = process.platform === "win32" ? "NUL" : "/dev/null";
  return new Promise((resolve, reject) => {
    const lines = [];
    ffmpeg(songPath)
      .audioFilters("silencedetect=noise=-40dB:d=0.05")
      .format("null")
      .output(nullOutput)
      .on("stderr", (line) => lines.push(line))
      .on("end", () => resolve(parseSilenceLines(lines)))
      .on("error", (err) => reject(err))
      .run();
  });
}

function parseSilenceLines(lines) {
  const silences = [];
  let currentStart = null;
  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);
    if (startMatch) currentStart = parseFloat(startMatch[1]) * 1000;
    if (endMatch && currentStart !== null) {
      silences.push({ start: currentStart, end: parseFloat(endMatch[1]) * 1000 });
      currentStart = null;
    }
  }
  return silences;
}

// Zamienia listę odcinków ciszy na listę odcinków NIE-cichych w [0, durationMs]
// - odpowiednik tego, co pydub.detect_nonsilent zwraca bezpośrednio.
function invertToNonsilent(silences, durationMs) {
  const nonsilent = [];
  let cursor = 0;
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    if (s.start > cursor) nonsilent.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < durationMs) nonsilent.push({ start: cursor, end: durationMs });
  return nonsilent;
}

// Czy odcinek [start, start+clipMs] zawiera choć trochę nie-ciszy
function hasNonsilentContent(nonsilentRanges, start, clipMs) {
  const end = start + clipMs;
  return nonsilentRanges.some((r) => r.start < end && r.end > start);
}

// Wycina fragment [startMs, startMs+durationMs] i zapisuje jako mp3 w CLIPS_DIR.
// To odpowiednik audio[start:start+len].export(...) z pydub, tylko przez ffmpeg.
function cutClip(songPath, startMs, durationMs, outFileName) {
  const outPath = path.join(CLIPS_DIR, outFileName);
  return new Promise((resolve, reject) => {
    ffmpeg(songPath)
      .setStartTime(startMs / 1000)
      .setDuration(durationMs / 1000)
      .audioCodec("libmp3lame")
      .output(outPath)
      .on("end", () => resolve(outPath))
      .on("error", reject)
      .run();
  });
}

// --- odpowiednik prepare_rounds() ---
// settings: { tryb, iloscRund, czasOdtwarzania (s), iloscOdpowiedzi, aktywniArtysci }
// onProgress(i, total) - callback do wysyłania postępu przez socket.io
async function prepareRounds(settings, onProgress) {
  const allSongs = getAllSongs(settings.aktywniArtysci);
  if (allSongs.length < settings.iloscRund) {
    throw new Error("Za mało piosenek do rozegrania tylu rund!");
  }

  const selected = shuffle(allSongs).slice(0, settings.iloscRund);
  const rounds = [];

  for (let i = 0; i < selected.length; i++) {
    const song = selected[i];
    onProgress?.(i + 1, selected.length);

    let duration;
    try {
      duration = await probeDuration(song);
    } catch (e) {
      console.warn(`[audioService] Pominięto (ffprobe): ${song} — ${e.message}`);
      continue; // plik uszkodzony/nieczytelny - pomiń, jak w oryginale
    }
    if (duration < 20000) {
      console.warn(`[audioService] Pominięto (za krótki, ${Math.round(duration)}ms): ${song}`);
      continue;
    }

    const clipMs = Math.round(settings.czasOdtwarzania * 1000);
    let startMs;

    // Detekcja ciszy na całym utworze - jedno przejście ffmpeg, wynik używany
    // przez oba tryby (odpowiednik detect_nonsilent z mp.py)
    let nonsilentRanges;
    try {
      const silences = await detectSilenceIntervals(song);
      nonsilentRanges = invertToNonsilent(silences, duration);
    } catch (e) {
      nonsilentRanges = [{ start: 0, end: duration }]; // fallback: traktuj cały utwór jako nie-cichy
    }

    if (settings.tryb === "losowy_fragment") {
      const maxStart = Math.max(10000, duration - 10000 - clipMs);
      startMs = randInt(10000, maxStart);

      // Jeśli trafiony fragment jest ciszą, przesuwaj o 100ms - dokładnie
      // jak pętla `while not detect_nonsilent(clip, ...)` w mp.py
      let attempts = 0;
      while (
        !hasNonsilentContent(nonsilentRanges, startMs, clipMs) &&
        attempts < 10
      ) {
        startMs = Math.min(startMs + 100, duration - clipMs);
        attempts++;
      }
    } else {
      // "poczatek" - pierwszy nie-cichy fragment utworu
      startMs = nonsilentRanges.length ? nonsilentRanges[0].start : 0;
      startMs = Math.min(startMs, Math.max(0, duration - clipMs));
    }

    const clipFileName = `clip_${Date.now()}_${i}.mp3`;
    let clipPath;
    try {
      clipPath = await cutClip(song, startMs, clipMs, clipFileName);
    } catch (e) {
      console.warn(`[audioService] Pominięto (cutClip): ${song} — ${e.message}`);
      continue;
    }

    const correctTitle = extractTitle(song);
    const otherTitles = allSongs
      .map(extractTitle)
      .filter((t) => t !== correctTitle);
    const distractors = shuffle(otherTitles).slice(
      0,
      Math.min(settings.iloscOdpowiedzi - 1, otherTitles.length)
    );
    const options = shuffle([...distractors, correctTitle]);

    rounds.push({
      songPath: song,
      clipFile: path.basename(clipPath), // serwowane statycznie pod /clips/<plik>
      correct: correctTitle,
      options,
    });
  }

  return rounds;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clearClips() {
  if (!fs.existsSync(CLIPS_DIR)) return;
  for (const f of fs.readdirSync(CLIPS_DIR)) {
    fs.unlinkSync(path.join(CLIPS_DIR, f));
  }
}

module.exports = {
  MUSIC_DIR,
  CLIPS_DIR,
  getArtists,
  getSongsByArtist,
  getAllSongs,
  prepareRounds,
  clearClips,
};
