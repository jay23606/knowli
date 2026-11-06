import { describe, expect, it } from "vitest";
import type { DynamicObjectiveKind, LessonExerciseDraft } from "../types";
import { historyLikeSubject } from "../testing/history-like-subject";
import { agentTestSubject, withAgentPolicy } from "../testing/agent-test-subject";
import { agentObjectivesOf } from "./capable";
import { messagesOf } from "../rules/catalog";

describe("agentObjectivesOf", () => {
  const topic = historyLikeSubject.topics[0]!;

  it("zachowuje kolejność, karty i typy ćwiczeń zagadnień", () => {
    const objectives = agentObjectivesOf(topic);
    expect(objectives.map((objective) => objective.id)).toEqual(topic.objectives.map((objective) => objective.id));
    expect(objectives[0]).toEqual({
      id: topic.objectives[0]!.id,
      titlePl: topic.objectives[0]!.titlePl,
      descriptionEn: topic.objectives[0]!.descriptionEn,
      cards: topic.objectives[0]!.cards.map((card) => ({ title: card.title, body: card.body })),
      exerciseTypes: topic.objectives[0]!.exerciseTypes,
    });
    expect(objectives[0]).not.toHaveProperty("kind");
  });

  it("bierze rodzaj zagadnienia z mapy i pomija go, gdy mapa go nie zna", () => {
    const [first, second] = topic.objectives;
    const kinds = new Map<string, DynamicObjectiveKind>([[second!.id, "frame"]]);
    const objectives = agentObjectivesOf(topic, kinds);
    expect(objectives[0]).not.toHaveProperty("kind");
    expect(objectives[1]!.kind).toBe("frame");
    expect(objectives[0]!.id).toBe(first!.id);
  });
});

describe("agentTestSubject", () => {
  const draft = (over: Partial<LessonExerciseDraft>): LessonExerciseDraft => ({
    exerciseType: "lesson_open_answer",
    objectiveId: "o",
    answer: "a",
    acceptedAnswers: ["a"],
    focus: [],
    ...over,
  });

  it("ma typy keywords i listen_choice oraz zaślepkę polityki", () => {
    expect(agentTestSubject.exerciseTypes).toEqual(expect.arrayContaining(["lesson_keywords", "lesson_listen_choice"]));
    expect(agentTestSubject.agentPolicy.blindSolveTypes).toEqual(agentTestSubject.exerciseTypes);
    expect(agentTestSubject.agentPolicy.ruleNotes).toEqual({ "lesson.leak": "leak victim", "lesson.leak_source": "leak source" });
  });

  it("validatePoolExtra wymaga rodziny pytania otwartego dla słów kluczowych", () => {
    const keywords = draft({ exerciseType: "lesson_keywords", familyId: "f" });
    expect(agentTestSubject.validatePoolExtra!([keywords], { material: "" }).get(0)?.map((issue) => issue.pl)).toEqual([
      "keywords without open-answer family",
    ]);
    expect(agentTestSubject.validatePoolExtra!([keywords, draft({ familyId: "f" })], { material: "" }).size).toBe(0);
    // Rodzina innego zagadnienia nie wystarcza (jak w szkole i `withoutOrphanKeywords`).
    expect(agentTestSubject.validatePoolExtra!([keywords, draft({ familyId: "f", objectiveId: "other" })], { material: "" }).size).toBe(1);
  });

  it("refineGeneratedPool usuwa wariant DROP i odrzuca REFINE-REJECT", () => {
    const result = agentTestSubject.refineGeneratedPool!(
      [draft({ acceptedAnswers: ["a", "DROP"] }), draft({ answer: "REFINE-REJECT" })],
      { material: "" },
    );
    expect(result.kept.map((kept) => kept.acceptedAnswers)).toEqual([["a"]]);
    expect(result.rejected.flatMap((rejected) => messagesOf(rejected.issues))).toEqual(["refine reject"]);
  });

  it("withAgentPolicy nadpisuje wybrane pola polityki", () => {
    const wrapped = withAgentPolicy(historyLikeSubject, { slack: 5 });
    expect(wrapped.agentPolicy.slack).toBe(5);
    expect(wrapped.agentPolicy.independentReserve).toBe(1);
  });
});
