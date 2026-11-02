import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createServices,
  loginParent,
  runDueGenerationWork,
  setupParent,
  createChild,
  endSession,
  startSession,
  nextTask,
  completePresentation,
  submitAttempt,
  FakeAnswerGrader,
  createDatabase,
  authorizeDisclosure,
  createSchoolLesson,
  createSubjectRegistry,
  schoolSubject,
  executeLessonGeneration,
  readLessonDeck,
  ensureLearningPolicy,
  type Services,
} from "@learning/server";
import {
  LessonDeckDtoSchema,
  LessonDraftDtoSchema,
  SubjectCatalogDtoSchema,
  TaskPromptSchema,
  type LessonDraftDto,
  type LessonExerciseInput,
} from "@learning/contracts";
import { testDatabase, testDatabaseUrl, truncateCoreTables } from "./helpers";
import { lessonWorld } from "../fixtures/lesson-world";
import { ManualClock } from "./helpers";
import { fakeGeneration, type FakeGeneration } from "./fakes";
import { handleParentApi } from "./helpers";
import { errorResponse } from "../../apps/web/src/http/errors";
import { createLessonSnapshot, toLessonDraftPatch } from "../../apps/web/src/parent/lessons/lesson-editor-state";

const { pool } = testDatabase();
const BASE = "http://localhost:3000";

async function truncateDeckTables(): Promise<void> {
  await pool.query(
    `truncate learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
       learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
       learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`,
  );
}

function lessonServices(fakes: FakeGeneration, clock = new ManualClock()): Services {
  const { db } = testDatabase();
  return createServices({ db, clock, media: fakes.settings, generation: fakes.deps });
}

