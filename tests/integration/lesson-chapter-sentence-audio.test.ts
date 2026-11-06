import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completePresentation,
  createChild,
  createServices,
  endSession,
  nextTask,
  publishLessonDraft,
  readLessonDeck,
  runDueGenerationWork,
  startSession,
  submitAttempt,
  type Services,
} from "@learning/server";
import type { AttemptDto, AttemptInput, TaskDto } from "@learning/contracts";
import { lessonTextTargetKey } from "../../packages/server/src/domain/lessons/exposure-key";
import { seedChapterDraft } from "./chapter-lesson-helpers";
import { fakeGeneration, type FakeGeneration } from "./fakes";
import { ManualClock, testDatabase } from "./helpers";

/**
 * Odczyt pełnego zdania po odpowiedzi w lekcji „Angielski — rozdział” (Etap 3,
 * mechanizm #194): szkic (pula sterowana zasiana edycją rodzica, bez generowania) zleca `feedback_audio` w `en-GB` bez stylu pl-PL dla
 * typów ze zdaniem, worker je syntezuje, a feedback ocenionej odpowiedzi niesie
 * nagranie z pieczęcią `audio_issued` na kluczu rozwiązanego zdania. Omówienie
 * z innym zatwierdzonym wariantem niż kanoniczny nie dostaje nagrania (design
 * rozdziału §5.2: dziecko nie słyszy innego zdania, niż widzi).
 */

const { db, pool } = testDatabase();

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

/** Dwa zagadnienia: grupa słów (pary, grupy, luki z bankiem) i rama zdaniowa (układanka). */
const MATERIAL = [
  "Zagadnienie 1: Ubrania",
  "coat, boots, dress, skirt, hat",
  "Zagadnienie 2: Co mam na sobie",
  "I'm wearing a coat today. I'm wearing boots. She is wearing a dress. She is wearing a skirt.",
].join("\n");

const EN_INSTRUCTION = "Speak British English.";

/** Instrukcje TTS obu języków i tryb stylu: zdanie feedbacku dostaje wyłącznie instrukcję en-GB. */
function mediaSettings(fakes: FakeGeneration) {
  return {
    ...fakes.settings,
    tts: { ...fakes.settings.tts, style: "instructions" as const, instructions: { "pl-PL": "Mów po polsku.", "en-GB": EN_INSTRUCTION } },
  };
}

const translation = (objectiveId: string, prompt: string, answer: string, variant: string, focus: string) => ({
  exerciseType: "lesson_open_answer", objectiveId, instructionPl: "Przetłumacz na angielski.", prompt,
  // Wariant z innym szykiem: literówka w nim daje „prawie” z pokazanym wariantem, nie kanoniczną odpowiedzią.
  answer, acceptedAnswers: [variant], focus: [focus],
});
const choice = (objectiveId: string, instructionPl: string, stem: string, correct: string, wrong: string) => ({
  exerciseType: "lesson_choice", objectiveId, instructionPl, stem,
  options: [{ id: "a", text: correct }, { id: "b", text: wrong }], correctOption: "a",
  answer: correct, acceptedAnswers: [], focus: [],
});
const gap = (objectiveId: string, instructionPl: string, stem: string, answer: string) => ({
  exerciseType: "lesson_gap", objectiveId, instructionPl, stem, answer, acceptedAnswers: [], focus: [answer],
});

/**
 * Zagadnienie słów: pary, grupy, luki z bankiem, wybór, luki, tłumaczenia (minima 3/3/2).
 * Rozwiązane zdania (klucze ekspozycji) są różne w obu zagadnieniach, więc pieczęć
 * odczytu i `targetKey` jednoznacznie wskazują jedno ćwiczenie.
 */
