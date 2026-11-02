import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  AppError,
  authorizeDisclosure,
  completePresentation,
  computeTargetKey,
  createChild,
  createServices,
  dictateLessonAnswer,
  endSession,
  FakeAnswerGrader,
  FakeDictationSttProvider,
  fakeLessonSpeechDeps,
  lessonObjectiveProgress,
  nextTask,
  startSession,
  submitAttempt,
} from "@learning/server";
import type { SttProvider, TranscriptionResult } from "@learning/server";
import type { TaskDto } from "@learning/contracts";
import { buildTestServices, handleKidApi, type ManualClock, testDatabase, truncateCoreTables } from "./helpers";

/**
 * Etap 3 przedmiotów szkolnych (design §5): dyktowanie odpowiedzi otwartej.
 * Dyktowanie zwraca tekst do pola albo powód jego braku i niczego nie zapisuje
 * poza licznikiem i skrótem w kontekście sesji; odpowiedź wysłana z tekstem
 * z dyktowania jest zwykłą próbą tekstową z `answer.inputMethod = 'speech'`.
 * STT zastępuje fake — nagranie nigdzie nie trafia.
 */

const { pool } = testDatabase();

beforeEach(async () => {
  await truncateCoreTables();
  await pool.query(`truncate learning_app.child_objective_progress, learning_app.lesson_verdicts,
    learning_app.revision_assets, learning_app.media_assets, learning_app.item_revision_skills,
    learning_app.item_revisions, learning_app.skill_versions, learning_app.learning_items,
    learning_app.deck_versions, learning_app.decks cascade`);
});
afterAll(() => pool.end());

const OBJECTIVE_ID = "school.ddeck000.poziomice";
const TWO_SENTENCES = "Poziomica to linia. Łączy punkty o tej samej wysokości.";
const DICTATED = "Poziomica to linia łącząca punkty o tej samej wysokości.";

