import { describe, expect, it } from "vitest";
import { exerciseExposureText } from "../exposure-key";
import { findExposureLeaks } from "../exposure-leaks";
import { answersEquivalent, validateLessonExerciseIssues, validatePoolIssues } from "../pool-validation";
import { materializeRawExercise } from "../raw-materialize";
import { rawShapeIssues } from "../raw-shape";
import { PRODUCTION_SUBJECTS } from "../subjects";
import type { LessonExerciseDraft, LessonExerciseType, LessonTopic, SubjectModule } from "../types";
import type { LessonRuleIssue } from "./catalog";
import { typeExample } from "./rule-book";
import { TYPE_CARDS, type SubjectFeatures } from "./type-cards";

/**
 * Karty typów (spec katalogu reguł §2.1): przykład każdej karty przechodzi drogę
 * rekordu agenta — materializację, kształt rekordu i walidację ćwiczenia (kontrakt,
 * rdzeń, przedmiot) — dla każdego produkcyjnego przedmiotu, który ma typ. Przykład
 * w zagadnieniu to przykład przedmiotu (`agentPolicy.typeExamples`) albo karty
 * (`typeExample`), więc temat katalogu sprawdzamy w każdym jego zagadnieniu z jego typami:
 * przykład nie może łamać reguł tematu ani celu (np. form „to be”).
 */

const OBJECTIVE_ID = "examples.objective";

/** Temat z jednym zagadnieniem, które dopuszcza wszystkie typy przedmiotu. */
function topicFor(subject: SubjectModule): LessonTopic {
  const base = subject.buildDynamicTopic?.({
    titlePl: "Przykłady",
    objectives: [{
      id: OBJECTIVE_ID,
      titlePl: "Przykłady",
      descriptionEn: "Examples of exercise types.",
      kind: "words",
      cards: [{ title: "Karta", body: "Treść karty." }],
    }],
  }) ?? subject.topics[0]!;
  const objective = base.objectives[0]!;
  return { ...base, objectives: [{ ...objective, exerciseTypes: [...subject.exerciseTypes] }] };
}

/** Typy, dla których księga musi dać przykład (karta pochodzi z tematu). */
function exampleTypes(types: readonly LessonExerciseType[]): LessonExerciseType[] {
  return types.filter((type) => type !== "lesson_card");
}

/** Zagadnienie, w którym sprawdzamy przykłady razem: jego temat i typy. */
interface ExampleCase {
  readonly name: string;
  readonly topic: LessonTopic;
  readonly types: readonly LessonExerciseType[];
}

/**
 * Zagadnienia przedmiotu: jedno ze wszystkimi typami przedmiotu (przykłady kart) i każde zagadnienie
 * każdego tematu katalogu z jego typami (przykłady przedmiotu dla tematu i celu). Temat zagadnienia
 * ma je na pierwszym miejscu.
 */
function casesOf(subject: SubjectModule): ExampleCase[] {
  const all: ExampleCase = { name: "wszystkie typy", topic: topicFor(subject), types: exampleTypes(subject.exerciseTypes) };
  const catalog = subject.topics.flatMap((topic) =>
    topic.objectives.map((objective): ExampleCase => ({
      name: objective.id,
      topic: { ...topic, objectives: [objective, ...topic.objectives.filter((other) => other !== objective)] },
      types: exampleTypes(objective.exerciseTypes),
    })),
  );
  return [all, ...catalog];
}

/** Zgłoszenia jako „id: found” (czytelna różnica przy porażce). */
function described(issues: readonly LessonRuleIssue[]): string[] {
  return issues.map((issue) => `${issue.rule} ${issue.field}: ${issue.found ?? issue.pl}`);
}

/** Przykład karty przez drogę rekordu agenta: szkic albo zgłoszenia. */
function admitExample(subject: SubjectModule, type: LessonExerciseType, topic: LessonTopic): LessonExerciseDraft {
  const objectiveId = topic.objectives[0]!.id;
  const example = typeExample(subject, { topicId: topic.id, objectiveId }, type);
  expect(example, `${subject.id} ${objectiveId} ${type}: brak przykładu`).toBeDefined();
  expect(example).not.toHaveProperty("objectiveId");
  expect(example!.exerciseType).toBe(type);
  const materialized = materializeRawExercise({ ...example, objectiveId });
  if (!materialized.ok) {
    expect.fail(`${subject.id} ${type}: materializacja — ${described(materialized.issues).join("; ")}`);
  }
  expect(described(rawShapeIssues(materialized.record)), `${subject.id} ${type}: kształt rekordu`).toEqual([]);
  // Przykłady nie mają pól `null`, więc rekord po materializacji jest szkicem.
  const draft = materialized.record as unknown as LessonExerciseDraft;
  expect(described(validateLessonExerciseIssues(draft, subject, topic, { agent: true })), `${subject.id} ${objectiveId} ${type}`).toEqual([]);
  return draft;
}

