import { describe, expect, it } from "vitest";
import { agentObjectivesOf } from "../../domain/lessons/agent/capable";
import { createLessonAgentState } from "../../domain/lessons/agent/state";
import { cardExposureSources } from "../../domain/lessons/card-exposure-sources";
import { lessonPoolMinimums } from "../../domain/lessons/lesson-coverage";
import { ENGINE_CATALOGS, type LessonRule } from "../../domain/lessons/rules/catalog";
import { ruleBookContextFor } from "../../domain/lessons/rules/rule-book";
import { englishChapterSubject } from "../../domain/lessons/subjects/english-chapter/module";
import { englishGrammarSubject } from "../../domain/lessons/subjects/english-grammar/module";
import { schoolSubject } from "../../domain/lessons/subjects/school/module";
import { validateDynamicTopicData } from "../../domain/lessons/topic-resolution";
import type { LessonExerciseType, LessonTopic, SubjectModule } from "../../domain/lessons/types";
import { buildDynamicTopicData, withSubjectObjectiveKinds } from "../../modules/materials/lessons/lesson-drafts";
import { kindsOf, lessonAgentLimits } from "../../modules/materials/lessons/lesson-pool-agent";
import { objectiveAgentInput } from "../../modules/materials/lessons/lesson-pool-agent-input";
import type { LessonObjectiveAgentInput } from "../../ports/ai";
import { FakeLlmProvider } from "../fake";
import { fakePlanFromCoverage } from "../fake-lesson-agent";
import { objectiveInstructions } from "./lesson-pool-agent";
import { repeatText } from "./llm";

/**
 * Złożony prompt podagenta z księgi reguł (spec katalogu reguł §2.4 pkt 5–6, §3) na fikcyjnych
 * materiałach z testów, dla zagadnienia z najdłuższym promptem każdego przedmiotu: księga reguł jest
 * w prompcie, reguły typów niedozwolonych w nim nie występują, zdań potoku nie ma, `Target` niesie
 * minima publikacji, migawka per przedmiot (zmiana reguły widać w diffie PR) i budżet długości.
 */

const CHAPTER_MATERIAL = ["Słowa:", "coat — płaszcz", "boots — buty", "scarf — szalik", "gloves — rękawiczki", "Zwroty:", "I am wearing …", "Put on your …"].join("\n");
const SCHOOL_MATERIAL = [
  "Zagadnienie 1: Rzeki Polski",
  "Wisła jest najdłuższą rzeką Polski. Odra płynie na zachodzie kraju.",
  "Zagadnienie 2: Góry Polski",
  "Tatry są najwyższymi górami Polski. Sudety leżą na południowym zachodzie.",
  "Zagadnienie 3: Morze",
  "Bałtyk jest morzem śródlądowym. Hel to półwysep.",
].join("\n");

interface PromptFixture {
  readonly subject: SubjectModule;
  readonly topic: LessonTopic;
  readonly input: LessonObjectiveAgentInput;
}

function fixtureFor(args: {
  subject: SubjectModule;
  topic: LessonTopic;
  material: string;
  objectiveId: string;
  kinds?: ReadonlyMap<string, "words" | "frame">;
  examples?: Readonly<Record<string, readonly string[]>>;
  examplesFixed?: boolean;
}): PromptFixture {
  const { subject, topic } = args;
  const limits = lessonAgentLimits(subject, topic, 0);
  const objectives = agentObjectivesOf(topic, args.kinds);
  const state = createLessonAgentState({ topic, objectives, fixed: [], examples: args.examples ?? {}, fixedSources: cardExposureSources(subject, topic) });
  const objective = objectives.find((candidate) => candidate.id === args.objectiveId)!;
  const input = objectiveAgentInput({
    subject,
    topic,
    state,
    objective,
    limits: limits.get(objective.id)!,
    material: args.material,
    graderAvailable: true,
    examplesFixed: args.examplesFixed ?? false,
    maxSteps: 8,
    callTimeoutMs: 90_000,
  });
  return { subject, topic, input };
}

