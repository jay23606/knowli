import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completePresentation, createChild, createLesson, createLessonDraftFromPublished, createLessonFromMaterial, createServices, createSubjectRegistry, decideLessonVerdict,
  editLessonDraft, englishGrammarSubject, executeLessonGeneration, FakeAnswerGrader, fakeGraderDeps, nextTask, publishLessonDraft, readAttempt,
  readLessonDeck, regenerateLessonPromptAudio, runDueGenerationWork, startSession, submitAttempt,
} from "@learning/server";
import { FeedbackDtoSchema, type AttemptInput, type LessonDraftDto, type TaskDto } from "@learning/contracts";
import { lessonWorld, RICH_KEYS, type LessonWorldOptions } from "../fixtures/lesson-world";
import { STYLE_SENTENCES_PL } from "../../packages/server/src/providers/tts-style-profile";
import { buildTestServices, ManualClock, testDatabase, truncateCoreTables } from "./helpers";
import { fakeGeneration } from "./fakes";
import {
  audioServices, generationsOf, publishAssignedSpiderLesson, seedSchoolDraft, SPIDER_OBJECTIVE, spiderExercises, truncateLessonAudioTables,
} from "./school-lesson-audio-helpers";

/**
 * Wyjaśnienie błędu dla dziecka (issue #196): `explanationPl` ćwiczenia ma nagranie
 * `explanation_audio` (pl-PL, styl `lesson_explanation`) planowane przy przygotowaniu
 * materiału. Nie blokuje publikacji, nie jest zasobem do decyzji rodzica i zależy od
 * flagi przedmiotu `exerciseExplanations`.
 */

const { db, pool } = testDatabase();
const OBJECTIVE = "english_grammar.present_simple.third_person_s";
const FAKE_EXPLANATION = "Ta reguła mówi, jak zbudować poprawne zdanie.";
const cleanup: Array<() => Promise<void>> = [];

beforeEach(async () => {
  await truncateCoreTables();
  await truncateLessonAudioTables();
  await pool.query(`truncate learning_app.generation_runs, learning_app.revision_assets, learning_app.media_assets,
    learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
    learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`);
});
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
afterAll(() => pool.end());

type Fakes = Awaited<ReturnType<typeof fakeGeneration>>;

const withoutExplanations = () => createSubjectRegistry([{ ...englishGrammarSubject, exerciseExplanations: false }]);

async function generatedGrammarLesson() {
  const fakes = await fakeGeneration();
  cleanup.push(fakes.dispose);
  const services = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps });
  const run = await createLesson(services, {
    subjectId: "english_grammar", topicId: "present_simple", objectiveIds: [OBJECTIVE],
    material: "He plays football. She reads books. She watches TV.", poolSize: 20, clientRequestId: randomUUID(),
  });
  await executeLessonGeneration(services, run.runId);
  const draft = (await readLessonDeck(services, run.deckId)).draft!;
  return { services, run, draft, fakes };
}

interface ExplanationRow { revisionId: string; position: number; assetId: string; fingerprint: string; text: string; locale: string; state: string; ready: string }

async function explanationRows(versionId: string): Promise<ExplanationRow[]> {
  return (await pool.query<ExplanationRow>(
    `select ir.id as "revisionId", ir.position, ra.asset_id as "assetId", ra.expected_fingerprint as fingerprint,
            ma.metadata->>'text' as text, ma.metadata->>'locale' as locale, ra.state, ma.state as ready
       from learning_app.revision_assets ra
       join learning_app.item_revisions ir on ir.id = ra.item_revision_id
       join learning_app.media_assets ma on ma.id = ra.asset_id
      where ir.deck_version_id = $1 and ra.role = 'explanation_audio'
      order by ir.position`,
    [versionId],
  )).rows;
}

async function drainWorker(services: ReturnType<typeof createServices>) {
  for (let pass = 0; pass < 20; pass += 1) {
    const result = await runDueGenerationWork(services, { lesson: 0, deck: 0, tts: 50, images: 0 });
    if (result.processed === 0) break;
  }
}

function inputs(draft: LessonDraftDto, edit: (exercise: Record<string, unknown>, index: number) => Record<string, unknown> = (exercise) => exercise) {
  return draft.exercises.map((exercise, index) => {
    const { revisionId: _revision, promptAudio: _prompt, explanationAudio: _explanation, sentenceAudio: _sentence, ...rest } = exercise;
    return edit(rest as Record<string, unknown>, index);
  });
}

