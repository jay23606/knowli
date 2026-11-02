/**
 * Raport ujawnionych rozwiązań w istniejących szkicach lekcji (tylko odczyt: transakcja READ ONLY).
 *
 * Dla każdego szkicu (draft/review) liczy rozwiązania widziane przez dziecko wcześniej
 * (twarde: przykład karty lub ćwiczenie niesamodzielne; miękkie: wcześniejsze ćwiczenie
 * samodzielne) i porównuje pokrycie publikacyjne przed i po regule ujawnień. Drukuje szkice
 * z ujawnieniami oraz podsumowanie „nowo zablokowane” (blockedAfter i nie blockedBefore).
 * Nie drukuje treści ćwiczeń ani danych dziecka — tylko identyfikatory i liczniki.
 *
 * Uruchomienie (właściciel, lokalnie, na gałęzi z regułą):
 *   DATABASE_URL=<baza odtworzona z kopii (deploy/restore.sh) albo tunel tylko do odczytu> \
 *     corepack pnpm report:exposure-leaks
 * `DATABASE_URL` można też podać w .env w katalogu głównym.
 */
import { readFileSync } from "node:fs";
import { createServices } from "../packages/server/src/config";
import { createDatabase } from "../packages/server/src/db/client";
import { reportLessonExposureLeaks } from "../packages/server/src/modules/materials/lessons/lesson-exposure-report";

let envText = "";
try {
  envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
for (const line of envText.split(/\r?\n/)) {
  const m = /^(?:export\s+)?([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]!] === undefined) {
    process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Brak DATABASE_URL — wskaż bazę odtworzoną z kopii albo tunel tylko do odczytu.");
  process.exit(2);
}

const { db, pool } = createDatabase(databaseUrl);
try {
  const services = createServices({ db });
  // Cały raport w jednej transakcji tylko do odczytu (BEGIN READ ONLY): baza odrzuci każdy zapis,
  // nawet przypadkowy, a odczyt widzi spójną migawkę.
  const rows = await db.transaction((tx) => reportLessonExposureLeaks(tx, services), { accessMode: "read only" });
  const leaking = rows.filter((row) => row.hardLeaks + row.softLeaks > 0);
  console.log(`szkice lekcji (draft/review): ${rows.length}, z ujawnieniami: ${leaking.length}`);
  for (const row of leaking) {
    console.log(
      `${row.state} deck=${row.deckId} version=${row.deckVersionId} twarde=${row.hardLeaks} miękkie=${row.softLeaks} ` +
        `blokada przed=${row.blockedBefore ? "tak" : "nie"} po=${row.blockedAfter ? "tak" : "nie"}`,
    );
  }
  const newlyBlocked = rows.filter((row) => row.blockedAfter && !row.blockedBefore);
  console.log(`nowo zablokowane: ${newlyBlocked.length}`);
} finally {
  await pool.end();
}
