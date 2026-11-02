import { randomUUID } from "node:crypto";
import { computeTargetKey } from "@learning/server";
import { LEARNING_V2_POLICY } from "../../packages/server/src/policies/learning-v2";
import type { testDatabase } from "../integration/helpers";

type Pool = ReturnType<typeof testDatabase>["pool"];

export interface LessonWorld {
  deckId: string;
  versionId: string;
  itemId: string;
  revisionId: string;
  objectiveSkillVersionId: string;
  subjectId: string;
  topicId: string;
  objectiveId: string;
  /** `target_key` ćwiczeń bogatej puli (tylko gdy `richPool`). */
  richKeys?: { notice: string; choice: string; gap: string; order: string };
  /** Ćwiczenie słuchowe (tylko gdy `listenChoice`). */
  listen?: LessonWorldListen;
}

export interface LessonWorldOptions {
  /** Tytuł materiału; pozwala testom rozpoznać własny rekord. */
  title?: string;
  /** Pozostaw szkic do testów edytora; domyślnie zachowuje publikację jak dotąd. */
  publish?: boolean;
  /** Przypisz lekcję temu dziecku (wymagane dla testów izolacji per dziecko). */
  childId?: string;
  /** Termin „sprawdzianu” lekcji z celem `lesson`, albo null. */
  testDate?: string | null;
  /**
   * Zasiej łańcuch oceny celu (`objective`): session_task(lesson_card) + attempt
   * + assessment skill='objective'. Służy do dowodu, że odbudowa postępu słówek
   * nie dotyka ocen celów. Wymaga `childId`. Domyślnie false.
   */
  withObjectiveAssessment?: boolean;
  /** Zegar — timestamp zdarzeń oceny; domyślnie now(). */
  now?: Date;
  /** Zasiej walidowalną pulę 3/4/2 do pełnego edytora lekcji. */
  editorReady?: boolean;
  /**
   * Zasiej bogatszą pulę ćwiczeń celu (notice + choice + gap + order) obok
   * domyślnego short_answer, z PRAWDZIWYMI `target_key` (computeTargetKey w
   * en-GB). Służy testom wydawania zadań, ekspozycji i selektora. Domyślnie false.
   */
  richPool?: boolean;
  /**
   * Dosiewa GOTOWY `target_audio` (TTS odpowiedzi) do rewizji wskazanych typów
   * PRZED publikacją (trigger niezmienności opublikowanej wersji blokuje dosiew
   * po publikacji). Służy testom A58 (serwowanie audio lekcji). Pusta/undefined
   * = brak audio. Wymaga `richPool`, by istniały ćwiczenia wszystkich typów.
   */
  withTargetAudioFor?: readonly string[];
  /**
   * Dosiewa nagranie pełnego zdania (`feedback_audio`) do KAŻDEJ rewizji wersji
   * przed publikacją: `ready` = gotowe przed wydaniem zadania, `pending` =
   * jeszcze w przygotowaniu (test może je potem oznaczyć jako gotowe).
   */
  withFeedbackAudio?: "ready" | "ready-approved" | "pending";
  /**
   * Dodatkowe zatwierdzone warianty ćwiczenia `lesson_transform` bogatej puli,
   * obok kanonicznego „she plays” (np. wariant ≠ odpowiedź kanoniczna do testu
   * bramki odczytu zdania). Wymaga `richPool`; domyślnie brak.
   */
  transformVariants?: readonly string[];
  /** Seed one issued contact while omitting all schedulable objectives. */
  unschedulableDailyRound?: boolean;
  /**
   * Dosiewa ćwiczenie „Posłuchaj i wybierz” (`lesson_listen_choice`) celu z
   * własnym nagraniem zdania (`feedback_audio`) w danym stanie (`none` = bez
   * zasobu). `stem` z jedną luką; opcje `plays`/`play` (poprawna `plays`).
   */
  listenChoice?: { audio: "ready" | "pending" | "failed" | "none"; stem?: string };
}

/** Ćwiczenie słuchowe zasiane przez `listenChoice`. */
export interface LessonWorldListen {
  itemId: string;
  revisionId: string;
  /** Zasób nagrania zdania (`null` przy `audio: "none"`) i jego fingerprint. */
  assetId: string | null;
  fingerprint: string;
  /** `target_key` ćwiczenia (odpowiedź) i klucz pełnego zdania (en-GB). */
  targetKey: string;
  sentence: string;
  sentenceTargetKey: string;
}