describe("nagranie wyjaśnienia", () => {
  it("generacja gramatyki zleca explanation_audio (pl-PL) per ćwiczenie; DTO szkicu niesie stan i flagę, a lista zasobów go pomija", async () => {
    const { draft } = await generatedGrammarLesson();
    const rows = await explanationRows(draft.id);
    expect(rows).toHaveLength(draft.exercises.length);
    for (const row of rows) expect(row).toMatchObject({ text: FAKE_EXPLANATION, locale: "pl-PL", state: "pending", ready: "pending" });
    expect(draft.exerciseExplanations).toBe(true);
    for (const exercise of draft.exercises) expect(exercise.explanationAudio).toEqual({ state: "pending" });
    expect(draft.assets.some((asset) => (asset.role as string) === "explanation_audio")).toBe(false);
    expect(draft.assets).toEqual([]);
  });

  it("publikacja nie czeka na pending explanation_audio", async () => {
    const { services, draft } = await generatedGrammarLesson();
    expect((await explanationRows(draft.id)).every((row) => row.state === "pending")).toBe(true);
    await expect(publishLessonDraft(services, draft.id, draft.editNumber)).resolves.toEqual({ deckVersionId: draft.id });
    const published = (await readLessonDeck(services, draft.deckId)).published!;
    expect(published.assets.some((asset) => (asset.role as string) === "explanation_audio")).toBe(false);
  });

  it("publikacja zleca ponownie nieudane nagranie wyjaśnienia (nie jest decyzją rodzica)", async () => {
    const { services, draft } = await generatedGrammarLesson();
    const [failed] = await explanationRows(draft.id);
    await pool.query("update learning_app.media_assets set state = 'failed', lease_token = null where id = $1", [failed!.assetId]);
    await publishLessonDraft(services, draft.id, draft.editNumber);
    const rows = await explanationRows(draft.id);
    expect(rows).toHaveLength(draft.exercises.length);
    for (const row of rows) {
      expect(row.assetId).not.toBe(failed!.assetId);
      expect(row).toMatchObject({ state: "pending", ready: "pending", text: failed!.text });
    }
  });

  it("CHECK roli przyjmuje explanation_audio i dalej odrzuca nieznane role", async () => {
    const { draft } = await generatedGrammarLesson();
    const revision = (await pool.query(`select id from learning_app.item_revisions where deck_version_id = $1 limit 1`, [draft.id])).rows[0].id;
    await pool.query(`delete from learning_app.revision_assets where item_revision_id = $1 and role = 'explanation_audio'`, [revision]);
    await expect(pool.query(
      `insert into learning_app.revision_assets (item_revision_id, role, expected_fingerprint, state) values ($1, 'explanation_audio', 'fp', 'pending')`, [revision],
    )).resolves.toBeDefined();
    await expect(pool.query(
      `insert into learning_app.revision_assets (item_revision_id, role, expected_fingerprint, state) values ($1, 'bogus_audio', 'fp', 'pending')`, [revision],
    )).rejects.toThrow(/revision_assets_role_allowed/);
  });

  it("worker nagrywa wyjaśnienie (pl-PL, ze zdaniem stylu) i DTO pokazuje gotowe nagranie", async () => {
    const { fakes, draft } = await generatedGrammarLesson();
    const styled = { ...fakes.settings, tts: { ...fakes.settings.tts, style: "instructions" as const } };
    // Zmiana trybu stylu zmienia instrukcje, więc uzgodnienie przy zapisie zleca nagranie ze zdaniem stylu.
    const services = createServices({ db, clock: new ManualClock(), media: styled, generation: fakes.deps });
    const saved = await editLessonDraft(services, draft.id, { expectedEditNumber: draft.editNumber, exercises: inputs(draft) });
    await drainWorker(services);

    const rows = await explanationRows(saved.id);
    expect(rows).toHaveLength(saved.exercises.length);
    expect(rows.every((row) => row.ready === "ready")).toBe(true);
    const requested = fakes.tts.requests.filter((request) => request.locale === "pl-PL" && request.text === FAKE_EXPLANATION);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested[0]!.instructions).toContain(STYLE_SENTENCES_PL.lesson_explanation);

    const ready = (await readLessonDeck(services, saved.deckId)).draft!;
    for (const exercise of ready.exercises) expect(exercise.explanationAudio).toMatchObject({ state: "ready", assetId: expect.any(String) });
  });

  it("worker z wyłączoną flagą przedmiotu zastępuje oczekujące explanation_audio bez wołania TTS", async () => {
    const { fakes, draft } = await generatedGrammarLesson();
    const rows = await explanationRows(draft.id);
    const assetIds = [...new Set(rows.map((row) => row.assetId))];
    // Przedmiot traci flagę wyjaśnień, ale zachowuje odczyt zdań feedbacku: tylko wyjaśnienia są anulowane.
    const services = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps, subjects: withoutExplanations() });
    await drainWorker(services);
    expect(fakes.tts.requests.some((request) => request.text === FAKE_EXPLANATION)).toBe(false);
    expect(fakes.tts.requests.length).toBeGreaterThan(0);
    const assets = (await pool.query<{ state: string }>("select state from learning_app.media_assets where id = any($1)", [assetIds])).rows;
    expect(assets.every((asset) => asset.state === "failed")).toBe(true);
    const runs = (await pool.query<{ state: string }>("select state from learning_app.generation_runs where asset_id = any($1)", [assetIds])).rows;
    expect(runs.every((run) => run.state === "superseded")).toBe(true);
  });

  it("przedmiot bez flagi nie ma roli ani pola w DTO szkicu (szkoła)", async () => {
    const { versionId } = await seedSchoolDraft([{ id: SPIDER_OBJECTIVE, titlePl: "Pająki", descriptionEn: "Spiders.",
      cards: [{ title: "Pająki", body: "Pająk ma osiem nóg." }, { title: "Owady", body: "Owady mają sześć nóg." }] }]);
    const draft = await editLessonDraft(audioServices(), versionId, { expectedEditNumber: 1, exercises: spiderExercises() });
    expect(draft).not.toHaveProperty("exerciseExplanations");
    for (const exercise of draft.exercises) expect(exercise).not.toHaveProperty("explanationAudio");
    expect(await explanationRows(versionId)).toEqual([]);
  });

  it("zapis szkicu z wyczyszczonym wyjaśnieniem usuwa wiersz roli tylko tego ćwiczenia", async () => {
    const { services, draft } = await generatedGrammarLesson();
    const saved = await editLessonDraft(services, draft.id, {
      expectedEditNumber: draft.editNumber,
      exercises: inputs(draft, (exercise, index) => {
        if (index !== 0) return exercise;
        const { explanationPl: _removed, ...rest } = exercise;
        return rest;
      }),
    });
    const rows = await explanationRows(saved.id);
    expect(rows).toHaveLength(draft.exercises.length - 1);
    expect(saved.exercises[0]).not.toHaveProperty("explanationAudio");
    expect(saved.exercises[0]).not.toHaveProperty("explanationPl");
    expect(saved.exercises.slice(1).every((exercise) => exercise.explanationAudio?.state === "pending")).toBe(true);
    expect(rows.map((row) => row.position)).not.toContain(0);
  });
});

