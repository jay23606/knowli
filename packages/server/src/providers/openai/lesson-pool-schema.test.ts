import { describe, expect, it } from "vitest";
import type { LessonPoolInput } from "../../ports/ai";
import { lessonPoolJsonSchema, voiceToneProperty } from "./lesson-pool-schema";

const input: LessonPoolInput = {
  subjectId: "subject",
  subjectTitle: "Subject",
  answerLocale: "en-GB",
  promptLocale: "pl-PL",
  promptProfile: { generationRole: "role", gradingRole: "grade", almostDefinition: "almost" },
  exerciseTypes: ["lesson_card", "lesson_choice", "lesson_gap", "lesson_transform"],
  transforms: [{ id: "to_negative", instructionPl: "Zmień na przeczenie" }],
  objectives: [{
    id: "objective-a",
    descriptionEn: "Objective A",
    exerciseTypes: ["lesson_choice", "lesson_gap", "lesson_card"],
    errorCategories: [],
  }],
  material: "play",
  countPerObjective: 3,
  stageCounts: { guided: 1, productive: 1, independent: 1 },
  graderAvailable: false,
};

describe("lessonPoolJsonSchema", () => {
  it("requires 1–3 quotes per exercise when grounding is required, keeps them optional otherwise", () => {
    const grounded = lessonPoolJsonSchema({ ...input, groundingRequired: true }) as any;
    expect(grounded.properties.exercises.items.properties.sourceRefs).toMatchObject({ type: "array", minItems: 1, maxItems: 3 });
    const plain = lessonPoolJsonSchema(input) as any;
    expect(plain.properties.exercises.items.properties.sourceRefs.type).toEqual(["null", "array"]);
    expect(plain.properties.exercises.items.properties.sourceRefs).not.toHaveProperty("minItems");
  });

  it("gives calculations a strict parameter-only branch, with all three closed kinds", () => {
    const schema = lessonPoolJsonSchema({
      ...input,
      exerciseTypes: ["lesson_gap", "lesson_calculation"],
      objectives: [{ ...input.objectives[0]!, exerciseTypes: ["lesson_gap", "lesson_calculation"] }],
    }) as any;
    const branches = schema.properties.exercises.items.anyOf;
    expect(branches).toHaveLength(2);
    const calculation = branches.find((branch: any) => branch.properties.exerciseType.enum.includes("lesson_calculation"));
    expect(calculation.required.sort()).toEqual(["exerciseType", "objectiveId", "calculation", "sourceRefs"].sort());
    expect(calculation.properties).not.toHaveProperty("answer");
    expect(calculation.properties).not.toHaveProperty("prompt");
    expect(calculation.additionalProperties).toBe(false);
    const kinds = calculation.properties.calculation.anyOf;
    expect(kinds.map((kind: any) => kind.properties.kind.enum[0])).toEqual(["scale_distance", "height_difference", "unit_conversion"]);
    expect(kinds[0].properties.params.required).toEqual(["scaleDenominator", "mapDistanceCm"]);
    for (const kind of kinds) {
      expect(kind.additionalProperties).toBe(false);
      expect(kind.properties.params.additionalProperties).toBe(false);
      expect(kind.required.sort()).toEqual(Object.keys(kind.properties).sort());
    }
    expect(branches[0].properties.exerciseType.enum).toEqual(["lesson_gap"]);
  });

  it("gives keywords a strict branch without answer, linked to an open-answer family", () => {
    const schema = lessonPoolJsonSchema({
      ...input,
      exerciseTypes: ["lesson_gap", "lesson_open_answer", "lesson_keywords"],
      objectives: [{ ...input.objectives[0]!, exerciseTypes: ["lesson_gap", "lesson_open_answer", "lesson_keywords"] }],
    }) as any;
    const branches = schema.properties.exercises.items.anyOf;
    expect(branches).toHaveLength(2);
    const keywords = branches.find((branch: any) => branch.properties.exerciseType.enum.includes("lesson_keywords"));
    expect(keywords.required.sort()).toEqual(["exerciseType", "objectiveId", "familyId", "keywordOptions", "keyOptionIds", "sourceRefs"].sort());
    expect(keywords.properties).not.toHaveProperty("answer");
    expect(keywords.additionalProperties).toBe(false);
    expect(keywords.properties.keywordOptions).toMatchObject({ minItems: 4, maxItems: 6 });
    expect(keywords.properties.keyOptionIds).toMatchObject({ minItems: 2, maxItems: 3 });
    expect(branches[0].properties.exerciseType.enum).toEqual(["lesson_gap", "lesson_open_answer"]);
  });

  it("keeps strict root, nullable required fields, and only the objective's pool types", () => {
    const schema = lessonPoolJsonSchema(input) as any;
    const item = schema.properties.exercises.items;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["exercises", "examples"] });
    expect(item.properties.exerciseType.enum).toEqual(["lesson_choice", "lesson_gap"]);
    expect(item.properties.objectiveId.enum).toEqual(["objective-a"]);
    expect(item.properties.transformId.enum).toEqual([null, "to_negative"]);
    expect(item.properties.options.type).toEqual(["null", "array"]);
    expect(item.required.sort()).toEqual(Object.keys(item.properties).sort());
    expect(item.additionalProperties).toBe(false);
    expect(schema.properties.examples.items.properties.objectiveId.enum).toEqual(["objective-a"]);
  });

  it("uses complete strict branches to pair each objective with its allowed exercise types", () => {
    const schema = lessonPoolJsonSchema({
      ...input,
      objectives: [
        { ...input.objectives[0]!, id: "objective-a", exerciseTypes: ["lesson_choice"] },
        { ...input.objectives[0]!, id: "objective-b", exerciseTypes: ["lesson_gap"] },
      ],
    }) as any;
    const branches = schema.properties.exercises.items.anyOf;
    expect(branches.map((branch: any) => [branch.properties.objectiveId.enum[0], branch.properties.exerciseType.enum[0]])).toEqual([
      ["objective-a", "lesson_choice"],
      ["objective-b", "lesson_gap"],
    ]);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required.sort()).toEqual(Object.keys(branch.properties).sort());
    }
  });

  it("dopuszcza lesson_listen_choice w zwykłej gałęzi tylko dla celu, który go wymienia", () => {
    const withListen = lessonPoolJsonSchema({
      ...input,
      exerciseTypes: [...input.exerciseTypes, "lesson_listen_choice"],
      objectives: [{ ...input.objectives[0]!, exerciseTypes: ["lesson_choice", "lesson_listen_choice", "lesson_gap"] }],
      listenChoicePerObjective: 2,
    }) as any;
    const branch = withListen.properties.exercises.items;
    expect(branch.properties.exerciseType.enum).toEqual(["lesson_choice", "lesson_listen_choice", "lesson_gap"]);
    // Zwykła gałąź niesie stem, options i correctOption potrzebne typowi słuchowemu.
    expect(branch.required).toEqual(expect.arrayContaining(["stem", "options", "correctOption", "focus"]));
    const without = lessonPoolJsonSchema(input) as any;
    expect(without.properties.exercises.items.properties.exerciseType.enum).not.toContain("lesson_listen_choice");
  });

  it("rejects empty objective sets and objectives with no supported pool types", () => {
    expect(() => lessonPoolJsonSchema({ ...input, objectives: [] })).toThrow(/at least one objective/);
    expect(() => lessonPoolJsonSchema({
      ...input,
      objectives: [{ ...input.objectives[0]!, exerciseTypes: ["lesson_card"] }],
    })).toThrow(/no supported pool exercise types/);
  });
});