/** Request helper: path -> segments; GET has no origin requirement. */
function req(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string | null; origin?: string | null } = {},
): { request: Request; segments: string[] } {
  const origin = options.origin === undefined ? BASE : options.origin;
  const headers: Record<string, string> = {};
  // jawny Host jak w żądaniu przyjmowanym przez serwer — router oRPC odtwarza
  // Request z samych nagłówków, więc kontrola Origin musi widzieć własnego hosta
  headers.host = "localhost:3000";
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (origin) headers.origin = origin;
  if (options.cookie) headers.cookie = `parent_session=${options.cookie}`;
  const request = new Request(`${BASE}/api/v1/parent/${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const segments = path.split("?")[0]!.split("/").filter((s) => s.length > 0);
  return { request, segments };
}

function call(
  services: Services,
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string | null; origin?: string | null } = {},
): Promise<Response> {
  const { request, segments } = req(method, path, options);
  // Odwzorowanie produkcyjnego `withApi`: wyjątki stają się odpowiedzią z
  // jednolitym formatem błędu (łącznie z `details`), tak jak w route.ts.
  return handleParentApi(request, services, segments).catch((error) => errorResponse(error));
}

const SUBJECT = "english_grammar";
const TOPIC = "present_simple";
const OBJECTIVE = "english_grammar.present_simple.third_person_s";

function lessonBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subjectId: SUBJECT,
    topicId: TOPIC,
    objectiveIds: [OBJECTIVE],
    material: "He plays football. She watches TV. They study English every day.",
    instruction: "Ćwicz -s w 3. osobie.",
    poolSize: 20,
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

/** Pętli worker generacji aż do wyczerpania pracy (lekcja + TTS odpowiedzi). */
async function drainWork(services: Services): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const { processed } = await runDueGenerationWork(services, { lesson: 5, deck: 5, tts: 50, images: 50 });
    if (processed === 0) return;
  }
}

/** Tworzy lekcję i generuje szkic (fake provider), zwraca {deckId, versionId, cookie}. */
async function createAndGenerate(
  services: Services,
  cookie: string,
): Promise<{ deckId: string; versionId: string }> {
  const created = await call(services, "POST", "lessons", { body: lessonBody(), cookie });
  expect(created.status).toBe(202);
  const { deckId } = (await created.json()) as { deckId: string };
  await drainWork(services);
  const read = await call(services, "GET", `lessons/${deckId}`, { cookie });
  const dto = LessonDeckDtoSchema.parse(await read.json());
  return { deckId, versionId: dto.draft!.id };
}

describe("Parent API lekcji (integracja, przez router HTTP)", () => {
  const disposers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    await truncateCoreTables();
    await truncateDeckTables();
  });

  afterAll(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
    await pool.end();
  });

  async function freshParent(fakes: FakeGeneration): Promise<{ services: Services; cookie: string }> {
    const services = lessonServices(fakes);
    await setupParent(services, "lesson-api-pin");
    const { token } = await loginParent(services, "lesson-api-pin");
    return { services, cookie: token };
  }

  it("odrzuca rachunek w gramatyce przez HTTP i zachowuje cały szkic", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    const before = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    const response = await call(services, "PATCH", `lesson-drafts/${before.draft!.id}`, {
      cookie, body: { expectedEditNumber: before.draft!.editNumber, title: "Nie zapisuj", exercises: [{
        exerciseType: "lesson_calculation", objectiveId: OBJECTIVE, prompt: "Oblicz.", answer: "250 m", acceptedAnswers: [], focus: [],
        calculation: { kind: "height_difference", params: { upperHeightM: 400, lowerHeightM: 150 }, unit: "m", templateFamilyId: "height" },
      }] },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("validation");
    const after = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    expect(after.draft).toEqual(before.draft);
  });

  it("hides inactive assignments from the lesson editor response", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    const draft = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json()).draft!;
    expect((await call(services, "POST", `lesson-drafts/${draft.id}/publish`, {
      cookie, body: { expectedEditNumber: draft.editNumber },
    })).status).toBe(200);
    const child = await createChild(services, { displayName: "Ala", avatarKey: "cat" });
    expect((await call(services, "PUT", `assignments/${child.id}/${deckId}`, {
      cookie, body: { testDate: null },
    })).status).toBe(204);

    const before = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    expect(before.assignments.map(({ childId }) => childId)).toContain(child.id);

    await pool.query("update learning_app.assignments set active = false where child_id = $1 and deck_id = $2", [child.id, deckId]);
    const after = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    expect(after.assignments.map(({ childId }) => childId)).not.toContain(child.id);
  });

  it("surowy JSON GET lessons/:deckId zawiera sessionTaskBudget po PATCH ustawień", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    // surowy JSON: parse-time default(20) w LessonDeckDtoSchema zamaskowałby
    // pominięcie pola przez serwer, więc asercja idzie przed schematem.
    const before = (await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json()) as { sessionTaskBudget?: number };
    expect(before.sessionTaskBudget).toBe(20);
    expect((await call(services, "PATCH", `decks/${deckId}`, { cookie, body: { sessionTaskBudget: 7 } })).status).toBe(200);
    const raw = (await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json()) as Record<string, unknown>;
    expect(raw.sessionTaskBudget).toBe(7);
  });

  it("archiwizuje szkic lekcji przez wspólny endpoint, idempotentnie i tylko z autoryzacją rodzica", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    const before = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    const path = `decks/${deckId}/archive`;
    expect((await call(services, "POST", path)).status).toBe(401);
    expect((await call(services, "POST", path, { cookie, origin: "https://attacker.example" })).status).toBe(403);
    expect((await call(services, "POST", path, { cookie })).status).toBe(204);
    const archivedAt = (await pool.query("select archived_at from learning_app.decks where id=$1", [deckId])).rows[0];
    expect(archivedAt.archived_at).not.toBeNull();
    expect((await call(services, "POST", path, { cookie })).status).toBe(204);
    expect((await pool.query("select archived_at from learning_app.decks where id=$1", [deckId])).rows[0]).toEqual(archivedAt);
    const after = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    expect(after.state).toBe("archived");
    expect(after.draft).toEqual(before.draft);
    const list = await (await call(services, "GET", "decks", { cookie })).json();
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ deckId, kind: "lesson", state: "archived" })]));
  });

  it("archiwizacja opublikowanej lekcji zachowuje historię i ćwiczenia oraz blokuje nowe sesje", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const child = await createChild(services, { displayName: "Ala", avatarKey: "cat" });
    await ensureLearningPolicy(services.db);
    const world = await lessonWorld(pool, { childId: child.id, withObjectiveAssessment: true });
    const before = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${world.deckId}`, { cookie })).json());
    async function history() {
      return {
        attempts: (await pool.query("select * from learning_app.attempts where child_id=$1 order by id", [child.id])).rows,
        assessments: (await pool.query("select * from learning_app.assessments where child_id=$1 order by attempt_id, skill", [child.id])).rows,
        sessions: (await pool.query("select * from learning_app.learning_sessions where child_id=$1 order by id", [child.id])).rows,
        progress: (await pool.query("select * from learning_app.child_objective_progress where child_id=$1 order by objective_id", [child.id])).rows,
      };
    }
    const originalHistory = await history();
    expect(originalHistory.attempts).toHaveLength(1);
    expect(originalHistory.assessments).toHaveLength(1);
    expect((await call(services, "POST", `decks/${world.deckId}/archive`, { cookie })).status).toBe(204);
    const after = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${world.deckId}`, { cookie })).json());
    expect(after.state).toBe("archived");
    expect(after.published).toEqual(before.published);
    expect(after.assignments).toEqual(before.assignments);
    expect(await history()).toEqual(originalHistory);
    for (const mode of ["training", "mock_test"] as const) {
      await expect(startSession(services, { childId: child.id, deckId: world.deckId, microphoneEnabled: false, mode })).rejects.toMatchObject({ code: "conflict" });
    }
    expect(await history()).toEqual(originalHistory);
  });

  it("wymaga sesji rodzica (401) i Origin dla mutacji (403)", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);

    const noSession = await call(services, "GET", "lesson-catalog", { cookie: null });
    expect(noSession.status).toBe(401);
    const crossOrigin = await call(services, "POST", "lessons", {
      body: lessonBody(),
      cookie,
      origin: "https://attacker.example",
    });
    expect(crossOrigin.status).toBe(403);
  });

  it("POST /lessons/material tworzy zestaw rozdziału (202), a szkołę i gramatykę odrzuca (400)", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const body = {
      subjectId: "english_chapter", topicTitlePl: "Unit 1", material: "I like pizza. What do you like?", clientRequestId: randomUUID(),
    };

    const created = await call(services, "POST", "lessons/material", { body, cookie });
    expect(created.status).toBe(202);
    const { deckId, runId } = (await created.json()) as { deckId: string; runId: string };
    const [deck] = (await pool.query("select title from learning_app.decks where id = $1", [deckId])).rows as Array<{ title: string }>;
    expect(deck!.title).toBe("Angielski — rozdział: Unit 1");
    // to samo polecenie jest idempotentne
    const again = await call(services, "POST", "lessons/material", { body, cookie });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ deckId, runId });

    for (const subjectId of ["school", "english_grammar", "nieznany"]) {
      const rejected = await call(services, "POST", "lessons/material", { body: { ...body, subjectId, clientRequestId: randomUUID() }, cookie });
      expect(rejected.status, subjectId).toBe(400);
      expect((await rejected.json()).code, subjectId).toBe("validation");
    }
    const crossOrigin = await call(services, "POST", "lessons/material", { body: { ...body, clientRequestId: randomUUID() }, cookie, origin: "https://attacker.example" });
    expect(crossOrigin.status).toBe(403);
    const noSession = await call(services, "POST", "lessons/material", { body: { ...body, clientRequestId: randomUUID() }, cookie: null });
    expect(noSession.status).toBe(401);
  });

  it("katalog zawiera english_grammar / present_simple z celami", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);

    const res = await call(services, "GET", "lesson-catalog", { cookie });
    expect(res.status).toBe(200);
    const catalog = SubjectCatalogDtoSchema.parse(await res.json());
    const subject = catalog.subjects.find((s) => s.id === SUBJECT)!;
    expect(subject.titlePl).toBe("Angielski — gramatyka");
    expect(subject).toMatchObject({ creation: "catalog", subjectTitleRequired: false });
    // przedmioty tworzone z materiału: szkoła z nazwą od rodzica, rozdział ze stałym tytułem
    expect(catalog.subjects.find((s) => s.id === "school")).toMatchObject({ creation: "material", subjectTitleRequired: true, topics: [] });
    expect(catalog.subjects.find((s) => s.id === "english_chapter")).toMatchObject({
      titlePl: "Angielski — rozdział", creation: "material", subjectTitleRequired: false, topics: [],
    });
    const topic = subject.topics.find((t) => t.id === TOPIC)!;
    expect(topic.objectives.some((o) => o.id === OBJECTIVE)).toBe(true);
    const objective = topic.objectives.find((o) => o.id === OBJECTIVE)!;
    expect(objective).toHaveProperty("cards");
    const cards = (objective as unknown as { cards: Array<{ title: string; body: string }> }).cards;
    expect(cards[0]).toEqual({ title: "Dodaj -s", body: expect.any(String) });
    expect(Object.keys(cards[0]!).sort()).toEqual(["body", "title"]);
    for (const forbidden of ["descriptionEn", "errorCategories", "hints"]) expect(objective).not.toHaveProperty(forbidden);
  });

  it("generacja → edycja samego tytułu → publikacja → rzeczywista sesja dziecka", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const generate = fakes.llm.generateLessonPool.bind(fakes.llm);
    fakes.llm.generateLessonPool = async (...args) => {
      const result = await generate(...args);
      let replaced = false;
      return { ...result, exercises: result.exercises.map((raw) => {
        const ex = raw as Record<string, unknown>;
        if (replaced || ex.exerciseType !== "lesson_gap") return raw;
        replaced = true;
        const { stem: _stem, hint: _hint, ...base } = ex;
        return { ...base, exerciseType: "lesson_transform", statement: "She dances.", transformId: "to_negative",
          answer: "She does not dance", focus: ["does", "not"], acceptedAnswers: [] };
      }) };
    };
    const { services, cookie } = await freshParent(fakes);
    // Transform jest preferowany dopiero przy dostępnym graderze; dokładna
    // odpowiedź w tym teście nadal jest oceniana deterministycznie.
    const sessionServices = createServices({ db: services.db, clock: services.clock,
      grader: { provider: new FakeAnswerGrader(), maxCallsPerSession: 20, timeoutMs: 8000 } });
    const created = await call(services, "POST", "lessons", { cookie, body: lessonBody({ objectiveIds: ["english_grammar.present_simple.negative"] }) });
    const { deckId } = await created.json() as { deckId: string };
    await drainWork(services);
    const deck = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    const draft = deck.draft!;
    expect(draft.exercises.some((ex) => ex.exerciseType === "lesson_transform")).toBe(true);
    const snapshot = createLessonSnapshot(draft, randomUUID);
    snapshot.form.title = "Zmieniony tytuł";
    const changed = await call(services, "PATCH", `lesson-drafts/${draft.id}`, { cookie, body: toLessonDraftPatch(snapshot) });
    expect(changed.status).toBe(200);
    const updated = LessonDraftDtoSchema.parse(await changed.json());
    for (const ex of draft.exercises.filter((ex) => ex.exerciseType === "lesson_transform")) {
      expect(updated.exercises.find((row) => row.id === ex.id)?.statement).toBe(ex.statement);
    }
    await drainWork(services);
    expect((await call(services, "POST", `lesson-drafts/${draft.id}/publish`, { cookie, body: { expectedEditNumber: updated.editNumber } })).status).toBe(200);
    const child = await createChild(services, { displayName: "Test przepływu", avatarKey: "owl" });
    expect((await call(services, "PUT", `assignments/${child.id}/${deckId}`, { cookie, body: { testDate: null } })).status).toBe(204);
    const seen = new Set<string>();
    const completeSession = async (sessionId: string) => {
      for (let i = 0; i < 18; i++) {
        const task = await nextTask(sessionServices, sessionId);
        if (!task) break;
        TaskPromptSchema.parse(task.prompt);
        if (task.exerciseType === "lesson_card") { await completePresentation(sessionServices, { taskId: task.taskId }); continue; }
        const key = (await pool.query("select answer_key from learning_app.session_tasks where id=$1", [task.taskId])).rows[0].answer_key;
        // Odsłuch zdania przed odpowiedzią — prawdziwa autoryzacja (zapieczętowane `audio_issued`).
        if (task.exerciseType === "lesson_listen_choice") await authorizeDisclosure(sessionServices, { taskId: task.taskId, kind: "audio" });
        const attempt = await submitAttempt(sessionServices, { taskId: task.taskId, clientAttemptId: randomUUID(),
          ...(["lesson_choice", "lesson_listen_choice", "lesson_short_answer", "lesson_notice"].includes(task.exerciseType) ? { modality: "choice" as const, optionId: key.correctOptionId }
            : task.exerciseType === "lesson_order" ? { modality: "sequence" as const, itemIds: key.itemIds }
            : { modality: "text" as const, text: key.answer }),
        });
        expect(attempt.feedback?.kind).toBe("great");
        seen.add(task.exerciseType);
      }
      await endSession(sessionServices, sessionId);
    };
    const firstSession = await startSession(sessionServices, { childId: child.id, deckId, microphoneEnabled: false });
    await completeSession(firstSession.sessionId);
    const nextSession = await startSession(sessionServices, { childId: child.id, deckId, microphoneEnabled: false });
    await completeSession(nextSession.sessionId);
    expect(seen.has("lesson_choice")).toBe(true);
    expect(seen.has("lesson_transform")).toBe(true);
  });

  it("utworzenie lekcji → 202 {runId, deckId}, idempotentny retry", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const body = lessonBody();

    const first = await call(services, "POST", "lessons", { body, cookie });
    const retry = await call(services, "POST", "lessons", { body, cookie });
    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    const a = (await first.json()) as { runId: string; deckId: string };
    const b = (await retry.json()) as { runId: string; deckId: string };
    expect(a).toEqual(b);
    const count = await pool.query("select count(*)::int as c from learning_app.decks");
    expect(count.rows[0]!.c).toBe(1);
  });

  it("odczyt w trakcie commita generacji nie zwraca succeeded z pustym szkicem", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const created = await call(services, "POST", "lessons", { body: lessonBody(), cookie });
    const { runId, deckId } = await created.json() as { runId: string; deckId: string };
    const isolated = createDatabase(testDatabaseUrl());
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    let paused = false;
    isolated.pool.on("connect", (client) => {
      const original = client.query.bind(client) as (...values: unknown[]) => unknown;
      client.query = ((...args: unknown[]) => {
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
        const stop = !paused && /^select/i.test(sql) && sql.includes('from "learning_app"."item_revisions"');
        if (stop) paused = true;
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          return original(...args.slice(0, -1), (error: unknown, result: unknown) => {
            if (stop) { enter(); void released.then(() => callback(error, result)); }
            else callback(error, result);
          });
        }
        return Promise.resolve(original(...args)).then(async (result) => {
          if (stop) { enter(); await released; }
          return result;
        });
      }) as typeof client.query;
    });
    const reader = createServices({ db: isolated.db, clock: services.clock, media: fakes.settings, generation: fakes.deps });
    const reading = readLessonDeck(reader, deckId);
    await entered;
    try {
      await executeLessonGeneration(services, runId);
      release();
      const snapshot = await reading;
      expect(snapshot.generation?.state).toBe("queued");
      expect(snapshot.draft?.exercises).toEqual([]);
      const fresh = await readLessonDeck(services, deckId);
      expect(fresh.generation?.state).toBe("succeeded");
      expect(fresh.draft?.exercises.length).toBeGreaterThan(0);
      // gramatyka nie nagrywa pytań ani kart — edytor nie pokazuje tonu lektora
      expect(fresh.draft).not.toHaveProperty("voiceTones");
    } finally { release(); await reading; await isolated.pool.end(); }
  });

  it("odczyt szkicu po wygenerowaniu: pokrycie, odrzucone, run i przypisania", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);

    const created = await call(services, "POST", "lessons", { body: lessonBody(), cookie });
    const { deckId } = (await created.json()) as { deckId: string };
    await runDueGenerationWork(services);

    const res = await call(services, "GET", `lessons/${deckId}`, { cookie });
    expect(res.status).toBe(200);
    const dto = LessonDeckDtoSchema.parse(await res.json());
    expect(dto.draft).not.toBeNull();
    expect(dto.published).toBeNull();
    expect(dto.draft!.status).toBe("review");
    expect(dto.draft!.subjectId).toBe(SUBJECT);
    expect(dto.draft!.exercises.length).toBeGreaterThan(0);
    expect(dto.draft!.rejectedCount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(dto.draft!.coverage)).toBe(true);
    expect(dto.generation?.state).toBe("succeeded");
    expect(dto.assignments).toEqual([]);
  });

  it("edycja: poprawna zmiana polecenia zachowuje skill_version; zmiana odpowiedzi tworzy nowy", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);

    const read = await call(services, "GET", `lessons/${deckId}`, { cookie });
    const dto = LessonDeckDtoSchema.parse(await read.json());
    const draft = dto.draft!;
    const exercises = draft.exercises.map(stripToInput);

    const skillBefore = await objectiveSkillVersionIds(draft.id);

    // Zmiana kosmetyczna (polecenie) pierwszego ćwiczenia.
    const cosmetic = exercises.map((ex, i) => (i === 0 ? { ...ex, instructionPl: "Nowe polecenie." } : ex));
    const patched = await call(services, "PATCH", `lesson-drafts/${draft.id}`, {
      body: { expectedEditNumber: draft.editNumber, exercises: cosmetic },
      cookie,
    });
    expect(patched.status).toBe(200);
    const afterCosmetic = LessonDraftDtoSchema.parse(await patched.json());
    expect(afterCosmetic.editNumber).toBe(draft.editNumber + 1);
    const skillAfterCosmetic = await objectiveSkillVersionIds(draft.id);
    expect(skillAfterCosmetic).toEqual(skillBefore);

    // Zmiana odpowiedzi pierwszego ćwiczenia → nowa skill_version.
    const afterInputs = afterCosmetic.exercises.map(stripToInput);
    const changed = afterInputs.map((ex, i) =>
      i === 0 ? { ...ex, answer: "goes", acceptedAnswers: [], focus: ["goes"] } : ex,
    );
    const patched2 = await call(services, "PATCH", `lesson-drafts/${draft.id}`, {
      body: { expectedEditNumber: afterCosmetic.editNumber, exercises: changed },
      cookie,
    });
    expect(patched2.status).toBe(200);
    const skillAfterChange = await objectiveSkillVersionIds(draft.id);
    expect(skillAfterChange).not.toEqual(skillAfterCosmetic);
  });

  it("edycja: błędy walidacji per ćwiczenie (400 z listą)", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    const dto = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    const draft = dto.draft!;
    const exercises = draft.exercises.map(stripToInput);

    // Niepoprawna luka: brak znacznika i odpowiedź > 3 tokeny.
    const invalid = exercises.map((ex, i) =>
      i === 0
        ? { ...ex, exerciseType: "lesson_gap" as const, stem: "no marker", answer: "a b c d e", acceptedAnswers: [], focus: [] }
        : ex,
    );
    const res = await call(services, "PATCH", `lesson-drafts/${draft.id}`, {
      body: { expectedEditNumber: draft.editNumber, exercises: invalid },
      cookie,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details?: { exercises?: unknown[] } };
    expect(body.code).toBe("validation");
    expect(Array.isArray(body.details?.exercises)).toBe(true);
    expect(body.details!.exercises!.length).toBeGreaterThan(0);
  });

  it("edycja: konflikt expectedEditNumber → 409; edycja opublikowanej → 409", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    const dto = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    const draft = dto.draft!;
    const exercises = draft.exercises.map(stripToInput);

    const stale = await call(services, "PATCH", `lesson-drafts/${draft.id}`, {
      body: { expectedEditNumber: draft.editNumber + 5, exercises },
      cookie,
    });
    expect(stale.status).toBe(409);
  });

  it("powtórzony bodziec jest odrzucany przy edycji i przy publikacji całej puli", async () => {
    const fakes = await fakeGeneration(); disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    const deck = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    const draft = deck.draft!;
    const exercises = draft.exercises.map(stripToInput);
    exercises[1] = { ...exercises[0]!, id: exercises[1]!.id };
    const edited = await call(services, "PATCH", `lesson-drafts/${draft.id}`, { cookie, body: { expectedEditNumber: draft.editNumber, exercises } });
    expect(edited.status).toBe(400);
    const { id: _id, ...payload } = exercises[1]!;
    await pool.query("update learning_app.item_revisions set payload=$1::jsonb where id=$2", [JSON.stringify(payload), draft.exercises[1]!.revisionId]);
    const published = await call(services, "POST", `lesson-drafts/${draft.id}/publish`, { cookie, body: { expectedEditNumber: draft.editNumber } });
    expect(published.status).toBe(400);
  });

  it("publikacja: braki pokrycia → 409 z listą; po dogenerowaniu/edycji → 200; szkic niewidoczny w Kid API", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    let dto = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    const draft = dto.draft!;

    // Zepsuj pokrycie: usuń wszystkie ćwiczenia poza jednym (brak etapów).
    const only = draft.exercises.slice(0, 1).map(stripToInput);
    const trimmed = await call(services, "PATCH", `lesson-drafts/${draft.id}`, {
      body: { expectedEditNumber: draft.editNumber, exercises: only },
      cookie,
    });
    const trimmedDto = LessonDraftDtoSchema.parse(await trimmed.json());

    const blocked = await call(services, "POST", `lesson-drafts/${draft.id}/publish`, {
      body: { expectedEditNumber: trimmedDto.editNumber },
      cookie,
    });
    expect(blocked.status).toBe(409);
    const gaps = (await blocked.json()) as { code: string; details?: { coverage?: Array<{ objectiveId: string; stage: string; required: number; actual: number }> } };
    expect(gaps.details?.coverage?.length).toBeGreaterThan(0);
    expect(gaps.details!.coverage![0]).toMatchObject({ objectiveId: OBJECTIVE });

    // Przywróć pełne pokrycie i opublikuj. Pierwsze ćwiczenie przeżyło (ma id);
    // pozostałe zostały usunięte, więc dodajemy je jako nowe (bez id).
    const survivor: LessonExerciseInput = {
      ...stripToInput(draft.exercises[0]!),
      id: trimmedDto.exercises[0]!.id,
    };
    const readded: LessonExerciseInput[] = draft.exercises.slice(1).map((ex) => {
      const input = stripToInput(ex);
      const { id: _id, ...rest } = input;
      return rest as LessonExerciseInput;
    });
    const full: LessonExerciseInput[] = [survivor, ...readded];
    const restored = await call(services, "PATCH", `lesson-drafts/${draft.id}`, {
      body: { expectedEditNumber: trimmedDto.editNumber, exercises: full },
      cookie,
    });
    expect(restored.status).toBe(200);
    const restoredDto = LessonDraftDtoSchema.parse(await restored.json());
    await drainWork(services);
    const published = await call(services, "POST", `lesson-drafts/${draft.id}/publish`, {
      body: { expectedEditNumber: restoredDto.editNumber },
      cookie,
    });
    expect(published.status).toBe(200);

    dto = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    expect(dto.published).not.toBeNull();
    expect(dto.published!.status).toBe("published");
  });

  it("dogenerowanie: 202 z regenerate", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    const dto = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    const draft = dto.draft!;

    const res = await call(services, "POST", `lesson-drafts/${draft.id}/regenerate`, {
      body: { objectiveId: OBJECTIVE, count: 4, expectedEditNumber: draft.editNumber, clientRequestId: randomUUID() },
      cookie,
    });
    expect(res.status).toBe(202);
    const out = (await res.json()) as { generationRunId?: string; runId?: string; deckId: string };
    expect(out.deckId).toBe(deckId);
  });

  describe("ton lektora (voiceTone) w szkicu szkolnym", () => {
    const SCHOOL_MATERIAL = [
      "Zagadnienie 1: Fotosynteza",
      "Wyjaśnienie: Fotosynteza to proces, w którym roślina z wody i dwutlenku węgla, przy udziale światła, wytwarza cukry. Cukry są pokarmem rośliny.",
      "Zagadnienie 2: Chrzest Polski",
      "Wyjaśnienie: Mieszko I przyjął chrzest w 966 roku. Chrzest włączył państwo do chrześcijańskiej Europy i wzmocnił władzę księcia.",
    ].join("\n");

    async function schoolDraft(fakes: FakeGeneration): Promise<{ services: Services; cookie: string; deckId: string; draft: LessonDraftDto }> {
      const { db } = testDatabase();
      const services = createServices({
        db,
        clock: new ManualClock(),
        media: fakes.settings,
        generation: fakes.deps,
        subjects: createSubjectRegistry([schoolSubject]),
      });
      await setupParent(services, "lesson-api-pin");
      const { token: cookie } = await loginParent(services, "lesson-api-pin");
      const { runId, deckId } = await createSchoolLesson(services, {
        subjectTitlePl: "Przyroda i historia",
        topicTitlePl: "Materiał pilotażowy",
        material: SCHOOL_MATERIAL,
        poolSize: 40,
        clientRequestId: randomUUID(),
      });
      await executeLessonGeneration(services, runId);
      const dto = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
      return { services, cookie, deckId, draft: dto.draft! };
    }

    async function patchExercises(
      services: Services, cookie: string, draft: LessonDraftDto,
      change: (ex: LessonExerciseInput, index: number) => LessonExerciseInput,
    ): Promise<LessonDraftDto> {
      const response = await call(services, "PATCH", `lesson-drafts/${draft.id}`, {
        body: { expectedEditNumber: draft.editNumber, exercises: draft.exercises.map(stripToInput).map(change) },
        cookie,
      });
      expect(response.status).toBe(200);
      return LessonDraftDtoSchema.parse(await response.json());
    }

    it("edycja samej treści pytania zachowuje ton w DTO i w payloadzie", async () => {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      const { services, cookie, draft } = await schoolDraft(fakes);
      expect(draft.exercises[0]!.voiceTone).toBe("curious");
      expect(draft.dynamicTopic!.objectives[0]!.cards[0]!.voiceTone).toBe("cheerful");

      const edited = await patchExercises(services, cookie, draft, (ex, i) => {
        if (i !== 0) return ex;
        return ex.prompt !== undefined ? { ...ex, prompt: `${ex.prompt} (inaczej)` } : { ...ex, stem: `${ex.stem ?? ""} (inaczej)` };
      });
      expect(edited.exercises[0]!.voiceTone).toBe("curious");
      const rows = await pool.query<{ payload: { voiceTone?: string } }>(
        "select payload from learning_app.item_revisions where id = $1", [edited.exercises[0]!.revisionId]);
      expect(rows.rows[0]!.payload.voiceTone).toBe("curious");
    });

    it("patch dynamicTopic z voiceTone karty zapisuje ton w lesson_context, a nieznany ton odrzuca", async () => {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      const { services, cookie, draft } = await schoolDraft(fakes);
      const objective = draft.dynamicTopic!.objectives[0]!;
      const cards = (voiceTone: string | undefined) => [{ ...objective.cards[0]!, ...(voiceTone ? { voiceTone } : {}) }, objective.cards[1]!];
      const patchTopic = (voiceTone: string | undefined) => call(services, "PATCH", `lesson-drafts/${draft.id}`, {
        body: {
          expectedEditNumber: draft.editNumber,
          dynamicTopic: { objectives: draft.dynamicTopic!.objectives.map((o) => o.id === objective.id ? { ...o, cards: cards(voiceTone) } : o) },
        },
        cookie,
      });

      expect((await patchTopic("loud")).status).toBe(400);
      const ok = await patchTopic("gentle");
      expect(ok.status).toBe(200);
      const dto = LessonDraftDtoSchema.parse(await ok.json());
      expect(dto.dynamicTopic!.objectives[0]!.cards[0]!.voiceTone).toBe("gentle");
      const [version] = (await pool.query<{ lesson_context: { dynamicTopic: { objectives: { id: string; cards: { voiceTone?: string }[] }[] } } }>(
        "select lesson_context from learning_app.deck_versions where id = $1", [draft.id])).rows;
      const stored = version!.lesson_context.dynamicTopic.objectives.find((o) => o.id === objective.id)!;
      expect(stored.cards[0]!.voiceTone).toBe("gentle");
    });

    it("zmiana samego tonu po publikacji i kopii szkicu nie tworzy skill_version ani nie rusza postępu dziecka", async () => {
      const fakes = await fakeGeneration();
      disposers.push(fakes.dispose);
      const { services, cookie, deckId, draft } = await schoolDraft(fakes);
      const publish = await call(services, "POST", `lesson-drafts/${draft.id}/publish`, { body: { expectedEditNumber: draft.editNumber }, cookie });
      expect(publish.status).toBe(200);

      const child = await createChild(services, { displayName: "Ton", avatarKey: "owl" });
      const objectiveId = draft.exercises[0]!.objectiveId;
      await pool.query(`insert into learning_app.child_objective_progress
        (child_id,subject_id,objective_id,topic_id,status,streak,next_review_at,projection_version)
        values ($1,'school',$2,'dynamic','needs_confirmation',3,'2000-01-01T00:00:00Z','proj-1')`, [child.id, objectiveId]);
      const progressBefore = (await pool.query("select * from learning_app.child_objective_progress where child_id = $1", [child.id])).rows;
      const skillCount = async () => Number((await pool.query<{ n: string }>(
        `select count(*) as n from learning_app.skill_versions sv
           join learning_app.learning_items li on li.id = sv.item_id where li.deck_id = $1`, [deckId])).rows[0]!.n);
      const countBefore = await skillCount();
      const idsBefore = await objectiveSkillVersionIds(draft.id);

      const forked = await call(services, "POST", `lessons/${deckId}/draft`, { cookie });
      expect(forked.status).toBe(201);
      const copy = LessonDraftDtoSchema.parse(await forked.json());
      expect(copy.exercises[0]!.voiceTone).toBe("curious");

      const retoned = await patchExercises(services, cookie, copy, (ex, i) => (i === 0 ? { ...ex, voiceTone: "mysterious" } : ex));
      expect(retoned.exercises[0]!.voiceTone).toBe("mysterious");
      const published = await call(services, "POST", `lesson-drafts/${retoned.id}/publish`, { body: { expectedEditNumber: retoned.editNumber }, cookie });
      expect(published.status).toBe(200);

      expect(await skillCount()).toBe(countBefore);
      expect(await objectiveSkillVersionIds(retoned.id)).toEqual(idsBefore);
      expect((await pool.query("select * from learning_app.child_objective_progress where child_id = $1", [child.id])).rows).toEqual(progressBefore);
    });
  });

  it("nowa wersja z opublikowanej", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    const dto = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    const draft = dto.draft!;
    const publish = await call(services, "POST", `lesson-drafts/${draft.id}/publish`, {
      body: { expectedEditNumber: draft.editNumber },
      cookie,
    });
    expect(publish.status).toBe(200);

    const forked = await call(services, "POST", `lessons/${deckId}/draft`, { cookie });
    expect(forked.status).toBe(201);
    const newDraft = LessonDraftDtoSchema.parse(await forked.json());
    expect(newDraft.status).toBe("draft");
    expect(newDraft.deckId).toBe(deckId);
    expect(newDraft.exercises.length).toBe(draft.exercises.length);
    expect(newDraft.subjectId).toBe(SUBJECT);
  });

  it("przypisanie z celem lesson; cele słówek → 400", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    const dto = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    await call(services, "POST", `lesson-drafts/${dto.draft!.id}/publish`, {
      body: { expectedEditNumber: dto.draft!.editNumber },
      cookie,
    });
    const child = await createChild(services, { displayName: "Ala", avatarKey: "cat" });

    const ok = await call(services, "PUT", `assignments/${child.id}/${deckId}`, {
      body: { testDate: "2026-10-20", testGoals: ["lesson"] },
      cookie,
    });
    expect(ok.status).toBe(204);

    const bad = await call(services, "PUT", `assignments/${child.id}/${deckId}`, {
      body: { testDate: "2026-10-20", testGoals: ["recall"] },
      cookie,
    });
    expect(bad.status).toBe(400);
  });

  it("endpointy słówek dla lekcji → deck_kind_mismatch; i odwrotnie", async () => {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const { services, cookie } = await freshParent(fakes);
    const { deckId } = await createAndGenerate(services, cookie);
    const dto = LessonDeckDtoSchema.parse(await (await call(services, "GET", `lessons/${deckId}`, { cookie })).json());
    const draft = dto.draft!;

    // Edytor słówek (PATCH /drafts/:id) na wersji lekcji → deck_kind_mismatch.
    const res = await call(services, "PATCH", `drafts/${draft.id}`, {
      body: { expectedEditNumber: draft.editNumber, title: "x" },
      cookie,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("deck_kind_mismatch");
  });
});

// --- helpery testowe (SQL i mapowanie DTO→Input) ---

function stripToInput(ex: Record<string, unknown>): LessonExerciseInput {
  // Nagrania pytania i zdania (`promptAudio`, `sentenceAudio`) są tylko do odczytu i nie wracają w patchu.
  const { revisionId: _r, promptAudio: _a, sentenceAudio: _s, ...rest } = ex as { revisionId?: string; promptAudio?: unknown; sentenceAudio?: unknown } & Record<string, unknown>;
  return rest as LessonExerciseInput;
}

async function objectiveSkillVersionIds(versionId: string): Promise<string[]> {
  const rows = await pool.query<{ skill_version_id: string }>(
    `select irs.skill_version_id from learning_app.item_revision_skills irs
       join learning_app.item_revisions ir on ir.id = irs.item_revision_id
      where ir.deck_version_id = $1 and irs.skill = 'objective'
      order by ir.position`,
    [versionId],
  );
  return rows.rows.map((r) => r.skill_version_id);
}
