import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createChild,
  createLesson,
  createServices,
  createLessonDraftFromPublished,
  createSubjectRegistry,
  deleteChild,
  editLessonDraft,
  englishGrammarSubject,
  executeLessonGeneration,
  historyLikeSubject,
  listChildren,
  publishLessonDraft,
  readGeneration,
  readLessonDeck,
  regenerateObjective,
  updateChild,
  type Services,
} from "@learning/server";
import type { LessonCommand } from "@learning/contracts";
import { buildTestServices, countRows, ManualClock, testDatabase, truncateCoreTables } from "./helpers";
import { fakeGeneration, type FakeGeneration } from "./fakes";

describe("profil — zainteresowania", () => {
  beforeEach(async () => {
    await truncateCoreTables();
  });

  it("nowy profil ma pustą listę zainteresowań", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ala", avatarKey: "fox" });
    expect(child.interests).toEqual([]);
    await expect(listChildren(services)).resolves.toEqual([expect.objectContaining({ id: child.id, interests: [] })]);
  });

  it("updateChild zapisuje zainteresowania w podanej kolejności, a pusta lista je czyści", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ala", avatarKey: "fox" });

    const updated = await updateChild(services, child.id, { interests: ["piłka nożna", "Minecraft"] });
    expect(updated.interests).toEqual(["piłka nożna", "Minecraft"]);
    await expect(listChildren(services)).resolves.toEqual([
      expect.objectContaining({ id: child.id, interests: ["piłka nożna", "Minecraft"] }),
    ]);

    // zmiana innego pola nie rusza listy
    await updateChild(services, child.id, { avatarKey: "owl" });
    await expect(listChildren(services)).resolves.toEqual([
      expect.objectContaining({ interests: ["piłka nożna", "Minecraft"] }),
    ]);

    const cleared = await updateChild(services, child.id, { interests: [] });
    expect(cleared.interests).toEqual([]);
  });

  it("CHECK odrzuca więcej niż 5 elementów i NULL w tablicy", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ala", avatarKey: "fox" });
    const { pool } = testDatabase();

    await expect(pool.query(
      "UPDATE learning_app.child_profiles SET interests = ARRAY['a','b','c','d','e','f'] WHERE id = $1",
      [child.id],
    )).rejects.toMatchObject({ constraint: "child_profiles_interests_valid" });
    await expect(pool.query(
      "UPDATE learning_app.child_profiles SET interests = ARRAY['a', NULL] WHERE id = $1",
      [child.id],
    )).rejects.toMatchObject({ constraint: "child_profiles_interests_valid" });
    await expect(pool.query(
      "INSERT INTO learning_app.child_profiles (id, display_name, avatar_key, interests) VALUES (gen_random_uuid(), 'Ola', 'cat', ARRAY['a','b','c','d','e','f'])",
    )).rejects.toMatchObject({ constraint: "child_profiles_interests_valid" });

    await expect(pool.query(
      "UPDATE learning_app.child_profiles SET interests = ARRAY['a','b','c','d','e'] WHERE id = $1",
      [child.id],
    )).resolves.toBeDefined();
  });

  it("deleteChild usuwa wiersz razem z listą", async () => {
    const { services } = buildTestServices();
    const child = await createChild(services, { displayName: "Ala", avatarKey: "fox" });
    await updateChild(services, child.id, { interests: ["dinozaury"] });

    await deleteChild(services, child.id);

    expect(await countRows("child_profiles")).toBe(0);
  });
});

const OBJECTIVE_ID = "english_grammar.present_simple.third_person_s";

function lessonServices(fakes: FakeGeneration): Services {
  const { db } = testDatabase();
  return createServices({
    db,
    clock: new ManualClock(),
    media: fakes.settings,
    generation: fakes.deps,
    subjects: createSubjectRegistry([englishGrammarSubject, historyLikeSubject]),
  });
}

function grammarCommand(overrides: Partial<LessonCommand> = {}): LessonCommand {
  return {
    subjectId: "english_grammar",
    topicId: "present_simple",
    objectiveIds: [OBJECTIVE_ID],
    material: "He plays football. She watches TV. They study English every day.",
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

/** Czyste tabele lekcji przed każdym testem i świeże fake'i generacji (sprzątane po teście). */
function useLessonWorld(): () => Promise<{ fakes: FakeGeneration; services: Services }> {
  const disposers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    await truncateCoreTables();
    const { pool } = testDatabase();
    await pool.query(
      `truncate learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
              learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
              learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`,
    );
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });

  return async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    return { fakes, services: lessonServices(fakes) };
  };
}

