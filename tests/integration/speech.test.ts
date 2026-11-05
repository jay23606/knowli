import { startLegacyTrainingSession } from "./helpers";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  computeTargetKey,
  completePresentation,
  createChild,
  createDraft,
  createServices,
  endSession,
  ensureLearningPolicy,
  nextTask,
  publishDraft,
  readAttempt,
  startSession,
  submitAttempt,
  submitSpeechAttempt,
  authorizeDisclosure,
  authorizeFeedbackAudio,
  upsertAssignment,
  type PronunciationProvider,
  type SttProvider,
} from "@learning/server";
import { AttemptDtoSchema, type TaskDto } from "@learning/contracts";
import { letterGroups } from "../../packages/server/src/domain/pronunciation-fragments";
import { readLearningSnapshot } from "../../packages/server/src/modules/learning/learning-snapshot";
import { loadPolicy } from "../../packages/server/src/policies/registry";
import { selectTask } from "../../packages/server/src/domain/scheduler";
import { buildTestServices, testDatabase, truncateCoreTables, ManualClock } from "./helpers";
import { UI_AUDIO_TEXTS } from "../../packages/server/src/domain/ui-audio-catalog";
import { ttsFingerprint } from "../../packages/server/src/domain/media-fingerprint";

const { pool } = testDatabase();

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

afterAll(async () => {
  await pool.end();
});

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`Oczekiwano błędu ${code}, otrzymano sukces`);
    },
    (error: unknown) => {
      expect(error).toMatchObject({ code });
    },
  );
}

/** Krótkie WAV 8 kHz mono 16-bit — poprawny kontener z wyliczalnym czasem. */
function wavInput(seconds: number, mimeType = "audio/wav") {
  const dataBytes = Math.round(seconds * 8000 * 2);
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return { bytes: new Uint8Array(buffer), mimeType, locale: "en-GB" };
}

interface Fakes {
  calls: { stt: number; pronunciation: number };
  transcription: { status: "ok" | "no_speech" | "failed"; text: string | null; confidence: number | null };
  pronunciation: { status: "ok" | "no_speech" | "failed"; overallScore: number | null; recognizedText: string | null };
  pronunciationScore?: number;
  hangUntilAbort: boolean;
  advanceClockMs: number;
  analysisTimeoutMs?: number;
  /** Otwarta bramka wstrzymuje pierwsze wywołanie STT — licznik rośnie przy wejściu. */
  gate?: Promise<void>;
}

type MutableFakes = Fakes & { providers: { stt: SttProvider; pronunciation: PronunciationProvider } };

/** `durationMs` widziane przez STT: przypadek użycia wypełnia je z metadanych nagrania (koszty mowy). */
const seenDurationsMs: (number | undefined)[] = [];

/** Fake-providery zwracają jeden i ten sam obiekt stanu — mutacje widać w domknięciach. */
function makeFakes(clock: ManualClock, overrides: Partial<Fakes> = {}): MutableFakes {
  const fakes = {
    calls: { stt: 0, pronunciation: 0 },
    transcription: { status: "ok", text: "Thursday", confidence: 0.9 },
    pronunciation: { status: "ok", overallScore: 95, recognizedText: "Thursday" },
    hangUntilAbort: false,
    advanceClockMs: 0,
    ...overrides,
  } as MutableFakes;
  fakes.providers = {
    stt: {
      name: "fake-stt",
      transcribe: async (audio, signal) => {
        fakes.calls.stt += 1;
        seenDurationsMs.push(audio.durationMs);
        if (fakes.gate) await fakes.gate;
        if (fakes.hangUntilAbort && signal) {
          await new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)));
        }
        if (fakes.advanceClockMs > 0) clock.advanceMs(fakes.advanceClockMs);
        return fakes.transcription;
      },
    },
    pronunciation: {
      name: "fake-pron",
      assess: async (_audio, expectedText) => {
        fakes.calls.pronunciation += 1;
        const score = fakes.pronunciationScore ?? fakes.pronunciation.overallScore;
        const word = expectedText.trim().toLowerCase();
        return {
          ...fakes.pronunciation,
          overallScore: score,
          ...(fakes.pronunciation.status === "ok" && score !== null
            ? {
                words: [{
                  text: word,
                  accuracyScore: score,
                  errorType: null,
                  phonemes: letterGroups(word).map((group) => ({ phoneme: group, accuracyScore: 96 })),
                }],
              }
            : {}),
        };
      },
    },
  };
  return fakes;
}

type Services = ReturnType<typeof buildTestServices>["services"];

function speechServices(clock: ManualClock, fakes: ReturnType<typeof makeFakes>): Services {
  const { db } = testDatabase();
  return createServices({
    db,
    clock,
    media: {
      tts: { provider: "fake", model: "fake-tts", voice: "test", format: "mp3" },
      image: { provider: "fake", model: "fake-image", size: "small", quality: "low", format: "svg" },
    },
    speech: {
      stt: fakes.providers.stt,
      pronunciation: fakes.providers.pronunciation,
      ...(fakes.analysisTimeoutMs === undefined ? {} : { analysisTimeoutMs: fakes.analysisTimeoutMs }),
    },
  });
}

const ITEMS: { source: string; target: string; acceptedAnswers?: string[] }[] = [
  { source: "czwartek", target: "Thursday" },
  { source: "wtorek", target: "Tuesday" },
  { source: "kanapa", target: "sofa", acceptedAnswers: ["couch"] },
];

function vocabItem(pair: { source: string; target: string; acceptedAnswers?: string[] }) {
  return {
    source: pair.source,
    target: pair.target,
    acceptedAnswers: pair.acceptedAnswers ?? [],
    locales: { source: "pl-PL", target: "en-GB" },
    visualType: "color" as const,
    visualData: { color: "#4169e1" },
  };
}

