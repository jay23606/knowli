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

/**
 * Łączy raport przebiegu z poprzednim raportem szkicu. Zagadnienia z przebiegu
 * nadpisują poprzednie wpisy tego samego zagadnienia; `changed`/`notes`/`machine`
 * tracą wpisy ćwiczeń spoza `liveExerciseIds`, a `machine` zastępuje wpis tego
 * samego ćwiczenia; `dropped`/`toppedUp` są ograniczone do 200 najnowszych wpisów.
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

  const runMachineIds = new Set(run.machine.map((m) => m.exerciseId));
  const machine = [...(previous?.machine ?? []).filter((m) => !runMachineIds.has(m.exerciseId)), ...run.machine].filter(
    (m) => liveExerciseIds.has(m.exerciseId),
  );
  const live = <T extends { exerciseId: string }>(entries: readonly T[]) =>
    entries.filter((entry) => liveExerciseIds.has(entry.exerciseId));

  const model = run.model ?? previous?.model;
  return {
    status: statusFromObjectives(objectives),
    ...(model === undefined ? {} : { model }),
    objectives,
    changed: live([...(previous?.changed ?? []), ...run.changed]),
    dropped: [...(previous?.dropped ?? []), ...run.dropped].slice(-REVIEW_REPORT_LIST_LIMIT),
    notes: live([...(previous?.notes ?? []), ...run.notes]),
    toppedUp: [...(previous?.toppedUp ?? []), ...run.toppedUp].slice(-REVIEW_REPORT_LIST_LIMIT),
    machine,
  };
}

/** Krótki, jednowierszowy fragment ćwiczenia do raportu (≤ 80 znaków). */
export function exerciseSnippet(draft: LessonExerciseDraft): string {
  const candidates = [draft.stem, draft.prompt, draft.statement, draft.instructionPl, draft.clozeText, draft.answer];
  for (const candidate of candidates) {
    const text = candidate?.replace(/\s+/g, " ").trim();
    if (!text) continue;
    return text.length <= SNIPPET_LIMIT ? text : `${text.slice(0, SNIPPET_LIMIT - 1).trimEnd()}…`;
  }
  return "(bez treści)";
}
