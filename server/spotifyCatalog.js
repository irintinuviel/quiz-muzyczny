// Ta warstwa NIE wymaga zalogowania hosta - wyszukiwanie i przeglądanie
// katalogu Spotify działa na tokenie aplikacji (Client Credentials Flow).
// Logowanie hosta (spotifyAuth.js) jest potrzebne dopiero do odtwarzania.

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let appToken = null;
let appTokenExpiresAt = 0;

async function getAppToken() {
  if (appToken && Date.now() < appTokenExpiresAt) return appToken;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Brak SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET w zmiennych środowiskowych");
  }
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Nie udało się pobrać tokenu aplikacji Spotify (${res.status})`);
  const data = await res.json();
  appToken = data.access_token;
  appTokenExpiresAt = Date.now() + data.expires_in * 1000 - 30_000;
  return appToken;
}

async function spotifyFetch(path) {
  const token = await getAppToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify API ${path} -> ${res.status}`);
  return res.json();
}

async function searchArtist(query) {
  const data = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=artist&limit=8`);
  return (data.artists?.items || []).map((a) => ({
    id: a.id,
    name: a.name,
    image: a.images?.[a.images.length - 1]?.url || null,
    followers: a.followers?.total ?? 0,
  }));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Dokleja pole `popularity` (0-100) do utworów - potrzebne tylko dla trybu
// "popularne", więc wywoływane osobno, żeby nie robić zbędnych requestów
// w trybie losowym. Endpoint /albums/{id}/tracks tego pola nie zwraca,
// trzeba dociągnąć pełne obiekty utworów przez /tracks (batch po 50 sztuk).
async function attachPopularity(tracks) {
  const out = [];
  for (let i = 0; i < tracks.length; i += 50) {
    const batch = tracks.slice(i, i + 50);
    const ids = batch.map((t) => t.id).join(",");
    const data = await spotifyFetch(`/tracks?ids=${ids}&market=PL`);
    (data.tracks || []).forEach((full, idx) => {
      out.push({ ...batch[idx], popularity: full?.popularity ?? 0 });
    });
  }
  return out;
}

// Pobiera utwory z albumów i singli artysty (NIE tylko z /top-tracks, który
// ogranicza się do garstki najpopularniejszych) - dzięki temu pula bazowa
// zawiera też mniej znane utwory. Ograniczone do pierwszych 25 wydawnictw,
// żeby nie zarzucać Spotify API dziesiątkami requestów dla artystów
// z ogromną dyskografią.
//
// options.limit: ile utworów finalnie wybrać z tej bazowej puli
// options.mode: "popularne" (sortowanie po popularności, top N) albo
//               "losowe" (losowe N z całej dyskografii)
async function getArtistTracks(artistId, options = {}) {
  const { limit = 20, mode = "losowe" } = options;

  const albumsData = await spotifyFetch(
    `/artists/${artistId}/albums?include_groups=album,single&limit=50&market=PL`
  );
  const albums = (albumsData.items || []).slice(0, 25);

  const seenTitles = new Set();
  let tracks = [];

  for (const album of albums) {
    const page = await spotifyFetch(`/albums/${album.id}/tracks?limit=50&market=PL`);
    for (const t of page.items || []) {
      const key = t.name.toLowerCase();
      if (seenTitles.has(key)) continue; // pomijamy duplikaty (reedycje/remastery)
      seenTitles.add(key);
      tracks.push({
        id: t.id,
        uri: t.uri,
        name: t.name,
        durationMs: t.duration_ms,
      });
    }
  }

  if (mode === "popularne") {
    tracks = await attachPopularity(tracks);
    tracks.sort((a, b) => b.popularity - a.popularity);
  } else {
    tracks = shuffle(tracks);
  }

  return tracks.slice(0, limit);
}

module.exports = { searchArtist, getArtistTracks };
