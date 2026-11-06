import { exerciseExposureText, lessonExerciseTargetKey, lessonTextTargetKey } from "./exposure-key";
import { answersEquivalent } from "./pool-validation";
import { outsideStagePath, stageOf } from "./stages";
import type { LessonExerciseDraft, SubjectModule } from "./types";

/**
 * Wykrywanie ujawnionych rozwiązań (spec etapu przeglądu lekcji §3, §5.2):
 * ćwiczenie samodzielne („ofiara”) nie jest niezależnym sprawdzianem, gdy
 * dziecko widziało już jego rozwiązanie — w przykładzie karty albo w innym
 * ćwiczeniu. Czysta funkcja nad jawnymi danymi: bez I/O, czasu i losowości.
 */

/** Wycinek przedmiotu potrzebny do porównań (klucze ekspozycji i normalizacja odpowiedzi). */
export type LeakSubject = Pick<SubjectModule, "answerLocale" | "exposureText" | "normalizeExposureText" | "normalizer">;

/** Skąd dziecko zna rozwiązanie: przykład karty zagadnienia albo inne ćwiczenie (indeks w liście wejściowej). */
export type LeakSource =
  | { readonly kind: "card_example"; readonly objectiveId: string; readonly text: string }
  | { readonly kind: "exercise"; readonly index: number };

export interface ExposureLeak {
  /** Indeks ofiary w liście ćwiczeń. */
  readonly index: number;
  /** `hard`: rozwiązanie widziane wcześniej jako przykład lub ćwiczenie niesamodzielne; `soft`: powtórzone w innym samodzielnym. */
  readonly kind: "hard" | "soft";
  readonly source: LeakSource;
}

export interface ExposureLeakInput {
  /** Kolejność = pozycja w lekcji. */
  readonly exercises: readonly LessonExerciseDraft[];
  /** Przykłady kart: zagadnienie → teksty. */
  readonly examples: Readonly<Record<string, readonly string[]>>;
  /** Kolejność zagadnień w lekcji (rozstrzyga, które samodzielne ćwiczenie jest „wcześniejsze”). */
  readonly objectiveOrder: readonly string[];
  readonly subject: LeakSubject;
  /**
   * `coverage`: równość kluczy ekspozycji (`target_key`, jak w pokryciu puli);
   * `generation`: równoważność odpowiedzi po normalizatorze przedmiotu
   * (także warianty zaakceptowane ofiary) — ostrzejsza, bo działa na świeżych tekstach.
   */
  readonly mode: "coverage" | "generation";
  /**
   * `true`: powtórzenie odpowiedzi w tej samej rodzinie pytań ({@link sameQuestionFamily}) nie jest
   * źródłem miękkiego ujawnienia — rodzina to zamierzona struktura (różne sformułowania jednego pytania),
   * a pokrycie i tak liczy ją raz. Źródła twarde i samodzielne ćwiczenia spoza rodziny działają jak zwykle.
   */
  readonly familyRepeatsAllowed?: boolean;
}

/**
 * Ta sama rodzina pytań: to samo zagadnienie i ta sama niepusta `familyId` (rodziny pytań otwartych
 * szkoły). Wspólna dla przyjęcia agenta puli i ostrzeżeń szkicu dla rodzica.
 */
export function sameQuestionFamily(a: LessonExerciseDraft, b: LessonExerciseDraft): boolean {
  return a.objectiveId === b.objectiveId && a.familyId !== undefined && a.familyId.trim() !== "" && a.familyId === b.familyId;
}