async function seedSchoolDeck(childId: string, options: { expectedForm?: string } = {}): Promise<{ deckId: string }> {
  const deckId = randomUUID();
  const versionId = randomUUID();
  const context = {
    subjectId: "school", topicId: "dynamic", topicVersion: 1, objectiveIds: [OBJECTIVE_ID], poolSize: 20, examples: {},
    material: "Poziomica to linia na mapie łącząca punkty położone na tej samej wysokości.",
    subjectTitlePl: "Geografia",
    dynamicTopic: {
      titlePl: "Mapa",
      objectives: [{
        id: OBJECTIVE_ID, titlePl: "Poziomice", descriptionEn: "Contour lines join points of equal height.",
        cards: [{ title: "Poziomica", body: "Linia łącząca punkty o tej samej wysokości." }],
      }],
    },
  };
  await pool.query("insert into learning_app.decks (id, title, kind) values ($1, 'Geografia: Mapa', 'lesson')", [deckId]);
  await pool.query(
    `insert into learning_app.deck_versions (id, deck_id, version_number, edit_number, state, title, lesson_context)
     values ($1, $2, 1, 1, 'draft', 'Geografia: Mapa', $3::jsonb)`,
    [versionId, deckId, JSON.stringify(context)],
  );
  const exercises: Record<string, unknown>[] = [
    {
      exerciseType: "lesson_choice", objectiveId: OBJECTIVE_ID, instructionPl: "Wybierz.",
      stem: "Co łączy poziomica?", answer: "punkty o tej samej wysokości", acceptedAnswers: [], focus: ["wysokości"],
      options: [{ id: "a", text: "punkty o tej samej wysokości" }, { id: "b", text: "miasta" }], correctOption: "a",
      sourceRefs: [{ quote: "łącząca punkty położone na tej samej wysokości" }],
    },
    {
      exerciseType: "lesson_choice", objectiveId: OBJECTIVE_ID, instructionPl: "Wybierz.",
      stem: "Gdzie rysuje się poziomice?", answer: "na mapie", acceptedAnswers: [], focus: ["mapie"],
      options: [{ id: "a", text: "na mapie" }, { id: "b", text: "na niebie" }], correctOption: "a",
      sourceRefs: [{ quote: "linia na mapie" }],
    },
    {
      exerciseType: "lesson_gap", objectiveId: OBJECTIVE_ID, instructionPl: "Uzupełnij.",
      stem: "Poziomica to ___ na mapie.", answer: "linia", acceptedAnswers: [], focus: ["linia"],
      sourceRefs: [{ quote: "Poziomica to linia" }],
    },
    {
      exerciseType: "lesson_gap", objectiveId: OBJECTIVE_ID, instructionPl: "Uzupełnij.",
      stem: "Poziomica łączy punkty o tej samej ___.", answer: "wysokości", acceptedAnswers: [], focus: ["wysokości"],
      sourceRefs: [{ quote: "na tej samej wysokości" }],
    },
    // Trzy rodziny pytań otwartych: ujawniona odpowiedź nie wraca jako sprawdzenie,
    // więc kolejne odpowiedzi w jednym teście trafiają do innej rodziny.
    ...["Co to jest poziomica?", "Czym jest poziomica na mapie?", "Wyjaśnij, co oznacza poziomica."].map((prompt, index) => ({
      exerciseType: "lesson_open_answer", objectiveId: OBJECTIVE_ID, instructionPl: "Odpowiedz własnymi słowami.",
      prompt, familyId: `def-${index}`,
      answer: `${DICTATED} (${index + 1})`,
      // zatwierdzone warianty: dopasowanie deterministyczne, bez modelu
      acceptedAnswers: [DICTATED, TWO_SENTENCES], focus: ["poziomica"],
      questionType: "definition", expectedForm: options.expectedForm ?? "explanation",
      requiredElements: [{ id: "e1", text: "poziomica to linia" }, { id: "e2", text: "łączy punkty o tej samej wysokości" }],
      supplementaryElements: [], commonErrors: [],
      sourceRefs: [{ quote: "łącząca punkty położone na tej samej wysokości" }],
    })),
  ];
  let position = 0;
  for (const payload of exercises) {
    const itemId = randomUUID();
    const revisionId = randomUUID();
    const skillVersionId = randomUUID();
    await pool.query("insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'lesson_exercise')", [itemId, deckId]);
    await pool.query(
      `insert into learning_app.item_revisions (id, item_id, deck_id, deck_version_id, position, payload_version, payload, target_key)
       values ($1, $2, $3, $4, $5, 3, $6::jsonb, $7)`,
      [revisionId, itemId, deckId, versionId, position++, JSON.stringify(payload), computeTargetKey(String(payload.answer), "pl-PL")],
    );
    await pool.query(
      `insert into learning_app.skill_versions (id, item_id, skill, revision_number, criteria, criteria_hash)
       values ($1, $2, 'objective', 1, $3::jsonb, $4)`,
      [skillVersionId, itemId, JSON.stringify({ objectiveId: payload.objectiveId }), `oc-${skillVersionId}`],
    );
    await pool.query(
      "insert into learning_app.item_revision_skills (item_revision_id, item_id, skill, skill_version_id) values ($1, $2, 'objective', $3)",
      [revisionId, itemId, skillVersionId],
    );
  }
  await pool.query("update learning_app.deck_versions set state = 'published', published_at = now() where id = $1", [versionId]);
  await pool.query("update learning_app.decks set published_version_id = $1 where id = $2", [versionId, deckId]);
  await pool.query(
    "insert into learning_app.assignments (id, child_id, deck_id, test_date, test_goals) values ($1, $2, $3, CURRENT_DATE + 7, ARRAY['lesson'])",
    [randomUUID(), childId, deckId],
  );
  return { deckId };
}

type AnyServices = ReturnType<typeof createServices>;

/** STT, które zwraca kolejne zaprogramowane wyniki i liczy wywołania. */
class ScriptedStt implements SttProvider {
  readonly name = "scripted-stt";
  calls: { locale: string; bytes: number; durationMs?: number }[] = [];
  constructor(private readonly results: TranscriptionResult[]) {}
  async transcribe(audio: { bytes: Uint8Array; locale: string; durationMs?: number }): Promise<TranscriptionResult> {
    this.calls.push({ locale: audio.locale, bytes: audio.bytes.byteLength, durationMs: audio.durationMs });
    return this.results.shift() ?? { status: "ok", text: DICTATED, confidence: 0.97 };
  }
}

/** Zegar ostatnio złożonych usług — kolejna odpowiedź w teście to inny dzień. */
let currentClock: ManualClock;

