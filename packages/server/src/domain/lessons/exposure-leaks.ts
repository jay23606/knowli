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

export interface GenerationLeakResolution {
  readonly keptFresh: LessonExerciseDraft[];
  readonly droppedFresh: LessonExerciseDraft[];
  /** Nowe przykłady po odrzuceniu ujawniających; zagadnienie bez żadnego pozostałego przykładu jest POMINIĘTE (zostają stare przykłady szkicu). */
  readonly keptNewExamples: Record<string, string[]>;
  readonly droppedExampleCount: number;
}

/**
 * Rozstrzyga ujawnienia po generowaniu dla szkicu z istniejącymi ćwiczeniami:
 * istniejące ćwiczenia i przykłady są nietykalne, odpadają tylko świeże
 * ćwiczenia i nowe przykłady. Ocena jak w trybie `generation`; ujawnienia
 * miękkie nic nie usuwają.
 *
 * `fixedSources` (zagadnienie → teksty) to stałe źródła ujawnień, np. zdania
 * kart rozdziału: doklejane per zagadnienie PO scaleniu przykładów, więc nowe
 * przykłady zagadnienia ich nie zastępują. Służą wyłącznie jako źródła reguły
 * twardej wobec świeżych ćwiczeń; nie wpływają na filtr nowych przykładów,
 * `keptNewExamples` ani `droppedExampleCount`.
 */
export function resolveGenerationLeaks(input: {
  readonly existing: readonly LessonExerciseDraft[];
  readonly fresh: readonly LessonExerciseDraft[];
  readonly existingExamples: Readonly<Record<string, readonly string[]>>;
  readonly newExamples: Readonly<Record<string, readonly string[]>>;
  readonly fixedSources?: Readonly<Record<string, readonly string[]>>;
  readonly objectiveOrder: readonly string[];
  readonly subject: LeakSubject;
}): GenerationLeakResolution {
  const { existing, fresh, existingExamples, newExamples, fixedSources = {}, objectiveOrder, subject } = input;
  const judge = { subject, mode: "generation" } as const;

  // Nowy przykład ujawniający rozwiązanie istniejącego ćwiczenia odpada.
  const keptNewExamples: Record<string, string[]> = {};
  let droppedExampleCount = 0;
  for (const [objectiveId, texts] of Object.entries(newExamples)) {
    const kept = texts.filter((text) => !existing.some((victim) => isVictimCandidate(victim) && exampleExposes(judge, victim, text)));
    droppedExampleCount += texts.length - kept.length;
    if (kept.length > 0) {
      keptNewExamples[objectiveId] = kept;
    }
  }

  // Końcowe przykłady: stare z zagadnieniami zastąpionymi przez zachowane nowe,
  // a do każdego zagadnienia dokleja się jego stałe źródła (konkatenacja).
  const merged: Record<string, readonly string[]> = { ...existingExamples, ...keptNewExamples };
  const withFixed: Record<string, readonly string[]> = { ...merged };
  for (const [objectiveId, texts] of Object.entries(fixedSources)) {
    withFixed[objectiveId] = [...(merged[objectiveId] ?? []), ...texts];
  }
  const all: ExposureLeakInput = {
    exercises: [...existing, ...fresh],
    examples: withFixed,
    objectiveOrder,
    subject,
    mode: "generation",
  };
  const droppedIndexes = new Set<number>();
  all.exercises.forEach((_victim, victimIndex) => {
    const sources = hardSourcesOf(victimIndex, all);
    if (sources.length === 0) {
      return;
    }
    if (victimIndex >= existing.length) {
      droppedIndexes.add(victimIndex);
      return;
    }
    for (const source of sources) {
      if (source.kind === "exercise" && source.index >= existing.length) {
        droppedIndexes.add(source.index);
      }
    }
  });

  const keptFresh: LessonExerciseDraft[] = [];
  const droppedFresh: LessonExerciseDraft[] = [];
  fresh.forEach((draft, freshIndex) => {
    (droppedIndexes.has(existing.length + freshIndex) ? droppedFresh : keptFresh).push(draft);
  });
  return { keptFresh, droppedFresh, keptNewExamples, droppedExampleCount };
}
