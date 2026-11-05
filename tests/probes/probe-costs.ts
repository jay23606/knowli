import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isOpenRouterEndpoint } from "../../packages/server/src/providers/chat-request-options";

/**
 * Narzędzia płatnych prób (`*.probe.test.ts`): rejestr kosztów (`costs.json` poza repozytorium),
 * szacunek kosztu generowania, kontrola hosta usługi i drobne pomocniki odczytu. Bez wywołań modelu;
 * testy w `probe-costs.test.ts` (konfiguracja unit). Żadna funkcja nie pisze na konsolę.
 */

/** Szacunek kosztu jednego generowania (wszystkie wywołania przebiegu) — kontrola limitu. */
export const GENERATION_ESTIMATE_USD = 0.4;
/** Zmierzony koszt poniżej tylu USD na wywołanie uznajemy za niepełny (`usage.cost` brak w części odpowiedzi) — wpisujemy szacunek. */
export const MIN_MEASURED_USD_PER_CALL = 0.005;
/** Limit łączny prób dla nowego rejestru kosztów. */
export const DEFAULT_COST_CAP_USD = 10;

// ---------------------------------------------------------------------------------------------
// Rejestr kosztów (`costs.json` w katalogu danych próby)

export interface CostEntry {
  at: string;
  probe: string;
  dump: string;
  costUsd: number;
  /** Dostawca nie zwrócił `usage.cost` mimo wywołań — wpisany szacunek zamiast zera. */
  estimated?: boolean;
  /** Identyfikator wpisu tymczasowego (rozliczanego po próbie przez `settleCostEntry`). */
  id?: string;
  /** Wpis tymczasowy: szacunek zapisany przed płatnym wywołaniem; zostaje, gdy proces zginie przed rozliczeniem. */
  provisional?: boolean;
}

export interface CostLedger {
  capUsd: number;
  spentUsd: number;
  entries: CostEntry[];
}

/** Szacunek przed uruchomieniem: liczba generowań × koszt jednego. */
export function estimateProbeCostUsd(input: { generations: number }): number {
  return input.generations * GENERATION_ESTIMATE_USD;
}

/**
 * Koszt do rejestru: zmierzony (`usage.cost`), a gdy były wywołania, a koszt jest nieznany albo
 * mniejszy niż `MIN_MEASURED_USD_PER_CALL` × wywołania (część odpowiedzi bez `usage.cost`) — szacunek
 * z flagą `estimated` (lepiej przeszacować wydatki niż wpisać zero).
 */
