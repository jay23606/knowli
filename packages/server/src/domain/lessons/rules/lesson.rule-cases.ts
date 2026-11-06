import { admitBatch, precheckBatch, type AdmitEntry, type CandidateChecks, type PrecheckEntry } from "../agent/admission";
import { validatePoolIssues, type PoolValidationOptions } from "../pool-validation";
import {
  A,
  B,
  choice,
  contextFor,
  gap as gapOf,
  listen as listenOf,
  NA_CHECKS,
  open as openOf,
  stateWith,
  subject as agentSubject,
} from "../testing/agent-admission-fixtures";
import { withAgentPolicy } from "../testing/agent-test-subject";
import { historyLikeSubject } from "../testing/history-like-subject";
import { registerRuleCases } from "../testing/rule-cases";
import type { LearningObjective, LessonExerciseDraft, LessonExerciseType, LessonTopic, SubjectModule } from "../types";

/**
 * Przypadki reguł katalogu lekcji (`lesson-rules.ts`) dla testu kompletności
 * `rule-cases.test.ts`. Reguły całej puli: każdy przypadek woła prawdziwy
 * `validatePoolIssues` na przedmiocie testowym (silnik nie importuje
 * przedmiotów produkcyjnych) i zwraca zgłoszenia odrzuconych ćwiczeń. Limity,
 * ujawnienia i kontrole modelami: prawdziwe `precheckBatch`/`admitBatch` na
 * przedmiocie testowym agenta z fikcyjnymi wynikami kontroli (`CandidateChecks`).
 */

const TYPES: readonly LessonExerciseType[] = ["lesson_gap", "lesson_open_answer", "lesson_listen_choice"];
const OBJECTIVE_ID = "lesson_cases.topic.any";

const objective: LearningObjective = {
  id: OBJECTIVE_ID,
  titlePl: "Cel testowy",
  descriptionEn: "Test objective.",
  cards: [{ title: "Karta", body: "Treść." }, { title: "Druga", body: "Treść." }],
  errorCategories: ["wrong_date"],
  hints: { wrong_date: "Sprawdź." },
  exerciseTypes: TYPES,
};

const topic: LessonTopic = {
  id: "lesson_cases",
  version: 1,
  titlePl: "Temat testowy",
  extraErrorCategories: [],
  transforms: [],
  objectives: [objective],
};

/** Przedmiot z unikalnością odpowiedzi (domyślna polityka puli). */
const answerSubject: SubjectModule = {
  ...historyLikeSubject,
  exerciseTypes: TYPES,
  topics: [topic],
  validateExercise: () => [],
};

/** Przedmiot z unikalnością bodźca (`poolDeduplication: "exercise"`). */
const stimulusSubject: SubjectModule = { ...answerSubject, poolDeduplication: "exercise" };

function gap(stem: string, answer: string): LessonExerciseDraft {
  return { exerciseType: "lesson_gap", objectiveId: OBJECTIVE_ID, stem, answer, acceptedAnswers: [], focus: [answer] };
}

function open(answer: string): LessonExerciseDraft {
  return {
    exerciseType: "lesson_open_answer",
    objectiveId: OBJECTIVE_ID,
    prompt: "Co ona robi?",
    answer,
    acceptedAnswers: [],
    // Drugie słowo odpowiedzi (czasownik) jako sprawdzany element.
    focus: [answer.split(" ")[1] ?? answer],
  };
}

const listen: LessonExerciseDraft = {
  exerciseType: "lesson_listen_choice",
  objectiveId: OBJECTIVE_ID,
  stem: "She ___ tennis.",
  options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }],
  correctOption: "a",
  answer: "plays",
  acceptedAnswers: [],
  focus: [],
};

/** Zgłoszenia odrzuconych ćwiczeń puli. */
const poolIssues = (
  exercises: readonly LessonExerciseDraft[],
  subject: SubjectModule,
  options: PoolValidationOptions = {},
) => () => validatePoolIssues(exercises, subject, topic, options).rejected.flatMap((entry) => entry.issues);

/** Zgłoszenia odrzucenia albo noty przyjęcia (wynik przyjmowania agenta). */
function issuesOf(entry: PrecheckEntry | AdmitEntry | undefined) {
  if (entry === undefined) return [];
  if ("pass" in entry) return entry.pass ? entry.notes : entry.rejection.issues;
  return "rejected" in entry ? entry.rejected.issues : entry.notes;
}