describe("lessonPoolJsonSchema — pary i grupy (design szkoły §10.6)", () => {
  it("dokłada ścisłe gałęzie lesson_match i lesson_group bez pola odpowiedzi", () => {
    const schema = lessonPoolJsonSchema({
      ...input,
      exerciseTypes: ["lesson_choice", "lesson_match", "lesson_group"],
      objectives: [{ ...input.objectives[0]!, exerciseTypes: ["lesson_choice", "lesson_match", "lesson_group"] }],
    }) as any;
    const branches = schema.properties.exercises.items.anyOf;
    const byType = Object.fromEntries(branches.map((branch: any) => [branch.properties.exerciseType.enum.join(","), branch]));
    expect(Object.keys(byType)).toEqual(["lesson_choice", "lesson_match", "lesson_group"]);
    for (const type of ["lesson_match", "lesson_group"]) {
      const branch = byType[type];
      expect(branch.additionalProperties).toBe(false);
      expect(branch.properties.answer).toBeUndefined();
      expect(branch.required.sort()).toEqual(Object.keys(branch.properties).sort());
    }
    expect(byType.lesson_match.properties.pairs).toMatchObject({ minItems: 3, maxItems: 5 });
    expect(byType.lesson_group.properties.groupItems).toMatchObject({ minItems: 4, maxItems: 8 });
  });

  it("dokłada ścisłą gałąź lesson_cloze bez pola odpowiedzi (design szkoły §13.6)", () => {
    const schema = lessonPoolJsonSchema({
      ...input,
      exerciseTypes: ["lesson_choice", "lesson_cloze"],
      objectives: [{ ...input.objectives[0]!, exerciseTypes: ["lesson_choice", "lesson_cloze"] }],
    }) as any;
    const branches = schema.properties.exercises.items.anyOf;
    const cloze = branches.find((branch: any) => branch.properties.exerciseType.enum[0] === "lesson_cloze");
    expect(cloze.additionalProperties).toBe(false);
    expect(cloze.properties.answer).toBeUndefined();
    expect(cloze.required.sort()).toEqual(Object.keys(cloze.properties).sort());
    expect(cloze.properties.gapAnswers).toMatchObject({ minItems: 2, maxItems: 4 });
    expect(cloze.properties.extraWords).toMatchObject({ minItems: 1, maxItems: 2 });
    expect(cloze.properties.clozeText).toMatchObject({ maxLength: 300 });
  });
});

