const fs = require("fs");
const path = require("path");

const AVATARS_DIR = path.join(__dirname, "..", "public", "avatars");

function getAvatarFiles() {
  if (!fs.existsSync(AVATARS_DIR)) return [];
  return fs
    .readdirSync(AVATARS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".png"));
}

// Zwraca losowy awatar (ścieżkę serwowaną statycznie pod /avatars/<plik>)
// albo null, jeśli folder jest pusty - wtedy front-end pokazuje inicjał
// zamiast zdjęcia.
function randomAvatar() {
  const files = getAvatarFiles();
  if (files.length === 0) return null;
  const pick = files[Math.floor(Math.random() * files.length)];
  return `/avatars/${pick}`;
}

module.exports = { randomAvatar };