function wordsPool(objectiveId: string) {
  return [
    {
      exerciseType: "lesson_match", objectiveId, instructionPl: "Połącz słowa w pary.",
      pairs: [{ left: "coat", right: "płaszcz" }, { left: "boots", right: "buty" }, { left: "dress", right: "sukienka" }],
      extraRight: ["czapka"], answer: "coat, boots, dress", acceptedAnswers: [], focus: [],
    },
    {
      exerciseType: "lesson_group", objectiveId, instructionPl: "Co założysz? Pogrupuj.",
      groups: [{ id: "g1", label: "Na zimno" }, { id: "g2", label: "Na lato" }],
      groupItems: [
        { text: "coat", groupId: "g1" }, { text: "boots", groupId: "g1" },
        { text: "dress", groupId: "g2" }, { text: "skirt", groupId: "g2" },
      ],
      answer: "Na zimno / Na lato", acceptedAnswers: [], focus: [],
    },
    {
      exerciseType: "lesson_cloze", objectiveId, instructionPl: "Mam na sobie płaszcz i buty. Uzupełnij tekst.",
      clozeText: "I'm wearing a ___ and ___.", gapAnswers: ["coat", "boots"], extraWords: ["dress"],
      answer: "coat, boots", acceptedAnswers: [], focus: [],
    },
    choice(objectiveId, "Mam na sobie sukienkę. Wybierz słowo.", "I'm wearing a ___.", "dress", "skirt"),
    gap(objectiveId, "Mam na sobie płaszcz. Wpisz brakujące słowo.", "I'm wearing a ___.", "coat"),
    gap(objectiveId, "Ona ma na sobie spódnicę. Wpisz brakujące słowo.", "She is wearing a ___.", "skirt"),
    gap(objectiveId, "Mam dziś na sobie czapkę. Wpisz brakujące słowo.", "I'm wearing a ___ today.", "hat"),
    translation(objectiveId, "Ona ma dziś na sobie czapkę.", "She is wearing a hat today.", "Today she is wearing a hat.", "hat"),
    translation(objectiveId, "Ona ma dziś na sobie sukienkę.", "She is wearing a dress today.", "Today she is wearing a dress.", "dress"),
  ];
}

/** Rama zdaniowa: układanka, wybór, luki, tłumaczenia. */
function framePool(objectiveId: string) {
  return [
    {
      exerciseType: "lesson_order", objectiveId, instructionPl: "Ona ma na sobie sukienkę. Ułóż zdanie.",
      items: [{ id: "i1", text: "She" }, { id: "i2", text: "is" }, { id: "i3", text: "wearing" }, { id: "i4", text: "a dress" }],
      answer: "She is wearing a dress", acceptedAnswers: [], focus: [],
    },
    choice(objectiveId, "Mam na sobie buty. Wybierz słowo.", "I'm wearing ___.", "boots", "hat"),
    choice(objectiveId, "Mam dziś na sobie płaszcz. Wybierz słowo.", "I'm wearing a ___ today.", "coat", "skirt"),
    gap(objectiveId, "Mam dziś na sobie spódnicę. Wpisz brakujące słowo.", "I'm ___ a skirt today.", "wearing"),
    gap(objectiveId, "Ona ma na sobie płaszcz. Wpisz brakujące słowo.", "She is wearing a ___.", "coat"),
    gap(objectiveId, "Ona ma dziś na sobie spódnicę. Wpisz brakujące słowo.", "She is wearing a ___ today.", "skirt"),
    translation(objectiveId, "Mam dziś na sobie buty.", "I'm wearing boots today.", "Today I'm wearing boots.", "boots"),
    translation(objectiveId, "Ona ma dziś na sobie buty.", "She is wearing boots today.", "Today she is wearing boots.", "boots"),
  ];
}

/** Odpowiedź bez identyfikatorów zadania i próby (rozdzielnie po wariantach modalności). */
type AnswerInput = AttemptInput extends infer Input ? Input extends AttemptInput ? Omit<Input, "taskId" | "clientAttemptId"> : never : never;

const SENTENCE_TYPES = ["lesson_choice", "lesson_gap", "lesson_cloze", "lesson_order", "lesson_open_answer"];

