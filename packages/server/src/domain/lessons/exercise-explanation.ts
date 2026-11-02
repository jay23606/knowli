/**
 * Wyjaśnienie błędu dla dziecka (`explanationPl`, spec 2026-11-01-lesson-error-explanation):
 * jedno zdanie po polsku, które dziecko widzi po błędnej odpowiedzi w treningu. Czysta domena —
 * bez bazy, sieci i zegara.
 */

import { sentenceCount } from "../tts-style";
import { normalizeTargetText } from "../target-key";
import type { SubjectModule } from "./types";

/**
 * Maksymalna długość wyjaśnienia (znaki) — jak pozostałe pola tekstowe ćwiczenia
 * (`MAX_TEXT_LENGTH` w `pool-validation.ts`, tu osobno, by uniknąć cyklu importów).
 */
export const MAX_EXPLANATION_LENGTH = 120;

/**
 * Błędy treści wyjaśnienia (pusta lista = poprawne). Tekst jest zwykły i czytany głosem:
 * po przycięciu niepusty, ≤ 120 znaków, bez łamania wiersza i znaczników `*`/`_`, dokładnie
 * jedno zdanie. Komunikaty (po polsku, dla rodzica) mają prefiks `explanationPl:`.
 */
export function explanationTextErrors(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return ["explanationPl: wyjaśnienie nie może być puste"];
  const errors: string[] = [];
  if ([...trimmed].length > MAX_EXPLANATION_LENGTH) {
    errors.push(`explanationPl: przekracza ${MAX_EXPLANATION_LENGTH} znaków`);
  }
  if (/[\r\n]/u.test(trimmed)) {
    errors.push("explanationPl: wyjaśnienie nie może zawierać łamania wiersza");
  }
  if (/[*_]/u.test(trimmed)) {
    errors.push("explanationPl: zwykły tekst bez znaczników (* i _)");
  }
  if (sentenceCount(trimmed) !== 1) {
    errors.push("explanationPl: wyjaśnienie ma mieć dokładnie jedno zdanie");
  }
  return errors;
}

/** Tekst ekspozycji i klucz `target_key` ćwiczenia, jak w `exposure-key.ts`. */
export interface ExposureTarget {
  readonly exposureText: string;
  readonly targetKey: string;
}

/** Normalizacja przedmiotu (gdy ją ma), potem jak w `computeTargetKey`: NFC, przycięcie, małe litery. */
function normalizedExposure(
  subject: Pick<SubjectModule, "normalizeExposureText">,
  text: string,
): string {
  return normalizeTargetText(subject.normalizeExposureText?.(text) ?? text);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Tekst na granicach słów: litera lub cyfra tuż obok wyklucza trafienie. */
function wordBounded(text: string, flags: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(text)}(?![\\p{L}\\p{N}])`, flags);
}

/**
 * Jednowyrazowe cele, które są też zwykłymi polskimi słowami (spójniki, przyimki, zaimki):
 * „I”, „a”, „do”, „to”, „on”, „no”, „we”, „go”… Polskie wyjaśnienie zawiera je niemal zawsze,
 * a ekspozycja cytatu jest trwała jak każda inna, więc dopasowanie oznaczałoby te cele jako
 * ujawnione na zawsze. Takie cele pomijamy (spec §4.4) — świadome ryzyko: wyjaśnienie, które
 * naprawdę cytuje „do” innego ćwiczenia, nie zapisze ekspozycji.
 */
const POLISH_HOMOGRAPHS: ReadonlySet<string> = new Set([
  "a", "i", "o", "u", "w", "z", "do", "to", "on", "no", "na", "my", "we", "go", "ja", "ze", "po", "od",
]);

/** Cel jednowyrazowy z `POLISH_HOMOGRAPHS` (po normalizacji ekspozycji). */
function isPolishHomograph(normalized: string): boolean {
  return !/\s/u.test(normalized) && POLISH_HOMOGRAPHS.has(normalized);
}

/** Cel przygotowany do dopasowań: znormalizowany tekst i jego wyrażenie (budowane raz). */
interface PreparedTarget {
  readonly targetKey: string;
  readonly text: string;
  readonly pattern: RegExp | null;
}

function prepareTarget(target: ExposureTarget, subject: Pick<SubjectModule, "normalizeExposureText">): PreparedTarget {
  const text = normalizedExposure(subject, target.exposureText);
  const matchable = text !== "" && !isPolishHomograph(text);
  return { targetKey: target.targetKey, text, pattern: matchable ? wordBounded(text, "u") : null };
}

function quotedKeys(
  explanation: string,
  own: PreparedTarget,
  others: readonly PreparedTarget[],
  subject: Pick<SubjectModule, "normalizeExposureText">,
): string[] {
  const quoted = normalizedExposure(subject, explanation);
  const ownText = own.text;
  const remaining = ownText === "" ? quoted : quoted.replace(wordBounded(ownText, "gu"), " ");
  const keys: string[] = [];
  for (const other of others) {
    if (other.pattern === null) continue;
    if (other.targetKey === own.targetKey || keys.includes(other.targetKey)) continue;
    // Dłuższy cel zawierający własny tekst sprawdzamy w pełnym wyjaśnieniu: po usunięciu
    // własnego tekstu jego cytat zostałby okaleczony i ujawnienie umknęłoby ekspozycji.
    const haystack = ownText !== "" && other.text.includes(ownText) ? quoted : remaining;
    if (other.pattern.test(haystack)) keys.push(other.targetKey);
  }
  return keys;
}

/**
 * Klucze `target_key` innych ćwiczeń tej samej wersji lekcji, których tekst ekspozycji
 * występuje w wyjaśnieniu (spec §4.4): wyjaśnienie, które cytuje cudzą odpowiedź, ujawnia ją
 * dziecku, więc musi zostać zapisane jako ekspozycja. Obie strony przechodzą normalizację
 * ekspozycji przedmiotu i `normalizeTargetText`; z wyjaśnienia usuwamy wcześniej własny tekst
 * ćwiczenia (jego ujawnia sam feedback; cel zawierający własny tekst jest szukany w pełnym
 * wyjaśnieniu), a dopasowanie wymaga granic słów. Własny klucz i jednowyrazowe cele będące
 * polskimi słowami (`POLISH_HOMOGRAPHS`) są pomijane. Wynik bez duplikatów, w kolejności
 * `others`. Fałszywe trafienie kosztuje najwyżej dodatkową (trwałą) ekspozycję — nic nie jest
 * blokowane.
 */
export function explanationExposureKeys(
  explanation: string,
  own: ExposureTarget,
  others: readonly ExposureTarget[],
  subject: Pick<SubjectModule, "normalizeExposureText">,
): string[] {
  return quotedKeys(
    explanation,
    prepareTarget(own, subject),
    others.map((other) => prepareTarget(other, subject)),
    subject,
  );
}

/**
 * Jak `explanationExposureKeys` dla wszystkich ćwiczeń wersji naraz: każdy cel jest
 * normalizowany, a jego wyrażenie budowane raz na wywołanie (nie raz na parę ćwiczeń).
 * Zwraca klucze dla pozycji `index` (inne ćwiczenia = wszystkie pozostałe pozycje).
 */
export function explanationExposureKeyFinder(
  targets: readonly ExposureTarget[],
  subject: Pick<SubjectModule, "normalizeExposureText">,
): (explanation: string, index: number) => string[] {
  const prepared = targets.map((target) => prepareTarget(target, subject));
  return (explanation, index) =>
    quotedKeys(explanation, prepared[index]!, prepared.filter((_, other) => other !== index), subject);
}
