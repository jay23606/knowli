import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { TaskPrompt } from "@learning/contracts";
import type { Executor } from "../../../db/client";
import { lessonStoryAssets, mediaAssets } from "../../../db/schema";
import { lessonTextTargetKey } from "../../../domain/lessons/exposure-key";
import { squashStoryText, type LessonStory } from "../../../domain/lessons/story";
import type { SubjectModule } from "../../../domain/lessons/types";
import type { LessonTrainingSessionPlanSnapshot, LessonTrainingSessionSlot } from "../../../domain/training-session-plan";
import { lessonLocale, seededShuffle } from "./lesson-materialize";

/**
 * Historyjka na końcu sesji lekcji (design „Historyjka lekcji” §8.2–§8.3):
 * sloty `lesson_story` i `lesson_story_question` doklejane do planu sesji po
 * ocenianych slotach. Poza budżetem (`assessed: false`), kotwiczone w rewizji
 * ćwiczenia jak karty. Publiczny prompt nie niesie klucza: opcje pytań dostają
 * nowe UUID, a poprawna opcja i id pytania z wersji żyją wyłącznie w kluczu.
 */

/** Powód slotów historyjki w planie i w kontekście zadania. */
const CLOSING_STORY_REASON = "closing_story";

/**
 * Nagranie lektora historyjki wersji: jak nagrania kart — najnowszy gotowy zasób
 * TTS o oczekiwanym fingerprincie wiersza `lesson_story_assets`, niezależnie od
 * zasobu powiązanego przy edycji (publikacja na nagranie nie czeka). `null`, gdy
 * brak gotowego nagrania.
 */
export async function loadLessonStoryAudio(tx: Executor, deckVersionId: string): Promise<string | null> {
  const [row] = await tx
    .select({ assetId: mediaAssets.id })
    .from(lessonStoryAssets)
    .innerJoin(mediaAssets, eq(mediaAssets.fingerprint, lessonStoryAssets.expectedFingerprint))
    .where(and(eq(lessonStoryAssets.deckVersionId, deckVersionId), eq(mediaAssets.kind, "tts"), eq(mediaAssets.state, "ready")))
    .orderBy(desc(mediaAssets.generationNumber))
    .limit(1);
  return row?.assetId ?? null;
}

export interface LessonStorySlotsInput {
  story: LessonStory;
  subject: Pick<SubjectModule, "id" | "answerLocale" | "normalizeExposureText">;
  /** Rewizja ćwiczenia, do której przypięte są zadania historyjki (jak karty). */
  anchor: { itemId: string; revisionId: string };
  audioAssetId: string | null;
  /** Ordinal pierwszego slotu historyjki = liczba wcześniejszych slotów planu. */
  firstOrdinal: number;
  newTaskId?: () => string;
  /**
   * Ziarno kolejności opcji pytania. Domyślnie z losowym składnikiem: ziarno
   * wyliczalne z publicznego `taskId` zdradzałoby pozycję poprawnej opcji.
   * Kolejność zamraża plan, więc ponowny odczyt zadania jest stabilny.
   */
  shuffleSeed?: (taskId: string) => string;
}

/**
 * Sloty historyjki: najpierw tekst, potem po jednym pytaniu w kolejności
 * historyjki. Każdy slot ujawnia klucze zdań (prompt pytania znowu pokazuje
 * tekst), nigdy klucze ćwiczeń.
 */
export function lessonStorySlots(input: LessonStorySlotsInput): LessonTrainingSessionSlot[] {
  const { story, subject, anchor, audioAssetId, firstOrdinal } = input;
  const newTaskId = input.newTaskId ?? randomUUID;
  const shuffleSeed = input.shuffleSeed ?? ((taskId: string) => `${taskId}:${randomUUID()}`);
  const sentences = story.sentences.map(squashStoryText);
  const revealsTargetKeys = [...new Set(sentences.map((sentence) => lessonTextTargetKey(subject, sentence)))];
  const locale = lessonLocale(subject.answerLocale);
  const shared = {
    ...(locale ? { contentLocale: locale } : {}),
    ...(audioAssetId ? { questionAudioAssetId: audioAssetId } : {}),
  };
  const common = {
    itemId: anchor.itemId, itemRevisionId: anchor.revisionId, direction: null, assessed: false, reason: CLOSING_STORY_REASON,
  } as const;

  const storyPrompt: TaskPrompt = { kind: "lesson_story", story: { sentences }, ...shared };
  const slots: LessonTrainingSessionSlot[] = [{
    ...common,
    taskId: newTaskId(),
    ordinal: firstOrdinal,
    exerciseType: "lesson_story",
    taskKind: "story",
    prompt: storyPrompt,
    answerKey: { exerciseType: "lesson_story", subjectId: subject.id },
    context: { reason: CLOSING_STORY_REASON },
    revealsTargetKeys: [...revealsTargetKeys],
  }];
  for (const question of story.questions) {
    const taskId = newTaskId();
    const options = seededShuffle(
      question.options.map((option) => ({ id: randomUUID(), text: option.text, correct: option.id === question.correctOption })),
      shuffleSeed(taskId),
    );
    const correct = options.find((option) => option.correct)!;
    const prompt: TaskPrompt = {
      kind: "lesson_story_question",
      question: question.question,
      options: options.map((option) => ({ id: option.id, text: option.text })),
      story: { sentences },
      ...shared,
    };
    slots.push({
      ...common,
      taskId,
      ordinal: firstOrdinal + slots.length,
      exerciseType: "lesson_story_question",
      taskKind: "story_question",
      prompt,
      answerKey: {
        exerciseType: "lesson_story_question",
        subjectId: subject.id,
        storyQuestionId: question.id,
        correctOptionId: correct.id,
        optionValues: Object.fromEntries(options.map((option) => [option.id, option.text])),
      },
      context: { reason: CLOSING_STORY_REASON, storyQuestionId: question.id },
      revealsTargetKeys: [...revealsTargetKeys],
    });
  }
  return slots;
}

/** Czy plan sesji kończy się historyjką. */
export function planHasClosingStory(plan: LessonTrainingSessionPlanSnapshot | null): boolean {
  return plan?.slots.some((slot) => slot.taskKind === "story") ?? false;
}