function makeServices(options: { stt?: SttProvider | null; grader?: FakeAnswerGrader } = {}): AnyServices {
  const { services: base, clock } = buildTestServices();
  currentClock = clock;
  return createServices({
    db: (base as unknown as { db: Parameters<typeof createServices>[0]["db"] }).db,
    clock,
    ...(options.stt === null ? {} : { lessonSpeech: fakeLessonSpeechDeps(options.stt ?? new FakeDictationSttProvider()) }),
    ...(options.grader ? { grader: { provider: options.grader, maxCallsPerSession: 20, timeoutMs: 8000 } } : {}),
  });
}

/** WAV PCM 16 kHz mono o zadanej długości — w pamięci, bez pliku. */
function wav(seconds: number): { bytes: Uint8Array; mimeType: string; locale: string } {
  const dataBytes = Math.round(seconds * 16_000) * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, dataBytes, true);
  // klient zawsze podaje locale — serwer i tak bierze język z przedmiotu
  return { bytes, mimeType: "audio/wav", locale: "en-GB" };
}

/** Dochodzi do zadania otwartego w sesji treningowej (seed należnego sprawdzenia). */
async function reachOpenTask(
  services: AnyServices,
  childId: string,
  deckId: string,
  input: { microphoneEnabled?: boolean; mode?: "training" | "mock_test" } = {},
): Promise<TaskDto> {
  await pool.query(
    `insert into learning_app.child_objective_progress
       (child_id, subject_id, objective_id, topic_id, status, streak, next_review_at, projection_version)
     values ($1, 'school', $2, 'dynamic', 'needs_confirmation', 3, '2000-01-01T00:00:00Z', 'proj-1')
     on conflict do nothing`,
    [childId, OBJECTIVE_ID],
  );
  // Kolejne odpowiedzi w teście: cel ponownie należny niezależnie od poprzedniego wyniku.
  await pool.query(
    `update learning_app.child_objective_progress set status = 'needs_confirmation', next_review_at = '2000-01-01T00:00:00Z'
      where child_id = $1 and objective_id = $2`,
    [childId, OBJECTIVE_ID],
  );
  for (let s = 0; s < 5; s++) {
    const session = await startSession(services, {
      childId, deckId, microphoneEnabled: input.microphoneEnabled ?? true, ...(input.mode ? { mode: input.mode } : {}),
    });
    for (let i = 0; i < 40; i++) {
      const task = await nextTask(services, session.sessionId);
      if (task === null) break;
      if (task.exerciseType === "lesson_open_answer") return task;
      if (task.exerciseType === "lesson_card") {
        await completePresentation(services, { taskId: task.taskId });
        continue;
      }
      const rows = await pool.query<{ answerKey: Record<string, unknown> }>(
        `select answer_key as "answerKey" from learning_app.session_tasks where id = $1`, [task.taskId],
      );
      const key = rows.rows[0]!.answerKey;
      if (task.exerciseType === "lesson_choice") {
        await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "choice", optionId: key.correctOptionId as string });
      } else if (input.mode === "mock_test") {
        await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "skip" });
      } else {
        await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: key.answer as string });
      }
    }
  }
  throw new Error("open task not reached");
}

async function sessionContextOf(taskId: string): Promise<Record<string, unknown>> {
  const rows = await pool.query<{ context: Record<string, unknown> }>(
    `select s.context from learning_app.learning_sessions s join learning_app.session_tasks t on t.session_id = s.id where t.id = $1`,
    [taskId],
  );
  return rows.rows[0]!.context;
}

async function countRows(table: "attempts" | "assessments", taskId: string): Promise<number> {
  const sql = table === "attempts"
    ? "select count(*)::int as count from learning_app.attempts where task_id = $1"
    : "select count(*)::int as count from learning_app.assessments n join learning_app.attempts a on a.id = n.attempt_id where a.task_id = $1";
  return (await pool.query<{ count: number }>(sql, [taskId])).rows[0]!.count;
}