async function attachFakeReadyAudio(deckVersionId: string, itemIndex: number): Promise<void> {
  const revision = (
    await query<{ id: string }>(
      `select id from learning_app.item_revisions
        where deck_version_id = $1 order by position offset $2 limit 1`,
      [deckVersionId, itemIndex],
    )
  )[0]!;
  const assetId = randomUUID();
  const fingerprint = `fp-${randomUUID()}`;
  await pool.query(
    `insert into learning_app.media_assets
       (id, kind, fingerprint, generation_number, state, storage_key, content_sha256,
        mime_type, byte_count, provider, model)
     values ($1,'tts',$2,1,'ready',$3,$4,'audio/mpeg',1024,'fake','fake-tts')`,
    [assetId, fingerprint, `blob/${assetId}`, `sha-${assetId}`],
  );
  await pool.query(
    `insert into learning_app.revision_assets
       (item_revision_id, role, asset_id, expected_fingerprint, state)
     values ($1,'target_audio',$2,$3,'approved')`,
    [revision.id, assetId, fingerprint],
  );
}

async function publishDeckWithAssignment(
  services: Services,
  childId: string,
  pairs: { source: string; target: string; acceptedAnswers?: string[] }[],
  vocabularyFormat: "standard" | "picture" = "standard",
): Promise<{ deckId: string; versionId: string }> {
  const draft = await createDraft(services, { title: `Zestaw ${pairs[0]!.target}`, vocabularyFormat, items: pairs.map(vocabItem) });
  for (const index of pairs.keys()) {
    await attachFakeReadyAudio(draft.id, index);
    const revision = (
      await query<{ id: string }>(
        `select id from learning_app.item_revisions
          where deck_version_id = $1 order by position offset $2 limit 1`,
        [draft.id, index],
      )
    )[0]!;
    if (vocabularyFormat === "picture") {
      const illustrationId = randomUUID();
      const fingerprint = `fp-ill-${randomUUID()}`;
      await pool.query(`insert into learning_app.media_assets
        (id, kind, fingerprint, generation_number, state, storage_key, content_sha256, mime_type, byte_count, provider, model)
        values ($1,'illustration',$2,1,'ready',$3,$4,'image/svg+xml',128,'fake','fake-image')`,
      [illustrationId, fingerprint, `blob/${illustrationId}`, `sha-${illustrationId}`]);
      await pool.query(`insert into learning_app.revision_assets
        (item_revision_id, role, asset_id, expected_fingerprint, state) values ($1,'illustration',$2,$3,'approved')`,
      [revision.id, illustrationId, fingerprint]);
    }
    if (vocabularyFormat === "standard") {
      await pool.query(
        `insert into learning_app.revision_assets
           (item_revision_id, role, asset_id, expected_fingerprint, state)
         values ($1,'illustration',null,$2,'omitted')`,
        [revision.id, `fp-ill-${randomUUID()}`],
      );
    }
  }
  await publishDraft(services, draft.id, 1);
  await upsertAssignment(services, childId, draft.deckId, null);
  return { deckId: draft.deckId, versionId: draft.id };
}

/** Fixture: element o zadanym indeksie ma należne sprawdzenie danej umiejętności. */
async function setDueProgress(childId: string, versionId: string, itemIndex: number, skill: string): Promise<void> {
  const revision = (
    await query<{ id: string }>(
      `select id from learning_app.item_revisions
        where deck_version_id = $1 order by position offset $2 limit 1`,
      [versionId, itemIndex],
    )
  )[0]!;
  for (const id of await skillVersionIds(revision.id, skill)) {
    await pool.query(
      `insert into learning_app.child_skill_progress
         (child_id, skill_version_id, policy_id, status, independent_success_streak, next_review_at, last_reviewed_at, first_issued_at, has_qualifying_assessment, projection_version)
       select $1,$2,coalesce((select policy_id from learning_app.learning_sessions where child_id = $1 and state = 'active' order by started_at desc limit 1), c.policy_id, 'learning-v2'),'needs_confirmation',3,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',null,false,'proj-3' from learning_app.child_profiles c where c.id = $1
       on conflict (child_id, skill_version_id, policy_id) do update
         set status = 'needs_confirmation', independent_success_streak = 3,
             next_review_at = '2026-10-01T00:00:00Z'`,
      [childId, id],
    );
  }
}

/**
 * Sesja, której pierwszym wydanym zadaniem jest recall danego elementu —
 * należne sprawdzenie ma pierwszeństwo przed nowym materiałem (arch §9.3).
 */
async function recallSession(
  services: Services,
  childId: string,
  deckId: string,
  versionId: string,
  itemIndex: number,
): Promise<{ sessionId: string; task: TaskDto }> {
  await setDueProgress(childId, versionId, itemIndex, "recall");
  const session = await startLegacyTrainingSession(services, { childId, deckId, microphoneEnabled: true });
  const task = (await nextTask(services, session.sessionId))!;
  expect(task.exerciseType).toBe("recall");
  return { sessionId: session.sessionId, task };
}

async function pictureRecallSession(services: Services, childId: string, deckId: string, versionId: string, itemIndex: number) {
  await ensureUiAudioCatalog(services);
  await setDueProgress(childId, versionId, itemIndex, "recall");
  const session = await startLegacyTrainingSession(services, { childId, deckId, microphoneEnabled: true, supportsPictureVocabulary: true });
  const task = (await nextTask(services, session.sessionId))!;
  expect(task.exerciseType).toBe("recall");
  expect(task.prompt.kind).toBe("picture_recall");
  return { sessionId: session.sessionId, task };
}

