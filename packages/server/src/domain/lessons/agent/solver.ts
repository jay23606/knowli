import { messages } from "@learning/contracts";
import { renderCalculationPrompt } from "../calculation";
import { answersEquivalent } from "../pool-validation";
import type { AnswerNormalizer, LessonExerciseDraft, LessonTopic } from "../types";

/**
 * Widok dziecka dla niezależnego rozwiązującego („ślepy solver”) i porównanie jego
 * odpowiedzi z kluczem ćwiczenia (spec etapu 1 §3.7). Czyste funkcje nad szkicem:
 * bez modelu, zegara i losowości — kolejność banków i kolumn ustala `sortedTexts`.
 */

const sortedTexts = (texts: readonly string[]): string[] => [...texts].sort((a, b) => a.localeCompare(b, "en"));

/**
 * Elementy grupowania w kolejności alfabetycznej tekstu — ta sama w widoku i w `blindMatches`.
 * Kolejność szkicu bywa skorelowana z `groupId` (model wypisuje grupę po grupie), więc
 * pozycja zdradzałaby przypisanie.
 */
const groupItemsInViewOrder = (draft: LessonExerciseDraft): NonNullable<LessonExerciseDraft["groupItems"]> =>
  [...(draft.groupItems ?? [])].sort((a, b) => a.text.localeCompare(b.text, "en"));

/**
 * Klasa pola szkicu względem widoku dziecka (Kid DTO z `lesson-materialize.ts`):
 * `view` — widoczne przed odpowiedzią; `key` — wyłącznie klucz lub ocena;
 * `mixed` — widoczne tylko w przekształconej postaci (posortowany bank, kolumny
 * bez powiązań, teksty bez identyfikatorów); `meta` — nie wpływa na widok.
 * Rekord wymusza klasę dla każdego pola szkicu — nowe pole nie skompiluje się bez niej,
 * a allowlista widoku nie wycieka klucza przez przeoczenie.
 */
export const SOLVER_FIELD_CLASS: Readonly<Record<keyof LessonExerciseDraft, "view" | "key" | "mixed" | "meta">> = {
  exerciseType: "meta",
  objectiveId: "meta",
  instructionPl: "view",
  stem: "view",
  statement: "view",
  prompt: "view",
  // Pierwszy widok jest bez podpowiedzi; ryzyko fałszywych rozjazdów w lukach gramatyki mierzy etap 3.
  hint: "key",
  transformId: "meta", // polecenie przekształcenia bierzemy z tematu (`topic.transforms`)
  noticeSegments: "view",
  visualSubject: "view",
  answer: "key",
  acceptedAnswers: "key",
  focus: "key",
  options: "mixed", // teksty opcji bez `id` i bez `correctOption`
  correctOption: "key",
  items: "mixed", // bloki „Ułóż” posortowane
  questionType: "meta",
  requiredElements: "key",
  supplementaryElements: "key",
  commonErrors: "key",
  expectedForm: "meta",
  familyId: "meta",
  sourceRefs: "key",
  calculation: "mixed", // widoczna treść zadania (render), bez wyniku
  keywordOptions: "mixed", // teksty pojęć posortowane, bez `keyOptionIds`
  keyOptionIds: "key",
  pairs: "mixed", // lewe w kolejności, prawe posortowane, bez powiązań
  extraRight: "mixed", // dystraktory widać tylko w posortowanej prawej kolumnie
  groups: "mixed", // etykiety bez `id`
  groupItems: "mixed", // `text` tak, `groupId` nie
  clozeText: "view", // tekst z lukami, bez wstawionych odpowiedzi
  gapAnswers: "mixed", // tylko w posortowanym banku słów
  extraWords: "mixed", // dystraktory banku, tylko w posortowanym banku
  voiceTone: "meta",
  explanationPl: "key", // widoczne dopiero po błędnej odpowiedzi
};

const joined = (texts: readonly string[]): string => sortedTexts(texts).join(" | ");

/** Polecenie widoczne dla dziecka: z szkicu, z przekształcenia tematu albo tytuł celu (jak materializacja). */
function instructionOf(draft: LessonExerciseDraft, topic: LessonTopic, fallback?: string): string | undefined {
  if (draft.instructionPl) return draft.instructionPl;
  if (fallback !== undefined) return fallback;
  const transform =
    draft.exerciseType === "lesson_transform" && draft.transformId
      ? topic.transforms.find((candidate) => candidate.id === draft.transformId)
      : undefined;
  return transform?.instructionPl ?? topic.objectives.find((objective) => objective.id === draft.objectiveId)?.titlePl;
}

/**
 * Tekst, który dziecko widzi przed odpowiedzią, bez klucza, focusu, wyjaśnienia i podpowiedzi.
 * Układ zależy od typu ćwiczenia, jak w Kid DTO; listy to zwykłe wiersze ze stałymi etykietami.
 */
