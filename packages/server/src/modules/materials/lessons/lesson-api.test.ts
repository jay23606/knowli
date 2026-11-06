import { describe, expect, it } from "vitest";
import { LessonDraftDtoSchema, SubjectCatalogDtoSchema } from "@learning/contracts";
import { createServices } from "../../../config";
import { createSubjectRegistry, type SubjectRegistry } from "../../../domain/lessons/registry";
import { englishChapterSubject } from "../../../domain/lessons/subjects/english-chapter/module";
import { generationGapsDto, lessonCatalog, readLessonContext } from "./lesson-api";
import { createLessonFromMaterial, createMaterialLesson } from "./lesson-drafts";

describe("lessonCatalog (sposób tworzenia zestawu per przedmiot)", () => {
  const catalog = lessonCatalog(createServices({ db: {} as never }));
  const byId = (id: string) => catalog.subjects.find((subject) => subject.id === id);

  it("zwraca poprawny kontrakt katalogu", () => {
    expect(SubjectCatalogDtoSchema.safeParse(catalog).success).toBe(true);
  });

  it("przedmiot z tematami katalogowymi: creation catalog, bez nazwy od rodzica", () => {
    expect(byId("english_grammar")).toMatchObject({ creation: "catalog", subjectTitleRequired: false });
    expect(byId("english_grammar")!.topics.length).toBeGreaterThan(0);
  });

  it("acceptsInterests tylko dla przedmiotu z regułą tematów zdań (gramatyka)", () => {
    expect(byId("english_grammar")!.acceptsInterests).toBe(true);
    expect(byId("school")!.acceptsInterests).toBe(false);
    expect(byId("english_chapter")!.acceptsInterests).toBe(false);
  });

  it("offersListenChoice dla przedmiotów z nagraniem zdania i typem „Posłuchaj i wybierz”", () => {
    expect(byId("english_grammar")!.offersListenChoice).toBe(true);
    expect(byId("english_chapter")!.offersListenChoice).toBe(true);
    expect(byId("school")!.offersListenChoice).toBe(false);
    const objectives = byId("english_grammar")!.topics.flatMap((topic) => topic.objectives);
    expect(objectives.find((o) => o.id.endsWith(".third_person_s"))!.offersListenChoice).toBe(true);
    expect(objectives.find((o) => o.id.endsWith(".spelling_es_ies"))!.offersListenChoice).toBe(false);
  });

  it("generationService tylko gdy jest skonfigurowane w usługach", () => {
    expect(catalog).not.toHaveProperty("generationService");
    const configured = lessonCatalog(createServices({ db: {} as never, generationService: "openrouter.ai · google/gemini-3.8-flash" }));
    expect(configured.generationService).toBe("openrouter.ai · google/gemini-3.8-flash");
    expect(SubjectCatalogDtoSchema.safeParse(configured).success).toBe(true);
  });

  it("szkoła: z materiału, rodzic nazywa przedmiot", () => {
    expect(byId("school")).toMatchObject({ creation: "material", subjectTitleRequired: true, topics: [] });
  });

  it("rozdział angielski: z materiału, stały tytuł przedmiotu", () => {
    expect(byId("english_chapter")).toMatchObject({
      titlePl: "Angielski — rozdział",
      creation: "material",
      subjectTitleRequired: false,
      topics: [],
    });
  });

  describe("usługi generowania i kontroli per przedmiot (agent puli)", () => {
    const agent = {
      generationService: "openrouter.ai · agent-model",
      checkService: "openrouter.ai · checker-model",
    };
    const withAgent = (extra: { generationService?: string } = {}) =>
      lessonCatalog(createServices({ db: {} as never, lessonAgentPublic: agent, ...extra }));

    it("bez opisu agenta: generowanie niedostępne, przedmioty bez usług agenta", () => {
      const catalog = lessonCatalog(createServices({ db: {} as never, generationService: "openrouter.ai · llm" }));
      expect(catalog.lessonGenerationAvailable).toBe(false);
      // usługa UMIEM_LLM zostaje (etap zagadnień szkoły, historyjka, tematy zdań)
      expect(catalog.generationService).toBe("openrouter.ai · llm");
      for (const subject of catalog.subjects) {
        expect(subject).not.toHaveProperty("generationServices");
        expect(subject).not.toHaveProperty("checkService");
        expect(subject).not.toHaveProperty("checkServiceIncludesMaterial");
        expect(subject).not.toHaveProperty("openCheckService");
      }
      expect(SubjectCatalogDtoSchema.safeParse(catalog).success).toBe(true);
    });

    it("z opisem agenta: generowanie dostępne i usługi dla każdego przedmiotu", () => {
      const catalog = withAgent({ generationService: "openrouter.ai · llm" });
      expect(catalog.lessonGenerationAvailable).toBe(true);
      for (const subject of catalog.subjects) {
        expect(subject.generationServices?.[0]).toBe("openrouter.ai · agent-model");
        expect(subject.checkService).toBe("openrouter.ai · checker-model");
        expect(typeof subject.checkServiceIncludesMaterial).toBe("boolean");
      }
      expect(SubjectCatalogDtoSchema.safeParse(catalog).success).toBe(true);
    });

    it("gramatyka i rozdział: usługi per przedmiot", () => {
      const catalog = withAgent({ generationService: "openrouter.ai · llm" });
      const grammar = catalog.subjects.find((s) => s.id === "english_grammar")!;
      // tematy katalogowe bez etapu zagadnień, ale run historyjki (`lessonStory`) idzie do usługi UMIEM_LLM
      expect(grammar.generationServices).toEqual(["openrouter.ai · agent-model", "openrouter.ai · llm"]);
      expect(grammar.checkService).toBe("openrouter.ai · checker-model");
      expect(grammar.checkServiceIncludesMaterial).toBe(false);
      // rozdział: planer z polityki zastępuje etap zagadnień — usługa UMIEM_LLM nie dostaje materiału
      const chapter = catalog.subjects.find((s) => s.id === "english_chapter")!;
      expect(chapter.generationServices).toEqual(["openrouter.ai · agent-model"]);
      expect(chapter.checkServiceIncludesMaterial).toBe(false);
    });

    it("szkoła: dwie usługi i wariant z materiałem", () => {
      const catalog = withAgent({ generationService: "openrouter.ai · llm" });
      const school = catalog.subjects.find((s) => s.id === "school")!;
      expect(school.generationServices).toEqual(["openrouter.ai · agent-model", "openrouter.ai · llm"]);
      expect(school.checkService).toBe("openrouter.ai · checker-model");
      expect(school.checkServiceIncludesMaterial).toBe(true);
    });

    it("szkoła: ta sama usługa etapu zagadnień i agenta nie dubluje się, brak usługi etapu — sam agent", () => {
      const same = withAgent({ generationService: "openrouter.ai · agent-model" });
      expect(same.subjects.find((s) => s.id === "school")!.generationServices).toEqual(["openrouter.ai · agent-model"]);
      const none = withAgent();
      expect(none.subjects.find((s) => s.id === "school")!.generationServices).toEqual(["openrouter.ai · agent-model"]);
    });

    describe("usługa oceny odpowiedzi próbnych do pytań otwartych (openCheckService)", () => {
      const OPEN = "openrouter.ai · grader-model";
      const withOpen = (openCheckService?: string) =>
        lessonCatalog(createServices({
          db: {} as never,
          lessonAgentPublic: { ...agent, ...(openCheckService ? { openCheckService } : {}) },
        }));

      it("szkoła: pole w DTO", () => {
        const catalog = withOpen(OPEN);
        expect(catalog.subjects.find((s) => s.id === "school")!.openCheckService).toBe(OPEN);
        expect(SubjectCatalogDtoSchema.safeParse(catalog).success).toBe(true);
      });

      it("gramatyka i rozdział (puste openAnswerCheckTypes): bez pola", () => {
        const catalog = withOpen(OPEN);
        expect(catalog.subjects.find((s) => s.id === "english_grammar")).not.toHaveProperty("openCheckService");
        expect(catalog.subjects.find((s) => s.id === "english_chapter")).not.toHaveProperty("openCheckService");
      });

      it("bez openCheckService w konfiguracji agenta: bez pola", () => {
        const catalog = withOpen();
        expect(catalog.subjects.find((s) => s.id === "school")).not.toHaveProperty("openCheckService");
      });
    });
  });

  describe("luki generowania w DTO szkicu", () => {
    const gaps = [
      { objectiveId: "o1", reason: "incomplete" as const },
      { objectiveId: "o2", reason: "add_short" as const, added: 2, requested: 5 },
    ];

    it("szkic: generationGaps w DTO", () => {
      const context = readLessonContext({ subjectId: "school", objectiveIds: ["o1", "o2"], generationGaps: gaps });
      const dto = generationGapsDto(context, false);
      expect(dto).toEqual(gaps);
      expect(dto).not.toBe(context.generationGaps);
      expect(LessonDraftDtoSchema.shape.generationGaps.safeParse(dto).success).toBe(true);
    });

    it("luka usuniętego zagadnienia (poza objectiveIds) znika z DTO; bez pozostałych — bez pola", () => {
      expect(generationGapsDto(readLessonContext({ objectiveIds: ["o2"], generationGaps: gaps }), false)).toEqual([gaps[1]]);
      expect(generationGapsDto(readLessonContext({ objectiveIds: ["o3"], generationGaps: gaps }), false)).toBeUndefined();
    });

    it("brak luk, pusta lista albo wersja opublikowana: bez pola", () => {
      expect(generationGapsDto(readLessonContext({}), false)).toBeUndefined();
      expect(generationGapsDto(readLessonContext({ generationGaps: [] }), false)).toBeUndefined();
      expect(readLessonContext({ generationGaps: [] })).not.toHaveProperty("generationGaps");
      expect(generationGapsDto(readLessonContext({ objectiveIds: ["o1", "o2"], generationGaps: gaps }), true)).toBeUndefined();
    });
  });

  it("temat dynamiczny bez deklaracji tytułu: rejestr go odrzuca, a katalog i polecenie i tak nie obiecują tworzenia z materiału", async () => {
    const { materialSubjectTitle: _omitted, ...undeclared } = englishChapterSubject;
    const subject = { ...undeclared, id: "undeclared_title" };
    expect(() => createSubjectRegistry([subject])).toThrow(/buildDynamicTopic wymaga materialSubjectTitle/);
    // Obrona w głąb: rejestr bez walidacji (np. zbudowany ręcznie) nadal nie daje ścieżki z materiału.
    const unvalidated: SubjectRegistry = {
      getSubject: (id) => (id === subject.id ? subject : undefined),
      listSubjects: () => [subject],
      getTopic: () => undefined,
      getLatestTopic: () => undefined,
    };
    const services = createServices({ db: {} as never, subjects: unvalidated });
    expect(lessonCatalog(services).subjects[0]).toMatchObject({ id: "undeclared_title", creation: "catalog", subjectTitleRequired: false });
    const command = { subjectId: "undeclared_title", topicTitlePl: "Unit 1", material: "I like pizza.", clientRequestId: "11111111-1111-4111-8111-111111111111" };
    await expect(createLessonFromMaterial(services, command)).rejects.toMatchObject({ code: "validation" });
    await expect(createMaterialLesson(services, command)).rejects.toMatchObject({ code: "validation" });
  });
});