/** Ofiarą bywa tylko ćwiczenie samodzielne ze ścieżki etapów. */
function isVictimCandidate(draft: LessonExerciseDraft): boolean {
  return stageOf(draft.exerciseType) === "independent" && !outsideStagePath(draft.exerciseType);
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Czy tekst ujawniony dziecku (przykład karty albo ćwiczenie źródłowe)
 * rozwiązuje ofiarę. `sourceKey` jest liczony tylko w trybie `coverage`.
 */
function exposes(
  input: Pick<ExposureLeakInput, "subject" | "mode">,
  victim: LessonExerciseDraft,
  sourceText: string,
  sourceKey: () => string,
): boolean {
  const { subject, mode } = input;
  if (isBlank(sourceText)) {
    return false;
  }
  if (mode === "coverage") {
    return !isBlank(exerciseExposureText(subject, victim)) && lessonExerciseTargetKey(subject, victim) === sourceKey();
  }
  const norm = (text: string): string => subject.normalizeExposureText?.(text) ?? text;
  const victimTexts = [exerciseExposureText(subject, victim), ...victim.acceptedAnswers].filter((text) => !isBlank(text));
  return victimTexts.some((victimText) => answersEquivalent(norm(victimText), norm(sourceText), subject.normalizer));
}

function exampleExposes(input: Pick<ExposureLeakInput, "subject" | "mode">, victim: LessonExerciseDraft, text: string): boolean {
  return exposes(input, victim, text, () => lessonTextTargetKey(input.subject, text));
}

function exerciseExposes(input: Pick<ExposureLeakInput, "subject" | "mode">, victim: LessonExerciseDraft, source: LessonExerciseDraft): boolean {
  return exposes(input, victim, exerciseExposureText(input.subject, source), () => lessonExerciseTargetKey(input.subject, source));
}

/** Zagadnienia w kolejności lekcji, a potem pozostałe w kolejności wstawienia. */
function examplesInOrder(input: ExposureLeakInput): { objectiveId: string; text: string }[] {
  const objectiveIds = [
    ...input.objectiveOrder.filter((id) => id in input.examples),
    ...Object.keys(input.examples).filter((id) => !input.objectiveOrder.includes(id)),
  ];
  return objectiveIds.flatMap((objectiveId) => (input.examples[objectiveId] ?? []).map((text) => ({ objectiveId, text })));
}

/**
 * Wszystkie źródła twarde ofiary: przykłady kart (każdego zagadnienia) i inne
 * ćwiczenia niesamodzielne, także poza ścieżką etapów (np. wybór ze słuchu).
 * Najpierw przykłady, potem ćwiczenia w kolejności listy. Nie-ofiara → `[]`.
 */
function hardSourcesOf(victimIndex: number, input: ExposureLeakInput): LeakSource[] {
  const victim = input.exercises[victimIndex];
  if (victim === undefined || !isVictimCandidate(victim)) {
    return [];
  }
  const sources: LeakSource[] = [];
  for (const example of examplesInOrder(input)) {
    if (exampleExposes(input, victim, example.text)) {
      sources.push({ kind: "card_example", objectiveId: example.objectiveId, text: example.text });
    }
  }
  input.exercises.forEach((other, index) => {
    if (index !== victimIndex && stageOf(other.exerciseType) !== "independent" && exerciseExposes(input, victim, other)) {
      sources.push({ kind: "exercise", index });
    }
  });
  return sources;
}

/** Pozycja w lekcji: najpierw zagadnienie według `objectiveOrder` (nieznane na końcu), potem indeks. */
function positionOf(input: ExposureLeakInput, index: number): readonly [number, number] {
  const rank = input.objectiveOrder.indexOf(input.exercises[index]!.objectiveId);
  return [rank === -1 ? input.objectiveOrder.length : rank, index];
}

function isEarlier(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
}

/** Pierwsze (w kolejności lekcji) wcześniejsze ćwiczenie samodzielne rozwiązujące ofiarę. */
function firstSoftSourceOf(victimIndex: number, input: ExposureLeakInput): LeakSource | undefined {
  const victim = input.exercises[victimIndex]!;
  const victimPosition = positionOf(input, victimIndex);
  let best: { readonly index: number; readonly position: readonly [number, number] } | undefined;
  input.exercises.forEach((other, index) => {
    if (index === victimIndex || stageOf(other.exerciseType) !== "independent") {
      return;
    }
    if (input.familyRepeatsAllowed === true && sameQuestionFamily(victim, other)) {
      return;
    }
    const position = positionOf(input, index);
    if (!isEarlier(position, victimPosition) || (best !== undefined && !isEarlier(position, best.position))) {
      return;
    }
    if (exerciseExposes(input, victim, other)) {
      best = { index, position };
    }
  });
  return best === undefined ? undefined : { kind: "exercise", index: best.index };
}

/** Jeden wpis na ofiarę (pierwsze źródło twarde, inaczej miękkie) — do DTO i pokrycia. */
export function findExposureLeaks(input: ExposureLeakInput): ExposureLeak[] {
  const leaks: ExposureLeak[] = [];
  input.exercises.forEach((victim, index) => {
    if (!isVictimCandidate(victim)) {
      return;
    }
    const hard = hardSourcesOf(index, input)[0];
    if (hard !== undefined) {
      leaks.push({ index, kind: "hard", source: hard });
      return;
    }
    const soft = firstSoftSourceOf(index, input);
    if (soft !== undefined) {
      leaks.push({ index, kind: "soft", source: soft });
    }
  });
  return leaks;
}