describe("nagranie wyjaśnienia — „Nagraj ponownie”", () => {
  it("role explanation_audio zleca nową generację tego samego fingerprintu, a wiersz wraca do pending", async () => {
    const { fakes, draft } = await generatedGrammarLesson();
    const worker = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps });
    await drainWorker(worker);
    const [first] = await explanationRows(draft.id);
    expect(first).toMatchObject({ ready: "ready" });

    const { assetId } = await regenerateLessonPromptAudio(worker, { lessonDraftId: draft.id, itemRevisionId: first!.revisionId, role: "explanation_audio" });
    expect(assetId).not.toBe(first!.assetId);
    const generations = await generationsOf(first!.fingerprint);
    expect(generations.map((generation) => generation.generationNumber)).toEqual([1, 2]);
    const row = (await explanationRows(draft.id)).find((entry) => entry.revisionId === first!.revisionId)!;
    expect(row).toMatchObject({ assetId, state: "pending", ready: "pending" });

    // Odsłuch rodzica: nowe nagranie w toku niesie poprzednie gotowe ujęcie.
    const deck = (await readLessonDeck(worker, draft.deckId)).draft!;
    expect(deck.exercises.find((exercise) => exercise.revisionId === first!.revisionId)!.explanationAudio)
      .toEqual({ state: "pending", previousAssetId: first!.assetId });
  });

  it("brak wiersza roli (ćwiczenie bez wyjaśnienia) daje not_found; wywołanie bez role dotyczy prompt_audio i nie rusza wyjaśnienia", async () => {
    const { services, draft } = await generatedGrammarLesson();
    const saved = await editLessonDraft(services, draft.id, {
      expectedEditNumber: draft.editNumber,
      exercises: inputs(draft, (exercise, index) => {
        if (index !== 0) return exercise;
        const { explanationPl: _removed, ...rest } = exercise;
        return rest;
      }),
    });
    const cleared = saved.exercises[0]!.revisionId;
    await expect(regenerateLessonPromptAudio(services, { lessonDraftId: saved.id, itemRevisionId: cleared, role: "explanation_audio" }))
      .rejects.toMatchObject({ code: "not_found" });

    // Gramatyka nie ma nagrań pytań (`ttsForPrompts: false`), więc domyślna rola `prompt_audio` nie ma wiersza.
    const withExplanation = saved.exercises[1]!.revisionId;
    const before = await explanationRows(saved.id);
    await expect(regenerateLessonPromptAudio(services, { lessonDraftId: saved.id, itemRevisionId: withExplanation }))
      .rejects.toMatchObject({ code: "not_found" });
    expect(await explanationRows(saved.id)).toEqual(before);
    expect((await generationsOf(before[0]!.fingerprint)).map((generation) => generation.generationNumber)).toEqual([1]);
  });

  it("nieznana rola jest odrzucana walidacją", async () => {
    const { services, draft } = await generatedGrammarLesson();
    await expect(regenerateLessonPromptAudio(services, {
      lessonDraftId: draft.id, itemRevisionId: draft.exercises[0]!.revisionId, role: "feedback_audio" as never,
    })).rejects.toThrow();
  });
});