describe("lekcja — migawka tematów", () => {
  const world = useLessonWorld();

  async function snapshots(deckId: string, runId: string) {
    const { pool } = testDatabase();
    const context = await pool.query(
      "select lesson_context ? 'interests' as has, lesson_context->'interests' as value from learning_app.deck_versions where deck_id = $1",
      [deckId],
    );
    const input = await pool.query(
      "select input ? 'interests' as has, input->'interests' as value from learning_app.generation_runs where id = $1",
      [runId],
    );
    return { context: context.rows[0] as { has: boolean; value: unknown }, input: input.rows[0] as { has: boolean; value: unknown } };
  }

  it("createLesson zapisuje migawkę w kontekście i w runie; bez pola nie ma klucza", async () => {
    const { services } = await world();

    const withThemes = await createLesson(services, grammarCommand({ interests: ["piłka nożna"] }));
    const stored = await snapshots(withThemes.deckId, withThemes.runId);
    expect(stored.context).toEqual({ has: true, value: ["piłka nożna"] });
    expect(stored.input).toEqual({ has: true, value: ["piłka nożna"] });

    const without = await createLesson(services, grammarCommand());
    const bare = await snapshots(without.deckId, without.runId);
    expect(bare.context.has).toBe(false);
    expect(bare.input.has).toBe(false);
  });

  it("przedmiot bez reguły odrzuca zainteresowania przed zapisem czegokolwiek", async () => {
    const { services } = await world();

    await expect(createLesson(services, {
      subjectId: historyLikeSubject.id,
      topicId: historyLikeSubject.topics[0]!.id,
      objectiveIds: [historyLikeSubject.topics[0]!.objectives[0]!.id],
      material: "Tekst.",
      interests: ["piłka nożna"],
      clientRequestId: randomUUID(),
    })).rejects.toMatchObject({ code: "validation" });

    expect(await countRows("decks")).toBe(0);
    expect(await countRows("deck_versions")).toBe(0);
    expect(await countRows("generation_runs")).toBe(0);
  });

  it("wykonanie i dogenerowanie niosą migawkę do agenta, a wejście podagenta nie zawiera danych dziecka", async () => {
    const { fakes, services } = await world();
    const child = await createChild(services, { displayName: "Zuzanna Testowa-Fikcyjna", avatarKey: "fox", birthYear: 2017 });
    const themes = ["piłka nożna", "dinozaury"];
    await updateChild(services, child.id, { interests: themes });

    const { runId, deckId } = await createLesson(services, grammarCommand({ interests: themes }));
    await executeLessonGeneration(services, runId);
    expect((await readGeneration(services, runId)).state).toBe("succeeded");

    expect(fakes.agent.calls.length).toBeGreaterThan(0);
    for (const call of fakes.agent.calls) {
      expect(call.input.pool.interests).toEqual(themes);
      expect(call.input.pool.promptProfile.interestsRule).toEqual(expect.any(String));
    }

    // Profil znika, a dogenerowanie dalej korzysta z migawki lekcji.
    await deleteChild(services, child.id);
    const before = fakes.agent.calls.length;
    const draft = (await readLessonDeck(services, deckId)).draft!;
    const topUp = await regenerateObjective(services, {
      deckId, objectiveId: OBJECTIVE_ID, count: 2, expectedEditNumber: draft.editNumber, clientRequestId: randomUUID(),
    });
    const topUpStored = await snapshots(deckId, topUp.runId);
    expect(topUpStored.input).toEqual({ has: true, value: themes });
    await executeLessonGeneration(services, topUp.runId);
    expect(fakes.agent.calls.length).toBeGreaterThan(before);
    for (const call of fakes.agent.calls.slice(before)) expect(call.input.pool.interests).toEqual(themes);

    const serialized = JSON.stringify(fakes.agent.calls.map((call) => call.input));
    expect(serialized).not.toContain("Zuzanna");
    expect(serialized).not.toContain("Testowa-Fikcyjna");
    expect(serialized).not.toContain("2017");
    expect(serialized).not.toContain(child.id);
  });
});