async function fixtures(): Promise<Record<string, PromptFixture>> {
  const grammarTopic = englishGrammarSubject.topics.find((candidate) => candidate.id === "present_simple")!;
  const grammar = fixtureFor({ subject: englishGrammarSubject, topic: grammarTopic, material: "", objectiveId: "english_grammar.present_simple.question" });
  // Temat „to be” ma własne reguły (`when` na temat): migawka zagadnienia z wyborem obrazka (reguły piktogramu i wskazówki tematu).
  const toBeTopic = englishGrammarSubject.topics.find((candidate) => candidate.id === "to_be")!;
  const grammarToBe = fixtureFor({ subject: englishGrammarSubject, topic: toBeTopic, material: "", objectiveId: "english_grammar.to_be.affirmative_forms" });

  const { objectives } = await new FakeLlmProvider().generateLessonObjectives({
    subjectTitle: schoolSubject.titlePl,
    topicTitle: "Polska",
    material: SCHOOL_MATERIAL,
    generationRole: schoolSubject.prompts.generationRole,
  });
  const built = buildDynamicTopicData(objectives, schoolSubject.id, "42", "Polska", (objective) =>
    validateDynamicTopicData(schoolSubject, { titlePl: "Polska", objectives: [objective] }),
  );
  const schoolTopic = schoolSubject.buildDynamicTopic!(withSubjectObjectiveKinds(schoolSubject, built.data!));
  const school = fixtureFor({ subject: schoolSubject, topic: schoolTopic, material: SCHOOL_MATERIAL, objectiveId: schoolTopic.objectives[0]!.id });

  const plan = fakePlanFromCoverage({
    subjectTitle: englishChapterSubject.titlePl,
    topicTitle: "Unit 1",
    material: CHAPTER_MATERIAL,
    generationRole: "",
    objectiveCount: { min: 3, max: 6 },
    coverage: englishChapterSubject.agentPolicy.planCoverage!(CHAPTER_MATERIAL),
    maxSteps: 8,
  });
  const data = buildDynamicTopicData(plan.objectives, englishChapterSubject.id, "42", "Unit 1").data!;
  const examples = Object.fromEntries(data.objectives.map((objective, index) => [objective.id, plan.objectives[index]!.examples as string[]]));
  const chapterTopic = englishChapterSubject.buildDynamicTopic!(data);
  const chapter = fixtureFor({
    subject: englishChapterSubject,
    topic: chapterTopic,
    material: CHAPTER_MATERIAL,
    objectiveId: chapterTopic.objectives[0]!.id,
    kinds: kindsOf(data),
    examples,
    examplesFixed: true,
  });
  return { english_grammar: grammar, english_grammar_to_be: grammarToBe, school, english_chapter: chapter };
}

const FIXTURES = await fixtures();
const SUBJECT_IDS = ["english_grammar", "english_grammar_to_be", "school", "english_chapter"] as const;

/**
 * Budżet długości promptu per przedmiot (rozstrzygnięcie kontrolera Task 8b: ≤ 1,5 × długości sprzed
 * katalogu reguł; po cięciach przeglądu końcowego I8 obniżony do 1,4 ×). Pomiar „przed” 2026-11-06 na HEAD
 * 2ca25cf2, te same fikstury i zagadnienia: gramatyka `present_simple.question` 14 841, szkoła `rzeki_polski`
 * 17 344, rozdział `part_1` 17 259 znaków.
 */
const PROMPT_LENGTH_BEFORE: Readonly<Partial<Record<(typeof SUBJECT_IDS)[number], number>>> = {
  english_grammar: 14_841,
  school: 17_344,
  english_chapter: 17_259,
};
const PROMPT_BUDGET_FACTOR = 1.4;

/** Zdania potoku sprzeczne z trybem narzędzi (spec §3 „Usuwane bez odpowiednika”). */
const REMOVED_PIPELINE_PHRASES = [
  "Return strict JSON",
  "no markdown",
  "exercises per objective in this batch",
  "160-exercise",
  "never exceed this batch",
];