describe("lessonPoolJsonSchema — ton lektora (stage B)", () => {
  const tones = [null, "cheerful", "curious", "gentle", "mysterious"];
  const allTypes = ["lesson_choice", "lesson_calculation", "lesson_keywords", "lesson_match", "lesson_group", "lesson_cloze"];
  const wide: LessonPoolInput = {
    ...input,
    exerciseTypes: allTypes,
    objectives: [{ ...input.objectives[0]!, exerciseTypes: allTypes }],
  };

  it("voiceToneProperty is a nullable strict enum of the contract tones; without whisper there is no mysterious", () => {
    expect(voiceToneProperty()).toEqual({ type: ["null", "string"], enum: tones });
    expect(voiceToneProperty({ whisper: false })).toEqual({ type: ["null", "string"], enum: [null, "cheerful", "curious", "gentle"] });
  });

  it("adds a required nullable voiceTone to every branch except calculation when voiceTones is true", () => {
    const schema = lessonPoolJsonSchema({ ...wide, voiceTones: true }) as any;
    const branches = schema.properties.exercises.items.anyOf;
    expect(branches).toHaveLength(6);
    for (const branch of branches) {
      const type = branch.properties.exerciseType.enum[0];
      if (type === "lesson_calculation") {
        expect(branch.properties).not.toHaveProperty("voiceTone");
        expect(branch.required).not.toContain("voiceTone");
        continue;
      }
      // Pytania nie są szeptane: ćwiczenia nie dostają `mysterious`.
      expect(branch.properties.voiceTone).toEqual({ type: ["null", "string"], enum: [null, "cheerful", "curious", "gentle"] });
      expect(branch.required).toContain("voiceTone");
      expect(branch.required.sort()).toEqual(Object.keys(branch.properties).sort());
    }
  });

  it("is byte-identical to the schema without the flag when voiceTones is false or absent", () => {
    const base = JSON.stringify(lessonPoolJsonSchema(wide));
    expect(JSON.stringify(lessonPoolJsonSchema({ ...wide, voiceTones: false }))).toBe(base);
    expect(base).not.toContain("voiceTone");
  });
});

describe("lessonPoolJsonSchema — cytaty w gałęziach pary/grupy/luki zależą od groundingRequired", () => {
  const dedicated = (groundingRequired: boolean | undefined) => {
    const schema = lessonPoolJsonSchema({
      ...input,
      exerciseTypes: ["lesson_match", "lesson_group", "lesson_cloze"],
      objectives: [{ ...input.objectives[0]!, exerciseTypes: ["lesson_match", "lesson_group", "lesson_cloze"] }],
      ...(groundingRequired === undefined ? {} : { groundingRequired }),
    }) as any;
    return Object.fromEntries(
      schema.properties.exercises.items.anyOf.map((branch: any) => [branch.properties.exerciseType.enum[0], branch]),
    ) as Record<string, any>;
  };

  it.each(["lesson_match", "lesson_group", "lesson_cloze"])("%s: bez uziemienia sourceRefs jest nullowalne i bez minItems", (type) => {
    for (const grounding of [false, undefined]) {
      const branch = dedicated(grounding)[type];
      expect(branch.properties.sourceRefs.type).toEqual(["array", "null"]);
      expect(branch.properties.sourceRefs).not.toHaveProperty("minItems");
      // Tryb strict: pole zostaje wymagane (model zwraca null), gałąź nadal zamknięta.
      expect(branch.required).toContain("sourceRefs");
      expect([...branch.required].sort()).toEqual(Object.keys(branch.properties).sort());
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it.each(["lesson_match", "lesson_group", "lesson_cloze"])("%s: z uziemieniem wymaga 1–3 cytatów jak dotąd", (type) => {
    const branch = dedicated(true)[type];
    expect(branch.properties.sourceRefs).toMatchObject({ type: "array", minItems: 1, maxItems: 3 });
    expect(branch.properties.sourceRefs.items.properties.quote).toMatchObject({ minLength: 10, maxLength: 600 });
  });
});
