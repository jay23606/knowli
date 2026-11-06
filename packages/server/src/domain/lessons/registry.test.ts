import { describe, expect, it } from "vitest";
import { createSubjectRegistry } from "./registry";
import { historyLikeSubject } from "./testing/history-like-subject";
import { testAgentPolicy } from "./testing/test-agent-policy";
import { createProductionSubjectRegistry } from "./subjects";
import type { LessonTopic, SubjectModule } from "./types";

function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Przedmiot z dwiema wersjami tego samego tematu, do testów odczytu wersji. */
function subjectWithTopicVersions(): SubjectModule {
  const v1Topic = cloneData(historyLikeSubject.topics[0] as LessonTopic);
  const v2Topic: LessonTopic = { ...cloneData(v1Topic), version: 2, titlePl: "Początki państwa Piastów (v2)" };
  return { ...historyLikeSubject, topics: [v1Topic, v2Topic] };
}

describe("createSubjectRegistry", () => {
  it("rejestruje poprawny przedmiot i udostępnia go po id", () => {
    const registry = createSubjectRegistry([historyLikeSubject]);
    expect(registry.getSubject("test_history")).toBe(historyLikeSubject);
    expect(registry.listSubjects()).toEqual([historyLikeSubject]);
  });

  it("odrzuca przedmiot bez polityki agenta, nazywając pole i przedmiot", () => {
    const withoutPolicy = { ...historyLikeSubject, agentPolicy: undefined } as unknown as SubjectModule;
    expect(() => createSubjectRegistry([withoutPolicy])).toThrow(/agentPolicy/);
    expect(() => createSubjectRegistry([withoutPolicy])).toThrow(/test_history/);
  });

  it("historyLikeSubject ma wspólną politykę testową", () => {
    expect(historyLikeSubject.agentPolicy).toBe(testAgentPolicy);
  });

  it("każdy przedmiot produkcyjny ma politykę agenta", () => {
    for (const subject of createProductionSubjectRegistry().listSubjects()) {
      expect(subject.agentPolicy, subject.id).toBeDefined();
    }
  });

  it("odrzuca przedmiot bez katalogu reguł", () => {
    const withoutRules = { ...historyLikeSubject, rules: undefined } as unknown as SubjectModule;
    expect(() => createSubjectRegistry([withoutRules])).toThrow(/rules/);
  });

  it("odrzuca ten sam id reguły w dwóch przedmiotach z różnymi wpisami", () => {
    const rule = { field: "answer", kind: "reject", description: "Shared fixture." } as const;
    const first: SubjectModule = { ...historyLikeSubject, rules: { "shared.fixture": rule } };
    const second: SubjectModule = { ...historyLikeSubject, id: "test_history_2", rules: { "shared.fixture": { ...rule } } };
    expect(() => createSubjectRegistry([first, second])).toThrow(/shared\.fixture.*test_history_2.*test_history/);
  });

  it("dopuszcza wspólny obiekt wpisu reguły w dwóch przedmiotach", () => {
    const shared = { "shared.fixture": { field: "answer", kind: "reject", description: "Shared fixture." } } as const;
    const first: SubjectModule = { ...historyLikeSubject, rules: shared };
    const second: SubjectModule = { ...historyLikeSubject, id: "test_history_2", rules: { ...shared } };
    expect(createSubjectRegistry([first, second]).listSubjects()).toHaveLength(2);
  });

  it("odrzuca zduplikowane id przedmiotów", () => {
    expect(() => createSubjectRegistry([historyLikeSubject, historyLikeSubject])).toThrow(/test_history/);
  });

  it("odrzuca moduł nieprzechodzący validateSubject z listą błędów", () => {
    const broken: SubjectModule = {
      ...historyLikeSubject,
      topics: [{ ...cloneData(historyLikeSubject.topics[0] as LessonTopic), objectives: [] }],
    };
    expect(() => createSubjectRegistry([broken])).toThrow();
    try {
      createSubjectRegistry([broken]);
      expect.unreachable("powinno rzucić");
    } catch (error) {
      expect((error as Error).message).toMatch(/cel|celu/i);
    }
  });

  it("odczytuje temat po wersji", () => {
    const subject = subjectWithTopicVersions();
    const registry = createSubjectRegistry([subject]);
    expect(registry.getTopic("test_history", "piast_origins", 1)?.version).toBe(1);
    expect(registry.getTopic("test_history", "piast_origins", 2)?.version).toBe(2);
  });

  it("odczytuje najnowszą wersję tematu", () => {
    const subject = subjectWithTopicVersions();
    const registry = createSubjectRegistry([subject]);
    expect(registry.getLatestTopic("test_history", "piast_origins")?.version).toBe(2);
  });

  it("nieznany przedmiot/temat/wersja → undefined (bez wyjątku przy odczycie)", () => {
    const registry = createSubjectRegistry([historyLikeSubject]);
    expect(registry.getSubject("brak")).toBeUndefined();
    expect(registry.getTopic("brak", "piast_origins", 1)).toBeUndefined();
    expect(registry.getTopic("test_history", "brak", 1)).toBeUndefined();
    expect(registry.getTopic("test_history", "piast_origins", 99)).toBeUndefined();
    expect(registry.getLatestTopic("test_history", "brak")).toBeUndefined();
    expect(registry.getLatestTopic("brak", "piast_origins")).toBeUndefined();
  });

  it("pusty rejestr jest poprawny", () => {
    const registry = createSubjectRegistry([]);
    expect(registry.listSubjects()).toEqual([]);
    expect(registry.getSubject("test_history")).toBeUndefined();
  });
});