describe("nagranie wyjaśnienia — edycja po publikacji", () => {
  it("edycja samego wyjaśnienia zachowuje skill_version i payload_version, a zleca nowe nagranie", async () => {
    const { services, run, draft } = await generatedGrammarLesson();
    await publishLessonDraft(services, draft.id, draft.editNumber);
    const copy = await createLessonDraftFromPublished(services, run.deckId);
    const stateOf = async (versionId: string) => (await pool.query<{ position: number; payloadVersion: number; skills: string }>(
      `select ir.position, ir.payload_version as "payloadVersion",
              string_agg(irs.skill || ':' || irs.skill_version_id::text, ',' order by irs.skill) as skills
         from learning_app.item_revisions ir
         left join learning_app.item_revision_skills irs on irs.item_revision_id = ir.id
        where ir.deck_version_id = $1 group by ir.id, ir.position order by ir.position`,
      [versionId],
    )).rows;
    const before = await stateOf(copy.id);
    expect(before.length).toBe(draft.exercises.length);

    const changed = "Po he, she i it dodajemy s.";
    const edited = await editLessonDraft(services, copy.id, {
      expectedEditNumber: copy.editNumber,
      exercises: inputs(copy, (exercise, index) => (index === 0 ? { ...exercise, explanationPl: changed } : exercise)),
    });
    expect(await stateOf(edited.id)).toEqual(before);

    const rows = await explanationRows(edited.id);
    const updated = rows.find((row) => row.text === changed)!;
    expect(updated).toMatchObject({ state: "pending", ready: "pending", locale: "pl-PL" });
    expect(rows.filter((row) => row.text === FAKE_EXPLANATION)).toHaveLength(draft.exercises.length - 1);
    const queued = await pool.query(
      "select count(*)::int as count from learning_app.generation_runs where asset_id = $1 and state = 'queued'", [updated.assetId]);
    expect(queued.rows[0].count).toBe(1);

    await expect(publishLessonDraft(services, edited.id, edited.editNumber)).resolves.toEqual({ deckVersionId: edited.id });
  });
});

// ---------------------------------------------------------------------------
// Sesja: wyjaśnienie w feedbacku po błędzie (spec 2026-11-01 §4)
// ---------------------------------------------------------------------------

type Services = ReturnType<typeof buildTestServices>["services"];

const EXPLANATION = "Po he, she, it dodajemy końcówkę do czasownika.";
const TEMPLATE_MISSING_ENDING = "Przy he, she, it dodajemy -s: he plays.";

const plain = () => buildTestServices().services;

/** Services z fake graderem (selektor wydaje wtedy typy zależne od modelu). */
function graderServices(grader: FakeAnswerGrader = new FakeAnswerGrader(), subjects?: ReturnType<typeof createSubjectRegistry>): Services {
  const { clock } = buildTestServices();
  return createServices({
    db, clock,
    generation: {} as Parameters<typeof createServices>[0]["generation"],
    grader: fakeGraderDeps({ provider: grader }),
    ...(subjects ? { subjects } : {}),
  });
}

async function answerKeyOf(taskId: string): Promise<Record<string, unknown>> {
  return (await pool.query<{ answerKey: Record<string, unknown> }>(
    `select answer_key as "answerKey" from learning_app.session_tasks where id = $1`, [taskId],
  )).rows[0]!.answerKey;
}

async function answerCorrectly(services: Services, task: TaskDto): Promise<void> {
  const key = await answerKeyOf(task.taskId);
  if (task.exerciseType === "lesson_choice" || task.exerciseType === "lesson_short_answer" || task.exerciseType === "lesson_notice") {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });
  } else if (task.exerciseType === "lesson_order") {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "sequence", itemIds: key.itemIds as string[] });
  } else {
    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: key.answer as string });
  }
}

const PRODUCTIVE = new Set(["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"]);

/** Wydaje zadania do pierwszego ćwiczenia typu (`null` = dowolne ćwiczenie). */
async function issueUntil(services: Services, sessionId: string, type: string | null, max = 40): Promise<TaskDto> {
  const advance = type !== null && PRODUCTIVE.has(type);
  for (let i = 0; i < max; i++) {
    const task = await nextTask(services, sessionId);
    if (task === null) throw new Error(`sesja skończyła się przed ${type}`);
    if (task.exerciseType === "lesson_card") {
      await completePresentation(services, { taskId: task.taskId });
      continue;
    }
    if (type === null || task.exerciseType === type) return task;
    if (advance) await answerCorrectly(services, task);
    else await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "skip" });
  }
  throw new Error(`nie doczekano ćwiczenia ${type}`);
}

async function assetOf(taskId: string, role: "feedback_audio" | "explanation_audio"): Promise<string> {
  return (await pool.query<{ assetId: string }>(
    `select ra.asset_id as "assetId" from learning_app.revision_assets ra
       join learning_app.session_tasks st on st.item_revision_id = ra.item_revision_id
      where st.id = $1 and ra.role = $2`, [taskId, role],
  )).rows[0]!.assetId;
}

interface EventRow { occurredAt: Date; sealed: boolean; exposures: string[] }

