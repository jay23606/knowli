import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  MockTestReportDtoSchema,
  type MockTestReportDto,
  DisclosureInputSchema,
  EventInputSchema,
  SessionSummaryDtoSchema,
  type DisclosureDto,
  type DisclosureInput,
  type EventInput,
  type SessionSummaryDto,
} from "@learning/contracts";
import type { Services } from "../../config";
import type { Tx } from "../../db/client";
import {
  deckVersions,
  decks,
  childProfiles,
  childTargetExposures,
  eventExposures,
  itemRevisions,
  learningEvents,
  learningSessions,
  mediaAssets,
  revisionAssets,
  sessionTasks,
} from "../../db/schema";
import { AppError } from "../../errors";
import { computeTargetKey } from "../../domain/target-key";

export interface SessionContextShape {
  canRead: boolean;
  vocabularyFormat: "standard" | "picture";
  supportsPictureVocabulary?: boolean;
  /** Klient obsługuje `picture_recognition`; brak/null = starszy klient (graceful). */
  supportsPictureRecognition?: boolean;
  microphoneDisabledTaskIds: string[];
  mockTestReport?: MockTestReportDto;
  timezone: string;
  /** Data sprawdzianu przypięta przy rozpoczęciu nowej sesji; brak w legacy. */
  testDate?: string | null;
  previousContact: Record<string, string>;
  /** Klucze celów objęte aktywną rezerwacją należnego sprawdzenia. */
  reservations: string[];
  /** Klucze sprawdzeń rozliczonych w tej sesji (odpowiedź/pominięcie/podpowiedź). */
  settledChecks: string[];
  /** Niezmienny wynik jawnego zakończenia, zachowany także przy spóźnionej finalizacji mowy. */
  summary?: SessionSummaryDto;
}

export function contextOf(session: { context: Record<string, unknown> }): SessionContextShape {
  const raw = session.context as Partial<SessionContextShape>;
  const summary = SessionSummaryDtoSchema.safeParse(raw.summary);
  const report = MockTestReportDtoSchema.safeParse(raw.mockTestReport);
  return {
    canRead: raw.canRead ?? true,
    vocabularyFormat: raw.vocabularyFormat === "picture" ? "picture" : "standard",
    supportsPictureVocabulary: raw.supportsPictureVocabulary === true,
    supportsPictureRecognition: raw.supportsPictureRecognition === true,
    microphoneDisabledTaskIds: Array.isArray(raw.microphoneDisabledTaskIds)
      ? raw.microphoneDisabledTaskIds.filter((id): id is string => typeof id === "string")
      : [],
    timezone: typeof raw.timezone === "string" ? raw.timezone : "Europe/Warsaw",
    ...(typeof raw.testDate === "string" || raw.testDate === null ? { testDate: raw.testDate } : {}),
    previousContact: raw.previousContact ?? {},
    reservations: raw.reservations ?? [],
    settledChecks: raw.settledChecks ?? [],
    ...(summary.success ? { summary: summary.data } : {}),
    ...(report.success ? { mockTestReport: report.data } : {}),
  };
}

/** Rodzaje zdarzeń pisanych wyłącznie przez serwer (arch §9.2). */
export type ServerEventKind =
  | "contact"
  | "prompt_issued"
  | "audio_issued"
  | "hint_issued"
  | "feedback_issued"
  | "presentation_completed";

export interface SealedEventInput {
  childId: string;
  taskId: string;
  itemId: string;
  kind: ServerEventKind;
  stepId: string;
  occurredAt: Date;
  clientEventId?: string;
  /** Klucze ujawnianych celów — komplet przed jakąkolwiek odpowiedzią HTTP. */
  exposures: readonly string[];
}

/**
 * Zapisuje zdarzenie z kompletem ekspozycji i pieczęcią w jednej transakcji:
 * insert (sealed=false) → event_exposures → jedna instrukcja CTE z przejściem
 * sealed=true i upsertem child_target_exposures. Dopiero commit zwalnia
 * odpowiedź HTTP — utracona odpowiedź sieciowa nie usuwa ujawnienia. Kolejność
 * pierwszych dwóch instrukcji wymuszają triggery guard_event_seal
 * i guard_exposure_insert (migracja 0001).
 */
