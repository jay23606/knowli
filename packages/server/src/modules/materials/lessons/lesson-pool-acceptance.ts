import { stripListenChoiceExtras } from "../../../domain/lessons/material-creation";
import { answersEquivalent, validatePool, withoutRedundantAcceptedVariants } from "../../../domain/lessons/pool-validation";
import { lessonExerciseIdentity, lessonIdentityOptionsOf } from "../../../domain/lessons/exercise-identity";
import type { LessonExerciseDraft, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import {
  capListenChoiceOverflow,
  isWellShapedRawExercise,
  refineGeneratedDrafts,
  scopeFamiliesToRun,
  splitByPoolExtra,
  stripParentAddedFlags,
  toExerciseDraft,
  withoutEmptyOptionalArrays,
  withoutInvalidExplanation,
  withoutVoiceToneUnlessAllowed,
  type ObjectiveGenerationLimits,
} from "./lesson-drafts";

/**
 * Walidacja świeżo wygenerowanej puli ćwiczeń (kształt → sanityzacja → czyszczenie
 * hakiem przedmiotu → pula z materiałem → walidacja puli → duplikaty wobec już
 * przyjętych → limity celu). Funkcja czysta: nie zna runu, bazy ani logów — całe
 * wejście przychodzi przez `FreshPoolInput`, więc można ją wołać wielokrotnie dla
 * kolejnych partii jednego runu. Liczniki, logi i `rejectedCount` składa wywołujący.
 */
export interface FreshPoolInput {
  readonly rawExercises: readonly unknown[];
  readonly subject: SubjectModule;
  readonly topic: LessonTopic;
  readonly material: string;
  /** runId przy dogenerowaniu ręcznym, `${runId}-t` w rundzie pod etap, null w pełnej generacji. */
  readonly familyScope: string | null;
  readonly existingDrafts: readonly LessonExerciseDraft[];
  readonly existingAnswers: ReadonlySet<string>;
  readonly existingExerciseIdentities: ReadonlySet<string>;
  readonly objectiveLimits: ReadonlyMap<string, ObjectiveGenerationLimits>;
}

export interface FreshPoolResult {
  readonly accepted: LessonExerciseDraft[];
  readonly shapeRejected: number;
  readonly refineRejected: number;
  readonly refinedReasons: Readonly<Record<string, number>>;
  /** Odrzucenia z `validatePool`, walidacji puli z materiałem i przycięcia limitów celu. */
  readonly rejected: readonly { exercise: LessonExerciseDraft; errors: string[] }[];
  readonly duplicateCount: number;
  readonly droppedAcceptedVariants: number;
  readonly droppedExplanations: number;
}

export interface SanitizedFreshDraft {
  readonly draft: LessonExerciseDraft;
  readonly droppedExplanation: boolean;
  /** Liczba wariantów `acceptedAnswers` porzuconych jako redundantne wobec odpowiedzi kanonicznej. */
  readonly droppedVariants: number;
}

/**
 * Sanityzacja jednego świeżego ćwiczenia z wyjścia modelu — wspólna dla potoku
 * `acceptFreshLessonPool` i kierownika agenta. Kolejność kroków jest częścią
 * kontraktu: ton głosu → wyjaśnienie → puste tablice → dodatki ćwiczenia słuchowego
 * → rodziny runu → warianty redundantne. Bez `stripParentAddedFlags` (woła go
 * wywołujący). Warianty acceptedAnswers redundantne wobec odpowiedzi kanonicznej
 * (np. skrótowa forma przeczenia „to be” przy pełnej) porzucamy — bez tego walidacja
 * fazy 1 odrzucałaby całe ćwiczenie za wpis nieznoszący informacji (odpowiedź
 * kanoniczna jest akceptowana automatycznie). Funkcja czysta.
 */
export function sanitizeFreshLessonDraft(
  draft: LessonExerciseDraft,
  subject: SubjectModule,
  familyScope: string | null,
): SanitizedFreshDraft {
  const toned = withoutVoiceToneUnlessAllowed(draft, subject);
  const explained = withoutInvalidExplanation(toned, subject);
  const droppedExplanation = explained !== toned;
  // Ćwiczenie słuchowe nie ma polecenia, podpowiedzi ani piktogramu: dodatek modelu usuwamy, nie odrzucamy ćwiczenia.
  const stripped = stripListenChoiceExtras(withoutEmptyOptionalArrays(explained));
  const scoped = familyScope === null ? stripped : scopeFamiliesToRun(stripped, familyScope);
  const sanitized = withoutRedundantAcceptedVariants(scoped, subject.normalizer);
  return {
    draft: sanitized,
    droppedExplanation,
    droppedVariants: scoped.acceptedAnswers.length - sanitized.acceptedAnswers.length,
  };
}

export function acceptFreshLessonPool(input: FreshPoolInput): FreshPoolResult {
  const { subject, topic } = input;
  const wellShaped = input.rawExercises.filter(isWellShapedRawExercise);
  const shapeRejected = input.rawExercises.length - wellShaped.length;
  // Sanityzacja per ćwiczenie (wspólna z kierownikiem agenta); liczniki porzuconych
  // wyjaśnień i wariantów redundantnych składamy z jej wyników.
  let droppedAcceptedVariants = 0;
  let droppedExplanations = 0;
  const drafts = wellShaped.map(toExerciseDraft).map((draft) => {
    const sanitized = sanitizeFreshLessonDraft(draft, subject, input.familyScope);
    if (sanitized.droppedExplanation) droppedExplanations += 1;
    droppedAcceptedVariants += sanitized.droppedVariants;
    return sanitized.draft;
  });
  // Czyszczenie świeżego wyjścia modelu hakiem przedmiotu (tylko generacja,
  // także dogenerowanie): odrzucenia liczą się do rejectedCount i są zliczone
  // po powodzie w rejectedReasons dla rodzica.
  const refined = refineGeneratedDrafts(subject, drafts, input.material);
  // Walidacja puli z materiałem (przedmiot: uziemienie cytatów, rodziny pytań)
  // przed walidacją semantyczną — odrzucone ćwiczenia liczą się do rejectedCount.
  const grounded = splitByPoolExtra(subject, stripParentAddedFlags(refined.kept), input.material);
  // Dogenerowanie dopisuje do szkicu: krzyżowa reguła ćwiczeń słuchowych widzi też ćwiczenia już w szkicu
  // (inaczej konflikt zdania z odpowiedzią tekstową wyszedłby dopiero przy publikacji).
  const poolResult = validatePool(grounded.kept, subject, topic, { existingExercises: input.existingDrafts });
  const rejected = [...grounded.extraRejected, ...poolResult.rejected];
  // Duplikaty wobec odpowiedzi już w puli: odrzucamy valid, których odpowiedź
  // równa się istniejącej (dogenerowanie nie powiela odpowiedzi szkicu).
  const identityOptions = lessonIdentityOptionsOf(subject);
  const deduplicated: LessonExerciseDraft[] = [];
  let duplicateCount = 0;
  for (const ex of poolResult.valid) {
    const clash = subject.poolDeduplication === "exercise"
      ? input.existingExerciseIdentities.has(lessonExerciseIdentity(ex, identityOptions))
      : [...input.existingAnswers].some((a) => answersEquivalent(a, ex.answer, subject.normalizer));
    if (clash) {
      duplicateCount += 1;
    } else {
      deduplicated.push(ex);
    }
  }
  // Dodatek słuchowy: najwyżej przyznana liczba na cel, a ćwiczenia etapów nie ponad zamówione.
  const capped = capListenChoiceOverflow(deduplicated, input.objectiveLimits);
  rejected.push(...capped.rejected);
  return {
    accepted: capped.kept,
    shapeRejected,
    refineRejected: refined.rejectedCount,
    refinedReasons: refined.rejectedReasons,
    rejected,
    duplicateCount,
    droppedAcceptedVariants,
    droppedExplanations,
  };
}