describe("lekcja Angielski — rozdział: odczyt zdania po odpowiedzi (integracja)", () => {
  const disposers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    await pool.query(
      `truncate learning_app.child_profiles, learning_app.parent_sessions, learning_app.parent_credentials,
              learning_app.integration_tokens, learning_app.generation_runs, learning_app.child_objective_progress,
              learning_app.lesson_verdicts, learning_app.revision_assets, learning_app.media_assets,
              learning_app.item_revision_skills, learning_app.item_revisions, learning_app.skill_versions,
              learning_app.learning_items, learning_app.deck_versions, learning_app.decks cascade`,
    );
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });

  afterAll(() => pool.end());

  /** Szkic z dwoma zagadnieniami (słowa i rama) z pulami sterowanymi, zasiany bez generowania. */
  async function chapterWorld() {
    const fakes = await fakeGeneration();
    disposers.push(fakes.dispose);
    const clock = new ManualClock();
    const services = createServices({ db, clock, media: mediaSettings(fakes), generation: fakes.deps });
    const { deckId } = await seedChapterDraft(services, {
      material: MATERIAL,
      topicTitlePl: "Ubrania",
      objectives: [
        {
          slug: "ubrania", titlePl: "Ubrania", kind: "words",
          cards: [{ title: "Wyjaśnienie", body: "coat, boots, dress, skirt, hat" }, { title: "Do zapamiętania", body: "coat, boots, dress, skirt, hat" }],
          exercises: (_deckId, objectiveId) => wordsPool(objectiveId),
        },
        {
          slug: "co_mam_na_sobie", titlePl: "Co mam na sobie", kind: "frame",
          cards: [{ title: "Wyjaśnienie", body: "I'm wearing a coat today." }, { title: "Do zapamiętania", body: "I'm wearing boots." }],
          exercises: (_deckId, objectiveId) => framePool(objectiveId),
        },
      ],
    });
    const draft = (await readLessonDeck(services, deckId)).draft!;
    return { fakes, services, clock, deckId, draft };
  }

  async function runWorker(services: Services) {
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await runDueGenerationWork(services, { lesson: 0, deck: 0, tts: 50, images: 0 });
      if (result.processed === 0) break;
    }
  }

  interface FeedbackRow { type: string; payload: Record<string, unknown>; metadata: Record<string, unknown> | null; state: string | null }

  async function feedbackRowsByRevision(versionId: string): Promise<FeedbackRow[]> {
    return query<FeedbackRow>(
      `select ir.payload->>'exerciseType' as type, ir.payload, ma.metadata, ma.state
         from learning_app.item_revisions ir
         left join learning_app.revision_assets ra on ra.item_revision_id = ir.id and ra.role = 'feedback_audio'
         left join learning_app.media_assets ma on ma.id = ra.asset_id
        where ir.deck_version_id = $1 order by ir.position`, [versionId],
    );
  }

  /** Zdanie, które omówienie pokazuje jako rozwiązanie (wejście nagrania), z payloadu rewizji. */
  function shownSentence(payload: Record<string, unknown>): string {
    switch (payload.exerciseType) {
      case "lesson_choice": {
        const options = payload.options as { id: string; text: string }[];
        return (payload.stem as string).replace(/_{2,}/u, options.find((option) => option.id === payload.correctOption)!.text);
      }
      case "lesson_gap":
        return (payload.stem as string).replace(/_{2,}/u, payload.answer as string);
      case "lesson_cloze": {
        const words = [...(payload.gapAnswers as string[])];
        return (payload.clozeText as string).replace(/_{2,}/gu, () => words.shift()!);
      }
      case "lesson_order":
        return (payload.items as { text: string }[]).map((item) => item.text).join(" ");
      default:
        return payload.answer as string;
    }
  }

  async function assign(childId: string, deckId: string) {
    await pool.query(
      "insert into learning_app.assignments (id, child_id, deck_id, test_date, test_goals) values ($1, $2, $3, null, null)",
      [randomUUID(), childId, deckId],
    );
  }

  async function answerKey(taskId: string): Promise<Record<string, unknown>> {
    return (await query<{ answer_key: Record<string, unknown> }>("select answer_key from learning_app.session_tasks where id = $1", [taskId]))[0]!.answer_key;
  }

  function correctAnswer(task: TaskDto, key: Record<string, unknown>): AnswerInput {
    switch (task.exerciseType) {
      case "lesson_choice":
        return { modality: "choice", optionId: key.correctOptionId as string };
      case "lesson_order":
        return { modality: "sequence", itemIds: key.itemIds as string[] };
      case "lesson_match":
      case "lesson_group":
      case "lesson_cloze":
        return { modality: "assignment", assignments: key.assignments as { itemId: string; targetId: string }[] };
      default:
        return { modality: "text", text: key.answer as string };
    }
  }

  async function submit(services: Services, task: TaskDto, answer: AnswerInput): Promise<AttemptDto> {
    return submitAttempt(services, { taskId: task.taskId, clientAttemptId: randomUUID(), ...answer } as AttemptInput);
  }

  interface Played { task: TaskDto; key: Record<string, unknown>; attempt: AttemptDto }

  /** Sesje co godzinę z poprawnymi odpowiedziami (jak w `lesson-chapter.test.ts`). */
  async function playSessions(services: Services, clock: ManualClock, childId: string, deckId: string, sessions: number): Promise<Played[]> {
    const played: Played[] = [];
    for (let index = 0; index < sessions; index++) {
      const session = await startSession(services, { childId, deckId, microphoneEnabled: false });
      for (let step = 0; step < 40; step++) {
        const task = await nextTask(services, session.sessionId);
        if (task === null) break;
        if (task.exerciseType === "lesson_card") {
          await completePresentation(services, { taskId: task.taskId });
          continue;
        }
        const key = await answerKey(task.taskId);
        const attempt = await submit(services, task, correctAnswer(task, key));
        played.push({ task, key, attempt });
      }
      await endSession(services, session.sessionId);
      clock.advanceHours(1);
    }
    return played;
  }

  /** Po kwalifikujących sukcesach i terminie powtórki sesja zaczyna się należnym tłumaczeniem. */
  async function dueTranslation(services: Services, clock: ManualClock, childId: string, deckId: string): Promise<TaskDto> {
    await playSessions(services, clock, childId, deckId, 3);
    const due = await query<{ next_review_at: Date }>(
      "select next_review_at from learning_app.child_objective_progress where child_id = $1 and next_review_at is not null", [childId],
    );
    expect(due.length).toBeGreaterThan(0);
    const latest = Math.max(...due.map((row) => row.next_review_at.getTime()));
    clock.advanceMs(Math.max(0, latest - clock.now().getTime()) + 1_000);
    const session = await startSession(services, { childId, deckId, microphoneEnabled: false });
    let task = await nextTask(services, session.sessionId);
    while (task !== null && task.exerciseType === "lesson_card") {
      await completePresentation(services, { taskId: task.taskId });
      task = await nextTask(services, session.sessionId);
    }
    if (task === null) throw new Error("sesja po terminie powtórki skończyła się bez zadania — brak należnego tłumaczenia");
    expect(task.exerciseType, "pierwsze zadanie po terminie powtórki").toBe("lesson_open_answer");
    return task;
  }

  /** Pierwsze zadanie typu w sesji; wcześniejsze karty przechodzą, inne zadania są pomijane. */
  async function skipUntil(services: Services, sessionId: string, type: string): Promise<TaskDto> {
    for (let step = 0; step < 40; step++) {
      const task = await nextTask(services, sessionId);
      if (task === null) throw new Error(`sesja skończyła się przed zadaniem ${type}`);
      if (task.exerciseType === type) return task;
      if (task.exerciseType === "lesson_card") await completePresentation(services, { taskId: task.taskId });
      else await submit(services, task, { modality: "skip" });
    }
    throw new Error(`nie doczekano zadania ${type} w 40 krokach`);
  }

  /**
   * Rozwiązane zdanie, które dziecko widzi po odpowiedzi: publiczny prompt zadania
   * (Kid DTO) z rozwiązaniem z klucza — niezależnie od payloadu rewizji.
   */
  function solvedSentenceSeen(task: TaskDto, key: Record<string, unknown>): string {
    const prompt = task.prompt;
    switch (prompt.kind) {
      case "lesson_choice": {
        const correct = prompt.options.find((option) => option.id === key.correctOptionId);
        if (correct === undefined) throw new Error("prompt wyboru bez poprawnej opcji z klucza");
        return prompt.stem.replace(/_{2,}/u, correct.text);
      }
      case "lesson_cloze": {
        const wordOf = new Map((key.assignments as { itemId: string; targetId: string }[]).map((entry) => [entry.itemId, entry.targetId]));
        const words = new Map(prompt.words.map((word) => [word.id, word.text]));
        return prompt.segments.map((segment) => {
          if (!("gapId" in segment)) return segment.text;
          const word = words.get(wordOf.get(segment.gapId) ?? "");
          if (word === undefined) throw new Error(`luka ${segment.gapId} bez słowa z klucza`);
          return word;
        }).join("");
      }
      case "lesson_gap":
        return prompt.stemWithGap.replace(/_{2,}/u, key.answer as string);
      case "lesson_order": {
        const texts = new Map(prompt.items.map((item) => [item.id, item.text]));
        return (key.itemIds as string[]).map((id) => texts.get(id)).join(" ");
      }
      default:
        throw new Error(`brak zdania do porównania dla ${prompt.kind}`);
    }
  }

  async function feedbackAssetOf(taskId: string): Promise<{ assetId: string; text: string } | null> {
    return (await query<{ assetId: string; text: string }>(
      `select ra.asset_id as "assetId", ma.metadata->>'text' as text
         from learning_app.revision_assets ra
         join learning_app.session_tasks st on st.item_revision_id = ra.item_revision_id
         join learning_app.media_assets ma on ma.id = ra.asset_id
        where st.id = $1 and ra.role = 'feedback_audio'`, [taskId],
    ))[0] ?? null;
  }

  interface AudioEventRow { occurredAt: Date; sealed: boolean; exposures: string[] }

  async function audioEvents(taskId: string): Promise<AudioEventRow[]> {
    return query<AudioEventRow>(
      `select le.occurred_at as "occurredAt", le.sealed,
              coalesce(array_agg(ee.target_key) filter (where ee.target_key is not null), '{}') as exposures
         from learning_app.learning_events le
         left join learning_app.event_exposures ee on ee.event_id = le.id
        where le.task_id = $1 and le.kind = 'audio_issued'
        group by le.id order by le.occurred_at`, [taskId],
    );
  }

  /** Feedback z nagraniem zdania pokazanego rozwiązania: jedna pieczęć po odpowiedzi na kluczu zdania. */
  async function expectSentenceReadback(entry: Played, shown: string) {
    const asset = await feedbackAssetOf(entry.task.taskId);
    expect(asset, entry.task.exerciseType).not.toBeNull();
    expect(asset!.text).toBe(shown);
    expect(entry.attempt.feedback?.correctAudioAssetId).toBe(asset!.assetId);
    const events = await audioEvents(entry.task.taskId);
    expect(events).toHaveLength(1);
    expect(events[0]!.sealed).toBe(true);
    expect(events[0]!.occurredAt.getTime()).toBeGreaterThan(new Date(entry.attempt.receivedAt).getTime());
    expect(events[0]!.exposures).toEqual([entry.key.targetKey]);
  }

  it("szkic zleca feedback_audio en-GB bez stylu dla typów ze zdaniem, nie dla par, grup i kart; publikacja na nie nie czeka", async () => {
    const { fakes, services, draft } = await chapterWorld();
    expect(draft.coverage).toEqual([]);
    expect(draft.dynamicTopic!.objectives.map((objective) => objective.kind)).toEqual(["words", "frame"]);
    // Rodzic nie widzi nagrań zdań w widoku szkicu.
    expect(draft.assets).toEqual([]);

    const rows = await feedbackRowsByRevision(draft.id);
    expect(new Set(rows.map((row) => row.type))).toEqual(new Set([...SENTENCE_TYPES, "lesson_match", "lesson_group"]));
    for (const row of rows) {
      if (!SENTENCE_TYPES.includes(row.type)) {
        expect(row.metadata, row.type).toBeNull();
        continue;
      }
      expect(row.state, row.type).toBe("pending");
      expect(row.metadata, row.type).toMatchObject({ kind: "tts", locale: "en-GB", text: shownSentence(row.payload), instructions: EN_INSTRUCTION });
    }
    // Luki z bankiem: pełny tekst, nie lista słów (`answer`).
    expect(rows.find((row) => row.type === "lesson_cloze")!.metadata).toMatchObject({ text: "I'm wearing a coat and boots." });
    // Każde ćwiczenie ze zdaniem ma własny klucz rozwiązanego zdania (bez kolizji między zagadnieniami).
    const sentenceKeys = (await query<{ type: string; target_key: string }>(
      "select payload->>'exerciseType' as type, target_key from learning_app.item_revisions where deck_version_id = $1", [draft.id],
    )).filter((row) => SENTENCE_TYPES.includes(row.type)).map((row) => row.target_key);
    expect(sentenceKeys.length).toBe(rows.filter((row) => SENTENCE_TYPES.includes(row.type)).length);
    expect(new Set(sentenceKeys).size, "rozwiązane zdania fixture muszą być różne").toBe(sentenceKeys.length);
    // Przedmiot nie ma nagrań odpowiedzi, pytań ani kart.
    expect((await query<{ role: string }>(
      `select distinct ra.role from learning_app.revision_assets ra
         join learning_app.item_revisions ir on ir.id = ra.item_revision_id where ir.deck_version_id = $1`, [draft.id],
    )).map((row) => row.role)).toEqual(["feedback_audio"]);
    expect(await query("select 1 from learning_app.lesson_card_assets where deck_version_id = $1", [draft.id])).toEqual([]);

    await expect(publishLessonDraft(services, draft.id, draft.editNumber)).resolves.toEqual({ deckVersionId: draft.id });
    await runWorker(services);
    const ready = (await feedbackRowsByRevision(draft.id)).filter((row) => row.metadata !== null);
    expect(ready.every((row) => row.state === "ready")).toBe(true);
    const spoken = fakes.tts.requests.map((request) => ({ text: request.text, locale: request.locale }));
    for (const row of ready) expect(spoken).toContainEqual({ text: shownSentence(row.payload), locale: "en-GB" });
    expect(fakes.tts.requests.some((request) => request.locale !== "en-GB")).toBe(false);
  });

  it("po publikacji i workerze feedback wyboru, luk z bankiem, układanki, luki i tłumaczenia czyta rozwiązane zdanie; pary i grupy bez nagrania", async () => {
    const { services, clock, deckId, draft } = await chapterWorld();
    await publishLessonDraft(services, draft.id, draft.editNumber);
    await runWorker(services);

    const child = await createChild(services, { displayName: "Lektor", avatarKey: "owl" });
    await assign(child.id, deckId);
    const played = await playSessions(services, clock, child.id, deckId, 3);
    const firstOf = (type: string) => played.find((entry) => entry.task.exerciseType === type);

    for (const type of ["lesson_choice", "lesson_cloze", "lesson_order", "lesson_gap"]) {
      const entry = firstOf(type);
      expect(entry, type).toBeDefined();
      expect(entry!.attempt.feedback?.kind, type).toBe("great");
      const payload = (await query<{ payload: Record<string, unknown> }>(
        "select ir.payload from learning_app.item_revisions ir join learning_app.session_tasks st on st.item_revision_id = ir.id where st.id = $1",
        [entry!.task.taskId],
      ))[0]!.payload;
      await expectSentenceReadback(entry!, shownSentence(payload));
      // `targetKey` zadania (i pieczęci odczytu) to klucz zdania, które dziecko widzi rozwiązane —
      // ta sama normalizacja przedmiotu co silnik (kontrakt Etapu 1).
      const seen = solvedSentenceSeen(entry!.task, entry!.key);
      expect(entry!.key.targetKey, `${type}: ${seen}`).toBe(lessonTextTargetKey(services.subjects.getSubject("english_chapter")!, seen));
    }
    // Luki z bankiem: nagranie to dokładnie tekst omówienia (`filledText` klucza zadania).
    const cloze = firstOf("lesson_cloze")!;
    expect((await feedbackAssetOf(cloze.task.taskId))!.text).toBe(cloze.key.filledText);
    expect(solvedSentenceSeen(cloze.task, cloze.key)).toBe(cloze.key.filledText);

    for (const type of ["lesson_match", "lesson_group"]) {
      for (const entry of played.filter((item) => item.task.exerciseType === type)) {
        expect(entry.attempt.feedback?.kind, type).toBe("great");
        expect(entry.attempt.feedback?.correctAudioAssetId, type).toBeUndefined();
        expect(await audioEvents(entry.task.taskId), type).toEqual([]);
      }
    }
    expect(played.some((entry) => entry.task.exerciseType === "lesson_match" || entry.task.exerciseType === "lesson_group")).toBe(true);

    // Błędny wybór pokazuje kanoniczne rozwiązanie — z nagraniem.
    const wrongChild = await createChild(services, { displayName: "Pomyłka", avatarKey: "owl" });
    await assign(wrongChild.id, deckId);
    const session = await startSession(services, { childId: wrongChild.id, deckId, microphoneEnabled: false });
    const task = await skipUntil(services, session.sessionId, "lesson_choice");
    const key = await answerKey(task.taskId);
    const wrong = (task.prompt as { options: { id: string }[] }).options.find((option) => option.id !== key.correctOptionId)!;
    const attempt = await submit(services, task, { modality: "choice", optionId: wrong.id });
    expect(attempt.feedback).toMatchObject({ kind: "incorrect", correctText: (key.optionValues as Record<string, string>)[key.correctOptionId as string] });
    const stem = (task.prompt as { stem: string }).stem;
    await expectSentenceReadback({ task, key, attempt }, stem.replace(/_{2,}/u, attempt.feedback!.correctText!));
  });

  it("tłumaczenie: poprawne i „prawie” z kanoniczną odpowiedzią czytają ją; „prawie” z pokazanym innym wariantem — bez nagrania i bez pieczęci", async () => {
    const { services, clock, deckId, draft } = await chapterWorld();
    await publishLessonDraft(services, draft.id, draft.editNumber);
    await runWorker(services);

    const exact = await createChild(services, { displayName: "Tłumacz", avatarKey: "owl" });
    await assign(exact.id, deckId);
    const exactTask = await dueTranslation(services, clock, exact.id, deckId);
    const exactKey = await answerKey(exactTask.taskId);
    const exactAttempt = await submit(services, exactTask, { modality: "text", text: exactKey.answer as string });
    expect(exactAttempt.feedback?.kind).toBe("great");
    await expectSentenceReadback({ task: exactTask, key: exactKey, attempt: exactAttempt }, exactKey.answer as string);

    // Literówka poza sprawdzanym słowem w odpowiedzi kanonicznej: najbliższy wariant = kanoniczny → odczyt zdania.
    const canonical = await createChild(services, { displayName: "Kanon", avatarKey: "owl" });
    await assign(canonical.id, deckId);
    const canonicalTask = await dueTranslation(services, clock, canonical.id, deckId);
    const canonicalKey = await answerKey(canonicalTask.taskId);
    const canonicalTypo = (canonicalKey.answer as string).replace("wearing", "wearring");
    expect(canonicalTypo).not.toBe(canonicalKey.answer);
    const canonicalAttempt = await submit(services, canonicalTask, { modality: "text", text: canonicalTypo });
    expect(canonicalAttempt.feedback).toMatchObject({ kind: "lesson_almost", correctText: canonicalKey.answer });
    expect(canonicalAttempt.taskState).toBe("answered");
    await expectSentenceReadback({ task: canonicalTask, key: canonicalKey, attempt: canonicalAttempt }, canonicalKey.answer as string);

    const almost = await createChild(services, { displayName: "Prawie", avatarKey: "owl" });
    await assign(almost.id, deckId);
    const almostTask = await dueTranslation(services, clock, almost.id, deckId);
    const almostKey = await answerKey(almostTask.taskId);
    const variant = (almostKey.acceptedAnswers as string[])[0]!;
    expect(variant).not.toBe(almostKey.answer);
    // Literówka poza sprawdzanym słowem w wariancie o innym szyku: najbliższy wariant ≠ kanoniczny.
    const attempt = await submit(services, almostTask, { modality: "text", text: variant.replace("wearing", "wearring") });
    expect(attempt.feedback).toMatchObject({ kind: "lesson_almost", correctText: variant });
    expect(attempt.feedback?.correctAudioAssetId).toBeUndefined();
    expect(attempt.taskState).toBe("answered");
    expect(await audioEvents(almostTask.taskId)).toEqual([]);
    // Nagranie rewizji istnieje — brak w feedbacku wynika z bramki wariantu, nie z braku zasobu.
    expect(await feedbackAssetOf(almostTask.taskId)).not.toBeNull();
    expect((await answerKey(almostTask.taskId)).feedbackAudioAssetId).toBeTruthy();
  });
});