export async function writeSealedEvent(tx: Tx, input: SealedEventInput): Promise<void> {
  const eventId = randomUUID();
  await tx.insert(learningEvents).values({
    id: eventId,
    childId: input.childId,
    taskId: input.taskId,
    itemId: input.itemId,
    clientEventId: input.clientEventId ?? null,
    sealed: false,
    stepId: input.stepId,
    kind: input.kind,
    occurredAt: input.occurredAt,
    context: {},
  });
  const exposures = [...new Set(input.exposures)];
  if (exposures.length > 0) {
    await tx.insert(eventExposures).values(
      exposures.map((targetKey) => ({ childId: input.childId, eventId, targetKey })),
    );
  }
  if (exposures.length === 0) {
    await tx.update(learningEvents).set({ sealed: true }).where(eq(learningEvents.id, eventId));
  } else {
    // Pieczęć i upsert child_target_exposures w jednej instrukcji (CTE z UPDATE):
    // trigger guard_event_seal wymaga dokładnie jednego przejścia sealed=false→true,
    // a guard_exposure_insert wpuszcza ekspozycje tylko do niezapieczętowanego
    // zdarzenia — dlatego insert zdarzenia i ekspozycji muszą zostać osobnymi
    // instrukcjami jak dotąd; łączymy tylko dwa ostatnie zapisy (4 → 3 instrukcje).
    const occurredAt = input.occurredAt.toISOString();
    await tx.execute(sql`
      with sealed_ev as (
        update ${learningEvents} set "sealed" = true where "id" = ${eventId} returning "id"
      )
      insert into ${childTargetExposures}
        ("child_id", "target_key", "first_exposure_at", "last_exposure_at")
      select ${input.childId}, unnest(${sql.param(exposures)}::text[]),
             ${occurredAt}::timestamptz, ${occurredAt}::timestamptz
      on conflict ("child_id", "target_key") do update
        set "first_exposure_at" = least("child_target_exposures"."first_exposure_at", excluded.first_exposure_at),
            "last_exposure_at" = greatest("child_target_exposures"."last_exposure_at", excluded.last_exposure_at)
    `);
  }
}

/**
 * Pieczęć odsłuchu rozwiązania ujawnionego w feedbacku po odpowiedzi
 * (`picture_recognition` słówek, zdanie lekcji gramatyki): `audio_issued`
 * z ekspozycją celu w tej samej transakcji co feedback, przed odpowiedzią HTTP
 * (arch §9.2). Odsłuch następuje PO odpowiedzi: czytniki liczą audio
 * z occurredAt <= receivedAt jako wsparcie przed próbą, a w ścieżce świeżej
 * próby `now` równa się receivedAt — stąd znacznik ściśle późniejszy (issue #187).
 */
export async function sealPostAnswerAudio(
  tx: Tx,
  input: { childId: string; taskId: string; itemId: string; targetKey: string; receivedAt: Date; now: Date },
): Promise<void> {
  const disclosedAt = new Date(Math.max(input.now.getTime(), input.receivedAt.getTime() + 1));
  const prior = await tx
    .select({ id: learningEvents.id })
    .from(learningEvents)
    .where(and(eq(learningEvents.taskId, input.taskId), inArray(learningEvents.kind, ["audio_issued", "hint_issued"])));
  await writeSealedEvent(tx, {
    childId: input.childId,
    taskId: input.taskId,
    itemId: input.itemId,
    kind: "audio_issued",
    stepId: `${input.taskId}:d${prior.length + 1}`,
    occurredAt: disclosedAt,
    exposures: [input.targetKey],
  });
}