async function ensureUiAudioCatalog(services: Services): Promise<void> {
  const { provider, model, voice, format } = services.media!.tts;
  for (const [key, text] of Object.entries(UI_AUDIO_TEXTS)) {
    const fingerprint = ttsFingerprint({ text, locale: "pl-PL", provider, model, voice, format });
    const existing = (await query<{ generation_number: number }>(
      "select generation_number from learning_app.media_assets where fingerprint = $1 order by generation_number desc limit 1",
      [fingerprint],
    ))[0];
    if (existing) continue;
    const id = randomUUID();
    await pool.query(
      `insert into learning_app.media_assets
         (id, kind, fingerprint, generation_number, state, storage_key, content_sha256,
          mime_type, byte_count, provider, model, metadata)
       values ($1,'tts',$2,1,'ready',$3,$4,'audio/mpeg',1,$5,$6,$7)`,
      [id, fingerprint, `blob/${id}`, `sha-${id}`, provider, model,
        { purpose: "kid_ui_guidance", uiAudioKey: key, text, locale: "pl-PL", voice, format }],
    );
  }
}

/**
 * Sesja doprowadzona do zadania ćwiczenia wymowy danego elementu — należna
 * powtórka wymowy czeka za prezentacjami nowego materiału (arch §9.3).
 */
async function speechSession(
  services: Services,
  childId: string,
  deckId: string,
  versionId: string,
  itemIndex: number,
): Promise<{ sessionId: string; task: TaskDto }> {
  await setDueProgress(childId, versionId, itemIndex, "pronunciation");
  const session = await startLegacyTrainingSession(services, { childId, deckId, microphoneEnabled: true });
  for (let step = 0; step < 30; step++) {
    const candidate = (await nextTask(services, session.sessionId))!;
    expect(candidate).not.toBeNull();
    if (candidate.exerciseType === "speech") {
      return { sessionId: session.sessionId, task: candidate };
    }
    if (candidate.exerciseType === "exposure") {
      await completePresentation(services, { taskId: candidate.taskId });
    } else {
      await pool.query(
        `update learning_app.session_tasks set state = 'answered' where id = $1 and state = 'issued'`,
        [candidate.taskId],
      );
    }
  }
  throw new Error("speechSession: nie wydano zadania wymowy");
}

async function answerKeyTarget(taskId: string): Promise<string> {
  return (
    await query<{ target: string }>(`select answer_key->>'target' as target from learning_app.session_tasks where id = $1`, [taskId])
  )[0]!.target;
}

async function attemptRows(taskId: string) {
  return query<{
    id: string;
    state: string;
    modality: string;
    attempt_number: number;
    answer: Record<string, unknown> | null;
    context: Record<string, unknown>;
    feedback: { kind?: string } | null;
  }>(
    `select id, state, modality, attempt_number, answer, context, feedback
       from learning_app.attempts where task_id = $1 order by attempt_number`,
    [taskId],
  );
}

async function assessmentsOf(attemptId: string) {
  return query<{
    skill: string;
    outcome: string;
    reason: string | null;
    independent: boolean;
    confirmation_eligible: boolean;
    details: Record<string, unknown>;
  }>(
    `select skill, outcome, reason, independent, confirmation_eligible, details
       from learning_app.assessments where attempt_id = $1 order by skill`,
    [attemptId],
  );
}

async function skillVersionIds(revisionId: string, skill: string): Promise<string[]> {
  const rows = await query<{ skill_version_id: string }>(
    `select skill_version_id from learning_app.item_revision_skills
      where item_revision_id = $1 and skill = $2`,
    [revisionId, skill],
  );
  return rows.map((r) => r.skill_version_id);
}

async function revisionOfTask(taskId: string): Promise<string> {
  return (
    await query<{ item_revision_id: string }>(
      `select item_revision_id from learning_app.session_tasks where id = $1`,
      [taskId],
    )
  )[0]!.item_revision_id;
}

async function progressOf(childId: string, skillVersionId: string) {
  return (
    await query<{ status: string; streak: number }>(
      `select status, independent_success_streak as streak
         from learning_app.child_skill_progress
        where child_id = $1 and skill_version_id = $2`,
      [childId, skillVersionId],
    )
  )[0];
}

/** Aktywna sesja dziecka — drugie zadanie w tej samej sesji. */
async function activeSessionId(childId: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `select id from learning_app.learning_sessions
      where child_id = $1 and state = 'active' order by started_at desc limit 1`,
    [childId],
  );
  return rows[0]!.id;
}

