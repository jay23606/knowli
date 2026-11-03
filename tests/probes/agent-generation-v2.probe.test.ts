import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateText, isStepCount, jsonSchema, Output, tool, ToolLoopAgent, type LanguageModel } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { englishChapterSubject } from "../../packages/server/src/domain/lessons/subjects/english-chapter/module";
import { englishGrammarSubject } from "../../packages/server/src/domain/lessons/subjects/english-grammar/module";
import { schoolSubject } from "../../packages/server/src/domain/lessons/subjects/school/module";
import { materializeGeneratedCalculations } from "../../packages/server/src/providers/lesson-calculations";
import { materializeGeneratedKeywords } from "../../packages/server/src/providers/lesson-keywords";
import { findExposureLeaks } from "../../packages/server/src/domain/lessons/exposure-leaks";
import { exerciseExposureText } from "../../packages/server/src/domain/lessons/exposure-key";
import {
  answersEquivalent,
  groupAnswer,
  matchAnswer,
  validateLessonExercise,
  validatePool,
} from "../../packages/server/src/domain/lessons/pool-validation";
import { outsideStagePath, stageOf } from "../../packages/server/src/domain/lessons/stages";
import type {
  DynamicTopicData,
  LessonExerciseDraft,
  LessonExerciseType,
  LessonTopic,
  SubjectModule,
} from "../../packages/server/src/domain/lessons/types";
import { avoidSentencesFor } from "../../packages/server/src/domain/lessons/avoid-sentences";
import { buildPoolInput, isWellShapedRawExercise, toExerciseDraft } from "../../packages/server/src/modules/materials/lessons/lesson-drafts";
import { lessonPoolJsonSchema } from "../../packages/server/src/providers/openai/lesson-pool-schema";
import { lessonSystemPrompt, lessonUserMaterial } from "../../packages/server/src/providers/openai/llm";
import { materializeGeneratedAssignments } from "../../packages/server/src/providers/lesson-assignments";
import { loadDotEnv, resolveOutsideRepoPath } from "./probe-helpers";

/**
 * Tryb promptu podagentów zagadnień (`UMIEM_PROBE_AGENT_PROMPT`):
 * `probe` — reguły przedmiotu + własny, uproszczony schemat narzędzia;
 * `production` — DOKŁADNIE prompt systemowy, schemat ćwiczeń i parser
 * produkcyjnego generatora (`lessonSystemPrompt`, `lessonPoolJsonSchema`,
 * `toExerciseDraft`), z dopisanym przepływem narzędzi.
 */
type PromptMode = "probe" | "production";
const PROMPT_MODE: PromptMode =
  process.env.UMIEM_PROBE_AGENT_PROMPT === "production" || !["", "chapter", undefined].includes(process.env.UMIEM_PROBE_AGENT_SUBJECT) ? "production" : "probe";
const POOL_COUNT_PER_OBJECTIVE = 10;

/**
 * PoC v2 (2026-11-03): mikro-agent `english_chapter` po wnioskach z v1
 * (`agent-generation.probe.test.ts`: 86 kroków po jednym ćwiczeniu, zgubione
 * słowa materiału, ujawnienia między ćwiczeniami, monotonia typów).
 *
 * 1. Planer (krótka pętla) proponuje zagadnienia; `propose_objectives`
 *    odrzuca plan, w którym słowo albo rama materiału nie trafia na żadną kartę.
 * 2. Podagenci per zagadnienie biegną RÓWNOLEGLE, każdy z małym kontekstem.
 *    `submit_exercises` przyjmuje PACZKĘ; kod sam wykonuje wszystkie kontrole
 *    (słownik, reguły przedmiotu i puli, ujawnienia wobec przykładów i wszystkich
 *    ćwiczeń lekcji, ślepe rozwiązanie innym modelem — równolegle) i zwraca
 *    braki zagadnienia (minima etapów, wymagane typy, niepokryte słowa).
 *    Pętla kończy się sama, gdy zagadnienie jest kompletne.
 * 3. Końcowa kontrola ujawnień na całej lekcji; ofiary wracają do swoich
 *    podagentów (najwyżej 2 rundy).
 *
 * Płatne wywołania, bez bazy (`pnpm probe:agent`). Pomijana bez `UMIEM_PROBE_AGENT_MATERIAL`
 * (rozdział) i bez `UMIEM_PROBE_AGENT_OBJECTIVES_DUMP` (gramatyka, szkoła). Zmienne:
 * - `UMIEM_PROBE_AGENT_SUBJECT` — `chapter` (domyślnie), `grammar`, `school`;
 * - `UMIEM_PROBE_AGENT_PROMPT=production` — prompt, schemat i parser generatora produkcyjnego
 *   (zawsze dla gramatyki i szkoły; tryb `probe` to uproszczony prompt z pierwszych prób);
 * - `UMIEM_PROBE_AGENT_OBJECTIVES_DUMP` — zrzut zwykłego generowania (`probe:chapter` +
 *   `UMIEM_PROBE_REVIEW_DUMP_OUT`): zagadnienia, karty, przykłady i materiał;
 * - `UMIEM_PROBE_AGENT_MODEL` (DeepSeek V4.1 Flash), `UMIEM_PROBE_AGENT_REASONING` (low),
 *   `UMIEM_PROBE_AGENT_SOLVER_MODEL` (inna rodzina niż generator), `UMIEM_PROBE_AGENT_TOPIC`,
 *   `UMIEM_PROBE_AGENT_DUMP` (JSON poza repozytorium), `UMIEM_PROBE_AGENT_TIMEOUT_MS`.
 * Ślepa ocena: `tests/probes/blind/gen-blind-sheet.cjs` (arkusz bez źródeł) i `score.cjs` (wady per źródło).
 */

const materialPath = process.env.UMIEM_PROBE_AGENT_MATERIAL;
/**
 * Przedmiot (`UMIEM_PROBE_AGENT_SUBJECT`): `chapter` (planer + bramki rozdziału), `grammar`
 * albo `school`. Dla gramatyki i szkoły zagadnienia, karty, przykłady i materiał pochodzą ze
 * zrzutu zwykłego generowania (`UMIEM_PROBE_AGENT_OBJECTIVES_DUMP`) — porównanie dotyczy
 * samego pisania ćwiczeń; zawsze prompt produkcyjny.
 */
const SUBJECT_KIND = (["grammar", "school"].includes(process.env.UMIEM_PROBE_AGENT_SUBJECT ?? "") ? process.env.UMIEM_PROBE_AGENT_SUBJECT : "chapter") as
  | "chapter"
  | "grammar"
  | "school";
