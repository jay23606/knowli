// Ścieżki narzędzi ślepej oceny: tylko w katalogu domowym i poza repozytorium (dane podręcznika i wyjście modeli).
const os = require("os");
const path = require("path");

const HOME = path.resolve(os.homedir());
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const within = (base, target) => target === base || target.startsWith(`${base}${path.sep}`);

/** Rozwiązana ścieżka argumentu `name` albo błąd, gdy leży poza katalogiem domowym lub w checkoucie. */
function probePath(raw, name) {
  if (raw === undefined || raw.trim() === "") throw new Error(`${name}: brak ścieżki`);
  const resolved = path.resolve(raw);
  if (!within(HOME, resolved)) throw new Error(`${name} musi leżeć w katalogu domowym (${HOME})`);
  if (within(REPO_ROOT, resolved)) throw new Error(`${name} wskazuje wewnątrz repozytorium (${REPO_ROOT}) — podaj ścieżkę poza checkoutem`);
  return resolved;
}

module.exports = { probePath };
