// Ślepy arkusz porównania generatorów: ćwiczenia wszystkich modeli jednej lekcji, wymieszane.
// Użycie: node tests/probes/blind/gen-blind-sheet.cjs <katalog lekcji POZA repozytorium: podkatalog per źródło z dump.json> <seed>
// Wynik: <katalog>\blind\sheet.csv (bez nazw modeli) i <katalog>\blind\key.json (rowId → model, indeks).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { probePath } = require("./paths.cjs");

const [, , lessonDirArg, seed = "gen-compare"] = process.argv;
const lessonDir = probePath(lessonDirArg, "katalog lekcji");
// `readdirSync` nie gwarantuje kolejności — sortujemy, żeby ten sam seed dawał ten sam arkusz na każdym systemie.
const candidates = fs
  .readdirSync(lessonDir)
  .filter((name) => fs.existsSync(path.join(lessonDir, name, "dump.json")))
  .sort((a, b) => a.localeCompare(b, "en"));
const models = [];

function rng(seedText) {
  let state = crypto.createHash("sha256").update(seedText).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

const rows = [];
for (const model of candidates) {
  const dump = JSON.parse(fs.readFileSync(path.join(lessonDir, model, "dump.json"), "utf8"));
  // Zrzut nieudanej próby (`{ ...header, errors }`) nie ma ćwiczeń — pomijamy źródło, reszta arkusza powstaje.
  if (!Array.isArray(dump.exercises)) {
    console.log(`pominięte źródło bez ćwiczeń: ${model}`);
    continue;
  }
  models.push(model);
  const objectives = new Map((dump.objectives ?? []).map((objective) => [String(objective.id).split(".").at(-1), objective]));
  dump.exercises.forEach((exercise, index) => {
    const slug = String(exercise.objectiveId ?? "").split(".").at(-1);
    const objective = objectives.get(slug);
    const context = objective
      ? { title: objective.title, kind: objective.kind ?? null, card: objective.card, examples: objective.examples ?? [] }
      : null;
    rows.push({ model, index, subject: dump.subjectId, exercise, context });
  });
}

const random = rng(seed);
for (let i = rows.length - 1; i > 0; i -= 1) {
  const j = Math.floor(random() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]];
}

const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;

/** Treść ćwiczenia bez metadanych zdradzających źródło: `id` (`ex<N>` agenta, UUID potoku), `revisionId`, pola `*Audio`, temat w `objectiveId`. */
function blindContent(exercise) {
  const content = {};
  for (const [field, value] of Object.entries(exercise ?? {})) {
    if (field === "id" || field === "revisionId" || field.endsWith("Audio")) continue;
    content[field] = field === "objectiveId" ? String(value ?? "").split(".").at(-1) : value;
  }
  return content;
}
const header = ["rowId", "subject", "objective", "exercise", "verdict", "criterion", "adjudicatorNote"];
const lines = [header.join(",")];
const key = { seed, models, rows: [] };
rows.forEach((row, position) => {
  const rowId = `r${String(position + 1).padStart(3, "0")}`;
  lines.push([rowId, row.subject, quote(JSON.stringify(row.context)), quote(JSON.stringify(blindContent(row.exercise))), "", "", ""].join(","));
  key.rows.push({ rowId, model: row.model, index: row.index });
});

const outDir = path.join(lessonDir, "blind");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "sheet.csv"), `${lines.join("\n")}\n`);
fs.writeFileSync(path.join(outDir, "key.json"), JSON.stringify(key, null, 1));
console.log(`models=${models.length} rows=${rows.length} → ${outDir}`);