/** Zadanie + blokada wiersza jego sesji — wspólna kolejność dla wszystkich operacji. */
export async function lockTaskWithSession(tx: Tx, taskId: string) {
  // Jedno zapytanie z joinami daje zadanie oraz dane rewizji i rodzaj zestawu,
  // po które gorące ścieżki prób sięgały osobnymi zapytaniami (itemId,
  // targetKey, locale wersji, payload rewizji, decks.kind).
  const joined = (
    await tx
      .select({
        task: sessionTasks,
        itemId: itemRevisions.itemId,
        targetKey: itemRevisions.targetKey,
        revisionPayload: itemRevisions.payload,
        targetLocale: deckVersions.targetLocale,
        lessonContext: deckVersions.lessonContext,
        deckKind: decks.kind,
      })
      .from(sessionTasks)
      .innerJoin(itemRevisions, eq(itemRevisions.id, sessionTasks.itemRevisionId))
      .innerJoin(deckVersions, eq(deckVersions.id, itemRevisions.deckVersionId))
      .innerJoin(decks, eq(decks.id, deckVersions.deckId))
      .where(eq(sessionTasks.id, taskId))
  )[0];
  if (!joined) {
    throw new AppError("not_found");
  }
  const { task } = joined;
  // Take the FK-compatible child lock before the session, including when a
  // concurrent profile deletion is about to cascade into its sessions.
  await tx.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.id, task.childId)).for("key share");
  const session = (
    await tx.select().from(learningSessions).where(eq(learningSessions.id, task.sessionId)).for("update")
  )[0]!;
  // Stan zadania mógł zmienić się podczas oczekiwania na wspólną blokadę.
  // Snapshot treści jest niezmienny, ale drugi klient musi zobaczyć terminalny stan.
  const freshTask = (await tx.select().from(sessionTasks).where(eq(sessionTasks.id, taskId)))[0]!;
  return {
    task: freshTask,
    session,
    itemId: joined.itemId,
    targetKey: joined.targetKey,
    revisionPayload: joined.revisionPayload,
    targetLocale: joined.targetLocale,
    lessonContext: joined.lessonContext,
    deckKind: joined.deckKind,
  };
}

/** Obserwacja klienta (display_confirmed/audio_played) — opcjonalna, idempotentna. */
export async function recordEvent(services: Services, input: EventInput): Promise<void> {
  const valid = EventInputSchema.parse(input);
  await services.db.transaction(async (tx) => {
    const task = (await tx.select().from(sessionTasks).where(eq(sessionTasks.id, valid.taskId)))[0];
    if (!task) {
      throw new AppError("not_found");
    }
    const revision = (
      await tx.select({ itemId: itemRevisions.itemId }).from(itemRevisions).where(eq(itemRevisions.id, task.itemRevisionId))
    )[0]!;
    await tx
      .insert(learningEvents)
      .values({
        id: randomUUID(),
        childId: task.childId,
        taskId: task.id,
        itemId: revision.itemId,
        clientEventId: valid.clientEventId,
        sealed: true,
        stepId: valid.stepId ?? `${task.id}:observation`,
        kind: valid.kind,
        occurredAt: services.clock.now(),
        context: {},
      })
      .onConflictDoNothing({ target: [learningEvents.childId, learningEvents.clientEventId] });
  });
}

/** Kolejny krok ujawnienia zadania (`<taskId>:dN`): liczy wcześniejsze `audio_issued` i `hint_issued`. */
async function nextDisclosureStepId(tx: Tx, taskId: string): Promise<string> {
  const prior = await tx
    .select({ id: learningEvents.id })
    .from(learningEvents)
    .where(and(eq(learningEvents.taskId, taskId), inArray(learningEvents.kind, ["audio_issued", "hint_issued"])));
  return `${taskId}:d${prior.length + 1}`;
}

/**
 * Wydaje podpowiedź albo autoryzuje odtworzenie wzorca (arch §9.2). Serwer
 * określa stepId i zapisuje ekspozycję celu przed zwroceniem zgody; przeglądarka
 * nie odtwarza wzorca z cache bez tego potwierdzenia. Ponowne wywołanie
 * (reload, retry) rejestruje nowy czas możliwej ekspozycji.
 */