describe("dyktowanie odpowiedzi otwartej (Etap 3)", () => {
  it("trening z mikrofonem i skonfigurowanym STT oferuje dyktowanie z limitem 45 s", async () => {
    const services = makeServices();
    const child = await createChild(services, { displayName: "Dyktujący", avatarKey: "owl" });
    const { deckId } = await seedSchoolDeck(child.id);
    const task = await reachOpenTask(services, child.id, deckId);
    expect(task.prompt).toMatchObject({ kind: "lesson_open_answer", speechInput: { maxSeconds: 45 } });
  });

  it("bez STT, bez mikrofonu w sesji i w kartkówce prompt nie oferuje mikrofonu", async () => {
    for (const variant of [
      { services: makeServices({ stt: null }), input: {} },
      { services: makeServices(), input: { microphoneEnabled: false } },
      { services: makeServices(), input: { mode: "mock_test" as const } },
    ]) {
      await truncateCoreTables();
      const child = await createChild(variant.services, { displayName: "Bez mikrofonu", avatarKey: "fox" });
      const { deckId } = await seedSchoolDeck(child.id);
      const task = await reachOpenTask(variant.services, child.id, deckId, variant.input);
      expect(task.prompt).not.toHaveProperty("speechInput");
      if (variant.input.mode === "mock_test" || variant.input.microphoneEnabled === false) {
        await expect(dictateLessonAnswer(variant.services, { taskId: task.taskId }, wav(3))).rejects.toMatchObject({ code: "validation" });
      }
    }
  });

  it("rozpoznany tekst wraca do pola: bez próby i oceny, po polsku, w sesji tylko licznik i skrót", async () => {
    const stt = new ScriptedStt([{ status: "ok", text: `  ${DICTATED} `, confidence: 0.97 }]);
    const services = makeServices({ stt });
    const child = await createChild(services, { displayName: "Ala", avatarKey: "owl" });
    const { deckId } = await seedSchoolDeck(child.id);
    const task = await reachOpenTask(services, child.id, deckId);

    const result = await dictateLessonAnswer(services, { taskId: task.taskId }, wav(6));

    expect(result).toEqual({ status: "heard", text: DICTATED });
    expect(stt.calls).toEqual([{ locale: "pl-PL", bytes: wav(6).bytes.byteLength, durationMs: 6000 }]);
    expect(await countRows("attempts", task.taskId)).toBe(0);
    const context = await sessionContextOf(task.taskId);
    expect(context.dictationCalls).toBe(1);
    expect(context.dictations).toEqual({ [task.taskId]: createHash("sha256").update(DICTATED).digest("hex") });
    // tekst dziecka nie trafia do kontekstu sesji ani zdarzeń przed wysłaniem odpowiedzi
    expect(JSON.stringify(context)).not.toContain("Poziomica");
    const events = await pool.query("select count(*)::int as count from learning_app.learning_events where task_id = $1 and kind <> 'prompt_issued'", [task.taskId]);
    expect(events.rows[0]!.count).toBe(0);
  });

  it("cisza, niepewne rozpoznanie, za długi tekst i awaria nie dają tekstu ani próby; zadanie czeka", async () => {
    const stt = new ScriptedStt([
      { status: "no_speech", text: null, confidence: null },
      { status: "ok", text: "When do we?", confidence: 0.1 },
      { status: "ok", text: "a ".repeat(400), confidence: 0.9 },
      { status: "failed", text: null, confidence: null },
    ]);
    const services = makeServices({ stt });
    const child = await createChild(services, { displayName: "Ola", avatarKey: "fox" });
    const { deckId } = await seedSchoolDeck(child.id);
    const task = await reachOpenTask(services, child.id, deckId);

    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push(await dictateLessonAnswer(services, { taskId: task.taskId }, wav(3)));
    expect(statuses).toEqual([{ status: "no_speech" }, { status: "uncertain" }, { status: "too_long" }, { status: "unavailable" }]);
    expect(await countRows("attempts", task.taskId)).toBe(0);
    const state = await pool.query<{ state: string }>("select state from learning_app.session_tasks where id = $1", [task.taskId]);
    expect(state.rows[0]!.state).toBe("issued");
    const context = await sessionContextOf(task.taskId);
    expect(context.dictationCalls).toBe(4);
    expect(context.dictations ?? {}).toEqual({});
  });

  it("wyjątek providera (np. odrzucony klucz) też kończy się „unavailable”", async () => {
    const services = makeServices({ stt: { name: "throwing", transcribe: async () => { throw new AppError("internal", { message: "speech-to-text credentials rejected" }); } } });
    const child = await createChild(services, { displayName: "Ewa", avatarKey: "owl" });
    const { deckId } = await seedSchoolDeck(child.id);
    const task = await reachOpenTask(services, child.id, deckId);
    expect(await dictateLessonAnswer(services, { taskId: task.taskId }, wav(3))).toEqual({ status: "unavailable" });
  });

  it("odpowiedź z dyktowania zapisuje sposób wprowadzenia; poprawka i deklaracja bez dyktowania są rozróżnione", async () => {
    const services = makeServices({ grader: new FakeAnswerGrader() });
    const child = await createChild(services, { displayName: "Ula", avatarKey: "owl" });
    const { deckId } = await seedSchoolDeck(child.id);

    // 1) niezmieniony tekst z dyktowania
    const first = await reachOpenTask(services, child.id, deckId);
    await dictateLessonAnswer(services, { taskId: first.taskId }, wav(5));
    await submitAttempt(services, { taskId: first.taskId, clientAttemptId: randomUUID(), modality: "text", text: DICTATED, inputMethod: "speech" });
    const firstAnswer = await pool.query<{ modality: string; answer: Record<string, unknown> }>("select modality, answer from learning_app.attempts where task_id = $1", [first.taskId]);
    expect(firstAnswer.rows[0]).toEqual({ modality: "text", answer: { text: DICTATED, inputMethod: "speech", edited: false } });

    // 2) dyktowanie poprawione przed wysłaniem (grader + licznik wywołań nie gubi stanu dyktowania)
    await endSession(services, first.sessionId);
    currentClock.advanceHours(48);
    const second = await reachOpenTask(services, child.id, deckId);
    await dictateLessonAnswer(services, { taskId: second.taskId }, wav(5));
    const edited = "Poziomica to linia, która łączy punkty o tej samej wysokości.";
    await submitAttempt(services, { taskId: second.taskId, clientAttemptId: randomUUID(), modality: "text", text: edited, inputMethod: "speech" });
    const secondAnswer = await pool.query<{ answer: Record<string, unknown> }>("select answer from learning_app.attempts where task_id = $1", [second.taskId]);
    expect(secondAnswer.rows[0]!.answer).toEqual({ text: edited, inputMethod: "speech", edited: true });
    const context = await sessionContextOf(second.taskId);
    expect(context.graderCalls).toBe(1);
    expect(Object.keys(context.dictations as object)).toEqual([second.taskId]);

    // 3) deklaracja „speech” bez dyktowania w tym zadaniu = klawiatura
    await endSession(services, second.sessionId);
    currentClock.advanceHours(48);
    const third = await reachOpenTask(services, child.id, deckId);
    await submitAttempt(services, { taskId: third.taskId, clientAttemptId: randomUUID(), modality: "text", text: DICTATED, inputMethod: "speech" });
    const thirdAnswer = await pool.query<{ answer: Record<string, unknown> }>("select answer from learning_app.attempts where task_id = $1", [third.taskId]);
    expect(thirdAnswer.rows[0]!.answer).toEqual({ text: DICTATED });

    // raport rodzica rozdziela sposoby wprowadzenia; suma jak dotąd
    const progress = await lessonObjectiveProgress(services, deckId, child.id);
    const school = progress[0]!.school!;
    const total = school.knowledge.correct + school.knowledge.partial + school.knowledge.incorrect;
    expect(total).toBeGreaterThanOrEqual(3);
    const speech = school.byInputMethod!.speech;
    const keyboard = school.byInputMethod!.keyboard;
    expect(speech.correct + speech.partial + speech.incorrect).toBe(2);
    expect(speech.edited).toBe(1);
    expect(keyboard.correct + keyboard.partial + keyboard.incorrect).toBe(total - 2);
    expect(school.recentAnswers.slice(0, 3).map((answer) => answer.inputMethod)).toEqual(["keyboard", "speech", "speech"]);
    expect(school.speechService).toBe("fake-dictation");
  });

  it("forma jednego zdania: kropki z dyktowania nie obniżają precyzji, ten sam tekst wpisany — tak", async () => {
    const stt = new ScriptedStt([{ status: "ok", text: TWO_SENTENCES, confidence: 0.95 }]);
    const services = makeServices({ stt });
    const child = await createChild(services, { displayName: "Iga", avatarKey: "owl" });
    const { deckId } = await seedSchoolDeck(child.id, { expectedForm: "one_sentence" });

    const spoken = await reachOpenTask(services, child.id, deckId);
    await dictateLessonAnswer(services, { taskId: spoken.taskId }, wav(5));
    await submitAttempt(services, { taskId: spoken.taskId, clientAttemptId: randomUUID(), modality: "text", text: TWO_SENTENCES, inputMethod: "speech" });

    await endSession(services, spoken.sessionId);
    currentClock.advanceHours(48);
    const typed = await reachOpenTask(services, child.id, deckId);
    await submitAttempt(services, { taskId: typed.taskId, clientAttemptId: randomUUID(), modality: "text", text: TWO_SENTENCES });

    const details = await pool.query<{ taskId: string; details: { precision?: string; formOk?: boolean; knowledge?: string } }>(
      `select a.task_id as "taskId", n.details from learning_app.assessments n join learning_app.attempts a on a.id = n.attempt_id
        where a.task_id = any($1::uuid[])`,
      [[spoken.taskId, typed.taskId]],
    );
    const byTask = new Map(details.rows.map((row) => [row.taskId, row.details]));
    expect(byTask.get(spoken.taskId)).toMatchObject({ knowledge: "correct", precision: "concise" });
    expect(byTask.get(spoken.taskId)).not.toHaveProperty("formOk");
    expect(byTask.get(typed.taskId)).toMatchObject({ knowledge: "correct", precision: "verbose", formOk: false });
  });

  it("limit dyktowań sesji, zbyt długie nagranie i zadanie już rozwiązane", async () => {
    const services = makeServices();
    const child = await createChild(services, { displayName: "Zosia", avatarKey: "owl" });
    const { deckId } = await seedSchoolDeck(child.id);
    const task = await reachOpenTask(services, child.id, deckId);

    await expect(dictateLessonAnswer(services, { taskId: task.taskId }, wav(46))).rejects.toMatchObject({ code: "validation" });
    expect((await sessionContextOf(task.taskId)).dictationCalls ?? 0).toBe(0);

    await pool.query(
      `update learning_app.learning_sessions s set context = s.context || '{"dictationCalls": 40}'::jsonb
        from learning_app.session_tasks t where t.session_id = s.id and t.id = $1`,
      [task.taskId],
    );
    expect(await dictateLessonAnswer(services, { taskId: task.taskId }, wav(3))).toEqual({ status: "unavailable" });

    await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "text", text: DICTATED });
    await expect(dictateLessonAnswer(services, { taskId: task.taskId }, wav(3))).rejects.toMatchObject({ code: "conflict" });
  });

  it("„Nie pamiętam” (ujawnienie podpowiedzi) nie kasuje stanu dyktowania ani licznika gradera w kontekście sesji", async () => {
    const services = makeServices();
    const child = await createChild(services, { displayName: "Kasia", avatarKey: "owl" });
    const { deckId } = await seedSchoolDeck(child.id);
    const task = await reachOpenTask(services, child.id, deckId);
    await dictateLessonAnswer(services, { taskId: task.taskId }, wav(3));
    await pool.query(
      `update learning_app.learning_sessions s set context = s.context || '{"graderCalls": 3}'::jsonb
        from learning_app.session_tasks t where t.session_id = s.id and t.id = $1`,
      [task.taskId],
    );

    await authorizeDisclosure(services, { taskId: task.taskId, kind: "hint" });

    const context = await sessionContextOf(task.taskId);
    expect(context.dictationCalls).toBe(1);
    expect(Object.keys(context.dictations as object)).toEqual([task.taskId]);
    expect(context.graderCalls).toBe(3);
    expect(context.settledChecks).toEqual(expect.any(Array));
  });

  it("HTTP: multipart POST /tasks/{taskId}/dictation zwraca tekst bez cache", async () => {
    const services = makeServices();
    const child = await createChild(services, { displayName: "Http", avatarKey: "owl" });
    const { deckId } = await seedSchoolDeck(child.id);
    const task = await reachOpenTask(services, child.id, deckId);

    const form = new FormData();
    form.append("audio", new File([wav(4).bytes as Uint8Array<ArrayBuffer>], "answer.wav", { type: "audio/wav" }));
    const response = await handleKidApi(new Request(`http://localhost/api/v1/kid/tasks/${task.taskId}/dictation`, {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost", "sec-fetch-site": "same-origin" },
      body: form,
    }), services);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "heard", text: "Poziomica to linia łącząca punkty o tej samej wysokości." });
  });
});