/**
 * Opublikowana lekcja utworzona WPROST w bazie (bez generacji): deck `lesson`
 * z `lesson_context` (przedmiot `english_grammar`, temat `present_simple` v1),
 * ćwiczenia `lesson_exercise` z rewizjami, `skill_versions`/`item_revision_skills`
 * dla umiejętności celu (`objective`) i opcjonalne przypisanie dziecku. Reużywalny
 * w kolejnych zadaniach warstwy lekcji. Pisze przez surową pulę pg, bo moduły
 * tworzenia lekcji (zadania 11+) jeszcze nie istnieją.
 */
export async function lessonWorld(sourcePool: Pool, options: LessonWorldOptions = {}): Promise<LessonWorld> {
  const client = await sourcePool.connect();
  try {
    await client.query("begin");
    // Keep every seed write on the same connection so a failed fixture cannot
    // leave a partial deck, revision, asset, or assignment in the shared world.
    const pool = { query: client.query.bind(client) } as unknown as Pool;
    const subjectId = "english_grammar";
    const topicId = "present_simple";
    const objectiveId = "english_grammar.present_simple.third_person_s";
    const now = options.now ?? new Date();

    const deckId = randomUUID();
    const versionId = randomUUID();
    const itemId = randomUUID();
    const revisionId = randomUUID();
    const skillVersionId = randomUUID();

    const lessonContext = JSON.stringify({
      subjectId,
      topicId,
      topicVersion: 1,
      objectiveIds: options.unschedulableDailyRound ? [] : [objectiveId],
      poolSize: 20,
      examples: { [objectiveId]: ["He plays football."] },
      material: "Present simple: trzecia osoba liczby pojedynczej dodaje -s.",
      instruction: "Ćwicz -s w 3. osobie.",
    });

    const title = options.title ?? "Present simple";
    await pool.query("insert into learning_app.decks (id, title, kind) values ($1, $2, 'lesson')", [deckId, title]);
    // Najpierw szkic (draft), potem treść, dopiero na końcu publikacja — trigger
    // „Published revision is immutable” blokuje wstawianie rewizji do opublikowanej wersji.
    await pool.query(
      `insert into learning_app.deck_versions (id, deck_id, version_number, edit_number, state, title, lesson_context)
       values ($1, $2, 1, 1, 'draft', $4, $3::jsonb)`,
      [versionId, deckId, lessonContext, title],
    );
    await pool.query("insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'lesson_exercise')", [itemId, deckId]);
    await pool.query(
      `insert into learning_app.item_revisions (id, item_id, deck_id, deck_version_id, position, payload_version, payload, target_key)
       values ($1, $2, $3, $4, 0, 2, $5::jsonb, $6)`,
      [
        revisionId,
        itemId,
        deckId,
        versionId,
        JSON.stringify({ exerciseType: "lesson_choice", objectiveId, stem: "He ___ (play) football.", answer: "plays", acceptedAnswers: [], focus: ["plays"], options: [{ id: "a", text: "plays" }, { id: "b", text: "play" }], correctOption: "a" }),
        `lesson-tk-${revisionId}`,
      ],
    );
    await pool.query(
      `insert into learning_app.skill_versions (id, item_id, skill, revision_number, criteria, criteria_hash)
       values ($1, $2, 'objective', 1, $3::jsonb, $4)`,
      [skillVersionId, itemId, JSON.stringify({ objectiveId }), `oc-${skillVersionId}`],
    );
    await pool.query(
      `insert into learning_app.item_revision_skills (item_revision_id, item_id, skill, skill_version_id)
       values ($1, $2, 'objective', $3)`,
      [revisionId, itemId, skillVersionId],
    );
    // Publikacja: state=published wymaga published_at; lesson_context niezmienny po publikacji.
    if (options.richPool) {
      await seedRichPool(pool, { deckId, versionId }, options.transformVariants ?? []);
    } else if (options.transformVariants !== undefined) {
      throw new Error("transformVariants wymaga richPool");
    }
    if (options.editorReady) {
      await seedEditorPool(pool, { deckId, versionId });
    }
    // Dosiew gotowego target_audio PRZED publikacją (po publikacji trigger blokuje).
    if (options.withTargetAudioFor && options.withTargetAudioFor.length > 0) {
      await attachLessonTargetAudio(pool, versionId, options.withTargetAudioFor);
    }
    if (options.withFeedbackAudio) {
      await attachLessonFeedbackAudio(pool, versionId, options.withFeedbackAudio);
    }
    // Po `withFeedbackAudio`: ćwiczenie słuchowe ma wyłącznie własny zasób zdania.
    const listen = options.listenChoice ? await seedListenChoice(pool, { deckId, versionId }, options.listenChoice) : undefined;
    if (options.publish !== false) {
      await pool.query(
        "update learning_app.deck_versions set state = 'published', published_at = $2 where id = $1",
        [versionId, now],
      );
      await pool.query("update learning_app.decks set published_version_id = $1 where id = $2", [versionId, deckId]);
    }

    if (options.childId && options.publish !== false) {
      const assignment = await pool.query<{ id: string }>(
        `insert into learning_app.assignments (id, child_id, deck_id, test_date, test_goals)
         values ($1, $2, $3, $4, $5) returning id`,
        [
          randomUUID(),
          options.childId,
          deckId,
          options.testDate ?? null,
          options.testDate !== undefined && options.testDate !== null ? ["lesson"] : null,
        ],
      );
      if (options.unschedulableDailyRound) {
        const sessionId = randomUUID();
        await pool.query(`insert into learning_app.learning_sessions
          (id, child_id, assignment_id, deck_id, deck_version_id, policy_id, microphone_enabled, state, task_budget, started_at, ended_at)
          values ($1, $2, $3, $4, $5, 'learning-v2', false, 'ended', 1, $6, $6)`,
        [sessionId, options.childId, assignment.rows[0]!.id, deckId, versionId, now]);
        await pool.query(`insert into learning_app.session_tasks
          (id, session_id, child_id, deck_version_id, item_revision_id, ordinal, exercise_type, state, public_prompt, answer_key, issued_at)
          values ($1, $2, $3, $4, $5, 0, 'lesson_choice', 'answered', '{}'::jsonb, '{}'::jsonb, $6)`,
        [randomUUID(), sessionId, options.childId, versionId, revisionId, now]);
      }
    }

    if (options.withObjectiveAssessment) {
      if (!options.childId) throw new Error("withObjectiveAssessment wymaga childId");
      const sessionId = randomUUID();
      const assignmentId = (
        await pool.query<{ id: string }>("select id from learning_app.assignments where child_id = $1 and deck_id = $2", [options.childId, deckId])
      ).rows[0]!.id;
      const policyId = LEARNING_V2_POLICY.version;
      await pool.query("insert into learning_app.learning_policies(id, config) values ($1, $2::jsonb) on conflict do nothing", [policyId, JSON.stringify(LEARNING_V2_POLICY)]);
      // Sesja lekcji (ścieżka lekcji jest osobna; tu sesję i zadanie wkładamy wprost,
      // żeby ocena celu miała łańcuch FK task->attempt->assessment).
      await pool.query(
        `insert into learning_app.learning_sessions
           (id, child_id, assignment_id, deck_id, deck_version_id, policy_id, microphone_enabled, mode, state, task_budget, started_at, ended_at)
         values ($1, $2, $3, $4, $5, $6, false, 'training', 'ended', 12, $7, $7)`,
        [sessionId, options.childId, assignmentId, deckId, versionId, policyId, now],
      );
      const taskId = randomUUID();
      await pool.query(
        `insert into learning_app.session_tasks
           (id, session_id, child_id, deck_version_id, item_revision_id, ordinal, exercise_type, state, public_prompt, answer_key, issued_at)
         values ($1, $2, $3, $4, $5, 0, 'lesson_short_answer', 'answered', '{}'::jsonb, '{}'::jsonb, $6)`,
        [taskId, sessionId, options.childId, versionId, revisionId, now],
      );
      const attemptId = randomUUID();
      // Próba najpierw jako 'processing' (bez completed_at): trigger pozwala wstawić
      // oceny tylko przed finalizacją. Po wstawieniu oceny finalizujemy do 'completed'.
      await pool.query(
        `insert into learning_app.attempts
           (id, child_id, task_id, item_revision_id, client_attempt_id, request_hash, attempt_number, modality, state, context, policy_id, received_at)
         values ($1, $2, $3, $4, $5, 'h', 1, 'text', 'processing', '{}'::jsonb, $6, $7)`,
        [attemptId, options.childId, taskId, revisionId, randomUUID(), policyId, now],
      );
      await pool.query(
        `insert into learning_app.assessments
           (child_id, attempt_id, item_revision_id, skill, skill_version_id, outcome, independent, confirmation_eligible, details)
         values ($1, $2, $3, 'objective', $4, 'correct', true, true, $5::jsonb)`,
        [options.childId, attemptId, revisionId, skillVersionId, JSON.stringify({ objectiveId, verdict: "exact" })],
      );
      await pool.query(
        "update learning_app.attempts set state = 'completed', completed_at = $2 where id = $1",
        [attemptId, now],
      );
      await pool.query(
        `insert into learning_app.child_objective_progress
           (child_id, subject_id, objective_id, topic_id, status, streak, last_independent_at, projection_version)
         values ($1, $2, $3, $4, 'practicing', 1, $5, 'proj-1')`,
        [options.childId, subjectId, objectiveId, topicId, now],
      );
    }

    const lesson = {
      deckId,
      versionId,
      itemId,
      revisionId,
      objectiveSkillVersionId: skillVersionId,
      subjectId,
      topicId,
      objectiveId,
      ...(options.richPool ? { richKeys: RICH_KEYS } : {}),
      ...(listen ? { listen } : {}),
    };
    await client.query("commit");
    return lesson;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const RICH_ANSWER_LOCALE = "en-GB";
/** Odpowiedzi kanoniczne bogatej puli — stałe, by test znał ich `target_key`. */
const RICH_ANSWERS = {  notice: "plays",
  choice: "plays",
  gap: "goes",
  gap2: "watches",
  gap3: "reads",
  order: "she plays football",
  transform: "she plays",
} as const;
/** `target_key` każdego ćwiczenia bogatej puli (computeTargetKey w en-GB). */
export const RICH_KEYS = {
  notice: computeTargetKey(RICH_ANSWERS.notice, RICH_ANSWER_LOCALE),
  choice: computeTargetKey(RICH_ANSWERS.choice, RICH_ANSWER_LOCALE),
  gap: computeTargetKey(RICH_ANSWERS.gap, RICH_ANSWER_LOCALE),
  gap2: computeTargetKey(RICH_ANSWERS.gap2, RICH_ANSWER_LOCALE),
  gap3: computeTargetKey(RICH_ANSWERS.gap3, RICH_ANSWER_LOCALE),
  order: computeTargetKey(RICH_ANSWERS.order, RICH_ANSWER_LOCALE),
  transform: computeTargetKey(RICH_ANSWERS.transform, RICH_ANSWER_LOCALE),
} as const;

/**
 * Dodaje do szkicu (przed publikacją) cztery ćwiczenia celu obok short_answer:
 * notice (intro), choice (guided), gap (productive), order (guided). Każde ma
 * własny `learning_item`, `skill_version` (objective), rewizję z payloadem
 * payload_version 2 i PRAWDZIWY `target_key`. Pozwala testom wydawania zadań
 * zobaczyć kartę → notice → ćwiczenie oraz ekspozycje per typ.
 */
async function seedRichPool(pool: Pool, version: { deckId: string; versionId: string }, transformVariants: readonly string[]): Promise<void> {
  const objectiveId = "english_grammar.present_simple.third_person_s";
  const exercises: { position: number; payload: Record<string, unknown>; answer: string }[] = [
    {
      position: 1,
      answer: RICH_ANSWERS.notice,
      payload: {
        exerciseType: "lesson_notice",
        objectiveId,
        instructionPl: "Dotknij słowa z końcówką -s.",
        noticeSegments: [["She", "plays", "football."], ["They", "play", "too."]],
        answer: RICH_ANSWERS.notice,
        acceptedAnswers: [RICH_ANSWERS.notice],
        focus: [RICH_ANSWERS.notice],
        correctOption: "plays",
      },
    },
    {
      position: 2,
      answer: RICH_ANSWERS.choice,
      payload: {
        exerciseType: "lesson_choice",
        objectiveId,
        instructionPl: "Wybierz poprawną formę.",
        stem: "She ___ football.",
        options: [
          { id: "o-play", text: "play" },
          { id: "o-plays", text: "plays" },
        ],
        answer: RICH_ANSWERS.choice,
        acceptedAnswers: [RICH_ANSWERS.choice],
        focus: [RICH_ANSWERS.choice],
        // `correctOption` dla choice/short_answer = ID OPCJI (kontrakt pool-validation:
        // `options.some(o => o.id === correctOption)`), nie tekst. Wcześniejszy
        // `"plays"` (tekst) maskował P1-1: stara materializacja dopasowywała po
        // tekście, więc błędny kształt „działał” tylko w teście.
        correctOption: "o-plays",
      },
    },
    {
      position: 3,
      answer: RICH_ANSWERS.gap,
      payload: {
        exerciseType: "lesson_gap",
        objectiveId,
        instructionPl: "Uzupełnij lukę.",
        stem: "He ___ (go) to school.",
        answer: RICH_ANSWERS.gap,
        acceptedAnswers: [RICH_ANSWERS.gap],
        focus: [RICH_ANSWERS.gap],
      },
    },
    {
      position: 4,
      answer: RICH_ANSWERS.order,
      payload: {
        exerciseType: "lesson_order",
        objectiveId,
        instructionPl: "Ułóż zdanie.",
        items: [
          { id: "i-she", text: "She" },
          { id: "i-plays", text: "plays" },
          { id: "i-football", text: "football" },
        ],
        answer: RICH_ANSWERS.order,
        acceptedAnswers: [RICH_ANSWERS.order],
        focus: ["plays"],
      },
    },
    {
      position: 5,
      answer: RICH_ANSWERS.transform,
      payload: {
        exerciseType: "lesson_transform",
        objectiveId,
        instructionPl: "Zamień na twierdzenie.",
        statement: "Does she play?",
        answer: RICH_ANSWERS.transform,
        acceptedAnswers: [RICH_ANSWERS.transform, ...transformVariants],
        // odpowiedź dwuwyrazowa, element sprawdzany to tylko „plays” — literówka
        // w „she” jest POZA focus, więc dopasowanie daje minor_typo (lesson_almost).
        focus: ["plays"],
      },
    },
    {
      // Drugie ćwiczenie produktywne (lesson_gap) z OSOBNYM itemId i target_key —
      // daje trzeci deterministycznie oceniany niezależny element celu, potrzebny
      // do opanowania (`successStreakRequired=3` na RÓŻNYCH ćwiczeniach).
      position: 6,
      answer: RICH_ANSWERS.gap2,
      payload: {
        exerciseType: "lesson_gap",
        objectiveId,
        instructionPl: "Uzupełnij lukę.",
        stem: "She ___ (watch) TV.",
        answer: RICH_ANSWERS.gap2,
        acceptedAnswers: [RICH_ANSWERS.gap2],
        focus: [RICH_ANSWERS.gap2],
      },
    },
    {
      // Czwarte ćwiczenie produktywne (osobny itemId/target_key): pozwala w DRUGIEJ
      // sesji wykonać potwierdzający niezależny sukces na NOWYM, różnym ćwiczeniu,
      // które wchodzi do okna opanowania — bez tego potwierdzenie padłoby na powtórkę.
      position: 7,
      answer: RICH_ANSWERS.gap3,
      payload: {
        exerciseType: "lesson_gap",
        objectiveId,
        instructionPl: "Uzupełnij lukę.",
        stem: "He ___ (read) books.",
        answer: RICH_ANSWERS.gap3,
        acceptedAnswers: [RICH_ANSWERS.gap3],
        focus: [RICH_ANSWERS.gap3],
      },
    },
  ];

  for (const ex of exercises) {
    const exItemId = randomUUID();
    const exRevisionId = randomUUID();
    const exSkillVersionId = randomUUID();
    await pool.query("insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'lesson_exercise')", [exItemId, version.deckId]);
    await pool.query(
      `insert into learning_app.item_revisions (id, item_id, deck_id, deck_version_id, position, payload_version, payload, target_key)
       values ($1, $2, $3, $4, $5, 2, $6::jsonb, $7)`,
      [
        exRevisionId,
        exItemId,
        version.deckId,
        version.versionId,
        ex.position,
        JSON.stringify({ ...ex.payload, answerLocale: RICH_ANSWER_LOCALE, promptLocale: "pl-PL" }),
        computeTargetKey(ex.answer, RICH_ANSWER_LOCALE),
      ],
    );
    await pool.query(
      `insert into learning_app.skill_versions (id, item_id, skill, revision_number, criteria, criteria_hash)
       values ($1, $2, 'objective', 1, $3::jsonb, $4)`,
      [exSkillVersionId, exItemId, JSON.stringify({ objectiveId }), `oc-${exSkillVersionId}`],
    );
    await pool.query(
      `insert into learning_app.item_revision_skills (item_revision_id, item_id, skill, skill_version_id)
       values ($1, $2, 'objective', $3)`,
      [exRevisionId, exItemId, exSkillVersionId],
    );
  }
}

/**
 * Ćwiczenie `lesson_listen_choice` celu (szkic, przed publikacją) z własnym
 * `feedback_audio`: gotowym, w przygotowaniu, nieudanym albo bez zasobu.
 */
async function seedListenChoice(
  pool: Pool,
  version: { deckId: string; versionId: string },
  options: NonNullable<LessonWorldOptions["listenChoice"]>,
): Promise<LessonWorldListen> {
  const objectiveId = "english_grammar.present_simple.third_person_s";
  const stem = options.stem ?? "She ___ football.";
  const answer = "plays";
  const sentence = stem.replace(/_{2,}/, answer);
  const itemId = randomUUID();
  const revisionId = randomUUID();
  const skillVersionId = randomUUID();
  const targetKey = computeTargetKey(answer, RICH_ANSWER_LOCALE);
  await pool.query("insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'lesson_exercise')", [itemId, version.deckId]);
  await pool.query(
    `insert into learning_app.item_revisions (id, item_id, deck_id, deck_version_id, position, payload_version, payload, target_key)
     values ($1, $2, $3, $4, 8, 2, $5::jsonb, $6)`,
    [revisionId, itemId, version.deckId, version.versionId, JSON.stringify({
      exerciseType: "lesson_listen_choice", objectiveId, stem,
      options: [{ id: "o-play", text: "play" }, { id: "o-plays", text: answer }], correctOption: "o-plays",
      answer, acceptedAnswers: [answer], focus: [answer], answerLocale: RICH_ANSWER_LOCALE, promptLocale: "pl-PL",
    }), targetKey],
  );
  await pool.query(
    `insert into learning_app.skill_versions (id, item_id, skill, revision_number, criteria, criteria_hash)
     values ($1, $2, 'objective', 1, $3::jsonb, $4)`,
    [skillVersionId, itemId, JSON.stringify({ objectiveId }), `oc-${skillVersionId}`],
  );
  await pool.query(
    `insert into learning_app.item_revision_skills (item_revision_id, item_id, skill, skill_version_id)
     values ($1, $2, 'objective', $3)`,
    [revisionId, itemId, skillVersionId],
  );
  const fingerprint = `fp-listen-${revisionId}`;
  let assetId: string | null = null;
  if (options.audio !== "none") {
    assetId = randomUUID();
    if (options.audio === "ready") {
      await pool.query(
        `insert into learning_app.media_assets
           (id, kind, fingerprint, generation_number, state, storage_key, content_sha256, mime_type, byte_count, provider, model, metadata)
         values ($1, 'tts', $2, 1, 'ready', $3, $4, 'audio/mpeg', 1024, 'fake', 'fake-tts', '{}'::jsonb)`,
        [assetId, fingerprint, `blob/${assetId}`, `sha-${assetId}`],
      );
    } else {
      await pool.query(
        `insert into learning_app.media_assets (id, kind, fingerprint, generation_number, state, provider, model, metadata)
         values ($1, 'tts', $2, 1, 'pending', 'fake', 'fake-tts', '{}'::jsonb)`,
        [assetId, fingerprint],
      );
      if (options.audio === "failed") {
        await pool.query("update learning_app.media_assets set state = 'failed', lease_token = null where id = $1", [assetId]);
      }
    }
    await pool.query(
      `insert into learning_app.revision_assets (item_revision_id, role, asset_id, expected_fingerprint, state)
       values ($1, 'feedback_audio', $2, $3, 'pending')`,
      [revisionId, assetId, fingerprint],
    );
  }
  return {
    itemId, revisionId, assetId, fingerprint, targetKey, sentence,
    sentenceTargetKey: computeTargetKey(sentence, RICH_ANSWER_LOCALE),
  };
}

/** Valid full editor pool for third-person -s: 3 guided, 4 productive, 2 independent. */
async function seedEditorPool(pool: Pool, version: { deckId: string; versionId: string }): Promise<void> {
  const objectiveId = "english_grammar.present_simple.third_person_s";
  const exercises = [
    { type: "lesson_choice", prompt: "He ___ football.", answer: "plays", focus: "plays" },
    { type: "lesson_choice", prompt: "She ___ at home.", answer: "works", focus: "works" },
    { type: "lesson_choice", prompt: "It ___ fast.", answer: "runs", focus: "runs" },
    { type: "lesson_gap", prompt: "He ___ to school.", answer: "goes", focus: "goes" },
    { type: "lesson_gap", prompt: "She ___ TV.", answer: "watches", focus: "watches" },
    { type: "lesson_gap", prompt: "It ___ dinner.", answer: "cooks", focus: "cooks" },
    { type: "lesson_gap", prompt: "He ___ books.", answer: "reads", focus: "reads" },
    { type: "lesson_open_answer", prompt: "What does he do?", answer: "He plays football.", focus: "plays" },
    { type: "lesson_open_answer", prompt: "What does she do?", answer: "She works at home.", focus: "works" },
  ] as const;
  for (const [index, exercise] of exercises.entries()) {
    const itemId = randomUUID();
    const revisionId = randomUUID();
    const skillVersionId = randomUUID();
    const payload = exercise.type === "lesson_choice"
      ? {
          exerciseType: exercise.type, objectiveId, instructionPl: "Wybierz poprawną formę.",
          stem: exercise.prompt.replace(exercise.answer, "___"),
          options: [{ id: "wrong", text: "play" }, { id: "right", text: exercise.answer }],
          correctOption: "right", answer: exercise.answer, acceptedAnswers: [], focus: [exercise.focus],
        }
      : exercise.type === "lesson_gap"
        ? {
            exerciseType: exercise.type, objectiveId, instructionPl: "Uzupełnij lukę.",
            stem: exercise.prompt,
            answer: exercise.answer, acceptedAnswers: [], focus: [exercise.focus],
          }
        : {
            exerciseType: exercise.type, objectiveId, instructionPl: "Powiedz całe zdanie.",
            prompt: exercise.prompt, answer: exercise.answer, acceptedAnswers: [], focus: [exercise.focus],
          };
    await pool.query("insert into learning_app.learning_items (id, deck_id, kind) values ($1, $2, 'lesson_exercise')", [itemId, version.deckId]);
    await pool.query(
      `insert into learning_app.item_revisions (id, item_id, deck_id, deck_version_id, position, payload_version, payload, target_key)
       values ($1, $2, $3, $4, $5, 2, $6::jsonb, $7)`,
      [revisionId, itemId, version.deckId, version.versionId, index + 1,
        JSON.stringify(payload),
        computeTargetKey(exercise.answer, RICH_ANSWER_LOCALE)],
    );
    await pool.query(
      `insert into learning_app.skill_versions (id, item_id, skill, revision_number, criteria, criteria_hash)
       values ($1, $2, 'objective', 1, $3::jsonb, $4)`,
      [skillVersionId, itemId, JSON.stringify({ objectiveId }), `oc-${skillVersionId}`],
    );
    await pool.query(
      `insert into learning_app.item_revision_skills (item_revision_id, item_id, skill, skill_version_id)
       values ($1, $2, 'objective', $3)`,
      [revisionId, itemId, skillVersionId],
    );
  }
}

/**
 * Dołącza GOTOWY zasób `target_audio` (TTS odpowiedzi kanonicznej) do wszystkich
 * rewizji ćwiczeń wskazanego typu w opublikowanej wersji lekcji — tak jak zrobiłby
 * to potok mediów przy publikacji, gdy `subject.ttsForAnswers`. Zwraca mapę
 * `revisionId -> assetId`. Pozwala testom udowodnić, że audio jest serwowane
 * tylko dla typów tekstowych, po zapieczętowaniu ekspozycji. `media_assets` musi
 * być „ready” z kompletem pól (storage_key/mime_type/byte_count/content_sha256).
 */
export async function attachLessonTargetAudio(
  pool: Pool,
  versionId: string,
  exerciseTypes: readonly string[] = ["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"],
): Promise<Map<string, string>> {
  const rows = await pool.query<{ id: string; payload: { exerciseType?: string } }>(
    "select id, payload from learning_app.item_revisions where deck_version_id = $1 order by position",
    [versionId],
  );
  const byRevision = new Map<string, string>();
  for (const row of rows.rows) {
    if (!exerciseTypes.includes(row.payload.exerciseType ?? "")) continue;
    const assetId = randomUUID();
    await pool.query(
      `insert into learning_app.media_assets
         (id, kind, fingerprint, generation_number, state, storage_key, content_sha256, mime_type, byte_count, provider, model, metadata)
       values ($1, 'tts', $2, 1, 'ready', $3, $4, 'audio/mpeg', 1024, 'fake', 'fake-tts', '{}'::jsonb)`,
      [assetId, `fp-${assetId}`, `blob/${assetId}`, `sha-${assetId}`],
    );
    await pool.query(
      `insert into learning_app.revision_assets (item_revision_id, role, asset_id, expected_fingerprint, state)
       values ($1, 'target_audio', $2, $3, 'approved')`,
      [row.id, assetId, `fp-${assetId}`],
    );
    byRevision.set(row.id, assetId);
  }
  return byRevision;
}

/**
 * Dołącza nagranie zdania feedbacku (`feedback_audio`) do każdej rewizji wersji —
 * jak planowanie mediów przy przygotowaniu lekcji gramatyki. Zasób `ready` ma
 * komplet pól gotowego blobu; `pending` czeka na worker. Zwraca mapę
 * `revisionId -> assetId`.
 *
 * Wiersz `revision_assets` ma stan `pending` także przy gotowym zasobie
 * (`"ready"`): to najczęstszy stan produkcji — publikacja nie czeka na media,
 * a wiersz opublikowanej rewizji jest niezmienny, więc worker go nie podnosi.
 * `"ready-approved"` to ten sam gotowy zasób z wierszem `approved`.
 */
export async function attachLessonFeedbackAudio(
  pool: Pool,
  versionId: string,
  state: "ready" | "ready-approved" | "pending",
): Promise<Map<string, string>> {
  const rows = await pool.query<{ id: string }>(
    "select id from learning_app.item_revisions where deck_version_id = $1 order by position",
    [versionId],
  );
  const byRevision = new Map<string, string>();
  for (const row of rows.rows) {
    const assetId = randomUUID();
    if (state !== "pending") {
      await pool.query(
        `insert into learning_app.media_assets
           (id, kind, fingerprint, generation_number, state, storage_key, content_sha256, mime_type, byte_count, provider, model, metadata)
         values ($1, 'tts', $2, 1, 'ready', $3, $4, 'audio/mpeg', 1024, 'fake', 'fake-tts', '{}'::jsonb)`,
        [assetId, `fp-feedback-${assetId}`, `blob/${assetId}`, `sha-${assetId}`],
      );
    } else {
      await pool.query(
        `insert into learning_app.media_assets (id, kind, fingerprint, generation_number, state, provider, model, metadata)
         values ($1, 'tts', $2, 1, 'pending', 'fake', 'fake-tts', '{}'::jsonb)`,
        [assetId, `fp-feedback-${assetId}`],
      );
    }
    await pool.query(
      `insert into learning_app.revision_assets (item_revision_id, role, asset_id, expected_fingerprint, state)
       values ($1, 'feedback_audio', $2, $3, $4)`,
      [row.id, assetId, `fp-feedback-${assetId}`, state === "ready-approved" ? "approved" : "pending"],
    );
    byRevision.set(row.id, assetId);
  }
  return byRevision;
}