async function eventsOf(taskId: string, kind: "audio_issued" | "feedback_issued"): Promise<EventRow[]> {
  return (await pool.query<EventRow>(
    `select le.occurred_at as "occurredAt", le.sealed,
            coalesce(array_agg(ee.target_key order by ee.target_key) filter (where ee.target_key is not null), '{}') as exposures
       from learning_app.learning_events le
       left join learning_app.event_exposures ee on ee.event_id = le.id
      where le.task_id = $1 and le.kind = $2
      group by le.id order by le.occurred_at, le.id`, [taskId, kind],
  )).rows;
}

async function independentOf(attemptId: string): Promise<boolean | null> {
  return (await pool.query<{ independent: boolean }>(
    "select independent from learning_app.assessments where attempt_id = $1 and skill = 'objective'", [attemptId],
  )).rows[0]?.independent ?? null;
}

type Answer = (task: TaskDto, key: Record<string, unknown>) => Record<string, unknown>;

interface Scenario {
  type: string;
  services: () => Services;
  answer: Answer;
  withPriorSuccess?: boolean;
  /** Domyślnie wyjaśnienie z gotowym nagraniem; `null` = lekcja bez wyjaśnień. */
  explanations?: LessonWorldOptions["withExplanations"] | null;
  feedbackAudio?: "ready" | "pending";
}

/** Jedno dziecko, jedna lekcja gramatyki, odpowiedź na pierwsze zadanie typu. */
async function play(scenario: Scenario) {
  const services = scenario.services();
  const now = services.clock.now();
  const child = await createChild(services, { displayName: "Wyjaśnienie", avatarKey: "owl" });
  const explanations = scenario.explanations === undefined ? { text: EXPLANATION, audio: "ready" as const } : scenario.explanations;
  const lesson = await lessonWorld(pool, {
    childId: child.id, richPool: true, now, withObjectiveAssessment: scenario.withPriorSuccess ?? false,
    ...(scenario.feedbackAudio ? { withFeedbackAudio: scenario.feedbackAudio } : {}),
    ...(explanations ? { withExplanations: explanations } : {}),
  });
  const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
  const task = await issueUntil(services, session.sessionId, scenario.type);
  const key = await answerKeyOf(task.taskId);
  const input = { taskId: task.taskId, clientAttemptId: randomUUID(), ...scenario.answer(task, key) } as AttemptInput;
  const attempt = await submitAttempt(services, input);
  return { services, task, key, input, attempt, independent: await independentOf(attempt.attemptId) };
}

const choiceCorrect: Answer = (_task, key) => ({ modality: "choice", optionId: key.correctOptionId as string });
const choiceWrong: Answer = (task, key) => ({
  modality: "choice",
  optionId: (task.prompt as { options: { id: string }[] }).options.find((o) => o.id !== key.correctOptionId)!.id,
});
const text = (value: string): Answer => () => ({ modality: "text", text: value });
const dontRemember: Answer = () => ({ modality: "dont_remember" });
const missingEndingGrader = () => new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "missing_ending", fragments: ["play"], note: "brak -s" } });