export function ledgerCost(input: { measuredUsd: number; calls: number; fallbackUsd: number }): { costUsd: number; estimated: boolean } {
  if (input.calls > 0 && !(input.measuredUsd >= input.calls * MIN_MEASURED_USD_PER_CALL)) return { costUsd: input.fallbackUsd, estimated: true };
  return { costUsd: Math.max(0, input.measuredUsd), estimated: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Rejestr z pliku. Brak pliku → błąd (literówka w `UMIEM_PROBE_COSTS` nie może założyć nowego
 * rejestru z pełnym limitem); nowy rejestr zakłada tylko `initCostLedger` (`UMIEM_PROBE_COSTS_INIT=1`).
 * Zepsuty plik → błąd (nigdy nie nadpisujemy).
 */
export function readCostLedger(path: string): CostLedger {
  if (!existsSync(path)) {
    throw new Error(`Rejestr kosztów (costs.json) ${path} nie istnieje — sprawdź UMIEM_PROBE_COSTS; nowy rejestr zakłada tylko UMIEM_PROBE_COSTS_INIT=1.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    // Bez komunikatu parsera: może cytować fragment pliku.
    throw new Error(`Rejestr kosztów (costs.json) ${path} jest nieczytelny (${errorClassOf(error)}) — popraw go ręcznie.`);
  }
  const validEntry = (entry: unknown): entry is CostEntry => isRecord(entry) && typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd) &&
    typeof entry.at === "string" && typeof entry.probe === "string" && typeof entry.dump === "string" &&
    (entry.estimated === undefined || typeof entry.estimated === "boolean") &&
    (entry.id === undefined || typeof entry.id === "string") && (entry.provisional === undefined || typeof entry.provisional === "boolean");
  if (!isRecord(raw) || typeof raw.capUsd !== "number" || !Number.isFinite(raw.capUsd) || !Array.isArray(raw.entries) || !raw.entries.every(validEntry)) {
    throw new Error(`Rejestr kosztów (costs.json) ${path} ma zły kształt — oczekiwano { capUsd, spentUsd, entries: [{ at, probe, dump, costUsd, estimated? }] }.`);
  }
  const entries = (raw.entries as CostEntry[]).map(({ id, at, probe, dump, costUsd, estimated, provisional }) => ({
    ...(id === undefined ? {} : { id }), at, probe, dump, costUsd,
    ...(estimated === undefined ? {} : { estimated }), ...(provisional === undefined ? {} : { provisional }),
  }));
  return { capUsd: raw.capUsd, spentUsd: round6(entries.reduce((sum, entry) => sum + entry.costUsd, 0)), entries };
}

function writeLedger(path: string, ledger: CostLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/**
 * Limit nowego rejestru z `UMIEM_PROBE_COSTS_CAP_USD`: brak albo pusta wartość → domyślne 10 USD;
 * wartość niebędąca dodatnią liczbą skończoną (kropka dziesiętna) → błąd przed jakimkolwiek wywołaniem.
 */
export function costCapFromEnv(value: string | undefined): number {
  const text = value?.trim() ?? "";
  if (text === "") return DEFAULT_COST_CAP_USD;
  const cap = Number(text);
  if (!/^\d+(?:\.\d+)?$/u.test(text) || !Number.isFinite(cap) || cap <= 0) {
    throw new Error(`UMIEM_PROBE_COSTS_CAP_USD musi być dodatnią liczbą USD (np. 2.5), jest: ${JSON.stringify(text)}.`);
  }
  return cap;
}

/**
 * Jawne założenie rejestru (`{ capUsd, spentUsd: 0, entries: [] }`, domyślnie limit 10 USD);
 * istniejący zostaje bez zmian, także jego limit.
 */
export function initCostLedger(path: string, capUsd: number = DEFAULT_COST_CAP_USD): CostLedger {
  if (existsSync(path)) return readCostLedger(path);
  const ledger: CostLedger = { capUsd, spentUsd: 0, entries: [] };
  writeLedger(path, ledger);
  return ledger;
}

/** „Wydane + szacunek > limit → stop”: błąd z liczbami, zanim padnie pierwsze płatne wywołanie. */
export function assertWithinCostCap(ledger: CostLedger, estimateUsd: number, label: string): void {
  if (ledger.spentUsd + estimateUsd > ledger.capUsd + 1e-9) {
    throw new Error(
      `Limit kosztu prób: wydane ${ledger.spentUsd.toFixed(2)} USD + szacunek ${estimateUsd.toFixed(2)} USD (${label}) > limit ${ledger.capUsd.toFixed(2)} USD — próba zatrzymana przed wywołaniem modelu.`,
    );
  }
}

/** Dopisuje wpis do istniejącego rejestru (odczyt → dopisanie → zapis przez plik tymczasowy); `spentUsd` = suma wpisów. */
export function appendCostEntry(path: string, entry: CostEntry): CostLedger {
  const ledger = readCostLedger(path);
  // Zaokrąglenie do mikrodolara: bez ogonów zmiennoprzecinkowych w pliku.
  const entries = [...ledger.entries, { ...entry, costUsd: round6(entry.costUsd) }];
  const next: CostLedger = { capUsd: ledger.capUsd, spentUsd: round6(entries.reduce((sum, item) => sum + item.costUsd, 0)), entries };
  writeLedger(path, next);
  return next;
}

/**
 * Wpis tymczasowy przed płatnym wywołaniem: szacunek (`estimated`, `provisional`) liczy się do
 * wydanych od razu, więc przerwany proces (kill, zawieszenie) nie zaniża rejestru. Zwraca id do
 * `settleCostEntry`.
 */
export function appendProvisionalCostEntry(path: string, entry: Omit<CostEntry, "estimated" | "provisional" | "id">, id: string = randomUUID()): string {
  appendCostEntry(path, { id, ...entry, estimated: true, provisional: true });
  return id;
}

/** Rozliczenie wpisu tymczasowego kosztem po próbie (w tym samym miejscu rejestru); brak wpisu o tym id → dopisanie. */
export function settleCostEntry(path: string, id: string, entry: Omit<CostEntry, "provisional" | "id">): CostLedger {
  const ledger = readCostLedger(path);
  const at = ledger.entries.findIndex((item) => item.id === id);
  if (at === -1) return appendCostEntry(path, { id, ...entry });
  const settled: CostEntry = { id, ...entry, costUsd: round6(entry.costUsd) };
  if (settled.estimated !== true) delete settled.estimated;
  const entries = ledger.entries.map((item, index) => (index === at ? settled : item));
  const next: CostLedger = { capUsd: ledger.capUsd, spentUsd: round6(entries.reduce((sum, item) => sum + item.costUsd, 0)), entries };
  writeLedger(path, next);
  return next;
}

/** Nazwa klasy błędu (bez komunikatu — może zawierać treść pliku albo odpowiedzi). */
export function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name || "Error" : typeof error;
}

/**
 * Host usługi próby (do nagłówka, bez ścieżki i klucza): tylko https; OpenRouter zawsze, inny host
 * tylko gdy `allowHost` (`UMIEM_PROBE_ALLOW_HOST`) wskazuje dokładnie ten host — materiał i zdania
 * nie trafią przez pomyłkę konfiguracji do nieznanej usługi.
 */
export function probeEndpointHost(baseUrl: string | undefined, name: string, allowHost?: string): string {
  let url: URL;
  try {
    url = new URL((baseUrl ?? "").trim());
  } catch {
    throw new Error(`${name}: brak albo nieprawidłowy adres usługi — próba nie wywoła modelu.`);
  }
  if (url.protocol !== "https:") throw new Error(`${name}: próba wymaga https:// (host ${url.host}).`);
  if (isOpenRouterEndpoint(url.href)) return url.host;
  const allowed = allowHost?.trim().toLowerCase();
  if (allowed !== undefined && allowed !== "" && allowed === url.host.toLowerCase()) return url.host;
  throw new Error(`${name}: host ${url.host} nie jest OpenRouter — próba wysyła dane tylko tam; inny host wymaga UMIEM_PROBE_ALLOW_HOST=${url.host}.`);
}

/** SHA-256 pliku wejściowego (do README i results.json zamiast treści). */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