export async function authorizeDisclosure(services: Services, input: DisclosureInput): Promise<DisclosureDto> {
  const valid = DisclosureInputSchema.parse(input);
  return services.db.transaction(async (tx) => {
    const { task, session, itemId } = await lockTaskWithSession(tx, valid.taskId);
    if (session.state !== "active") {
      throw new AppError("conflict", { message: "session is closed" });
    }
    if (task.state !== "issued") {
      throw new AppError("conflict", { message: "task is no longer issued" });
    }
    if (session.mode === "mock_test" && (valid.kind === "hint" || task.exerciseType !== "listening")) {
      throw new AppError("conflict", { message: "Odpowiedzi omówimy po zakończeniu kartkówki." });
    }
    // Odsłuch lekcji jest dozwolony WYŁĄCZNIE dla typów tekstowych (wym. 4.6,
    // design.md „Odsłuch w zadaniach tekstowych lekcji = wsparcie”). Dla typów
    // zamkniętych kanoniczne audio zdradziłoby właściwą opcję/kolejność i obeszło
    // deterministyczną ocenę po identyfikatorach — odmawiamy, nawet gdyby klient
    // zażądał odsłuchu dla takiego zadania.
    const LESSON_AUDIO_TEXT_TYPES = new Set(["lesson_gap", "lesson_error_fix", "lesson_transform", "lesson_open_answer"]);
    // Wyjątek: „Posłuchaj i wybierz” (`lesson_listen_choice`) ma własną gałąź niżej —
    // odsłuch zdania jest tam bodźcem, a nie wsparciem zdradzającym odpowiedź.
    const isListenChoice = task.exerciseType === "lesson_listen_choice";
    // Podpowiedź zadania słuchowego ujawniłaby brakujące słowo (`reveal.target` = odpowiedź).
    if (isListenChoice && valid.kind === "hint") {
      throw new AppError("conflict", { message: "zadanie słuchowe nie oferuje podpowiedzi" });
    }
    if (
      valid.kind === "audio" &&
      (task.exerciseType as string).startsWith("lesson_") &&
      !isListenChoice &&
      !LESSON_AUDIO_TEXT_TYPES.has(task.exerciseType)
    ) {
      throw new AppError("conflict", { message: "to zadanie lekcji nie oferuje odsłuchu" });
    }

    const revision = (
      await tx
        .select({ payload: itemRevisions.payload, targetLocale: deckVersions.targetLocale, dbTargetKey: itemRevisions.targetKey,
          lessonContext: deckVersions.lessonContext })
        .from(itemRevisions)
        .innerJoin(deckVersions, eq(deckVersions.id, itemRevisions.deckVersionId))
        .where(eq(itemRevisions.id, task.itemRevisionId))
    )[0]!;
    // Słówka: payload ma `target`. Lekcja: ćwiczenie ma `answer` (payload) i
    // `targetKey` (answer_key/rewizja); rozwiązaniem pokazywanym dziecku jest
    // odpowiedź kanoniczna, a klucz ekspozycji to `target_key` ćwiczenia.
    const payload = revision.payload as { target?: string; answer?: string };
    const isLesson = (task.exerciseType as string).startsWith("lesson_");
    if (isListenChoice && valid.kind === "audio") {
      // Bodziec zadania słuchowego (spec §7.3): zapieczętowane `audio_issued` z
      // ekspozycją celu i pełnego zdania PRZED zwróceniem id nagrania. Bez
      // `ttsForAnswers`, rezerwacji i `spoilsCheck` — odsłuch jest istotą zadania.
      const subjectId = (revision.lessonContext as { subjectId?: string } | null)?.subjectId;
      if (!subjectId || services.subjects.getSubject(subjectId)?.ttsForFeedbackSentence !== true) {
        throw new AppError("conflict", { message: "ten przedmiot nie oferuje odsłuchu zdania" });
      }
      const key = task.answerKey as { targetKey?: string; sentenceTargetKey?: string; feedbackAudioAssetId?: string };
      if (!key.feedbackAudioAssetId) {
        throw new AppError("conflict", { message: "zadanie nie ma nagrania zdania" });
      }
      const listenTargetKey = key.targetKey ?? revision.dbTargetKey;
      const listenStepId = await nextDisclosureStepId(tx, task.id);
      await writeSealedEvent(tx, {
        childId: task.childId,
        taskId: task.id,
        itemId,
        kind: "audio_issued",
        stepId: listenStepId,
        occurredAt: services.clock.now(),
        exposures: [...new Set([listenTargetKey, ...(key.sentenceTargetKey ? [key.sentenceTargetKey] : [])])],
      });
      return { taskId: task.id, stepId: listenStepId, kind: "audio", reveal: null, audioAssetId: key.feedbackAudioAssetId };
    }
    if (isLesson && valid.kind === "audio") {
      const subjectId = (revision.lessonContext as { subjectId?: string } | null)?.subjectId;
      if (!subjectId || services.subjects.getSubject(subjectId)?.ttsForAnswers !== true) {
        throw new AppError("conflict", { message: "ten przedmiot nie oferuje odsłuchu" });
      }
    }
    const target = isLesson ? (payload.answer ?? "") : (payload.target ?? "");
    const targetKey = isLesson
      ? ((task.answerKey as { targetKey?: string }).targetKey ?? revision.dbTargetKey)
      : computeTargetKey(target, revision.targetLocale);
    const pictureRecall = (task.publicPrompt as { kind?: string }).kind === "picture_recall";
    const pictureAudio = pictureRecall
      ? (await tx.select({ id: revisionAssets.assetId })
          .from(revisionAssets)
          .innerJoin(mediaAssets, eq(mediaAssets.id, revisionAssets.assetId))
          .where(and(
            eq(revisionAssets.itemRevisionId, task.itemRevisionId),
            eq(revisionAssets.role, "target_audio"),
            eq(revisionAssets.state, "approved"),
            eq(mediaAssets.kind, "tts"),
            eq(mediaAssets.state, "ready"),
          )))[0]?.id
      : undefined;
    if (pictureRecall && !pictureAudio) {
      throw new AppError("validation", { details: { reason: "picture_audio_unavailable" } });
    }

    const stepId = await nextDisclosureStepId(tx, task.id);
    const now = services.clock.now();

    await writeSealedEvent(tx, {
      childId: task.childId,
      taskId: task.id,
      itemId,
      kind: valid.kind === "audio" ? "audio_issued" : "hint_issued",
      stepId,
      occurredAt: now,
      exposures: [targetKey],
    });

    // Podpowiedź zawsze ujawnia rozwiązanie, a odsłuch wzorca psuje samodzielność
    // przypomnienia/pisowni — rezerwacja należnego sprawdzenia jest zwalniana,
    // żeby cel mógł wrócić jako dystraktor, a sprawdzenie nie było wydawane
    // ponownie w tej sesji (arch §9.3).
    const spoilsCheck =
      valid.kind === "hint" || ["recall", "spelling", "letter_completion"].includes(task.exerciseType);
    if (spoilsCheck) {
      const context = contextOf(session);
      const reservations = context.reservations.filter((k) => k !== targetKey);
      const settledChecks = [...new Set([...context.settledChecks, targetKey])];
      if (reservations.length !== context.reservations.length || settledChecks.length !== context.settledChecks.length) {
        await tx
          .update(learningSessions)
          .set({ context: { ...session.context, reservations, settledChecks } as unknown as Record<string, unknown> })
          .where(eq(learningSessions.id, session.id));
      }
    }

    return {
      taskId: task.id,
      stepId,
      kind: valid.kind,
      reveal: valid.kind === "hint" && !pictureRecall ? { target } : null,
      ...(pictureAudio ? { audioAssetId: pictureAudio } : {}),
    };
  });
}