const IS_CHAPTER = SUBJECT_KIND === "chapter";
const SUBJECT: SubjectModule = SUBJECT_KIND === "grammar" ? englishGrammarSubject : SUBJECT_KIND === "school" ? schoolSubject : englishChapterSubject;
const objectivesDumpPath = process.env.UMIEM_PROBE_AGENT_OBJECTIVES_DUMP;
const EXERCISE_TYPES = [
  "lesson_match",
  "lesson_group",
  "lesson_cloze",
  "lesson_choice",
  "lesson_listen_choice",
  "lesson_order",
  "lesson_gap",
  "lesson_open_answer",
] as const;
/** Typy rozwiązywane na ślepo: zamknięte i krótkie; otwarte odpowiedzi szkoły wymagają oceniającego, więc ich nie ma. */
const BLIND_TYPES: ReadonlySet<string> = new Set(
  SUBJECT_KIND === "school"
    ? ["lesson_choice", "lesson_match", "lesson_group", "lesson_cloze"]
    : ["lesson_choice", "lesson_gap", "lesson_cloze", "lesson_open_answer", "lesson_order", "lesson_match", "lesson_group", "lesson_error_fix", "lesson_transform"],
);
/** Typy, których warianty odpowiedzi sprawdza niezależny model (furtka: dopisanie odpowiedzi rozwiązującego). */
const VARIANT_CHECK_TYPES: ReadonlySet<string> = new Set(SUBJECT_KIND === "school" ? [] : ["lesson_open_answer", "lesson_transform", "lesson_error_fix", "lesson_gap"]);
/** Cele per zagadnienie: minima przedmiotu, samodzielne +1 na zapas pod końcową kontrolę ujawnień. */
const MINIMUMS = SUBJECT.poolMinimums ?? { guided: 3, productive: 3, independent: 2 };
const TARGETS = { guided: MINIMUMS.guided, productive: MINIMUMS.productive, independent: MINIMUMS.independent + 1 } as const;
const MAX_PER_OBJECTIVE = 14;
/** Wymagane typy per rodzaj zagadnienia: przeciw szablonowaniu i dla słuchania. */
const REQUIRED_TYPES: Record<"words" | "frame", readonly (readonly LessonExerciseType[])[]> = {
  words: [["lesson_match"], ["lesson_listen_choice"], ["lesson_cloze", "lesson_group"]],
  frame: [["lesson_order"], ["lesson_listen_choice"], ["lesson_cloze"]],
};

type Kind = "words" | "frame";
interface ObjectivePlan {
  id: string;
  slug: string;
  titlePl: string;
  descriptionEn: string;
  /** Tylko rozdział; gramatyka i szkoła nie dzielą zagadnień na rodzaje. */
  kind?: Kind;
  cards: { title: string; body: string }[];
  examples: string[];
}
interface PoolEntry {
  id: string;
  draft: LessonExerciseDraft;
}

export class LessonState {
  topic: LessonTopic | undefined;
  objectives: ObjectivePlan[] = [];
  pools = new Map<string, PoolEntry[]>();
  nextId = 1;
  costUsd = 0;
  stats = {
    submitted: 0,
    rejectedDeterministic: 0,
    rejectedLeak: 0,
    blindChecks: 0,
    blindMismatches: 0,
    variantChecks: 0,
    variantRejections: 0,
    accepted: 0,
    removed: 0,
  };
  agentSteps: Record<string, number> = {};
  /** Każde odrzucenie z powodem — do analizy, które reguły są niejasne. */
  rejections: { objective: string; exerciseType: string; kind: "shape" | "deterministic" | "leak" | "blind" | "variant" | "limit"; reason: string }[] = [];

  /** Lekcja w kolejności zagadnień, w zagadnieniu po etapach (jak w lekcji). */
  ordered(): PoolEntry[] {
    const rank = { intro: 0, guided: 1, productive: 2, independent: 3 } as const;
    return this.objectives.flatMap((objective) =>
      [...(this.pools.get(objective.id) ?? [])].sort((a, b) => rank[stageOf(a.draft.exerciseType)] - rank[stageOf(b.draft.exerciseType)]),
    );
  }
  /** Źródła ujawnień: pole examples i angielskie ZDANIA wpisane w treść kart (dziecko widzi je na karcie). */
  examples(): Record<string, string[]> {
    return Object.fromEntries(this.objectives.map((objective) => [objective.id, [...objective.examples, ...cardSentences(objective.cards)]]));
  }
}

/**
 * Angielskie zdania z kart: części linii (rozdzielone „ — ” albo „ / ”) z samych liter ASCII i
 * interpunkcji, zakończone . ? ! albo mające co najmniej 3 słowa, bez wielokropka ramy. Linia
 * słówek („living room — salon”) nie jest zdaniem — tłumaczenie słowa z karty słówek to nauka, nie ujawnienie.
 */