/** Reguły wszystkich katalogów przedmiotu (rdzeń, lekcja, przedmiot). */
function rulesOf(subject: SubjectModule): [string, LessonRule][] {
  return [...ENGINE_CATALOGS, subject.rules].flatMap((catalog) => Object.entries(catalog));
}

describe.each(SUBJECT_IDS)("prompt podagenta z księgi reguł — %s", (subjectId) => {
  const { subject, topic, input } = FIXTURES[subjectId]!;
  const prompt = objectiveInstructions(input);
  const allowed = input.pool.objectives[0]!.exerciseTypes as readonly LessonExerciseType[];
  const ctx = ruleBookContextFor(subject, topic.id, input.pool.objectives[0]!.id, allowed, allowed.includes("lesson_listen_choice"));

  it("księga reguł zagadnienia jest w prompcie: reguła z opisem po id, powtórzenie z odesłaniem, reguły `brief` poza promptem", () => {
    const book = input.pool.ruleBook;
    const lines = [book.general, ...book.types.map((block) => block.rules), book.lesson, book.checks].flat();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      if (line.brief === true) expect(prompt, line.id).not.toContain(`[${line.id}]`);
      else if (line.repeatOf === undefined) expect(prompt, line.id).toContain(`[${line.id}] ${line.text}`);
      else expect(prompt, line.id).toContain(`[${line.id}] ${repeatText(line.repeatOf)}`);
    }
    // Pełny opis reguły powtarzanej w blokach typów stoi w prompcie raz.
    for (const line of lines.filter((candidate) => candidate.repeatOf !== undefined)) {
      expect(prompt.split(`[${line.id}] ${line.text}`).length - 1, line.id).toBe(1);
    }
    for (const block of book.types) {
      expect(prompt).toContain(`${block.type} — ${block.summary}`);
      if (block.example !== undefined) expect(prompt).toContain(block.example);
      if (block.subjectRule !== undefined) expect(prompt).toContain(block.subjectRule);
    }
  });

  it("każda pasująca reguła reject/sanitize jest w prompcie, reguła typu niedozwolonego — nie", () => {
    for (const [id, rule] of rulesOf(subject)) {
      if (rule.kind === "internal") {
        expect(prompt, id).not.toContain(`[${id}]`);
        continue;
      }
      const typeMatches = rule.types === undefined || rule.types.some((type) => allowed.includes(type));
      if (!typeMatches || rule.promptBrief === true) expect(prompt, id).not.toContain(`[${id}]`);
      else if (rule.when === undefined || rule.when(ctx)) expect(prompt, id).toContain(`[${id}]`);
    }
  });

  it("bez zdań potoku i bez promptNotes", () => {
    for (const phrase of REMOVED_PIPELINE_PHRASES) expect(prompt).not.toContain(phrase);
    expect(input).not.toHaveProperty("promptNotes");
  });

  it("Target zawiera minima publikacji ze stałych przedmiotu", () => {
    const minima = lessonPoolMinimums(subject);
    const target = prompt.slice(prompt.indexOf("Target:"));
    expect(target).toContain(
      `Publication minima of the complete objective pool (exercises already in the lesson count too): ${minima.guided} guided, ` +
        `${minima.productive} productive and ${minima.independent} independent`,
    );
  });

  it("migawka promptu", async () => {
    await expect(prompt).toMatchFileSnapshot(`./__snapshots__/lesson-pool-prompt.${subjectId}.txt`);
  });

  // Temat „to be” nie ma pomiaru „przed” (migawka od przeglądu końcowego); budżet tylko dla zmierzonych zagadnień.
  it.runIf(PROMPT_LENGTH_BEFORE[subjectId] !== undefined)(`budżet długości: najwyżej ${PROMPT_BUDGET_FACTOR} × długości sprzed katalogu reguł`, () => {
    expect(prompt.length).toBeLessThanOrEqual(Math.floor(PROMPT_LENGTH_BEFORE[subjectId]! * PROMPT_BUDGET_FACTOR));
  });
});