/** Przyjęcie jednego kandydata w zagadnieniu A po precheck na tym samym stanie, z fikcyjnymi kontrolami. */
const admitted = (
  draft: LessonExerciseDraft,
  checks: Partial<CandidateChecks> = {},
  options: { readonly fixed?: readonly LessonExerciseDraft[]; readonly examples?: readonly string[]; readonly listenAllowance?: number; readonly subject?: SubjectModule } = {},
) => () => {
  const state = stateWith({ fixed: options.fixed ?? [], examples: options.examples === undefined ? {} : { [A]: options.examples } });
  const limits = { targetCount: 1, listenAllowance: options.listenAllowance ?? 2, maxExercises: 2 };
  const ctx = contextFor({ limits: { [A]: limits, [B]: limits }, ...(options.subject ? { subject: options.subject } : {}) });
  const prechecked = precheckBatch(state, A, [draft], ctx);
  return issuesOf(admitBatch(state, A, prechecked, [{ ...NA_CHECKS, ...checks }], ctx).results[0]);
};

/** Paczka w zagadnieniu A (precheck): zgłoszenia ostatniego kandydata. */
const lastInBatch = (drafts: readonly LessonExerciseDraft[]) => () => {
  const limits = { targetCount: 1, listenAllowance: 1, maxExercises: 2 };
  const results = precheckBatch(stateWith(), A, drafts, contextFor({ limits: { [A]: limits, [B]: limits } }));
  return issuesOf(results.at(-1));
};

const withVariant = { ...openOf(A, "Kiedy?", "w 966 roku"), acceptedAnswers: ["966"] };
const openGraded = (knowledge: "correct" | "partial" | "incorrect", answer: string) => ({ answer, knowledge, missing: knowledge === "partial" ? ["Odra"] : [], wrong: [] });

registerRuleCases([
  // Limity zagadnienia.
  { rule: "lesson.limit_full", violation: lastInBatch([choice(A, 1), choice(A, 2), choice(A, 3)]) },
  { rule: "lesson.limit_listen", violation: lastInBatch([listenOf(A, 1), listenOf(A, 2)]) },
  // Ujawnienia: kandydat ofiarą (przykład karty) i kandydat źródłem (ujawnia samodzielne fixed).
  { rule: "lesson.leak", violation: admitted(openOf(A, "Kiedy?", "w 966 roku"), {}, { examples: ["w 966 roku"] }) },
  { rule: "lesson.leak_source", violation: admitted(gapOf(A, "Chrzest w roku ___.", "966"), {}, { fixed: [openOf(A, "Rok chrztu?", "966")] }) },
  // Kontrole modelami (fikcyjne wyniki).
  { rule: "check.blind_solve", violation: admitted(choice(A, 1), { solve: { kind: "done", value: ["dystraktor 1"] } }) },
  { rule: "check.variants", violation: admitted(withVariant, { variants: { kind: "done", value: [false] } }) },
  {
    rule: "check.variants",
    violation: admitted(openOf(A, "Kiedy?", "w 966 roku"), { solve: { kind: "done", value: ["966 rok"] }, solverVariant: { kind: "done", value: true } }),
  },
  { rule: "check.hint_judge", violation: admitted(withVariant, { hint: { kind: "done", value: { verdict: "unsupported", reason: "no such fact" } } }) },
  {
    rule: "check.open_answer",
    violation: admitted(withVariant, {
      open: { kind: "done", value: { answers: [openGraded("correct", "w 966 roku"), openGraded("partial", "w X wieku")] } },
    }, { subject: withAgentPolicy(agentSubject, { openAnswerCheckTypes: ["lesson_open_answer"] }) }),
  },
  // Zdanie ćwiczenia słuchowego ujawnia odpowiedź ćwiczenia tekstowego (w puli i wobec szkicu).
  { rule: "lesson.listen_reveals_answer", violation: poolIssues([open("She plays tennis."), listen], answerSubject) },
  {
    rule: "lesson.listen_reveals_answer",
    violation: poolIssues([open("She plays tennis.")], answerSubject, { existingExercises: [listen] }),
  },
  {
    rule: "lesson.duplicate_stimulus",
    violation: poolIssues([gap("She ___ tennis.", "plays"), gap("She ___ tennis.", "likes")], stimulusSubject),
  },
  {
    rule: "lesson.duplicate_answer",
    violation: poolIssues([gap("She ___ tennis.", "plays"), gap("He ___ football.", "Plays")], answerSubject),
  },
]);

/** Poprawna pula przypadków (test pilnuje, że bez naruszenia nie ma odrzuceń). */
export const LESSON_CASE_BASELINES: readonly { readonly name: string; readonly issues: () => readonly unknown[] }[] = [
  { name: "pula z unikalnymi odpowiedziami", issues: poolIssues([gap("She ___ tennis.", "plays"), open("She likes tennis.")], answerSubject) },
  {
    name: "pula z unikalnymi bodźcami",
    issues: poolIssues([gap("She ___ tennis.", "plays"), gap("He ___ football.", "plays"), listen], stimulusSubject),
  },
];