describe("sesja — wyjaśnienie w feedbacku po błędzie", () => {
  it("błędny wybór → incorrect z wyjaśnieniem, jego nagraniem i nagraniem zdania; jedno audio_issued; samodzielność jak bez wyjaśnienia", async () => {
    const scenario: Scenario = { type: "lesson_choice", services: plain, answer: choiceWrong, feedbackAudio: "ready" };
    const played = await play(scenario);
    const { attempt, task, key } = played;
    const explanationAudio = await assetOf(task.taskId, "explanation_audio");
    expect(key).toMatchObject({ explanationPl: EXPLANATION, explanationAudioAssetId: explanationAudio });
    expect(JSON.stringify(task)).not.toContain(EXPLANATION);
    expect(JSON.stringify(task)).not.toContain(explanationAudio);
    expect(attempt.feedback).toEqual({
      kind: "incorrect",
      correctText: "plays",
      hintPl: EXPLANATION,
      explanationAudioAssetId: explanationAudio,
      correctAudioAssetId: await assetOf(task.taskId, "feedback_audio"),
    });
    expect(FeedbackDtoSchema.safeParse(attempt.feedback).success).toBe(true);

    const audio = await eventsOf(task.taskId, "audio_issued");
    expect(audio).toHaveLength(1);
    expect(audio[0]!.sealed).toBe(true);
    expect(audio[0]!.occurredAt.getTime()).toBeGreaterThan(new Date(attempt.receivedAt).getTime());

    const baseline = await play({ ...scenario, explanations: null });
    expect(baseline.attempt.feedback).not.toHaveProperty("hintPl");
    // Obie oceny istnieją (null = brak oceny celu), a wyjaśnienie nie zmienia samodzielności.
    expect(played.independent).not.toBeNull();
    expect(baseline.independent).not.toBeNull();
    expect(played.independent).toBe(baseline.independent);
  });

  it("samo nagranie wyjaśnienia (bez nagrania zdania) też daje jedno zapieczętowane audio_issued", async () => {
    const { attempt, task } = await play({ type: "lesson_choice", services: plain, answer: choiceWrong });
    expect(attempt.feedback?.correctAudioAssetId).toBeUndefined();
    expect(attempt.feedback?.explanationAudioAssetId).toBe(await assetOf(task.taskId, "explanation_audio"));
    const audio = await eventsOf(task.taskId, "audio_issued");
    expect(audio).toHaveLength(1);
    expect(audio[0]!.sealed).toBe(true);
    expect(audio[0]!.occurredAt.getTime()).toBeGreaterThan(new Date(attempt.receivedAt).getTime());
  });

  it("Angielski — rozdział: błędny wybór → incorrect z wyjaśnieniem i jego nagraniem", async () => {
    const fakes = await fakeGeneration();
    cleanup.push(fakes.dispose);
    const services = createServices({ db, clock: new ManualClock(), media: fakes.settings, generation: fakes.deps });
    const run = await createLessonFromMaterial(services, {
      subjectId: "english_chapter", topicTitlePl: "Ubrania", material: "I'm wearing a coat. I'm wearing boots. She is wearing a dress.",
      poolSize: 40, clientRequestId: randomUUID(),
    });
    await executeLessonGeneration(services, run.runId);
    const draft = (await readLessonDeck(services, run.deckId)).draft!;
    await drainWorker(services);
    await publishLessonDraft(services, draft.id, draft.editNumber);
    const child = await createChild(services, { displayName: "Rozdział", avatarKey: "owl" });
    await pool.query("insert into learning_app.assignments (id, child_id, deck_id) values ($1, $2, $3)", [randomUUID(), child.id, run.deckId]);
    const session = await startSession(services, { childId: child.id, deckId: run.deckId, microphoneEnabled: false });
    const task = await issueUntil(services, session.sessionId, "lesson_choice");
    const key = await answerKeyOf(task.taskId);
    expect(key).toMatchObject({ explanationPl: FAKE_EXPLANATION, explanationAudioAssetId: expect.any(String) });
    const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), ...choiceWrong(task, key) } as AttemptInput);
    expect(attempt.feedback).toMatchObject({
      kind: "incorrect", hintPl: FAKE_EXPLANATION, explanationAudioAssetId: key.explanationAudioAssetId, correctText: expect.any(String),
    });
    expect(FeedbackDtoSchema.safeParse(attempt.feedback).success).toBe(true);
    expect(JSON.stringify(task)).not.toContain(FAKE_EXPLANATION);
  });

  it("„Nie pamiętam” → incorrect z wyjaśnieniem", async () => {
    const { attempt, task } = await play({ type: "lesson_choice", services: plain, answer: dontRemember });
    expect(attempt.feedback).toMatchObject({
      kind: "incorrect", correctText: "plays", hintPl: EXPLANATION, explanationAudioAssetId: await assetOf(task.taskId, "explanation_audio"),
    });
  });

  it("model_incorrect z kategorią celu → szablon kategorii, bez nagrania wyjaśnienia", async () => {
    const { attempt } = await play({
      type: "lesson_transform", withPriorSuccess: true, answer: text("she play"), services: () => graderServices(missingEndingGrader()),
    });
    expect(attempt.feedback).toMatchObject({ kind: "lesson_hint", hintPl: TEMPLATE_MISSING_ENDING });
    expect(attempt.feedback?.explanationAudioAssetId).toBeUndefined();
  });

  describe("nadpisanie rodzica „niepoprawne” werdyktu kategorii other (model_incorrect bez szablonu)", () => {
    const otherGrader = () => new FakeAnswerGrader().onDefault({ raw: { verdict: "incorrect", errorCategory: "other", fragments: ["play"], note: "off topic" } });

    async function overriddenRetry(explanations?: Scenario["explanations"]) {
      const played = await play({
        type: "lesson_transform", withPriorSuccess: true, answer: text("she play"), services: () => graderServices(otherGrader()),
        ...(explanations === undefined ? {} : { explanations }),
      });
      // model_other: wynik nieoceniony, zadanie zostaje issued — bez wyjaśnienia.
      expect(played.attempt.taskState).toBe("issued");
      expect(played.attempt.feedback).toMatchObject({ kind: "incorrect" });
      expect(played.attempt.feedback?.hintPl).toBeUndefined();
      const verdictId = (await pool.query<{ id: string }>("select id from learning_app.lesson_verdicts")).rows[0]!.id;
      await decideLessonVerdict(played.services, verdictId, "overridden_incorrect");
      const retry = await submitAttempt(played.services, { taskId: played.task.taskId, clientAttemptId: randomUUID(), modality: "text", text: "she play" });
      return { ...played, retry };
    }

    it("z wyjaśnieniem → lesson_hint z wyjaśnieniem, nagraniem i segmentami", async () => {
      const { retry, task } = await overriddenRetry();
      expect(retry.taskState).toBe("answered");
      expect(retry.feedback).toMatchObject({
        kind: "lesson_hint", hintPl: EXPLANATION, explanationAudioAssetId: await assetOf(task.taskId, "explanation_audio"),
        correctText: expect.any(String), answerSegments: expect.any(Array),
      });
      expect(FeedbackDtoSchema.safeParse(retry.feedback).success).toBe(true);
    });

    it("bez wyjaśnienia → incorrect z correctText (bez segmentów), zgodny z kontraktem", async () => {
      const { retry } = await overriddenRetry(null);
      expect(retry.feedback).toEqual({ kind: "incorrect", correctText: expect.any(String) });
      expect(FeedbackDtoSchema.safeParse(retry.feedback).success).toBe(true);
    });
  });

  describe("bez wyjaśnienia", () => {
    it("dobra odpowiedź → great bez wyjaśnienia", async () => {
      const { attempt } = await play({ type: "lesson_choice", services: plain, answer: choiceCorrect });
      expect(attempt.feedback).toEqual({ kind: "great" });
    });

    it("„prawie” (minor_typo) → lesson_almost bez wyjaśnienia", async () => {
      const { attempt } = await play({ type: "lesson_transform", services: () => graderServices(), answer: text("shee plays"), withPriorSuccess: true });
      expect(attempt.feedback?.kind).toBe("lesson_almost");
      expect(attempt.feedback?.hintPl).toBeUndefined();
      expect(attempt.feedback?.explanationAudioAssetId).toBeUndefined();
    });

    it("not_assessed (brak modelu) → bez wyjaśnienia i bez audio_issued", async () => {
      const { attempt, task } = await play({ type: "lesson_gap", services: plain, answer: text("completely wrong"), withPriorSuccess: true });
      expect(attempt.feedback).toEqual({ kind: "not_assessed" });
      expect(await eventsOf(task.taskId, "audio_issued")).toEqual([]);
    });

    it("„Pomiń” → brak feedbacku i audio_issued", async () => {
      const { attempt, task } = await play({ type: "lesson_choice", services: plain, answer: () => ({ modality: "skip" }) });
      expect(attempt.feedback).toBeNull();
      expect(await eventsOf(task.taskId, "audio_issued")).toEqual([]);
    });

    it("kartkówka → klucz bez wyjaśnienia, feedback null", async () => {
      const services = plain();
      const child = await createChild(services, { displayName: "Kartkówka", avatarKey: "owl" });
      const lesson = await lessonWorld(pool, {
        childId: child.id, richPool: true, now: services.clock.now(), testDate: "2026-10-20", withExplanations: { text: EXPLANATION, audio: "ready" },
      });
      const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false, mode: "mock_test" });
      let checked = 0;
      for (let i = 0; i < 20; i++) {
        const task = await nextTask(services, session.sessionId);
        if (!task) break;
        if (task.exerciseType === "lesson_card") {
          await completePresentation(services, { taskId: task.taskId });
          continue;
        }
        const key = await answerKeyOf(task.taskId);
        expect(key).not.toHaveProperty("explanationPl");
        expect(key).not.toHaveProperty("explanationAudioAssetId");
        expect(key).not.toHaveProperty("explanationExposureKeys");
        const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "dont_remember" });
        expect(attempt.feedback).toBeNull();
        expect(await eventsOf(task.taskId, "audio_issued")).toEqual([]);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(0);
    });

    it("przedmiot bez flagi exerciseExplanations ignoruje wyjaśnienie w payloadzie", async () => {
      const { attempt, key } = await play({ type: "lesson_choice", services: () => graderServices(new FakeAnswerGrader(), withoutExplanations()), answer: choiceWrong });
      expect(key).not.toHaveProperty("explanationPl");
      expect(attempt.feedback).toEqual({ kind: "incorrect", correctText: "plays" });
    });

    it("szkoła → zadania bez wyjaśnienia, „Nie pamiętam” bez hintPl", async () => {
      const { active, child, deckId } = await publishAssignedSpiderLesson(
        await seedSchoolDraft([{ id: SPIDER_OBJECTIVE, titlePl: "Pająki", descriptionEn: "Spiders.",
          cards: [{ title: "Pająki", body: "Pająk ma osiem nóg." }, { title: "Owady", body: "Owady mają sześć nóg." }] }]),
        "Szkoła",
      );
      const session = await startSession(active, { childId: child.id, deckId, microphoneEnabled: false });
      const task = await issueUntil(active, session.sessionId, null);
      expect(await answerKeyOf(task.taskId)).not.toHaveProperty("explanationPl");
      const attempt = await submitAttempt(active, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "dont_remember" });
      expect(attempt.feedback?.hintPl).toBeUndefined();
      expect(attempt.feedback?.explanationAudioAssetId).toBeUndefined();
    });
  });

  describe("ekspozycje i niezmienność klucza", () => {
    const QUOTING = "Wybierz plays, tak jak w zdaniu he goes.";
    const quoting: Scenario = {
      type: "lesson_choice", services: plain, answer: choiceWrong,
      explanations: { text: EXPLANATION, textByType: { lesson_choice: QUOTING }, audio: "ready" },
    };

    it("wyjaśnienie cytujące odpowiedź innego ćwiczenia → ekspozycja tamtego celu zapisana razem z feedbackiem", async () => {
      const { attempt, task, key } = await play(quoting);
      expect(key.explanationExposureKeys).toContain(RICH_KEYS.gap);
      expect(key.explanationExposureKeys).not.toContain(key.targetKey);
      expect(attempt.feedback?.hintPl).toBe(QUOTING);
      const [feedbackEvent] = await eventsOf(task.taskId, "feedback_issued");
      expect(feedbackEvent!.sealed).toBe(true);
      expect(feedbackEvent!.exposures).toEqual(expect.arrayContaining([key.targetKey as string, RICH_KEYS.gap]));
      expect(feedbackEvent!.exposures).not.toContain(RICH_KEYS.order);
    });

    it("feedback z szablonem kategorii nie zapisuje ekspozycji cytatów", async () => {
      const { attempt, task, key } = await play({
        type: "lesson_transform", withPriorSuccess: true, answer: text("she play"), services: () => graderServices(missingEndingGrader()),
        explanations: { text: QUOTING, audio: "ready" },
      });
      expect(attempt.feedback?.hintPl).toBe(TEMPLATE_MISSING_ENDING);
      expect(key.explanationExposureKeys).toContain(RICH_KEYS.gap);
      const [feedbackEvent] = await eventsOf(task.taskId, "feedback_issued");
      expect(feedbackEvent!.exposures).toEqual([key.targetKey]);
    });

    it("readAttempt i idempotentne ponowienie → ten sam feedback i ekspozycje, bez nowego audio_issued", async () => {
      const { services, attempt, task, input } = await play(quoting);
      const read = await readAttempt(services, attempt.attemptId);
      expect(read.feedback).toEqual(attempt.feedback);
      const retried = await submitAttempt(services, input);
      expect(retried.feedback).toEqual(attempt.feedback);
      const events = await eventsOf(task.taskId, "feedback_issued");
      expect(events).toHaveLength(3);
      for (const event of events) expect(event.exposures).toEqual(events[0]!.exposures);
      expect(events[0]!.exposures).toContain(RICH_KEYS.gap);
      expect(await eventsOf(task.taskId, "audio_issued")).toHaveLength(1);
    });

    it("nagranie niegotowe przy wydaniu, gotowe przy odpowiedzi → wyjaśnienie bez nagrania i bez audio_issued", async () => {
      const services = plain();
      const child = await createChild(services, { displayName: "Później", avatarKey: "owl" });
      const lesson = await lessonWorld(pool, {
        childId: child.id, richPool: true, now: services.clock.now(), withExplanations: { text: EXPLANATION, audio: "pending" },
      });
      const session = await startSession(services, { childId: child.id, deckId: lesson.deckId, microphoneEnabled: false });
      const task = await issueUntil(services, session.sessionId, "lesson_choice");
      await pool.query(
        `update learning_app.media_assets
            set state = 'ready', storage_key = 'blob/' || id, mime_type = 'audio/mpeg', byte_count = 3, content_sha256 = $1, lease_token = null
          where state = 'pending'`,
        ["0".repeat(64)],
      );
      const key = await answerKeyOf(task.taskId);
      expect(key).not.toHaveProperty("explanationAudioAssetId");
      const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), ...choiceWrong(task, key) } as AttemptInput);
      expect(attempt.feedback).toEqual({ kind: "incorrect", correctText: "plays", hintPl: EXPLANATION });
      expect(await eventsOf(task.taskId, "audio_issued")).toEqual([]);
    });

    it("zadanie wydane przed edycją wyjaśnienia zachowuje stary tekst i swoje nagranie", async () => {
      const { services, run, draft } = await generatedGrammarLesson();
      await drainWorker(services);
      await publishLessonDraft(services, draft.id, draft.editNumber);
      const child = await createChild(services, { displayName: "Edycja", avatarKey: "owl" });
      await pool.query("insert into learning_app.assignments (id, child_id, deck_id) values ($1, $2, $3)", [randomUUID(), child.id, run.deckId]);
      const session = await startSession(services, { childId: child.id, deckId: run.deckId, microphoneEnabled: false });
      const task = await issueUntil(services, session.sessionId, null);
      const key = await answerKeyOf(task.taskId);
      expect(key).toMatchObject({ explanationPl: FAKE_EXPLANATION, explanationAudioAssetId: expect.any(String) });

      const changed = "Po he, she i it dodajemy s.";
      const copy = await createLessonDraftFromPublished(services, run.deckId);
      const edited = await editLessonDraft(services, copy.id, {
        expectedEditNumber: copy.editNumber,
        exercises: inputs(copy, (exercise) => ({ ...exercise, explanationPl: changed })),
      });
      await publishLessonDraft(services, edited.id, edited.editNumber);
      await drainWorker(services);

      const attempt = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "dont_remember" });
      expect(attempt.feedback).toMatchObject({ kind: "incorrect", hintPl: FAKE_EXPLANATION, explanationAudioAssetId: key.explanationAudioAssetId });
    });
  });
});
