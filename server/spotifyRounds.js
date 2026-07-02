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

// settings: { tryb, iloscRund, czasOdtwarzania (s), iloscOdpowiedzi }
// trackPool: [{ id, uri, name, durationMs, artistId }, ...] zebrane z artystów
// dodanych przez hosta w panelu Spotify.
// artistNames: Map(artistId -> nazwa artysty), do zbudowania etykiety
// "Tytuł - Wykonawca" w opcjach odpowiedzi.
function prepareSpotifyRounds(settings, trackPool, artistNames) {
  // pomijamy bardzo krótkie utwory (interludia/skity) - za mało treści na rundę
  const eligible = trackPool.filter((t) => t.durationMs >= 40000);
  if (eligible.length < settings.iloscRund) {
    throw new Error("Za mało utworów w wybranych artystach Spotify na tyle rund!");
  }

  const entry = (track) => ({
    title: track.name,
    artist: artistNames?.get(track.artistId) || "Nieznany wykonawca",
  });

  const selected = shuffle(eligible).slice(0, settings.iloscRund);
  const clipMs = Math.round(settings.czasOdtwarzania * 1000);

  return selected.map((track) => {
    let startMs;
    if (settings.tryb === "poczatek") {
      startMs = 0;
    } else {
      // Pełny zakres utworu jest dostępny do losowania pozycji startu - bez
      // sztucznego omijania początku/końca. Bez dostępu do surowego audio
      // nie da się wykryć ciszy jak w trybie lokalnym (ffmpeg silencedetect),
      // więc czasem trafi się cichy fragment/fade - to świadomy kompromis.
      const maxStart = Math.max(0, track.durationMs - clipMs);
      startMs = randInt(0, maxStart);
    }

    const correctEntry = entry(track);
    const otherEntries = trackPool.filter((t) => t.id !== track.id).map(entry);
    const distractors = shuffle(otherEntries).slice(
      0,
      Math.min(settings.iloscOdpowiedzi - 1, otherEntries.length)
    );
    const options = shuffle([...distractors, correctEntry]);

    return {
      source: "spotify",
      spotifyUri: track.uri,
      startPositionMs: startMs,
      correct: correctEntry,
      options,
    };
  });
}

module.exports = { prepareSpotifyRounds };
