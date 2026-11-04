import type {
  AgentGateFinding,
  AgentObjective,
  DynamicObjectiveKind,
  LessonExerciseDraft,
  LessonExerciseType,
  RawPlanObjective,
  SubjectAgentPolicy,
} from "../../types";
import { chapterExposureText } from "./exposure";
import { frameKey, mentions, parseMaterialLexicon, plainText } from "./material-lexicon";

/**
 * Polityka agenta puli dla przedmiotu `english_chapter` (design etapu 1 §4.2):
 * wymagane typy ćwiczeń, bramki słów i ram kart zagadnienia, braki słów oraz
 * pokrycie materiału przez plan. Tylko reguły domenowe nad przekazanymi danymi.
 */

/**
 * Typy rozwiązywane na ślepo (zamknięte i krótkie). Bez `lesson_listen_choice`
 * (odpowiedź wymaga odsłuchu, którego checker nie ma) i `lesson_keywords`.
 * Listy są literałami, nie importem z `module.ts`: ten importuje politykę, a cykl
 * zostawiłby stałą w strefie martwej; zgodność z typami przedmiotu pilnuje test.
 */
const BLIND_SOLVE_TYPES: readonly LessonExerciseType[] = [
  "lesson_choice",
  "lesson_gap",
  "lesson_cloze",
  "lesson_open_answer",
  "lesson_order",
  "lesson_match",
  "lesson_group",
];

/** Typy, których warianty odpowiedzi sprawdza niezależny model. */
const VARIANT_CHECK_TYPES: readonly LessonExerciseType[] = ["lesson_open_answer", "lesson_gap"];

/** Wymagane typy per rodzaj zagadnienia: przeciw szablonowaniu i dla słuchania. */
const REQUIRED_TYPES: Readonly<Record<DynamicObjectiveKind, readonly (readonly LessonExerciseType[])[]>> = {
  words: [["lesson_match"], ["lesson_listen_choice"], ["lesson_cloze", "lesson_group"]],
  frame: [["lesson_order"], ["lesson_listen_choice"], ["lesson_cloze"]],
};

/** Typy bez rozwiązania w szkicu (karta) — bramki ich nie dotyczą. */
const NO_SOLUTION_TYPES: ReadonlySet<LessonExerciseType> = new Set(["lesson_card"]);
/** Typy, których rozwiązanie nie jest jednym zdaniem ramy: bramka ramy je pomija. */
const FRAME_GATE_SKIPPED: ReadonlySet<LessonExerciseType> = new Set(["lesson_listen_choice", "lesson_match", "lesson_group"]);

function cardsText(objective: AgentObjective): string {
  return objective.cards.map((card) => card.body).join("\n");
}

/** Słowa materiału, które występują na kartach tego zagadnienia. */
function objectiveCardWords(objective: AgentObjective, material: string): string[] {
  return parseMaterialLexicon(material).words.filter((word) => objective.cards.some((card) => mentions(card.body, word)));
}

/** Ramy materiału, których stała część występuje na kartach tego zagadnienia. */
function objectiveFrames(objective: AgentObjective, material: string): string[] {
  const cards = plainText(cardsText(objective));
  return parseMaterialLexicon(material).frames.filter((frame) => {
    const key = frameKey(frame);
    return key !== "" && cards.includes(key);
  });
}

/** Wszystkie teksty ćwiczenia (polecenie, odpowiedzi, opcje, elementy, pary, grupy, luki). */
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

const isMatchOrGroup = (draft: LessonExerciseDraft): boolean => draft.exerciseType === "lesson_match" || draft.exerciseType === "lesson_group";

/** Sprawdzana część ćwiczenia zagadnienia „words”: luki, poprawna opcja, odpowiedź, lewe strony par, elementy grup. */
function checkedCardWordTexts(draft: LessonExerciseDraft): string[] {
  switch (draft.exerciseType) {
    case "lesson_match":
      return (draft.pairs ?? []).map((pair) => pair.left);
    case "lesson_group":
      return (draft.groupItems ?? []).map((item) => item.text);
    case "lesson_cloze":
      return [...(draft.gapAnswers ?? [])];
    case "lesson_choice":
    case "lesson_listen_choice":
      return [draft.options?.find((option) => option.id === draft.correctOption)?.text ?? draft.answer];
    default:
      return [draft.answer];
  }
}

/**
 * Zagadnienie słówek: ćwiczenie sprawdza słowo z KART tego zagadnienia (wada z
 * prób: luka na „live” zamiast na „treehouse”). Pary i grupy — co najmniej dwa.
 */
