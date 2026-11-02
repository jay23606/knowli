import type { ReviewCategory } from "./review-criteria";
import type { LessonExerciseDraft } from "./types";

export type ReviewReason = "disabled" | "not_configured" | "failed" | "timeout" | "limit";

/** Raport przeglądu krytyka zapisywany przy wersji szkicu (bez danych dziecka). */
export interface LessonReviewReport {
  status: "reviewed" | "partial" | "unreviewed";
  model?: string;
  objectives: { objectiveId: string; status: "reviewed" | "unreviewed" | "suspicious"; reason?: ReviewReason }[];
  changed: {
    exerciseId: string;
    fingerprint: string;
    category: ReviewCategory;
    reasonPl: string;
    beforePl: string;
    addedVariants: string[];
  }[];
  dropped: { objectiveId: string; category: ReviewCategory; reasonPl: string; snippet: string }[];
  notes: { exerciseId: string; fingerprint: string; category: ReviewCategory; reasonPl: string; fixRejected: boolean }[];
  toppedUp: { objectiveId: string; guided: number; productive: number; independent: number }[];
  machine: { exerciseId: string; fingerprint: string; reviewed: boolean }[];
}

/** Maksymalna długość list `dropped` i `toppedUp` (najstarsze wpisy są obcinane). */
export const REVIEW_REPORT_LIST_LIMIT = 200;

const SNIPPET_LIMIT = 80;

function statusFromObjectives(objectives: LessonReviewReport["objectives"]): LessonReviewReport["status"] {
  const reviewed = objectives.filter((o) => o.status === "reviewed" || o.status === "suspicious").length;
  if (reviewed === 0) return "unreviewed";
  return reviewed === objectives.length ? "reviewed" : "partial";
}

/** Wpisy przebiegu zastępują wcześniejsze wpisy tego samego ćwiczenia; identyfikator się nie powtarza. */
function replaceById<T extends { exerciseId: string }>(previous: readonly T[], run: readonly T[]): T[] {
  const runIds = new Set(run.map((entry) => entry.exerciseId));
  return [...previous.filter((entry) => !runIds.has(entry.exerciseId)), ...run];
}

/**
 * Łączy raport przebiegu z poprzednim raportem szkicu. Zagadnienia z przebiegu
 * nadpisują poprzednie wpisy tego samego zagadnienia; `changed`/`notes`/`machine`
 * tracą wpisy ćwiczeń spoza `liveExerciseIds`, a wpis przebiegu zastępuje wcześniejszy
 * wpis tego samego ćwiczenia; `dropped`/`toppedUp` są ograniczone do 200 najnowszych wpisów.
 * Status wynika z zagadnień (`suspicious` liczy się jak `reviewed`).
 */
export function mergeReviewReport(
  previous: LessonReviewReport | undefined,
  run: LessonReviewReport,
  liveExerciseIds: ReadonlySet<string>,
): LessonReviewReport {
  // Zagadnienie z przebiegu zajmuje miejsce poprzedniego wpisu; nowe trafiają na koniec.
  const runObjectives = new Map(run.objectives.map((o) => [o.objectiveId, o] as const));
  const previousObjectives = (previous?.objectives ?? []).map((o) => runObjectives.get(o.objectiveId) ?? o);
  const previousObjectiveIds = new Set(previousObjectives.map((o) => o.objectiveId));
  const objectives = [...previousObjectives, ...run.objectives.filter((o) => !previousObjectiveIds.has(o.objectiveId))];

  const live = <T extends { exerciseId: string }>(entries: readonly T[]) =>
    entries.filter((entry) => liveExerciseIds.has(entry.exerciseId));

  const model = run.model ?? previous?.model;
  return {
    status: statusFromObjectives(objectives),
    ...(model === undefined ? {} : { model }),
    objectives,
    changed: live(replaceById(previous?.changed ?? [], run.changed)),
    dropped: [...(previous?.dropped ?? []), ...run.dropped].slice(-REVIEW_REPORT_LIST_LIMIT),
    notes: live(replaceById(previous?.notes ?? [], run.notes)),
    toppedUp: [...(previous?.toppedUp ?? []), ...run.toppedUp].slice(-REVIEW_REPORT_LIST_LIMIT),
    machine: live(replaceById(previous?.machine ?? [], run.machine)),
  };
}

const SNIPPET_SEPARATOR = " → ";
const SNIPPET_MIN_ANSWER = 30;
const SNIPPET_MIN_STIMULUS = 20;

function collapse(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Jednowierszowy fragment ćwiczenia do raportu: „bodziec → odpowiedź” w ≤ 80 znakach.
 * Bodziec to pierwsze niepuste z: stem, prompt, statement, clozeText, instructionPl.
 * Odpowiedź ma gwarantowane min(jej długość, 30) znaków — najpierw skracany jest bodziec.
 * Puste ćwiczenie daje pusty tekst (zastępnik wybiera warstwa UI).
 */
export function exerciseSnippet(draft: LessonExerciseDraft): string {
  const stimulus =
    [draft.stem, draft.prompt, draft.statement, draft.clozeText, draft.instructionPl].map(collapse).find((t) => t) ?? "";
  const answer = collapse(draft.answer);
  if (!stimulus) return truncate(answer, SNIPPET_LIMIT);
  if (!answer) return truncate(stimulus, SNIPPET_LIMIT);

  const available = SNIPPET_LIMIT - SNIPPET_SEPARATOR.length;
  // Bodziec dostaje resztę po całej odpowiedzi (nie mniej niż 20 znaków), ale odpowiedź zawsze ma ≥ min(długość, 30).
  const stimulusBudget = Math.min(
    available - Math.min(answer.length, SNIPPET_MIN_ANSWER),
    Math.max(available - answer.length, Math.min(stimulus.length, SNIPPET_MIN_STIMULUS)),
  );
  const shownStimulus = truncate(stimulus, stimulusBudget);
  const shownAnswer = truncate(answer, available - shownStimulus.length);
  return `${shownStimulus}${SNIPPET_SEPARATOR}${shownAnswer}`;
}