export function cardSentences(cards: readonly { body: string }[]): string[] {
  const sentences: string[] = [];
  for (const card of cards) {
    for (const rawLine of card.body.split(/\r?\n/u)) {
      for (const part of rawLine.split(/\s+[—/]\s+/u)) {
        const text = part.trim().replace(/[’‘]/gu, "'");
        if (text === "" || /…|\.\.\./u.test(text) || !/^[A-Za-z][A-Za-z' ,.?!]*$/u.test(text)) continue;
        if (/[.?!]$/u.test(text) || text.split(/\s+/u).length >= 3) sentences.push(text);
      }
    }
  }
  return [...new Set(sentences)];
}

function line(text = ""): void {
  console.log(text);
}

const slugOf = (id: string): string => id.split(".").at(-1) ?? id;

function costOf(meta: unknown): number {
  const cost = (meta as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  return typeof cost === "number" ? cost : 0;
}

// ---------- materiał: słowa i ramy ----------

interface MaterialLexicon {
  words: string[];
  frames: string[];
}

/** Słowa z linii „en — pl” (bez pytań i zdań) i ramy z sekcji zwrotów. */
export function parseMaterial(material: string): MaterialLexicon {
  const words: string[] = [];
  const frames: string[] = [];
  let section = "";
  for (const raw of material.split(/\r?\n/u)) {
    const text = raw.trim();
    if (text === "") continue;
    if (text.endsWith(":") && !text.includes(" — ")) {
      section = text.toLowerCase();
      continue;
    }
    if (/zwroty|ramy/u.test(section)) {
      frames.push(text);
      continue;
    }
    const pair = /^(.+?)\s+—\s+(.+)$/u.exec(text);
    if (pair && !/[?.!]/u.test(pair[1]!) && pair[1]!.split(/\s+/u).length <= 3) words.push(pair[1]!.trim());
  }
  return { words, frames };
}

/** Tekst do porównań ram: małe litery, bez interpunkcji i podwójnych spacji. */
export function plainText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/gu, "'")
    .replace(/[?.!,;:"“”„]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Stała część ramy do wyszukania: najdłuższy fragment bez wielokropka. */
export function frameKey(frame: string): string {
  return frame
    .split(/…|\.\.\./u)
    .map(plainText)
    .sort((a, b) => b.length - a.length)[0]!;
}

export function mentions(haystack: string, word: string): boolean {
  const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}(s|es)?([^a-z]|$)`, "u").test(haystack.toLowerCase().replace(/[’‘]/gu, "'"));
}

function exerciseText(draft: LessonExerciseDraft): string {
  return [
    draft.stem,
    draft.answer,
    ...draft.acceptedAnswers,
    ...(draft.options ?? []).map((option) => option.text),
    ...(draft.items ?? []).map((item) => item.text),
    ...(draft.pairs ?? []).map((pair) => pair.left),
    ...(draft.groupItems ?? []).map((item) => item.text),
    draft.clozeText,
    ...(draft.gapAnswers ?? []),
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" \n ");
}

// ---------- ćwiczenia ----------

const exerciseInputSchema = z.object({
  exerciseType: z.enum(EXERCISE_TYPES),
  instructionPl: z.string().optional(),
  stem: z.string().optional(),
  prompt: z.string().optional().describe("Polish sentence to translate (lesson_open_answer)"),
  answer: z.string().optional().describe("canonical answer; omit for lesson_match/lesson_group/lesson_cloze/choice types (derived)"),
  acceptedAnswers: z.array(z.string()).optional(),
  focus: z.array(z.string()).optional(),
  options: z.array(z.string()).optional().describe("option texts for lesson_choice/lesson_listen_choice"),
  correctOptionText: z.string().optional().describe("exact text of the correct option"),
  items: z.array(z.string()).optional().describe("word blocks in correct order (lesson_order)"),
  pairs: z.array(z.object({ left: z.string(), right: z.string() })).optional(),
  extraRight: z.array(z.string()).optional(),
  groups: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  groupItems: z.array(z.object({ text: z.string(), groupId: z.string() })).optional(),
  clozeText: z.string().optional(),
  gapAnswers: z.array(z.string()).optional(),
  extraWords: z.array(z.string()).optional(),
  explanationPl: z.string().optional(),
});
type ExerciseInput = z.infer<typeof exerciseInputSchema>;

function toDraft(input: ExerciseInput, objectiveId: string): { draft?: LessonExerciseDraft; error?: string } {
  const options = input.options?.map((text, i) => ({ id: `o${i + 1}`, text }));
  let correctOption: string | undefined;
  if (input.exerciseType === "lesson_choice" || input.exerciseType === "lesson_listen_choice") {
    correctOption = options?.find((option) => option.text === input.correctOptionText)?.id;
    if (!correctOption) return { error: "correctOptionText must be exactly one of options" };
  }
  const items = input.items?.map((text, i) => ({ id: `i${i + 1}`, text }));
  const answer =
    input.exerciseType === "lesson_match"
      ? matchAnswer({ pairs: input.pairs })
      : input.exerciseType === "lesson_group"
        ? groupAnswer({ groups: input.groups })
        : input.exerciseType === "lesson_cloze"
          ? (input.gapAnswers ?? []).join(", ")
          : input.exerciseType === "lesson_choice" || input.exerciseType === "lesson_listen_choice"
            ? (input.correctOptionText ?? "")
            : input.exerciseType === "lesson_order" && !input.answer
              ? (input.items ?? []).join(" ")
              : (input.answer ?? "");
  const draft: LessonExerciseDraft = {
    exerciseType: input.exerciseType,
    objectiveId,
    ...(input.instructionPl ? { instructionPl: input.instructionPl } : {}),
    ...(input.stem ? { stem: input.stem } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    answer,
    acceptedAnswers: input.acceptedAnswers ?? [],
    focus: input.focus ?? [],
    ...(options ? { options } : {}),
    ...(correctOption ? { correctOption } : {}),
    ...(items ? { items } : {}),
    ...(input.pairs ? { pairs: input.pairs } : {}),
    ...(input.extraRight ? { extraRight: input.extraRight } : {}),
    ...(input.groups ? { groups: input.groups } : {}),
    ...(input.groupItems ? { groupItems: input.groupItems } : {}),
    ...(input.clozeText ? { clozeText: input.clozeText } : {}),
    ...(input.gapAnswers ? { gapAnswers: input.gapAnswers } : {}),
    ...(input.extraWords ? { extraWords: input.extraWords } : {}),
    ...(input.explanationPl ? { explanationPl: input.explanationPl } : {}),
  };
  return { draft };
}

/** Kontrole deterministyczne jednego ćwiczenia wobec puli zagadnienia. */
function deterministicErrors(
  state: LessonState,
  objective: ObjectivePlan,
  draft: LessonExerciseDraft,
  material: string,
  lexicon: MaterialLexicon,
): { draft?: LessonExerciseDraft; errors: string[] } {
  // Ta sama kolejność co w produkcji: hak przedmiotu, walidacja ćwiczenia, puli i puli z materiałem.
  const refined = SUBJECT.refineGeneratedPool?.([draft], { material }) ?? { kept: [draft], rejected: [] };
  if (refined.rejected.length > 0) return { errors: refined.rejected.map((entry) => entry.reason) };
  const kept = refined.kept[0]!;
  const errors = validateLessonExercise(kept, SUBJECT, state.topic!);
  if (errors.length > 0) return { errors };
  const own = (state.pools.get(objective.id) ?? []).map((entry) => entry.draft);
  const pooled = validatePool([...own, kept], SUBJECT, state.topic!);
  if (pooled.valid.length !== own.length + 1) {
    const mine = pooled.rejected.find((entry) => entry.exercise === kept);
    return { errors: mine?.errors ?? ["rejected by pool validation (duplicate or cross-exercise rule)"] };
  }
  const extra = SUBJECT.validatePoolExtra?.([...own, kept], { material }).get(own.length);
  if (extra && extra.length > 0) return { errors: [...extra] };
  const offCard = cardWordErrors(objective, kept, lexicon);
  if (offCard.length > 0) return { errors: offCard };
  return { draft: kept, errors: [] };
}

/**
 * Zagadnienie słówek rozdziału: ćwiczenie sprawdza słowo z KART tego zagadnienia
 * (powtarzająca się wada: luka na „live” zamiast na „treehouse”). Pary i grupy — co najmniej dwa słowa kart.
 */
function cardWordErrors(objective: ObjectivePlan, draft: LessonExerciseDraft, lexicon: MaterialLexicon): string[] {
  if (!IS_CHAPTER || objective.kind !== "words") return [];
  const cardWords = lexicon.words.filter((word) => objective.cards.some((card) => mentions(card.body, word)));
  if (cardWords.length === 0) return [];
  const checked: string[] =
    draft.exerciseType === "lesson_match"
      ? (draft.pairs ?? []).map((pair) => pair.left)
      : draft.exerciseType === "lesson_group"
        ? (draft.groupItems ?? []).map((item) => item.text)
        : draft.exerciseType === "lesson_cloze"
          ? [...(draft.gapAnswers ?? [])]
          : [draft.answer];
  const hits = cardWords.filter((word) => checked.some((text) => mentions(text, word))).length;
  const needed = draft.exerciseType === "lesson_match" || draft.exerciseType === "lesson_group" ? 2 : 1;
  return hits >= needed
    ? []
    : [`the checked ${draft.exerciseType === "lesson_cloze" ? "gap words" : draft.exerciseType === "lesson_match" || draft.exerciseType === "lesson_group" ? "items" : "answer"} must contain a word of THIS objective's cards (${cardWords.join(", ")}); other words may only fill the sentence.`];
}

/** Ujawnienia twarde po wstawieniu kandydata: ofiarą jest on sam albo ćwiczenie już przyjęte. */
function leakErrors(state: LessonState, objectiveId: string, candidate: LessonExerciseDraft): string[] {
  const entries = state.ordered();
  const lastOwn = entries.map((entry) => entry.draft.objectiveId).lastIndexOf(objectiveId);
  const insertAt = lastOwn === -1 ? objectiveInsertIndex(state, objectiveId, entries) : lastOwn + 1;
  const drafts = entries.map((entry) => entry.draft);
  drafts.splice(insertAt, 0, candidate);
  const leaks = findExposureLeaks({
    exercises: drafts,
    examples: state.examples(),
    objectiveOrder: state.objectives.map((objective) => objective.id),
    subject: SUBJECT,
    mode: "generation",
  }).filter((leak) => leak.kind === "hard");
  const before = new Set(
    findExposureLeaks({
      exercises: entries.map((entry) => entry.draft),
      examples: state.examples(),
      objectiveOrder: state.objectives.map((objective) => objective.id),
      subject: SUBJECT,
      mode: "generation",
    })
      .filter((leak) => leak.kind === "hard")
      .map((leak) => entries[leak.index]!.id),
  );
  const errors: string[] = [];
  for (const leak of leaks) {
    const sourceText =
      leak.source.kind === "card_example" ? `the card example "${leak.source.text}"` : `exercise "${exerciseExposureText(SUBJECT, drafts[leak.source.index]!)}"`;
    if (leak.index === insertAt) {
      errors.push(
        `answer leak (K5): the child already sees this answer in ${sourceText}. An independent answer must be a NEW sentence nobody showed before — change the room, object or place.`,
      );
    } else {
      const victimIndex = leak.index > insertAt ? leak.index - 1 : leak.index;
      const victim = entries[victimIndex]!;
      if (!before.has(victim.id) && leak.source.kind === "exercise" && leak.source.index === insertAt) {
        errors.push(`this exercise would reveal the answer of independent exercise ${victim.id} ("${victim.draft.answer}"); use a different sentence.`);
      }
    }
  }
  return errors;
}

function objectiveInsertIndex(state: LessonState, objectiveId: string, entries: PoolEntry[]): number {
  const order = state.objectives.map((objective) => objective.id);
  const mine = order.indexOf(objectiveId);
  const index = entries.findIndex((entry) => order.indexOf(entry.draft.objectiveId) > mine);
  return index === -1 ? entries.length : index;
}

/** Widok dziecka do ślepego rozwiązania: bez klucza, focus i wyjaśnienia. */
export function childView(draft: LessonExerciseDraft): string {
  const parts: string[] = [];
  if (draft.instructionPl) parts.push(draft.instructionPl);
  if (draft.prompt) parts.push(draft.prompt);
  if (draft.stem) parts.push(draft.stem);
  if (draft.clozeText) parts.push(draft.clozeText);
  if (draft.options?.length) parts.push(`Options: ${draft.options.map((option) => option.text).join(" | ")}`);
  if (draft.exerciseType === "lesson_order") parts.push(`Word blocks (shuffled): ${[...(draft.items ?? [])].map((item) => item.text).sort().join(" | ")}`);
  if (draft.exerciseType === "lesson_cloze") {
    const bank = [...(draft.gapAnswers ?? []), ...(draft.extraWords ?? [])].sort();
    parts.push(`Word bank: ${bank.join(", ")}`);
  }
  const statement = (draft as { statement?: string }).statement;
  if (statement) parts.push(statement);
  if (draft.exerciseType === "lesson_match") {
    parts.push(`Left (in this order): ${(draft.pairs ?? []).map((pair) => pair.left).join(" | ")}`);
    parts.push(`Right (shuffled): ${[...(draft.pairs ?? []).map((pair) => pair.right), ...(draft.extraRight ?? [])].sort().join(" | ")}`);
  }
  if (draft.exerciseType === "lesson_group") {
    parts.push(`Groups: ${(draft.groups ?? []).map((group) => group.label).join(" | ")}`);
    parts.push(`Items (in this order): ${(draft.groupItems ?? []).map((item) => item.text).join(" | ")}`);
  }
  return parts.join("\n");
}

/** Liczba odpowiedzi rozwiązującego: luki cloze, lewe strony par, elementy grup, inaczej jedna. */
function expectedAnswerCount(draft: LessonExerciseDraft): number {
  if (draft.exerciseType === "lesson_cloze") return draft.gapAnswers?.length ?? 1;
  if (draft.exerciseType === "lesson_match") return draft.pairs?.length ?? 1;
  if (draft.exerciseType === "lesson_group") return draft.groupItems?.length ?? 1;
  return 1;
}

const plainKey = (text: string): string => text.trim().toLowerCase().replace(/[’‘]/gu, "'").replace(/\s+/gu, " ");

export function blindMatches(draft: LessonExerciseDraft, solved: string[]): boolean {
  if (draft.exerciseType === "lesson_cloze") {
    const expected = draft.gapAnswers ?? [];
    return solved.length === expected.length && expected.every((answer, i) => answersEquivalent(solved[i] ?? "", answer, SUBJECT.normalizer));
  }
  if (draft.exerciseType === "lesson_match" || draft.exerciseType === "lesson_group") {
    // Rozwiązujący zwraca „lewa => prawa” / „element => grupa” w podanej kolejności.
    const expected =
      draft.exerciseType === "lesson_match"
        ? (draft.pairs ?? []).map((pair) => pair.right)
        : (draft.groupItems ?? []).map((item) => draft.groups?.find((group) => group.id === item.groupId)?.label ?? "");
    return (
      solved.length === expected.length &&
      expected.every((right, i) => plainKey(solved[i]?.split("=>").at(-1) ?? "") === plainKey(right))
    );
  }
  return [draft.answer, ...draft.acceptedAnswers].some((candidate) => answersEquivalent(solved[0] ?? "", candidate, SUBJECT.normalizer));
}

// ---------- braki zagadnienia ----------

function objectiveStatus(state: LessonState, objective: ObjectivePlan, lexicon: MaterialLexicon) {
  const pool = state.pools.get(objective.id) ?? [];
  const counts = { guided: 0, productive: 0, independent: 0, listening: 0, total: pool.length };
  for (const { draft } of pool) {
    if (outsideStagePath(draft.exerciseType)) counts.listening += 1;
    else {
      const stage = stageOf(draft.exerciseType);
      if (stage === "guided" || stage === "productive" || stage === "independent") counts[stage] += 1;
    }
  }
  const missing: string[] = [];
  for (const stage of ["guided", "productive", "independent"] as const) {
    if (counts[stage] < TARGETS[stage]) missing.push(`${stage}: ${counts[stage]} of ${TARGETS[stage]}`);
  }
  const types = new Set(pool.map((entry) => entry.draft.exerciseType));
  for (const alternatives of IS_CHAPTER && objective.kind ? REQUIRED_TYPES[objective.kind] : []) {
    if (!alternatives.some((type) => types.has(type))) missing.push(`needs at least one ${alternatives.join(" or ")}`);
  }
  // Słowa zagadnienia „words”: każde słowo z jego kart musi wystąpić w którymś ćwiczeniu.
  const uncoveredWords =
    IS_CHAPTER && objective.kind === "words"
      ? lexicon.words.filter(
          (word) => objective.cards.some((card) => mentions(card.body, word)) && !pool.some((entry) => mentions(exerciseText(entry.draft), word)),
        )
      : [];
  if (uncoveredWords.length > 0) missing.push(`card words not used in any exercise yet: ${uncoveredWords.join(", ")}`);
  return { counts, missing, complete: missing.length === 0 };
}

// ---------- prompty ----------

function rulesBlock(): string {
  const prompts = SUBJECT.prompts;
  return [
    prompts.generationRole,
    prompts.fieldRules ?? "",
    ...Object.entries(prompts.typeRules ?? {}).map(([type, rules]) => `${type}: ${rules}`),
    "Answer conventions: lesson_choice/listen_choice: options + correctOptionText. lesson_order: items in correct order (4-7, no final punctuation). " +
      "lesson_match: pairs (left English, right Polish) + extraRight. lesson_group: groups + groupItems. lesson_cloze: clozeText + gapAnswers + extraWords. " +
      "explanationPl: one true Polish sentence with Polish diacritics (ą, ę, ł, ó, ś, ż, ź, ć, ń), about the checked word or rule; when it quotes a translation, the English word comes first: „spider” to „pająk”.",
  ].join("\n\n");
}

function plannerInstructions(lexicon: MaterialLexicon): string {
  return [
    SUBJECT.prompts.generationRole,
    SUBJECT.prompts.objectivesRules ?? "",
    "Plan the lesson by calling propose_objectives once. Every English word of the material word lists and every sentence frame must appear on the cards of some objective " +
      "(words on 'words' cards as 'English — Polish' lines; frames on 'frame' cards). A story section becomes its own objective. Up to 6 objectives are allowed when the material needs them. " +
      "examples: 1-3 short English example sentences from the material per objective, shown to the child on the card. If the tool reports uncovered words or frames, call it again with a fixed plan.",
    `Material words (${lexicon.words.length}): ${lexicon.words.join(", ")}`,
    `Material frames (${lexicon.frames.length}): ${lexicon.frames.join(" | ")}`,
  ].join("\n\n");
}

/** Wejście produkcyjnego generatora dla jednego zagadnienia (te same pola co w `executeLessonGeneration`). */
export function productionPoolInput(state: LessonState, objective: ObjectivePlan, material: string) {
  const others = state.ordered().filter((entry) => entry.draft.objectiveId !== objective.id).map((entry) => entry.draft);
  const avoidSentences = avoidSentencesFor({ examples: state.examples(), exercises: others, subject: SUBJECT });
  return buildPoolInput(SUBJECT, state.topic!, objective.id, POOL_COUNT_PER_OBJECTIVE, material, undefined, true, [], [], undefined, { avoidSentences });
}

function objectiveInstructions(state: LessonState, objective: ObjectivePlan, rules: string): string {
  const topicObjective = state.topic!.objectives.find((item) => item.id === objective.id)!;
  const others = state.objectives
    .filter((item) => item.id !== objective.id)
    .map((item) => `- ${item.titlePl}${item.kind ? ` (${item.kind})` : ""}: ${item.cards.map((card) => card.body.replace(/\n/gu, " / ")).join(" / ").slice(0, 400)}`)
    .join("\n");
  const required = IS_CHAPTER && objective.kind ? REQUIRED_TYPES[objective.kind].map((alternatives) => alternatives.join(" or ")).join("; ") : "none";
  return [
    rules,
    ...(PROMPT_MODE === "production"
      ? [
          "TOOL MODE: ignore the instruction above to answer with JSON text. Deliver exercises ONLY by calling submit_exercises, whose argument is the exercises array " +
            "of exactly that JSON shape (same fields, same nulls, objectiveId as above); card examples are not needed.",
        ]
      : []),
    "YOUR JOB: write the exercises of ONE objective of the lesson and nothing else.",
    `Objective: ${objective.titlePl}${objective.kind ? ` (kind: ${objective.kind})` : ""} — ${objective.descriptionEn}`,
    `Cards:\n${objective.cards.map((card) => `[${card.title}] ${card.body}`).join("\n")}`,
    `Card examples and card sentences (the child sees them; never use them as independent answers): ${state.examples()[objective.id]!.join(" | ") || "none"}`,
    `Other objectives of the lesson (do not test them):\n${others}`,
    `Allowed types: ${topicObjective.exerciseTypes.filter((type) => type !== "lesson_card").join(", ")}. ` +
      "Stages: guided = lesson_match, lesson_group, lesson_cloze, lesson_choice, lesson_order, lesson_short_answer; productive = lesson_gap, lesson_error_fix, lesson_transform; " +
      "independent = lesson_open_answer, lesson_calculation; lesson_listen_choice and lesson_keywords are outside stages.",
    `Target: guided >= ${TARGETS.guided}, productive >= ${TARGETS.productive}, independent >= ${TARGETS.independent}, required types: ${required}; at most ${MAX_PER_OBJECTIVE} exercises. ` +
      (IS_CHAPTER && objective.kind === "words"
        ? "Every checked answer (gap, option, translation, cloze gap, pair or group item) must contain a word of THIS objective's cards, and every card word must be used in some exercise. "
        : "") +
      "Vary sentences: never two exercises with the same sentence, and do not reuse one template more than twice.",
    "WORKFLOW: call submit_exercises with ALL exercises of the objective in ONE call (about 10-12). The tool checks each one (subject and pool rules, answer leaks against the whole lesson, " +
      "a blind solve by another model, and an independent check of every accepted answer variant). Rejected exercises are NOT in the pool: the result names each problem. " +
      "Then call submit_exercises again with ONLY corrected or additional exercises, until the result says complete=true. " +
      "If the blind solver gave a different answer, first decide whether it is EXACTLY as correct for this stimulus: only then add it to acceptedAnswers; " +
      "otherwise the stimulus is ambiguous — make it point to one answer. Never add a variant that adds or drops meaning. Never resubmit an exercise unchanged.",
  ].join("\n\n");
}

// ---------- agenci ----------

type Solver = (view: string, gaps: number) => Promise<string[]>;
/** Dla każdego wariantu: czy jest równie poprawną odpowiedzią o tym samym znaczeniu (true/false). */
type Judge = (view: string, answer: string, variants: readonly string[]) => Promise<boolean[]>;

async function runPlanner(state: LessonState, model: LanguageModel, effort: string, material: string, topicTitle: string, lexicon: MaterialLexicon, timeoutMs: number) {
  const proposeTool = tool({
    description: "Propose the lesson objectives with cards and card examples. Rejected (with reasons) when a material word or frame is on no card.",
    inputSchema: z.object({
      objectives: z
        .array(
          z.object({
            slug: z.string().describe("ascii snake_case"),
            titlePl: z.string(),
            descriptionEn: z.string(),
            kind: z.enum(["words", "frame"]),
            cards: z.array(z.object({ title: z.string(), body: z.string() })).min(2).max(4),
            examples: z.array(z.string()).max(3),
          }),
        )
        .min(3)
        .max(6),
    }),
    execute: async ({ objectives }) => {
      const errors: string[] = [];
      const slugs = objectives.map((objective) => objective.slug);
      if (new Set(slugs).size !== slugs.length) errors.push("slugs must be unique");
      for (const slug of slugs) if (!/^[a-z0-9_]+$/u.test(slug)) errors.push(`slug "${slug}" must be ascii snake_case`);
      const cardText = objectives.map((objective) => objective.cards.map((card) => card.body).join("\n")).join("\n");
      const uncoveredWords = lexicon.words.filter((word) => !mentions(cardText, word));
      const plainCards = plainText(cardText);
      const uncoveredFrames = lexicon.frames.filter((frame) => !plainCards.includes(frameKey(frame)));
      if (uncoveredWords.length > 0) errors.push(`material words on no card: ${uncoveredWords.join(", ")}`);
      if (uncoveredFrames.length > 0) errors.push(`material frames on no card: ${uncoveredFrames.join(" | ")}`);
      if (errors.length > 0) {
        line(`[v2] plan odrzucony: ${errors.join("; ").slice(0, 200)}`);
        line(`[v2] karty odrzuconego planu: ${JSON.stringify(objectives.map((objective) => ({ slug: objective.slug, cards: objective.cards.map((card) => card.body) })))}`);
        return { ok: false, errors };
      }
      state.objectives = objectives.map((objective) => ({ ...objective, id: `english_chapter.poc.${objective.slug}` }));
      const data: DynamicTopicData = {
        titlePl: topicTitle,
        objectives: state.objectives.map((objective) => ({
          id: objective.id,
          titlePl: objective.titlePl,
          descriptionEn: objective.descriptionEn,
          kind: objective.kind,
          cards: objective.cards,
        })),
      };
      state.topic = SUBJECT.buildDynamicTopic!(data);
      for (const objective of state.objectives) state.pools.set(objective.id, []);
      line(`[v2] plan: ${state.objectives.map((objective) => `${objective.slug}(${objective.kind})`).join(", ")}`);
      return { ok: true };
    },
  });
  const planner = new ToolLoopAgent({
    model,
    instructions: plannerInstructions(lexicon),
    tools: { propose_objectives: proposeTool },
    stopWhen: [isStepCount(8), () => state.topic !== undefined],
    providerOptions: { openrouter: { reasoning: { effort } } },
  });
  const result = await planner.generate({
    prompt: `Plan the lesson "${topicTitle}" from this chapter material.\n\n<MATERIAL>\n${material}\n</MATERIAL>`,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  state.costUsd += result.steps.reduce((sum, step) => sum + costOf(step.providerMetadata), 0);
  state.agentSteps.planner = result.steps.length;
}

async function runObjectiveAgent(
  state: LessonState,
  objective: ObjectivePlan,
  context: { model: LanguageModel; effort: string; material: string; lexicon: MaterialLexicon; solver: Solver; judge: Judge; timeoutMs: number; maxSteps: number },
  prompt: string,
): Promise<void> {
  const { material, lexicon, solver } = context;
  const poolInput = PROMPT_MODE === "production" ? productionPoolInput(state, objective, material) : undefined;
  const reject = (kind: LessonState["rejections"][number]["kind"], exerciseType: string, errors: string[]) => {
    for (const reason of errors) state.rejections.push({ objective: objective.slug, exerciseType, kind, reason });
  };
  // Tryb produkcyjny: gałąź `exercises` ścisłego schematu puli, surowe rekordy przez parser produkcyjny.
  const productionSchema = poolInput
    ? jsonSchema<{ exercises: unknown[] }>({
        type: "object",
        additionalProperties: false,
        required: ["exercises"],
        properties: { exercises: (lessonPoolJsonSchema(poolInput).properties as Record<string, unknown>).exercises },
      } as Parameters<typeof jsonSchema>[0])
    : undefined;
  const toCandidate = (raw: unknown): { draft?: LessonExerciseDraft; error?: string; type: string } => {
    if (!poolInput) {
      const input = raw as ExerciseInput;
      const built = toDraft(input, objective.id);
      return { ...built, type: input.exerciseType };
    }
    const record = (raw ?? {}) as Record<string, unknown>;
    const type = typeof record.exerciseType === "string" ? record.exerciseType : "?";
    if (record.objectiveId !== objective.id) return { error: `objectiveId must be "${objective.id}"`, type };
    if (!isWellShapedRawExercise(raw)) return { error: "malformed exercise: required fields of its type are missing or have the wrong shape", type };
    return { draft: toExerciseDraft(raw), type };
  };
  const submit = tool({
    description: "Submit a batch of exercises for your objective. Each is checked; accepted ones enter the pool. Returns per-exercise results and what the objective still misses.",
    inputSchema: (productionSchema ?? z.object({ exercises: z.array(exerciseInputSchema).min(1).max(MAX_PER_OBJECTIVE) })) as never,
    execute: async ({ exercises: submitted }: { exercises: unknown[] }) => {
      // Ta sama materializacja co w adapterze produkcyjnym (rachunki, słowa kluczowe, pary/grupy/luki).
      const exercises = poolInput ? materializeGeneratedAssignments(materializeGeneratedKeywords(materializeGeneratedCalculations(submitted))) : submitted;
      const results: { index: number; accepted?: string; errors?: string[] }[] = [];
      const candidates: { index: number; draft: LessonExerciseDraft }[] = [];
      exercises.forEach((input, index) => {
        state.stats.submitted += 1;
        const built = toCandidate(input);
        if (!built.draft) {
          state.stats.rejectedDeterministic += 1;
          reject("shape", built.type, [built.error ?? "invalid exercise"]);
          results.push({ index, errors: [built.error ?? "invalid exercise"] });
          return;
        }
        candidates.push({ index, draft: built.draft });
      });
      // Ślepe rozwiązania i kontrola wariantów równolegle; kontrole deterministyczne i ujawnień przy wstawianiu (pula mogła urosnąć).
      const [solved, variantVerdicts] = await Promise.all([
        Promise.all(
          candidates.map(async ({ draft }) => {
            if (!BLIND_TYPES.has(draft.exerciseType)) return undefined;
            state.stats.blindChecks += 1;
            try {
              return await solver(childView(draft), expectedAnswerCount(draft));
            } catch {
              return undefined;
            }
          }),
        ),
        Promise.all(
          candidates.map(async ({ draft }) => {
            if (!VARIANT_CHECK_TYPES.has(draft.exerciseType) || draft.acceptedAnswers.length === 0) return undefined;
            state.stats.variantChecks += 1;
            try {
              return await context.judge(childView(draft), draft.answer, draft.acceptedAnswers);
            } catch {
              return undefined;
            }
          }),
        ),
      ]);
      candidates.forEach(({ index, draft: raw }, position) => {
        const pool = state.pools.get(objective.id)!;
        if (pool.length >= MAX_PER_OBJECTIVE) {
          reject("limit", raw.exerciseType, ["objective full"]);
          results.push({ index, errors: [`objective already has ${MAX_PER_OBJECTIVE} exercises`] });
          return;
        }
        const checked = deterministicErrors(state, objective, raw, material, lexicon);
        if (!checked.draft) {
          state.stats.rejectedDeterministic += 1;
          reject("deterministic", raw.exerciseType, checked.errors);
          results.push({ index, errors: checked.errors });
          return;
        }
        const leaks = leakErrors(state, objective.id, checked.draft);
        if (leaks.length > 0) {
          state.stats.rejectedLeak += 1;
          reject("leak", raw.exerciseType, leaks);
          results.push({ index, errors: leaks });
          return;
        }
        const answers = solved[position];
        if (answers !== undefined && !blindMatches(checked.draft, answers)) {
          state.stats.blindMismatches += 1;
          const key = checked.draft.exerciseType === "lesson_cloze" ? checked.draft.gapAnswers : checked.draft.answer;
          reject("blind", raw.exerciseType, [`solver ${JSON.stringify(answers)} vs key ${JSON.stringify(key)} | ${childView(checked.draft).replace(/\n/gu, " / ").slice(0, 200)}`]);
          results.push({
            index,
            errors: [
              `blind solve mismatch: another model answered ${JSON.stringify(answers)}, your key is ${JSON.stringify(key)}. ` +
                "If that answer is also correct, add it to acceptedAnswers (open answers) or make the stimulus point to one answer; if it is wrong, the stimulus is ambiguous — fix it.",
            ],
          });
          return;
        }
        const verdicts = variantVerdicts[position];
        const badVariants = verdicts === undefined ? [] : checked.draft.acceptedAnswers.filter((_, i) => verdicts[i] === false);
        if (badVariants.length > 0) {
          state.stats.variantRejections += 1;
          reject("variant", raw.exerciseType, [`variants ${JSON.stringify(badVariants)} vs answer ${JSON.stringify(checked.draft.answer)}`]);
          results.push({
            index,
            errors: [
              `an independent check says these acceptedAnswers are NOT equivalent correct answers (they add, drop or change meaning): ${JSON.stringify(badVariants)}. Remove them and resubmit.`,
            ],
          });
          return;
        }
        const id = `ex${state.nextId++}`;
        pool.push({ id, draft: checked.draft });
        state.stats.accepted += 1;
        results.push({ index, accepted: id });
      });
      const status = objectiveStatus(state, objective, lexicon);
      const accepted = results.filter((entry) => entry.accepted).length;
      line(`[v2] ${objective.slug}: +${accepted}/${exercises.length} pula=${status.counts.total} braki=${status.missing.length}`);
      return { results, ...status };
    },
  });
  const remove = tool({
    description: "Remove one of your exercises by id.",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const pool = state.pools.get(objective.id)!;
      const before = pool.length;
      state.pools.set(objective.id, pool.filter((entry) => entry.id !== id));
      if (before !== pool.length) state.stats.removed += 1;
      return { ok: before !== state.pools.get(objective.id)!.length, ...objectiveStatus(state, objective, lexicon) };
    },
  });
  const agent = new ToolLoopAgent({
    model: context.model,
    instructions: objectiveInstructions(state, objective, poolInput ? lessonSystemPrompt(poolInput) : rulesBlock()),
    tools: { submit_exercises: submit, remove_exercise: remove },
    stopWhen: [isStepCount(context.maxSteps), () => objectiveStatus(state, objective, lexicon).complete],
    providerOptions: { openrouter: { reasoning: { effort: context.effort } } },
  });
  // Tryb produkcyjny: materiał (i zdania do unikania) w tej samej postaci co wiadomość użytkownika generatora.
  const userPrompt = poolInput ? `${prompt.split("\n\n<MATERIAL>")[0]}\n\n${lessonUserMaterial(poolInput)}` : prompt;
  const result = await agent.generate({ prompt: userPrompt, abortSignal: AbortSignal.timeout(context.timeoutMs) });
  state.costUsd += result.steps.reduce((sum, step) => sum + costOf(step.providerMetadata), 0);
  state.agentSteps[objective.slug] = (state.agentSteps[objective.slug] ?? 0) + result.steps.length;
}

/** Ofiary twardych ujawnień w całej lekcji (po równoległej pracy podagentów). */
function lessonHardLeaks(state: LessonState): PoolEntry[] {
  const entries = state.ordered();
  return findExposureLeaks({
    exercises: entries.map((entry) => entry.draft),
    examples: state.examples(),
    objectiveOrder: state.objectives.map((objective) => objective.id),
    subject: SUBJECT,
    mode: "generation",
  })
    .filter((leak) => leak.kind === "hard")
    .map((leak) => entries[leak.index]!);
}

/** Zrzut zwykłego generowania (`probe:chapter` + `UMIEM_PROBE_REVIEW_DUMP_OUT`): zagadnienia, karty (tekst), przykłady, materiał. */
interface ObjectivesDump {
  subjectId: string;
  material: string;
  topicTitle: string;
  topicId?: string;
  objectives: { id: string; title: string; card: string; examples: string[]; descriptionEn: string }[];
}

/** Karty zrzutu („Tytuł: treść” w wierszach) → karty tematu; wiersz bez tytułu dokleja się do poprzedniej. */
function parseDumpCards(card: string): { title: string; body: string }[] {
  const cards: { title: string; body: string }[] = [];
  for (const raw of card.split(/\r?\n/u)) {
    const match = /^([^:]{1,60}):\s+(.+)$/u.exec(raw.trim());
    if (match) cards.push({ title: match[1]!.trim(), body: match[2]!.trim() });
    else if (raw.trim() !== "" && cards.length > 0) cards[cards.length - 1]!.body += `\n${raw.trim()}`;
  }
  return cards;
}

/** Gramatyka: temat z katalogu przedmiotu; szkoła: temat dynamiczny z kart zrzutu. Przykłady kart — ze zrzutu. */
export function loadObjectivesFromDump(state: LessonState, dump: ObjectivesDump): void {
  if (dump.subjectId !== SUBJECT.id) throw new Error(`zrzut jest dla ${dump.subjectId}, próba dla ${SUBJECT.id}`);
  if (SUBJECT_KIND === "grammar") {
    const topic = SUBJECT.topics.find((item) => item.id === dump.topicId);
    if (!topic) throw new Error(`brak tematu ${dump.topicId} w katalogu przedmiotu`);
    state.topic = topic;
    state.objectives = topic.objectives.map((objective) => ({
      id: objective.id,
      slug: slugOf(objective.id),
      titlePl: objective.titlePl,
      descriptionEn: objective.descriptionEn,
      cards: objective.cards.map((card) => ({ title: card.title, body: card.body })),
      examples: dump.objectives.find((item) => item.id === objective.id)?.examples ?? [],
    }));
  } else {
    state.objectives = dump.objectives.map((objective) => ({
      id: objective.id,
      slug: slugOf(objective.id),
      titlePl: objective.title,
      descriptionEn: objective.descriptionEn,
      cards: parseDumpCards(objective.card),
      examples: objective.examples,
    }));
    state.topic = SUBJECT.buildDynamicTopic!({
      titlePl: dump.topicTitle,
      objectives: state.objectives.map((objective) => ({ id: objective.id, titlePl: objective.titlePl, descriptionEn: objective.descriptionEn, cards: objective.cards })),
    });
  }
  for (const objective of state.objectives) state.pools.set(objective.id, []);
  line(`[v2] zagadnienia ze zrzutu: ${state.objectives.map((objective) => `${objective.slug}(${objective.cards.length} kart)`).join(", ")}`);
}

describe.skipIf(!materialPath && !objectivesDumpPath)("PoC v2: mikro-agent z planerem i równoległymi zagadnieniami", () => {
  it("buduje kompletną lekcję", async () => {
    loadDotEnv();
    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.UMIEM_LLM_API_KEY;
    if (!apiKey) throw new Error("Brak OPENROUTER_API_KEY w .env — PoC nie ma czego wywołać.");
    const dumpPath = resolveOutsideRepoPath(process.env.UMIEM_PROBE_AGENT_DUMP, "UMIEM_PROBE_AGENT_DUMP");
    const objectivesDump = objectivesDumpPath ? (JSON.parse(readFileSync(objectivesDumpPath, "utf8")) as ObjectivesDump) : undefined;
    if (!IS_CHAPTER && !objectivesDump) throw new Error("gramatyka i szkoła wymagają UMIEM_PROBE_AGENT_OBJECTIVES_DUMP");
    const material = objectivesDump?.material ?? readFileSync(materialPath!, "utf8");
    const lexicon = IS_CHAPTER ? parseMaterial(material) : { words: [], frames: [] };
    const topicTitle = process.env.UMIEM_PROBE_AGENT_TOPIC ?? objectivesDump?.topicTitle ?? "Unit 3";
    const modelId = process.env.UMIEM_PROBE_AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";
    const solverId =
      process.env.UMIEM_PROBE_AGENT_SOLVER_MODEL ?? (modelId.startsWith("google/") ? "deepseek/deepseek-v4.1-flash-1017" : "google/gemini-3.8-flash");
    const effort = (process.env.UMIEM_PROBE_AGENT_REASONING ?? "low").toLowerCase();
    const timeoutMs = Number(process.env.UMIEM_PROBE_AGENT_TIMEOUT_MS ?? 12 * 60_000);

    const openrouter = createOpenRouter({ apiKey });
    const model = openrouter.chat(modelId, { usage: { include: true } });
    const solverModel = openrouter.chat(solverId, { usage: { include: true } });
    const state = new LessonState();
    const solverUsage = { calls: 0, costUsd: 0 };
    const solver: Solver = async (view, gaps) => {
      solverUsage.calls += 1;
      const result = await generateText({
        model: solverModel,
        providerOptions: { openrouter: { reasoning: { effort: "low" } } },
        output: Output.object({ schema: z.object({ answers: z.array(z.string()) }) }),
        abortSignal: AbortSignal.timeout(90_000),
        prompt: [
          (SUBJECT_KIND === "school"
            ? "You are a Polish pupil who has read the lesson material below. Solve the exercise using only that material. "
            : "You are a Polish child learning English. Solve the exercise. ") +
            "Return ONLY the answer(s): for a choice, the exact text of the correct option; for a gap, the missing word or phrase; " +
            "for a translation or word blocks, the full sentence; for a sentence to correct or transform, the full corrected sentence; for a text with gaps, one bank word per gap, in gap order; " +
            "for matching, one 'left => right' per left item, in the given order; for grouping, one 'item => group label' per item, in the given order.",
          `Expected number of answers: ${gaps}.`,
          ...(SUBJECT_KIND === "school" ? ["", "<MATERIAL>", material, "</MATERIAL>"] : []),
          "",
          view,
        ].join("\n"),
      });
      solverUsage.costUsd += costOf(result.providerMetadata);
      return result.output.answers;
    };
    // Kontrola wariantów: ten sam niezależny model, bez dostępu do uzasadnień autora.
    const judge: Judge = async (view, answer, variants) => {
      solverUsage.calls += 1;
      const result = await generateText({
        model: solverModel,
        providerOptions: { openrouter: { reasoning: { effort: "low" } } },
        output: Output.object({ schema: z.object({ equivalent: z.array(z.boolean()) }) }),
        abortSignal: AbortSignal.timeout(90_000),
        prompt: [
          "An exercise for a child has a canonical correct answer. For EACH candidate variant decide: is it ALSO a fully correct answer to this exercise, " +
            "with exactly the same meaning as the canonical answer (no added, dropped or changed content; contractions and word order that keep the meaning are fine)? " +
            `Return one boolean per candidate, in order (${variants.length} in total).`,
          "",
          view,
          `Canonical answer: ${answer}`,
          `Candidates: ${variants.map((variant) => JSON.stringify(variant)).join(" | ")}`,
        ].join("\n"),
      });
      solverUsage.costUsd += costOf(result.providerMetadata);
      return result.output.equivalent;
    };

    line(`\n=== PoC v2 [${SUBJECT_KIND}, prompt=${PROMPT_MODE}]: model=${modelId} reasoning=${effort} solver=${solverId} słowa=${lexicon.words.length} ramy=${lexicon.frames.length} ===`);
    const started = Date.now();
    const timings: Record<string, number> = {};
    const errors: string[] = [];
    try {
      if (objectivesDump) loadObjectivesFromDump(state, objectivesDump);
      else await runPlanner(state, model, effort, material, topicTitle, lexicon, timeoutMs);
      timings.plannerMs = Date.now() - started;
      if (!state.topic) throw new Error("planer nie przyjął planu");
      const context = { model, effort, material, lexicon, solver, judge, timeoutMs, maxSteps: 8 };
      const runSafe = (objective: ObjectivePlan, prompt: string) =>
        runObjectiveAgent(state, objective, context, prompt).catch((error: unknown) => {
          errors.push(`${objective.slug}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
        });
      await Promise.all(state.objectives.map((objective) => runSafe(objective, `Write the exercises of the objective "${objective.titlePl}".\n\n<MATERIAL>\n${material}\n</MATERIAL>`)));
      timings.objectivesMs = Date.now() - started - timings.plannerMs;
      // Końcowa kontrola ujawnień na całej lekcji: ofiary wypadają, ich zagadnienia uzupełniają braki.
      for (let round = 1; round <= 2; round += 1) {
        const victims = lessonHardLeaks(state);
        line(`[v2] ujawnienia w lekcji (runda ${round}): ${victims.length}`);
        if (victims.length === 0) break;
        const affected = new Map<string, string[]>();
        for (const victim of victims) {
          const pool = state.pools.get(victim.draft.objectiveId)!;
          state.pools.set(victim.draft.objectiveId, pool.filter((entry) => entry.id !== victim.id));
          state.stats.removed += 1;
          affected.set(victim.draft.objectiveId, [...(affected.get(victim.draft.objectiveId) ?? []), victim.draft.answer]);
        }
        await Promise.all(
          [...affected].map(([objectiveId, answers]) =>
            runSafe(
              state.objectives.find((objective) => objective.id === objectiveId)!,
              `These independent exercises were removed because another exercise of the lesson already shows their answer: ${answers.map((answer) => `"${answer}"`).join(", ")}. ` +
                "Submit replacements with NEW sentences so the objective is complete again.",
            ),
          ),
        );
      }
    } catch (error) {
      errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
    const durationMs = Date.now() - started;
    const pool = state.ordered();
    const statuses = Object.fromEntries(state.objectives.map((objective) => [objective.slug, objectiveStatus(state, objective, lexicon)]));
    const pooled = state.topic ? validatePool(pool.map((entry) => entry.draft), SUBJECT, state.topic) : undefined;
    const remainingLeaks = state.topic ? lessonHardLeaks(state).length : 0;
    const totalCost = state.costUsd + solverUsage.costUsd;

    line(`\nCzas=${(durationMs / 1000).toFixed(0)} s (planer ${((timings.plannerMs ?? 0) / 1000).toFixed(0)} s, zagadnienia ${((timings.objectivesMs ?? 0) / 1000).toFixed(0)} s)`);
    line(`Kroki: ${JSON.stringify(state.agentSteps)}; błędy: ${errors.length ? errors.join(" | ") : "brak"}`);
    line(`Koszt: generator ${state.costUsd.toFixed(4)} USD + solver ${solverUsage.costUsd.toFixed(4)} USD (${solverUsage.calls} wywołań) = ${totalCost.toFixed(4)} USD`);
    line(`Statystyki: ${JSON.stringify(state.stats)}`);
    line(`Pula: ${pool.length}; validatePool: ważne=${pooled?.valid.length ?? 0} odrzucone=${pooled?.rejected.length ?? 0}; twarde ujawnienia=${remainingLeaks}`);
    for (const [slug, status] of Object.entries(statuses)) line(`  ${slug}: ${JSON.stringify(status.counts)} ${status.complete ? "KOMPLET" : `braki: ${status.missing.join("; ")}`}`);

    if (dumpPath) {
      writeFileSync(
        dumpPath,
        JSON.stringify(
          {
            modelId,
            effort,
            solverId,
            promptMode: PROMPT_MODE,
            rejections: state.rejections,
            durationMs,
            timings,
            errors,
            costUsd: totalCost,
            agentSteps: state.agentSteps,
            stats: state.stats,
            subjectId: SUBJECT.id,
            objectives: state.objectives.map((objective) => ({
              ...objective,
              card: objective.cards.map((card) => `[${card.title}] ${card.body}`).join("\n"),
              title: objective.titlePl,
            })),
            exercises: pool.map((entry) => ({ id: entry.id, ...entry.draft })),
            statuses,
            remainingLeaks,
            validatePool: { valid: pooled?.valid.length ?? 0, rejected: pooled?.rejected.length ?? 0 },
          },
          null,
          2,
        ),
        "utf8",
      );
      line(`Zrzut: ${dumpPath}`);
    }
    expect(pool.length).toBeGreaterThan(0);
  });
});