export function solverView(draft: LessonExerciseDraft, topic: LessonTopic): string {
  const lines: (string | undefined)[] = [];
  const options = (texts: readonly string[]) => lines.push(`Options: ${joined(texts)}`);
  const objectiveTitle = topic.objectives.find((objective) => objective.id === draft.objectiveId)?.titlePl;
  switch (draft.exerciseType) {
    case "lesson_notice":
      lines.push(instructionOf(draft, topic));
      (draft.noticeSegments ?? []).forEach((sentence, index) => lines.push(`Sentence ${index + 1}: ${sentence.join(" ")}`));
      break;
    case "lesson_choice":
      if (draft.visualSubject) lines.push(`Picture shows: ${draft.visualSubject}`);
      lines.push(instructionOf(draft, topic), draft.stem);
      options((draft.options ?? []).map((option) => option.text));
      break;
    case "lesson_listen_choice":
      // Bez polecenia: dziecko słyszy nagranie, a pytanie dostaje z katalogu komunikatów.
      lines.push(draft.stem);
      options((draft.options ?? []).map((option) => option.text));
      break;
    case "lesson_short_answer":
      lines.push(draft.prompt ?? draft.stem ?? instructionOf(draft, topic));
      options((draft.options ?? []).map((option) => option.text));
      break;
    case "lesson_order":
      lines.push(instructionOf(draft, topic), `Word blocks (shuffled): ${joined((draft.items ?? []).map((item) => item.text))}`);
      break;
    case "lesson_gap":
      lines.push(instructionOf(draft, topic), draft.stem);
      break;
    case "lesson_error_fix":
    case "lesson_transform":
      lines.push(instructionOf(draft, topic), draft.statement);
      break;
    case "lesson_calculation": {
      lines.push(instructionOf(draft, topic, messages.kid.lessonCalculationInstruction));
      try {
        if (draft.calculation) lines.push(renderCalculationPrompt(draft.calculation));
      } catch {
        // Niepoprawna specyfikacja: treść zadania pomijamy jawnie. Walidacja puli działa przed
        // sprawdzaniem (rozwiązujący dostaje tylko ćwiczenia, które ją przeszły), więc ta gałąź
        // nie powinna się zdarzyć; widok bez treści nie jest błędem tej funkcji.
      }
      break;
    }
    case "lesson_keywords":
      // Jak w Kid DTO: pytanie to prompt sparowanej odpowiedzi otwartej (nie ma go w szkicu) albo tytuł celu.
      lines.push(instructionOf(draft, topic, messages.kid.lessonKeywordsInstruction), objectiveTitle);
      lines.push(`Concepts: ${joined((draft.keywordOptions ?? []).map((option) => option.text))}`);
      break;
    case "lesson_match":
      lines.push(
        instructionOf(draft, topic, messages.kid.lessonMatchInstruction),
        `Left (in this order): ${(draft.pairs ?? []).map((pair) => pair.left).join(" | ")}`,
        `Right (shuffled): ${joined([...(draft.pairs ?? []).map((pair) => pair.right), ...(draft.extraRight ?? [])])}`,
      );
      break;
    case "lesson_group":
      lines.push(
        instructionOf(draft, topic, messages.kid.lessonGroupInstruction),
        `Groups: ${(draft.groups ?? []).map((group) => group.label).join(" | ")}`,
        `Items (in this order): ${groupItemsInViewOrder(draft).map((item) => item.text).join(" | ")}`,
      );
      break;
    case "lesson_cloze":
      lines.push(
        instructionOf(draft, topic, messages.kid.lessonClozeInstruction),
        draft.clozeText,
        `Word bank: ${joined([...(draft.gapAnswers ?? []), ...(draft.extraWords ?? [])])}`,
      );
      break;
    default:
      // lesson_open_answer i typy bez własnego układu: polecenie i pytanie, jak w Kid DTO.
      lines.push(instructionOf(draft, topic), draft.prompt);
  }
  return lines.filter((line): line is string => line !== undefined && line !== "").join("\n");
}

/** Liczba odpowiedzi rozwiązującego: luki cloze, lewe strony par, elementy grup, inaczej jedna. */
export function expectedAnswerCount(draft: LessonExerciseDraft): number {
  if (draft.exerciseType === "lesson_cloze") return draft.gapAnswers?.length ?? 1;
  if (draft.exerciseType === "lesson_match") return draft.pairs?.length ?? 1;
  if (draft.exerciseType === "lesson_group") return draft.groupItems?.length ?? 1;
  return 1;
}

/** Zapis etykiety do porównania: wielkość liter, apostrofy typograficzne i odstępy nie mają znaczenia. */
const plainKey = (text: string): string =>
  text.trim().toLowerCase().replace(/[’‘]/gu, "'").replace(/\s+/gu, " ");

/**
 * Czy odpowiedzi rozwiązującego zgadzają się z kluczem szkicu. Cloze porównuje pozycyjnie
 * z wariantami przedmiotu; pary i grupy — „lewa => prawa” / „element => grupa” w podanej
 * kolejności, po etykiecie z prawej strony; pozostałe typy — jedna odpowiedź względem
 * `answer` i `acceptedAnswers`. Inna liczba odpowiedzi niż oczekiwana to zawsze rozjazd.
 */
export function blindMatches(draft: LessonExerciseDraft, answers: readonly string[], normalizer: AnswerNormalizer): boolean {
  if (answers.length !== expectedAnswerCount(draft)) return false;
  switch (draft.exerciseType) {
    case "lesson_cloze":
      return (draft.gapAnswers ?? []).every((gap, index) => answersEquivalent(answers[index] ?? "", gap, normalizer));
    case "lesson_match":
    case "lesson_group": {
      const expected =
        draft.exerciseType === "lesson_match"
          ? (draft.pairs ?? []).map((pair) => pair.right)
          : groupItemsInViewOrder(draft).map((item) => draft.groups?.find((group) => group.id === item.groupId)?.label ?? "");
      return expected.every((right, index) => plainKey(answers[index]?.split("=>").at(-1) ?? "") === plainKey(right));
    }
    default:
      return [draft.answer, ...draft.acceptedAnswers].some((candidate) => answersEquivalent(answers[0] ?? "", candidate, normalizer));
  }
}
