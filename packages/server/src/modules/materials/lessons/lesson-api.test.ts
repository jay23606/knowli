import { describe, expect, it } from "vitest";
import { SubjectCatalogDtoSchema } from "@learning/contracts";
import { createServices } from "../../../config";
import { createSubjectRegistry, type SubjectRegistry } from "../../../domain/lessons/registry";
import { englishChapterSubject } from "../../../domain/lessons/subjects/english-chapter/module";
import { lessonCatalog } from "./lesson-api";
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