describe("karty typów", () => {
  it("każdy typ ma niepusty opis bez cyfr (limity podają reguły)", () => {
    for (const [type, card] of Object.entries(TYPE_CARDS)) {
      expect(card.summary.trim(), type).not.toBe("");
      expect(card.summary, type).not.toMatch(/\d/u);
    }
  });

  describe.each(PRODUCTION_SUBJECTS.flatMap((subject) => casesOf(subject).map((entry) => [`${subject.id}: ${entry.name}`, subject, entry] as const)))("%s", (_name, subject, { topic, types }) => {
    it.each(types)("przykład %s przechodzi materializację, kształt i walidację", (type) => {
      admitExample(subject, type, topic);
    });

    it("przykłady razem przechodzą walidację puli i haki puli przedmiotu", () => {
      const drafts = types.map((type) => admitExample(subject, type, topic));
      const pool = validatePoolIssues(drafts, subject, topic, { agent: true });
      expect(pool.rejected.map((entry) => described(entry.issues))).toEqual([]);
      // Materiał: cytaty przykładów (uziemienie samych przykładów, rodziny pytań, słowa kluczowe).
      const material = drafts.flatMap((draft) => draft.sourceRefs ?? []).map((ref) => ref.quote).join("\n");
      const extra = subject.validatePoolExtra?.(drafts, { material }) ?? new Map();
      expect([...extra.values()].map(described)).toEqual([]);
    });

    /**
     * Model kopiuje przykłady, więc przykłady typów jednego przedmiotu nie mogą modelować
     * `lesson.leak` ani powtórzonego zdania: razem nie dają ujawnienia (tryb przyjmowania agenta) i każdy
     * ma własny tekst rozwiązania i własne polskie zdanie-bodziec. Wyjątek: rodzina pytania otwartego
     * i jego słowa kluczowe (ta sama `familyId`) dotyczą celowo jednego faktu.
     */
    it("przykłady razem nie ujawniają odpowiedzi i nie powtarzają zdania ani bodźca", () => {
      const drafts = types.map((type) => admitExample(subject, type, topic));
      const leaks = findExposureLeaks({
        exercises: drafts,
        examples: {},
        objectiveOrder: [topic.objectives[0]!.id],
        subject,
        mode: "generation",
        familyRepeatsAllowed: true,
      });
      expect(leaks.map((leak) => `${drafts[leak.index]!.exerciseType} ← ${JSON.stringify(leak.source)}`)).toEqual([]);

      const repeated = (texts: readonly { type: string; text: string; family?: string }[]): string[] =>
        texts.flatMap((a, i) =>
          texts.slice(i + 1)
            .filter((b) => (a.family === undefined || a.family !== b.family) && answersEquivalent(a.text, b.text, subject.normalizer))
            .map((b) => `${a.type} = ${b.type}: ${a.text}`),
        );
      // Jednowyrazowa odpowiedź luki (np. forma „be”) to nie zdanie: porównujemy zdanie z wstawioną odpowiedzią.
      const solvedText = (draft: LessonExerciseDraft): string => {
        const text = exerciseExposureText(subject, draft);
        return !/\s/u.test(text.trim()) && draft.stem?.includes("___") === true ? draft.stem.replace("___", text) : text;
      };
      const solved = drafts.map((draft) => ({
        type: draft.exerciseType,
        text: solvedText(draft),
        ...(draft.familyId === undefined ? {} : { family: draft.familyId }),
      }));
      expect(repeated(solved.filter((entry) => entry.text.trim() !== "")), "teksty rozwiązań").toEqual([]);
      // Polskie bodźce: zdanie przed poleceniem (przedmiot z poleceniem-bodźcem) i polecenie tłumaczenia.
      const stimuli = drafts.flatMap((draft) => {
        const sentence = subject.instructionIsStimulus === true && draft.instructionPl?.includes(". ") === true
          ? [draft.instructionPl.split(". ")[0]!]
          : [];
        const prompt = draft.exerciseType === "lesson_open_answer" && draft.prompt !== undefined ? [draft.prompt] : [];
        return [...sentence, ...prompt].map((text) => ({ type: draft.exerciseType, text }));
      });
      expect(repeated(stimuli), "bodźce").toEqual([]);
    });

    it("klocki i odpowiedź lesson_order bez interpunkcji końcowej", () => {
      if (!types.includes("lesson_order")) return;
      const order = admitExample(subject, "lesson_order", topic);
      for (const text of [order.answer, ...(order.items ?? []).map((item) => item.text)]) {
        expect(text, `${subject.id}: ${text}`).not.toMatch(/[.!?]$/u);
      }
    });

    it("sanityzacja agenta nie zmienia przykładów (np. podpowiedź pytania otwartego zostaje)", () => {
      const sanitize = subject.agentPolicy.sanitize;
      if (sanitize === undefined) return;
      for (const type of types) {
        const draft = admitExample(subject, type, topic);
        const material = (draft.sourceRefs ?? []).map((ref) => ref.quote).join("\n");
        const result = sanitize(draft, { material });
        expect(result.removed, `${subject.id} ${type}`).toEqual([]);
        expect(described(result.notes ?? []), `${subject.id} ${type}`).toEqual([]);
      }
    });
  });

  it("przykład zależy od cech, nie od przedmiotu: te same cechy dają ten sam przykład", () => {
    const features = { groundingRequired: false, usesV3Payload: false, answerLocale: "en-GB", instructionIsStimulus: false };
    for (const card of Object.values(TYPE_CARDS)) {
      expect(card.example?.(features)).toEqual(card.example?.({ ...features }));
    }
    // Polecenie z bodźcem tylko przy `instructionIsStimulus`; cytat tylko przy uziemieniu.
    expect(TYPE_CARDS.lesson_choice.example?.(features)).toMatchObject({ instructionPl: "Wybierz poprawną formę." });
    expect(TYPE_CARDS.lesson_choice.example?.({ ...features, instructionIsStimulus: true }))
      .toMatchObject({ instructionPl: "Dziś pada deszcz. Wybierz słowo." });
    expect(TYPE_CARDS.lesson_gap.example?.(features)).not.toHaveProperty("sourceRefs");
    expect(TYPE_CARDS.lesson_gap.example?.({ ...features, groundingRequired: true })).toHaveProperty("sourceRefs");
  });

  /**
   * Przykład wyboru i luki rozwiązuje ślepy rozwiązujący (gramatyka i rozdział), więc bodziec
   * ma wskazywać jedno rozwiązanie: z poleceniem-bodźcem robi to polskie zdanie, bez niego opcje
   * wyboru to formy jednego czasownika (pasuje gramatycznie tylko jedna), a luka ma w podpowiedzi
   * formę podstawową czasownika z odpowiedzi.
   */
  it("angielskie przykłady wyboru i luki mają bodziec wskazujący jedno rozwiązanie", () => {
    const exampleOf = (type: LessonExerciseType, features: SubjectFeatures) =>
      TYPE_CARDS[type].example?.(features) as unknown as LessonExerciseDraft;
    const plain: SubjectFeatures = { groundingRequired: false, usesV3Payload: false, answerLocale: "en-GB", instructionIsStimulus: false };
    const choice = exampleOf("lesson_choice", plain);
    const texts = choice.options!.map((option) => option.text);
    const base = [...texts].sort((a, b) => a.length - b.length)[0]!;
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts.every((text) => text.startsWith(base)), "opcje to formy jednego czasownika").toBe(true);
    expect(texts.filter((text) => text === choice.answer)).toHaveLength(1);
    const gap = exampleOf("lesson_gap", plain);
    expect(gap.hint, "luka bez bodźca ma formę podstawową w podpowiedzi").toBeDefined();
    expect(gap.answer.startsWith(gap.hint!) && gap.answer !== gap.hint).toBe(true);

    const stimulus = { ...plain, instructionIsStimulus: true };
    for (const type of ["lesson_choice", "lesson_gap"] as const) {
      const example = exampleOf(type, stimulus);
      const task = exampleOf(type, plain);
      // Polskie zdanie-bodziec przed poleceniem; podpowiedzi przy bodźcu nie ma (rozdział jej nie przyjmuje).
      expect(example.instructionPl!.split(". ").length, type).toBeGreaterThan(1);
      expect(example).not.toHaveProperty("hint");
      expect(task.instructionPl!.split(". ")).toHaveLength(1);
    }
  });

  it("język odpowiedzi bez treści przykładów nie daje przykładu", () => {
    const features = { groundingRequired: true, usesV3Payload: true, answerLocale: "de-DE", instructionIsStimulus: false };
    for (const [type, card] of Object.entries(TYPE_CARDS)) {
      expect(card.example?.(features), type).toBeUndefined();
    }
  });
});