describe("ocena mowy bez trwałego audio (integracja)", () => {
  let clock: ManualClock;
  let childId: string;
  let baseServices: Services;

  beforeEach(async () => {
    await truncateCoreTables();
    await pool.query(
      `truncate learning_app.revision_assets, learning_app.media_assets, learning_app.item_revision_skills,
              learning_app.item_revisions, learning_app.skill_versions, learning_app.learning_items,
              learning_app.deck_versions, learning_app.decks cascade`,
    );
    clock = new ManualClock();
    const base = buildTestServices();
    baseServices = base.services;
    const child = await createChild(baseServices, { displayName: "Ola", avatarKey: "fox" });
    childId = child.id;
  });

  it("odsłuchuje wzorzec tylko z bieżącego, wiarygodnego feedbacku i pieczętuje replay", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await speechSession(services, childId, deckId, versionId, 0);
    fakes.transcription = { status: "ok", text: "Thursday", confidence: 0.95 };
    const attempt = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(attempt.feedback?.referenceAudioAvailable).toBe(true);
    expect(seenDurationsMs.at(-1)).toBeCloseTo(1000, -1);

    const first = await authorizeFeedbackAudio(services, attempt.attemptId);
    const replay = await authorizeFeedbackAudio(services, attempt.attemptId);
    expect(first.audioAssetId).toBe((task.prompt as { audioAssetId?: string | null }).audioAssetId);
    expect(replay.stepId).not.toBe(first.stepId);
    const events = await query<{ id: string; sealed: boolean }>(
      `select id,sealed from learning_app.learning_events where task_id=$1 and kind='feedback_issued' order by occurred_at`,
      [task.taskId],
    );
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((event) => event.sealed)).toBe(true);
    const exposed = await query<{ target_key: string }>(
      `select x.target_key from learning_app.event_exposures x where x.event_id=$1`,
      [events.at(-1)!.id],
    );
    expect(exposed).toContainEqual({ target_key: computeTargetKey("Thursday", "en-GB") });

    // Po przejściu do późniejszej karty poprzedni wynik nie może już autoryzować wzorca.
    await nextTask(services, task.sessionId);
    await expectAppError(authorizeFeedbackAudio(services, attempt.attemptId), "conflict");
    expect(fakes.calls.stt).toBe(1);
  });

  it("nie włącza wzorca dla akceptowanego, lecz niekanonicznego wariantu ani dla niepewnego STT", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, [ITEMS[2]!]);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await speechSession(services, childId, deckId, versionId, 0);
    fakes.transcription = { status: "ok", text: "couch", confidence: 0.95 };
    const alternate = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(alternate.feedback?.speech?.recognition).toBe("matched");
    expect(alternate.feedback?.referenceAudioAvailable).toBe(false);
    await expectAppError(authorizeFeedbackAudio(services, alternate.attemptId), "conflict");
    await endSession(services, await activeSessionId(childId));

    const { deckId: secondDeck, versionId: secondVersion } = await publishDeckWithAssignment(baseServices, childId, [ITEMS[0]!]);
    const otherTask = await speechSession(services, childId, secondDeck, secondVersion, 0);
    fakes.transcription = { status: "ok", text: "Tuesday", confidence: 0.2 };
    const uncertain = await submitSpeechAttempt(services, { taskId: otherTask.task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(uncertain.feedback?.referenceAudioAvailable).toBeUndefined();
    await expectAppError(authorizeFeedbackAudio(services, uncertain.attemptId), "conflict");
  });

  it("autoryzuje kanoniczny odsłuch dla wiarygodnie rozpoznanej innej odpowiedzi", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, [ITEMS[0]!]);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await speechSession(services, childId, deckId, versionId, 0);
    fakes.transcription = { status: "ok", text: "Monday", confidence: 0.95 };
    const attempt = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(attempt.feedback?.speech?.recognition).toBe("different");
    expect(attempt.feedback?.referenceAudioAvailable).toBe(true);
    const authorization = await authorizeFeedbackAudio(services, attempt.attemptId);
    expect(authorization.audioAssetId).toBe((task.prompt as { audioAssetId?: string | null }).audioAssetId);
  });

  it("poprawne słowo ustnie zalicza Recall; wynik wymowy zapisuje się bez oceny bez pasm", async () => {
    // ścieżka polityki bez pasm — v2 ma domyślnie pasma 70/50 (design 2026-10-09)
    await ensureLearningPolicy(baseServices.db);
    await pool.query(`update learning_app.child_profiles set policy_id = 'learning-v1' where id = $1`, [childId]);
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await recallSession(services, childId, deckId, versionId, 0);
    const target = await answerKeyTarget(task.taskId);
    fakes.transcription = { status: "ok", text: target, confidence: 0.9 };

    const dto = AttemptDtoSchema.parse(
      await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1)),
    );
    expect(dto.state).toBe("completed");
    expect(dto.modality).toBe("audio");
    expect(dto.feedback?.kind).toBe("great");
    expect(dto.feedback?.speech).toEqual({ recognition: "matched", pronunciation: "not_configured", referenceText: target });
    expect(dto.taskState).toBe("answered");

    const [attempt] = await attemptRows(task.taskId);
    expect(attempt.state).toBe("completed");
    // przechowujemy potrzebny wynik: transkrypcję i identyfikację providerów (SPEC §26)
    expect(Object.keys(attempt.answer ?? {}).sort()).toEqual(["pronunciation", "stt", "transcript"]);
    expect(attempt.answer?.transcript).toBe(target);

    const assessments = await assessmentsOf(attempt.id);
    const bySkill = Object.fromEntries(assessments.map((a) => [a.skill, a]));
    expect(bySkill.recall).toMatchObject({ outcome: "correct", independent: true });
    // bez pasm skalibrowanych wynik wymowy jest daną, nie oceną (SPEC §18)
    expect(bySkill.pronunciation).toMatchObject({ outcome: "unassessed" });
    expect(bySkill.pronunciation.details.pronunciation).toEqual({ provider: "fake-pron", score: 95 });
    expect(bySkill.spelling).toBeUndefined();

    const recallVersion = (await skillVersionIds(await revisionOfTask(task.taskId), "recall"))[0]!;
    expect(await progressOf(childId, recallVersion)).toMatchObject({ status: "practicing", streak: 1 });
    const pronVersion = (await skillVersionIds(await revisionOfTask(task.taskId), "pronunciation"))[0]!;
    expect(await progressOf(childId, pronVersion)).toBeUndefined();
  });

  it("awaria oceny wymowy daje wynik częściowy: Recall zaliczony, wymowa nieoceniona", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock, { pronunciation: { status: "failed", overallScore: null, recognizedText: null } });
    const services = speechServices(clock, fakes);
    const { task } = await recallSession(services, childId, deckId, versionId, 0);
    fakes.transcription = { status: "ok", text: await answerKeyTarget(task.taskId), confidence: 0.9 };

    const dto = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(dto.feedback?.kind).toBe("great");
    expect(dto.taskState).toBe("answered");

    const [attempt] = await attemptRows(task.taskId);
    const bySkill = Object.fromEntries((await assessmentsOf(attempt.id)).map((a) => [a.skill, a]));
    expect(bySkill.recall).toMatchObject({ outcome: "correct" });
    expect(bySkill.pronunciation).toMatchObject({ outcome: "unassessed", reason: "technical" });
  });

  it("cisza i timeout nie obniżają postępu: próba techniczna zostawia zadanie issued", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await recallSession(services, childId, deckId, versionId, 0);
    const target = await answerKeyTarget(task.taskId);

    // najpierw prawdziwy sukces ustny, żeby projekcja miała historię
    fakes.transcription = { status: "ok", text: target, confidence: 0.9 };
    await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    const recallVersion = (await skillVersionIds(await revisionOfTask(task.taskId), "recall"))[0]!;
    expect(await progressOf(childId, recallVersion)).toMatchObject({ status: "practicing", streak: 1 });

    // drugi element z należnym sprawdzeniem: próba w ciszy
    await setDueProgress(childId, versionId, 1, "recall");
    const sessionId = await activeSessionId(childId);
    const next = (await nextTask(services, sessionId))!;
    expect(next.exerciseType).toBe("recall");
    fakes.transcription = { status: "no_speech", text: null, confidence: null };
    const dto = await submitSpeechAttempt(services, { taskId: next.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(dto.feedback?.kind).toBe("not_assessed");
    expect(dto.feedback?.speech).toEqual({ recognition: "no_speech", pronunciation: "not_applicable" });
    expect(dto.taskState).toBe("issued");
    expect(await progressOf(childId, recallVersion)).toMatchObject({ status: "practicing", streak: 1 });

    // timeout analizy — hangujący provider i krótki deadline
    const timeoutFakes = makeFakes(clock, { hangUntilAbort: true, analysisTimeoutMs: 60 });
    const timeoutServices = speechServices(clock, timeoutFakes);
    const dto2 = await submitSpeechAttempt(timeoutServices, { taskId: next.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(dto2.state).toBe("completed");
    expect(dto2.feedback?.kind).toBe("not_assessed");
    expect(dto2.feedback?.speech).toEqual({ recognition: "unavailable", pronunciation: "not_applicable" });
    expect(dto2.taskState).toBe("issued");
    const rows = await attemptRows(next.taskId);
    expect(rows.every((r) => r.state === "completed")).toBe(true);

    fakes.transcription = { status: "ok", text: null, confidence: 0.99 };
    const empty = await submitSpeechAttempt(services, { taskId: next.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(empty.feedback?.speech).toEqual({ recognition: "no_speech", pronunciation: "not_applicable" });
    expect(empty.feedback?.heardText).toBeUndefined();
  });

  it("niepewny STT nie tworzy mylonej pary ani błędu wiedzy", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await recallSession(services, childId, deckId, versionId, 0);
    fakes.transcription = { status: "ok", text: "Tuesday", confidence: 0.2 };

    const dto = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(dto.feedback?.kind).toBe("not_assessed");
    expect(dto.feedback?.speech).toEqual({ recognition: "uncertain", pronunciation: "not_applicable" });
    expect(dto.taskState).toBe("issued");
    const [attempt] = await attemptRows(task.taskId);
    const assessments = await assessmentsOf(attempt.id);
    expect(assessments.every((a) => a.outcome === "unassessed")).toBe(true);
    expect(assessments.every((a) => a.details?.confusion === undefined)).toBe(true);

    // po niepewnej próbie dziecko może odpowiedzieć poprawnie jako druga próba
    fakes.transcription = { status: "ok", text: await answerKeyTarget(task.taskId), confidence: 0.9 };
    const retry = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(retry.feedback?.kind).toBe("great");
    expect((await attemptRows(task.taskId)).map((r) => r.attempt_number)).toEqual([1, 2]);
  });

  it("Review Focus 3: Tuesday z wysokim score wymowy Thursday — Recall błędny, wymowa nieoceniona", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await recallSession(services, childId, deckId, versionId, 0);
    expect(await answerKeyTarget(task.taskId)).toBe("Thursday");
    fakes.transcription = { status: "ok", text: "Tuesday", confidence: 0.95 };

    const dto = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(dto.feedback?.kind).toBe("incorrect");
    expect(dto.feedback?.speech).toEqual({ recognition: "different", pronunciation: "not_applicable", referenceText: "Thursday" });
    expect(dto.taskState).toBe("issued");

    const [attempt] = await attemptRows(task.taskId);
    const bySkill = Object.fromEntries((await assessmentsOf(attempt.id)).map((a) => [a.skill, a]));
    expect(bySkill.recall).toMatchObject({ outcome: "incorrect" });
    expect(bySkill.recall.details.confusion).toEqual({ expected: "Thursday", answered: "Tuesday" });
    expect(bySkill.pronunciation).toBeUndefined();
    // ocena wymowy oczekiwanego słowa po wypowiedzeniu innego nie została nawet wykonana
    expect(fakes.calls.pronunciation).toBe(0);
  });

  it("zatwierdzony wariant zalicza Recall, a wymowa względem innego tekstu nie jest używana", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, [ITEMS[2]!, ITEMS[0]!]);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await recallSession(services, childId, deckId, versionId, 0);
    expect(await answerKeyTarget(task.taskId)).toBe("sofa");
    fakes.transcription = { status: "ok", text: "couch", confidence: 0.9 };

    const dto = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(dto.feedback?.kind).toBe("great");
    expect(dto.feedback?.speech).toEqual({ recognition: "matched", pronunciation: "not_applicable", referenceText: "couch" });
    const issued = await query<{ target_keys: string[] }>(
      `select array_agg(x.target_key order by x.target_key) as target_keys
         from learning_app.learning_events e join learning_app.event_exposures x on x.event_id = e.id
        where e.task_id = $1 and e.kind = 'feedback_issued'`,
      [task.taskId],
    );
    expect(issued[0]!.target_keys).toEqual([
      computeTargetKey("couch", "en-GB"),
      computeTargetKey("sofa", "en-GB"),
    ].sort());
    const [attempt] = await attemptRows(task.taskId);
    const bySkill = Object.fromEntries((await assessmentsOf(attempt.id)).map((a) => [a.skill, a]));
    expect(bySkill.recall).toMatchObject({ outcome: "correct" });
    expect(bySkill.pronunciation).toMatchObject({ outcome: "unassessed" });
    // oceny względem „sofa” nie wykonano — nie przenosimy jej na „couch”
    expect(fakes.calls.pronunciation).toBe(0);
  });

  it("retry w trakcie processing nie uruchamia drugiej płatnej analizy", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await recallSession(services, childId, deckId, versionId, 0);
    fakes.transcription = { status: "ok", text: await answerKeyTarget(task.taskId), confidence: 0.9 };

    let releaseStt: (() => void) | undefined;
    fakes.gate = new Promise<void>((resolve) => {
      releaseStt = resolve;
    });

    const firstKey = randomUUID();
    const first = submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: firstKey }, wavInput(1));
    // Pierwsza próba stoi w STT (fakes.gate) — czekamy na to zamiast stałych 50 ms,
    // które nie wystarczały przy obciążonym procesorze.
    await expect.poll(() => fakes.calls.stt, { timeout: 10_000 }).toBe(1);

    const sameKey = randomUUID();
    const retry = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: sameKey }, wavInput(1));
    // drugi klient z innym kluczem też dostaje ten sam rekord processing (202)
    const otherClient = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(retry.state).toBe("processing");
    expect(otherClient.attemptId).toBe(retry.attemptId);
    expect(fakes.calls.stt).toBe(1);
    expect((await attemptRows(task.taskId)).length).toBe(1);

    releaseStt!();
    const done = await first;
    expect(done.state).toBe("completed");
    expect(done.attemptId).toBe(retry.attemptId);
    expect(fakes.calls.stt).toBe(1);

    // idempotentny retry po finalizacji zwraca ten sam wynik i ujawnia feedback ponownie
    const again = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: firstKey }, wavInput(1));
    expect(again.attemptId).toBe(done.attemptId);
    expect(again.feedback?.kind).toBe("great");
    expect(again.feedback).toEqual(done.feedback);
    expect((await readAttempt(services, done.attemptId)).feedback).toEqual(done.feedback);
    expect(fakes.calls.stt).toBe(1);
  });

  it("30 sekund analizy nie zamienia próby z 299 sekund w niezależną", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS.slice(0, 2));
    const fakes = makeFakes(clock, { advanceClockMs: 30_000 });
    const services = speechServices(clock, fakes);
    // element 0: prezentacja (ekspozycja celu), potem należne sprawdzenie
    const session = await startLegacyTrainingSession(services, { childId, deckId, microphoneEnabled: true });
    const exposure = (await nextTask(services, session.sessionId))!;
    expect(exposure.exerciseType).toBe("exposure");
    await completePresentation(services, { taskId: exposure.taskId });

    await setDueProgress(childId, versionId, 0, "recall");
    clock.advanceMs(299_000);
    const task = (await nextTask(services, session.sessionId))!;
    expect(task.exerciseType).toBe("recall");
    fakes.transcription = { status: "ok", text: await answerKeyTarget(task.taskId), confidence: 0.9 };

    const dto = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(dto.feedback?.kind).toBe("great");
    const [attempt] = await attemptRows(task.taskId);
    const bySkill = Object.fromEntries((await assessmentsOf(attempt.id)).map((a) => [a.skill, a]));
    expect(bySkill.recall).toMatchObject({ outcome: "correct", independent: false, confirmation_eligible: false });
    expect(attempt.context).toMatchObject({ lastExposureAt: expect.any(String) });
    // odczyt po analizie niczego nie zmienia — kontekst pozostał zamrożony
    clock.advanceMs(30_000);
    const reread = await readAttempt(services, attempt.id);
    expect(reread.attemptId).toBe(attempt.id);
  });

  it("wspomagane obrazkowe Recall zachowuje poprawny wynik, lecz pozostaje niezależne=false", async () => {
    const nonReader = await createChild(baseServices, { displayName: "Ola bez czytania", avatarKey: "fox", canRead: false });
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, nonReader.id, [ITEMS[0]!], "picture");
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await pictureRecallSession(services, nonReader.id, deckId, versionId, 0);
    await authorizeDisclosure(services, { taskId: task.taskId, kind: "audio" });
    clock.advanceMs(299_000);
    fakes.transcription = { status: "ok", text: await answerKeyTarget(task.taskId), confidence: 0.95 };

    const attempt = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(attempt.feedback?.kind).toBe("great");
    expect(attempt.taskState).toBe("answered");
    const [row] = await attemptRows(task.taskId);
    const assessments = await assessmentsOf(row.id);
    expect(assessments.map((assessment) => assessment.skill).sort()).toEqual(["pronunciation", "recall"]);
    expect(assessments.find((assessment) => assessment.skill === "recall")).toMatchObject({ outcome: "correct", independent: false, confirmation_eligible: false });
  });

  it("cisza, timeout i Nie pamiętam w picture Recall nie dodają oceny pisowni", async () => {
    const nonReader = await createChild(baseServices, { displayName: "Ola bez czytania", avatarKey: "fox", canRead: false });
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, nonReader.id, [ITEMS[0]!], "picture");
    const fakes = makeFakes(clock, { transcription: { status: "no_speech", text: null, confidence: null } });
    const services = speechServices(clock, fakes);
    const { sessionId, task } = await pictureRecallSession(services, nonReader.id, deckId, versionId, 0);

    const silence = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(silence.feedback?.speech?.recognition).toBe("no_speech");
    expect(silence.taskState).toBe("issued");
    const timeoutFakes = makeFakes(clock, { hangUntilAbort: true, analysisTimeoutMs: 60 });
    const timeoutServices = speechServices(clock, timeoutFakes);
    const timeout = await submitSpeechAttempt(timeoutServices, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(timeout.feedback?.speech?.recognition).toBe("unavailable");
    expect(timeout.taskState).toBe("issued");

    const nonAnswer = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "dont_remember" });
    expect(nonAnswer.taskState).toBe("answered");
    const rows = await attemptRows(task.taskId);
    for (const row of rows) expect((await assessmentsOf(row.id)).every((assessment) => assessment.skill !== "spelling")).toBe(true);
    expect((await nextTask(services, sessionId))?.exerciseType).not.toBe("letter_completion");
  });

  it("za duży i za długi payload odrzuca walidacja przed zapisem próby", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await recallSession(services, childId, deckId, versionId, 0);

    await expectAppError(
      submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(16)),
      "validation",
    );
    const big = { ...wavInput(1), bytes: new Uint8Array(2 * 1024 * 1024 + 1) };
    await expectAppError(
      submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, big),
      "validation",
    );
    expect(await attemptRows(task.taskId)).toEqual([]);
    expect(fakes.calls.stt).toBe(0);
  });

  it("ćwiczenie wymowy ocenia samą wymowę i pokazuje słowo bez psucia samodzielności", async () => {
    // ścieżka polityki bez pasm — v2 ma domyślnie pasma 70/50 (design 2026-10-09)
    await ensureLearningPolicy(baseServices.db);
    await pool.query(`update learning_app.child_profiles set policy_id = 'learning-v1' where id = $1`, [childId]);
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await speechSession(services, childId, deckId, versionId, 0);

    const dto = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    const [attempt] = await attemptRows(task.taskId);
    const assessments = await assessmentsOf(attempt.id);
    expect(assessments.map((a) => a.skill)).toEqual(["pronunciation"]);
    expect(assessments[0]).toMatchObject({ outcome: "unassessed" });
    expect(assessments[0]!.details.pronunciation).toEqual({ provider: "fake-pron", score: 95 });
    // wypowiedziane właściwe słowo wykonuje ćwiczenie także bez pasm oceny
    // wymowy (SPEC §15.4) — dziecko nie utyka na jednym zadaniu
    expect(dto.taskState).toBe("answered");
    expect(dto.feedback?.kind).toBe("content_matched");
  });

  it("próba wymowy z fake'ami zwraca feedback z fragmentami", async () => {
    await ensureLearningPolicy(baseServices.db);
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await speechSession(services, childId, deckId, versionId, 0);

    const dto = await submitSpeechAttempt(
      services,
      { taskId: task.taskId, clientAttemptId: randomUUID() },
      wavInput(1),
    );
    expect(dto.feedback).toEqual({
      kind: "great",
      heardText: "Thursday",
      fragments: [{ text: "Thursday", verdict: "good" }],
      speech: { recognition: "matched", pronunciation: "good", referenceText: "Thursday" },
      referenceAudioAvailable: true,
    });
    expect(dto.taskState).toBe("answered");
  });

  it("ćwiczenie wymowy: druga wiarygodna rozbieżność domyka zadanie bez ocen wiedzy", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock, { transcription: { status: "ok", text: "Friday", confidence: 0.9 } });
    const services = speechServices(clock, fakes);
    const { task } = await speechSession(services, childId, deckId, versionId, 0);

    const first = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(first.taskState).toBe("issued");
    expect(first.feedback?.kind).toBe("incorrect");
    // rozbieżna treść nie ocenia wymowy oczekiwanego słowa (arch §11)
    expect(await assessmentsOf((await attemptRows(task.taskId))[0]!.id)).toEqual([]);

    const second = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(second.taskState).toBe("answered");
    const rows = await attemptRows(task.taskId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(await assessmentsOf(row.id)).toEqual([]);
    }
  });

  it("ćwiczenie wymowy: próba techniczna zostawia drugie podejście, a „Pomiń” jest zawsze dostępny", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock, { transcription: { status: "failed", text: null, confidence: null } });
    const services = speechServices(clock, fakes);
    const { task } = await speechSession(services, childId, deckId, versionId, 0);

    const technical = await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(technical.taskState).toBe("issued");
    expect(technical.feedback?.kind).toBe("not_assessed");

    // świadome pominięcie zamyka zadanie bez oceny (SPEC §15.3 kontynuowanie)
    const skipped = await submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), modality: "skip" });
    expect(skipped.taskState).toBe("skipped");
  });

  it("brak providerów mowy kończy próbę wynikiem technicznym bez fałszywego sukcesu", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    // usługi bez zależności speech — np. wystawienie bez skonfigurowanych kluczy
    const bare = createServices({ db: testDatabase().db, clock });
    const { task } = await recallSession(bare, childId, deckId, versionId, 0);

    const dto = await submitSpeechAttempt(bare, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    expect(dto.state).toBe("completed");
    expect(dto.feedback?.kind).toBe("not_assessed");
    expect(dto.taskState).toBe("issued");
    const [attempt] = await attemptRows(task.taskId);
    expect(attempt.answer).toMatchObject({ transcript: null, stt: "none" });
    const assessments = await assessmentsOf(attempt.id);
    expect(assessments.every((a) => a.outcome === "unassessed")).toBe(true);
  });

  it("ponawia pierwsze nieocenione ćwiczenie wymowy po 24 godzinach w nowej sesji", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS.slice(0, 1));
    const first = await speechSession(baseServices, childId, deckId, versionId, 0);
    const technical = await submitSpeechAttempt(
      baseServices,
      { taskId: first.task.taskId, clientAttemptId: randomUUID() },
      wavInput(1),
    );
    expect(technical.feedback?.kind).toBe("not_assessed");
    expect(technical.taskState).toBe("issued");
    await endSession(baseServices, first.sessionId);

    clock.advanceHours(24);
    const resumed = await startLegacyTrainingSession(baseServices, { childId, deckId, microphoneEnabled: true });
    expect(resumed.sessionId).not.toBe(first.sessionId);
    expect(resumed.microphoneEnabled).toBe(true);
    const [revision] = await query<{ itemRevisionId: string }>(
      `select item_revision_id as "itemRevisionId" from learning_app.session_tasks where id = $1`,
      [first.task.taskId],
    );
    const [sessionPolicy] = await query<{ policyId: string }>(
      `select policy_id as "policyId" from learning_app.learning_sessions where id = $1`,
      [resumed.sessionId],
    );
    const policy = await loadPolicy(testDatabase().db, sessionPolicy!.policyId);
    const [snapshot] = await readLearningSnapshot(testDatabase().db, {
      childId,
      revisionIds: [revision!.itemRevisionId],
      policy,
      now: clock.now().toISOString(),
    });
    expect(snapshot?.work.pronunciation).toMatchObject({ dueNow: true });
    const selected = selectTask({
      now: clock.now().toISOString(),
      policy,
      microphoneEnabled: resumed.microphoneEnabled,
      assessedRemaining: 12,
      nextOrdinal: 0,
      candidates: [{ itemRevisionId: revision!.itemRevisionId, itemId: "item-thursday", position: 0,
        target: "Thursday", source: "czwartek", acceptedAnswers: [], targetLocale: "en-GB",
        progress: snapshot!.progress, work: snapshot!.work, failuresThisSession: 0,
        supportedThisSession: false, usedThisSession: 0, presentationsThisSession: 0,
        lastContactAt: null, lastUsedOrdinal: null, readingDirections: {}, practiceMix: { listening: 0, reading: 0 },
        introducedSkills: snapshot!.introducedSkills, ownPresentationCompleted: snapshot!.ownPresentationCompleted }],
      peers: [], reservedTargetKeys: [],
    });
    expect(selected).toMatchObject({
      exerciseType: "speech",
      itemRevisionId: revision!.itemRevisionId,
      reason: "due-review",
    });
  });

  it("nieoceniona próba techniczna nie przesuwa daty przeglądu istniejącej projekcji", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS.slice(0, 1));
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const first = await speechSession(services, childId, deckId, versionId, 0);
    fakes.transcription.text = await answerKeyTarget(first.task.taskId);
    await submitSpeechAttempt(services, { taskId: first.task.taskId, clientAttemptId: randomUUID() }, wavInput(1));
    const skillVersionId = (await query<{ skillVersionId: string }>(
      `select s.skill_version_id as "skillVersionId"
         from learning_app.session_tasks t
         join learning_app.item_revision_skills s on s.item_revision_id = t.item_revision_id
        where t.id = $1 and s.skill = 'pronunciation'`,
      [first.task.taskId],
    ))[0]!.skillVersionId;
    const original = (await query<{ lastReviewedAt: Date }>(
      `select last_reviewed_at as "lastReviewedAt" from learning_app.child_skill_progress
        where child_id = $1 and skill_version_id = $2`,
      [childId, skillVersionId],
    ))[0]!.lastReviewedAt.toISOString();

    clock.advanceHours(24 * 8);
    await endSession(services, first.sessionId);
    const bare = createServices({ db: testDatabase().db, clock });
    const retrySession = await startLegacyTrainingSession(bare, { childId, deckId, microphoneEnabled: true });
    const retryTask = await nextTask(bare, retrySession.sessionId);
    expect(retryTask).toMatchObject({ exerciseType: "speech" });
    const technical = await submitSpeechAttempt(
      bare,
      { taskId: retryTask!.taskId, clientAttemptId: randomUUID() },
      wavInput(1),
    );
    expect(technical.feedback?.kind).toBe("not_assessed");
    const after = (await query<{ lastReviewedAt: Date }>(
      `select last_reviewed_at as "lastReviewedAt" from learning_app.child_skill_progress
        where child_id = $1 and skill_version_id = $2`,
      [childId, skillVersionId],
    ))[0]!.lastReviewedAt.toISOString();

    expect(after).toBe(original);
  });

  it("nagranie nigdzie nie trafia: answer zawiera tylko potrzebny wynik", async () => {
    const { deckId, versionId } = await publishDeckWithAssignment(baseServices, childId, ITEMS);
    const fakes = makeFakes(clock);
    const services = speechServices(clock, fakes);
    const { task } = await recallSession(services, childId, deckId, versionId, 0);
    fakes.transcription = { status: "ok", text: await answerKeyTarget(task.taskId), confidence: 0.9 };
    await submitSpeechAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID() }, wavInput(5));

    const answers = await query<{ answer_text: string }>(
      `select answer::text as answer_text from learning_app.attempts where task_id = $1`,
      [task.taskId],
    );
    for (const row of answers) {
      expect(row.answer_text.length).toBeLessThan(300);
      expect(row.answer_text).not.toMatch(/RIFF|data:audio/);
    }
    const mediaCount = (
      await query<{ count: number }>(`select count(*)::int as count from learning_app.media_assets where kind = 'speech'`)
    )[0]!;
    expect(mediaCount.count).toBe(0);
    const blobLike = await query<{ count: number }>(
      `select count(*)::int as count from learning_app.learning_events
        where (context::text like '%RIFF%') or (context::text like '%transcript%')`,
    );
    expect(blobLike[0]!.count).toBe(0);
  });
});
