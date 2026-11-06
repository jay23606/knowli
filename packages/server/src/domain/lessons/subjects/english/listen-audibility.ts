import { clip, type LessonRuleIssue } from "../../rules/catalog";
import type { LessonExerciseDraft } from "../../types";
import { englishIssue } from "./rules";

/**
 * Słyszalność różnicy opcji `lesson_listen_choice` w angielskiej mowie ciągłej
 * (wspólne dla przedmiotów angielskich, wołane z ich `validateExercise`; silnik
 * lekcji tej reguły nie zna). Lektor czyta zdanie z poprawną opcją w luce, więc
 * końcówka -s, która zlewa się z następnym wyrazem, czyni zadanie niesprawiedliwym.
 */

/**
 * Wyraz zaraz za luką (także w cudzysłowie, również gdy cudzysłów zamyka lukę: “___” softly);
 * lukę zamkniętą interpunkcją pauzy (przecinek, kropka) pomija.
 * Regex zakotwiczony na tekście za luką — bez nawrotów po podkreśleniach.
 */
function wordAfterGap(stem: string): string | undefined {
  const gap = /_{2,}/.exec(stem);
  if (!gap) return undefined;
  return /^["'\u2019\u201d]?\s+["'\u2018\u201c\u201e]?([A-Za-z]+)/u.exec(stem.slice(gap.index + gap[0].length))?.[1];
}

/**
 * Wyraz zaczynający się głoską s, z albo sz: snakes, zoo, shoes, miękkie c (city),
 * x jak z (xylophone) i nieme p (psychology). Wiolonczela (/tʃ/) jest wyjątkiem.
 */
function startsWithSibilant(word: string): boolean {
  return /^(?:s|z|c[eiy]|x[a-z]|ps)/i.test(word) && !/^cellos?$/i.test(word);
}

/**
 * Opcje różnią się wyłącznie niesylabiczną końcówką -s (like / likes, go / goes,
 * study / studies, he / he's): przed sybilantem ta końcówka zlewa się w mowie ciągłej
 * („likes snakes” brzmi jak „like snakes”). Sylabiczne -es po sybilancie
 * (watch / watches, dance / dances) i zmiana samogłoski (do / does, say / says)
 * pozostają słyszalne. Apostrof pomijamy, więc skrót 's liczy się jak końcówka.
 * Jednoliterowa podstawa (a / as, I / is) to osobne słowa, nie odmiana.
 */
function differsByMergingS(a: string, b: string): boolean {
  const bare = (text: string) => text.trim().toLowerCase().replace(/['\u2019]/gu, "");
  const [x, y] = [bare(a), bare(b)];
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 2) return false;
  if (long === `${short}s`) return !/[cgsz]e$/.test(short) && !/(?:^|\s)say$/.test(short);
  if (long === `${short}es`) return !/(?:[sxz]|ch|sh)$/.test(short) && !/(?:^|\s)do$/.test(short);
  return short.endsWith("y") && long === `${short.slice(0, -1)}ies`;
}

/**
 * Błędy `lesson_listen_choice`, w którym opcje różnią się końcówką -s, a wyraz za
 * luką zaczyna się sybilantem — różnica byłaby w nagraniu niesłyszalna. Zdanie bez
 * dokładnie jednej luki pomija (zgłasza je ogólna walidacja typu).
 * Zgłoszenie reguły `english.listen_sibilant_merge`: `pl` dla rodzica, `found` po angielsku.
 */
export function listenChoiceSibilantErrors(ex: LessonExerciseDraft): LessonRuleIssue[] {
  const stem = ex.stem ?? "";
  if (ex.exerciseType !== "lesson_listen_choice" || (stem.match(/_{2,}/g) ?? []).length !== 1) return [];
  const nextWord = wordAfterGap(stem);
  if (nextWord === undefined || !startsWithSibilant(nextWord)) return [];
  const options = ex.options ?? [];
  const issues: LessonRuleIssue[] = [];
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      if (differsByMergingS(options[i]!.text, options[j]!.text)) {
        issues.push(englishIssue("english.listen_sibilant_merge", {
          pl: `stem: opcje „${options[i]!.text}” i „${options[j]!.text}” różnią się końcówką -s/-es, która w nagraniu zlewa się z początkiem wyrazu „${nextWord}” (głoska s, z albo sz) — różnica niesłyszalna, zmień wyraz za luką`,
          found: `options ${clip(options[i]!.text)} and ${clip(options[j]!.text)} differ only by the ending -s/-es, which merges into the following word ${clip(nextWord)} (s, z or sh sound) in speech`,
        }));
      }
    }
  }
  return issues;
}