function cardWordFindings(draft: LessonExerciseDraft, objective: AgentObjective, material: string): AgentGateFinding[] {
  const cardWords = objectiveCardWords(objective, material);
  if (cardWords.length === 0) return [];
  const checked = checkedCardWordTexts(draft);
  const hits = cardWords.filter((word) => checked.some((text) => mentions(text, word))).length;
  // Pary i grupy wymagają dwóch słów, ale zagadnienie z jednym słowem kart nie może wymagać więcej niż ma.
  if (hits >= (isMatchOrGroup(draft) ? Math.min(2, cardWords.length) : 1)) return [];
  const part = draft.exerciseType === "lesson_cloze" ? "gap words" : isMatchOrGroup(draft) ? "items" : "answer";
  return [
    {
      code: "card_word_missing",
      reason: `the checked ${part} must contain a word of THIS objective's cards (${cardWords.join(", ")}); other words may only fill the sentence.`,
    },
  ];
}

/** Zdania rozwiązania ćwiczenia: zdanie z ekspozycji, a dla układanki także złożone elementy. */
function solvedSentences(draft: LessonExerciseDraft): string[] {
  const sentences = [chapterExposureText(draft)];
  if (draft.exerciseType === "lesson_order" && draft.items !== undefined && draft.items.length > 0) {
    sentences.push(draft.items.map((item) => item.text).join(" "));
  }
  return sentences.map(plainText);
}

/**
 * Zagadnienie ramy: rozwiązanie (odpowiedź, zdanie układanki, zdanie luki po
 * wstawieniu odpowiedzi) zawiera stałą część ramy z kart TEGO zagadnienia.
 */
function frameFindings(draft: LessonExerciseDraft, objective: AgentObjective, material: string): AgentGateFinding[] {
  if (FRAME_GATE_SKIPPED.has(draft.exerciseType)) return [];
  const keys = objectiveFrames(objective, material).map(frameKey);
  if (keys.length === 0) return [];
  const solved = solvedSentences(draft);
  if (keys.some((key) => solved.some((sentence) => sentence.includes(key)))) return [];
  return [
    {
      code: "frame_missing",
      reason: `the solved sentence must contain the fixed part of a sentence frame of THIS objective's cards (${keys.map((key) => `"${key}"`).join(", ")}); do not use another objective's frame.`,
    },
  ];
}

export const chapterAgentPolicy: SubjectAgentPolicy = {
  blindSolveTypes: BLIND_SOLVE_TYPES,
  variantCheckTypes: VARIANT_CHECK_TYPES,
  checkerNeedsMaterial: false,
  independentReserve: 1,
  slack: 2,
  rejectionTexts: {
    leakVictim: "An independent answer must be a NEW sentence nobody showed before — change the room, object or place.",
    leakSource: "Use a different sentence.",
  },
  requiredTypes(objective: AgentObjective) {
    return objective.kind === undefined ? [] : REQUIRED_TYPES[objective.kind];
  },
  exerciseGate(draft, objective, ctx) {
    if (NO_SOLUTION_TYPES.has(draft.exerciseType)) return [];
    if (objective.kind === "words") return cardWordFindings(draft, objective, ctx.material);
    if (objective.kind === "frame") return frameFindings(draft, objective, ctx.material);
    return [];
  },
  objectiveGaps(pool, objective, ctx) {
    if (objective.kind !== "words") return [];
    const uncovered = objectiveCardWords(objective, ctx.material).filter(
      (word) => !pool.some((draft) => mentions(exerciseText(draft), word)),
    );
    return uncovered.length > 0 ? [`card words not used in any exercise yet: ${uncovered.join(", ")}`] : [];
  },
  planCoverage: parseMaterialLexicon,
  planGate(plan: readonly RawPlanObjective[], material: string) {
    const lexicon = parseMaterialLexicon(material);
    const cardText = plan.map((objective) => objective.cards.map((card) => card.body).join("\n")).join("\n");
    const plainCards = plainText(cardText);
    const uncoveredWords = lexicon.words.filter((word) => !mentions(cardText, word));
    const uncoveredFrames = lexicon.frames.filter((frame) => !plainCards.includes(frameKey(frame)));
    const errors: string[] = [];
    if (uncoveredWords.length > 0) errors.push(`material words on no card: ${uncoveredWords.join(", ")}`);
    if (uncoveredFrames.length > 0) errors.push(`material frames on no card: ${uncoveredFrames.join(" | ")}`);
    return errors;
  },
};
