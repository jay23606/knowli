// Liczy wady per źródło: łączy verdicts.csv (jeden lub kilka katalogów oceny) z key.json ślepego arkusza.
// Użycie: node tests/probes/blind/score.cjs <key.json> <verdicts.csv> [<verdicts.csv> ...]
const fs = require("fs");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""])));
}

const [, , keyPath, ...verdictPaths] = process.argv;
const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
const sourceOf = new Map(key.rows.map((row) => [row.rowId, row.model]));
const verdicts = verdictPaths.flatMap((path) => parseCsv(fs.readFileSync(path, "utf8")));
const stats = {};
const missing = [];
for (const row of verdicts) {
  const source = sourceOf.get(row.rowId);
  if (!source) { missing.push(row.rowId); continue; }
  const entry = (stats[source] ??= { rows: 0, defects: 0, k5: 0, nonK5: 0, criteria: {} });
  entry.rows += 1;
  if (row.verdict.trim() === "defect") {
    entry.defects += 1;
    const criteria = row.criterion.split("|").map((c) => c.trim()).filter(Boolean);
    for (const criterion of criteria) entry.criteria[criterion] = (entry.criteria[criterion] ?? 0) + 1;
    if (criteria.includes("K5")) entry.k5 += 1;
    if (criteria.some((c) => c !== "K5")) entry.nonK5 += 1;
  }
}
const judged = verdicts.length;
console.log(`ocenione wiersze: ${judged} z ${key.rows.length}${missing.length ? `; bez klucza: ${missing.join(",")}` : ""}`);
for (const [source, entry] of Object.entries(stats)) {
  const pct = (n) => ((100 * n) / entry.rows).toFixed(1);
  console.log(`${source.padEnd(46)} ${String(entry.rows).padStart(3)} ćw. | wady ${entry.defects} | poza K5 ${entry.nonK5} (${pct(entry.nonK5)}%) | K5 ${entry.k5} | ${JSON.stringify(entry.criteria)}`);
}