describe("lekcja — API rodzica (szkic i patch tematów)", () => {
  const world = useLessonWorld();

  it("DTO szkicu niesie migawkę tematów, a bez nich nie ma pola", async () => {
    const { services } = await world();
    const themes = ["piłka nożna", "dinozaury"];

    const withThemes = await createLesson(services, grammarCommand({ interests: themes }));
    expect((await readLessonDeck(services, withThemes.deckId)).draft!.interests).toEqual(themes);

    const without = await createLesson(services, grammarCommand());
    expect((await readLessonDeck(services, without.deckId)).draft).not.toHaveProperty("interests");
  });

  it("patch podmienia tematy, a pusta lista usuwa klucz; kolejne dogenerowanie idzie bez tematów", async () => {
    const { fakes, services } = await world();
    const { runId, deckId } = await createLesson(services, grammarCommand({ interests: ["piłka nożna"] }));
    await executeLessonGeneration(services, runId);
    const draft = (await readLessonDeck(services, deckId)).draft!;

    const replaced = await editLessonDraft(services, draft.id, { expectedEditNumber: draft.editNumber, interests: ["Minecraft", "dinozaury"] });
    expect(replaced.interests).toEqual(["Minecraft", "dinozaury"]);
    expect(replaced.editNumber).toBe(draft.editNumber + 1);

    const cleared = await editLessonDraft(services, draft.id, { expectedEditNumber: replaced.editNumber, interests: [] });
    expect(cleared).not.toHaveProperty("interests");
    const { pool } = testDatabase();
    const stored = await pool.query(
      "select lesson_context ? 'interests' as has from learning_app.deck_versions where id = $1", [draft.id],
    );
    expect(stored.rows[0]).toEqual({ has: false });

    const before = fakes.agent.calls.length;
    const topUp = await regenerateObjective(services, {
      deckId, objectiveId: OBJECTIVE_ID, count: 2, expectedEditNumber: cleared.editNumber, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, topUp.runId);
    expect(fakes.agent.calls.length).toBeGreaterThan(before);
    for (const call of fakes.agent.calls.slice(before)) expect(call.input.pool).not.toHaveProperty("interests");
  });

  it("patch niepustej listy dla przedmiotu bez reguły tematów kończy się validation i nic nie zapisuje", async () => {
    const { services } = await world();
    const { deckId } = await createLesson(services, {
      subjectId: historyLikeSubject.id,
      topicId: historyLikeSubject.topics[0]!.id,
      objectiveIds: [historyLikeSubject.topics[0]!.objectives[0]!.id],
      material: "Tekst.",
      clientRequestId: randomUUID(),
    });
    const draft = (await readLessonDeck(services, deckId)).draft!;

    await expect(editLessonDraft(services, draft.id, { expectedEditNumber: draft.editNumber, interests: ["piłka nożna"] }))
      .rejects.toMatchObject({ code: "validation" });
    expect((await readLessonDeck(services, deckId)).draft).toEqual(draft);

    // usunięcie (pusta lista) jest dozwolone także tam, gdzie przedmiot nie przyjmuje tematów
    const cleared = await editLessonDraft(services, draft.id, { expectedEditNumber: draft.editNumber, interests: [] });
    expect(cleared).not.toHaveProperty("interests");
    expect(cleared.editNumber).toBe(draft.editNumber + 1);
  });

  it("nowy szkic z opublikowanej lekcji zachowuje tematy", async () => {
    const { services } = await world();
    const themes = ["piłka nożna", "dinozaury"];
    const { runId, deckId } = await createLesson(services, grammarCommand({ interests: themes }));
    await executeLessonGeneration(services, runId);
    const draft = (await readLessonDeck(services, deckId)).draft!;
    await publishLessonDraft(services, draft.id, draft.editNumber);

    const fork = await createLessonDraftFromPublished(services, deckId);

    expect(fork.id).not.toBe(draft.id);
    expect(fork.interests).toEqual(themes);
  });
});

afterAll(async () => {
  const { pool } = testDatabase();
  await pool.end();
});
