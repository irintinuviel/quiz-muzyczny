const crypto = require("crypto");

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// Web Playback SDK wymaga "streaming" + danych profilu; nie prosimy o nic więcej
// (nie czytamy playlist, nie modyfikujemy biblioteki użytkownika).
const SCOPES = "streaming user-read-email user-read-private";

// Sesje trzymane w pamięci procesu - wystarczające dla prywatnej appki ze
// znajomymi. Restart serwera = trzeba zalogować się do Spotify ponownie.
const sessions = new Map(); // sessionId -> { accessToken, refreshToken, expiresAt }
const pendingStates = new Set(); // ochrona CSRF na czas trwania logowania

function assertConfigured() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "Brak SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET w zmiennych środowiskowych - " +
        "załóż aplikację na developer.spotify.com i ustaw te zmienne."
    );
  }
}

// redirectUri jest przekazywany z zewnątrz (patrz index.js: getRedirectUri) -
// wykrywany dynamicznie z adresu, spod którego host faktycznie korzysta
// z aplikacji (localhost, Tailscale, cokolwiek), żeby popup logowania zawsze
// wracał na TEN SAM origin co główne okno hosta.
function buildAuthorizeUrl(redirectUri) {
  assertConfigured();
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

function isValidState(state) {
  if (!state || !pendingStates.has(state)) return false;
  pendingStates.delete(state);
  return true;
}

async function exchangeCodeForTokens(code, redirectUri) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Wymiana kodu na token nie powiodła się (${res.status})`);
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Odświeżenie tokenu nie powiodło się (${res.status})`);
  return res.json();
}

function createSession(tokens) {
  const sessionId = crypto.randomBytes(24).toString("hex");
  sessions.set(sessionId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000 - 30_000, // 30s bufora
  });
  return sessionId;
}

// Zwraca ważny access token dla danej sesji, odświeżając go w razie potrzeby.
async function getValidAccessToken(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() < session.expiresAt) return session.accessToken;

  const refreshed = await refreshAccessToken(session.refreshToken);
  session.accessToken = refreshed.access_token;
  session.expiresAt = Date.now() + refreshed.expires_in * 1000 - 30_000;
  if (refreshed.refresh_token) session.refreshToken = refreshed.refresh_token;
  return session.accessToken;
}

module.exports = {
  buildAuthorizeUrl,
  isValidState,
  exchangeCodeForTokens,
  createSession,
  getValidAccessToken,
};
