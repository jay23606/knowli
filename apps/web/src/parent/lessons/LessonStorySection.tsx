"use client";

import { useEffect, useRef } from "react";
import { ActionIcon, Alert, Button, Group, Loader, Paper, Radio, Stack, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { messages, type GenerationDto, type LessonStoryDto } from "@learning/contracts";
import { ParentIcon } from "../ParentIcon";
import { runOnce } from "../run-once";
import {
  addQuestion,
  addSentence,
  emptyStory,
  removeQuestion,
  removeSentence,
  setCorrectOption,
  setOptionText,
  setQuestionText,
  setSentence,
  STORY_FORM_MAX_QUESTIONS,
  STORY_FORM_MAX_SENTENCES,
} from "./lesson-story-form";

const t = messages.lessons.story;
const numbered = (template: string, n: number) => template.replace("{n}", String(n));

/**
 * Sekcja „Historyjka na koniec sesji” w edytorze lekcji: edycja zdań i pytań
 * (szkic), generowanie i ponowienie runu historyjki, usunięcie (`onChange(null)`)
 * oraz podgląd tylko do odczytu w wersji opublikowanej. Stan formularza i zapis
 * należą do edytora; `locked` = niezapisane zmiany albo konflikt wersji.
 * Generowanie, ponowienie porażki i ponowienie zawieszonego runu (`running`)
 * zastępują istniejącą historyjkę, więc wtedy pytają o potwierdzenie.
 */
export default function LessonStorySection({
  story,
  editable,
  errors,
  generation,
  busy,
  locked,
  hasExercises,
  onChange,
  onGenerate,
  onRetry,
}: {
  story: LessonStoryDto | null;
  editable: boolean;
  errors: readonly string[];
  generation: GenerationDto | null;
  busy: boolean;
  locked: boolean;
  /** Szkic ma zapisane ćwiczenia — bez nich serwer odrzuca generowanie (`validation`). */
  hasExercises: boolean;
  onChange(story: LessonStoryDto | null): void;
  onGenerate(): void;
  onRetry(): void;
}) {
  const running = generation?.state === "queued" || generation?.state === "running";
  const stalled = generation?.state === "running";
  const failed = generation?.state === "failed";
  const generateDisabled = busy || locked || running || !hasExercises;

  // okno potwierdzenia nie przeżywa sekcji (powrót do listy, inna lekcja)
  const confirmIds = useRef<string[]>([]);
  useEffect(() => () => {
    for (const id of confirmIds.current) modals.close(id);
  }, []);

  // Wynik runu zastąpi obecną historyjkę (także napisaną ręcznie) — z historyjką najpierw potwierdzenie.
  const confirmReplace = (action: () => void, confirmLabel: string) => {
    if (!story) {
      action();
      return;
    }
    confirmIds.current.push(modals.openConfirmModal({
      title: confirmLabel,
      centered: true,
      radius: "lg",
      children: <Text size="sm">{t.regenerateConfirm}</Text>,
      labels: { confirm: confirmLabel, cancel: messages.lessons.regenerateCancel },
      confirmProps: { size: "md", "data-testid": "lesson-story-regenerate-confirm" } as Record<string, unknown>,
      cancelProps: { size: "md", variant: "default", "data-autofocus": true } as Record<string, unknown>,
      onConfirm: runOnce(action),
    }));
  };
  const generate = () => confirmReplace(onGenerate, t.regenerate);
  const retry = () => confirmReplace(onRetry, t.retry);

  return (
    <Paper component="section" withBorder radius="lg" p="md" data-testid="lesson-story-section" aria-labelledby="lesson-story-title">
      <Stack gap="sm">
        <Title order={2} fz="md" id="lesson-story-title">{t.title}</Title>
        <Text size="sm" className="pp-editor-muted">{t.info}</Text>

        {running && (
          <Alert color="blue" variant="light" icon={<Loader size="xs" />} data-testid="lesson-story-generating">
            <Stack gap="xs" align="flex-start">
              <Text size="sm">{t.generating}</Text>
              {/* run w `running` mógł utknąć po awarii workera — ponowienie zastępuje go nowym runem */}
              {stalled && editable && (
                <>
                  <Text size="sm">{messages.lessons.stalledGenerationHint}</Text>
                  <Button size="md" variant="default" leftSection={<ParentIcon name="refresh" />} data-testid="lesson-story-retry-stalled"
                    disabled={busy || locked} onClick={retry}>
                    {t.retry}
                  </Button>
                </>
              )}
            </Stack>
          </Alert>
        )}
        {failed && (
          <Alert color="red" variant="light" data-testid="lesson-story-failed">
            <Stack gap="xs" align="flex-start">
              <Text size="sm">{t.failed}</Text>
              {editable && (
                <Button size="md" variant="default" leftSection={<ParentIcon name="refresh" />} data-testid="lesson-story-retry"
                  disabled={busy || locked} onClick={retry}>
                  {t.retry}
                </Button>
              )}
            </Stack>
          </Alert>
        )}
        {errors.length > 0 && (
          <Alert color="red" variant="light" data-testid="lesson-story-errors">
            <ul className="pp-lesson-rejected-reasons">
              {errors.map((message, i) => <li key={i}>{message}</li>)}
            </ul>
          </Alert>
        )}

        {!story && <Text size="sm" data-testid="lesson-story-empty">{t.empty}</Text>}
        {/* w trakcie runu historyjki pola są zablokowane: zapis starej edycji nadpisałby świeżo wygenerowaną historyjkę */}
        {story && (editable ? <StoryFields story={story} busy={busy || running} onChange={onChange} /> : <StoryPreview story={story} />)}

        {editable ? (
          <Group gap="sm">
            <Button size="md" variant="light" leftSection={<ParentIcon name={story ? "refresh" : "sparkles"} />}
              data-testid="lesson-story-generate" disabled={generateDisabled} onClick={generate}>
              {story ? t.regenerate : t.generate}
            </Button>
            {story ? (
              <Button size="md" variant="subtle" color="red" data-testid="lesson-story-remove" disabled={busy || running} onClick={() => onChange(null)}>
                {t.remove}
              </Button>
            ) : (
              <Button size="md" variant="subtle" leftSection={<ParentIcon name="pencil" />} data-testid="lesson-story-write"
                disabled={busy || running} onClick={() => onChange(emptyStory())}>
                {t.write}
              </Button>
            )}
          </Group>
        ) : (
          <Text size="sm" className="pp-editor-muted" data-testid="lesson-story-published-hint">{t.publishedHint}</Text>
        )}
      </Stack>
    </Paper>
  );
}

/** Pola historyjki w szkicu: zdania, pytania z trzema odpowiedziami i wyborem poprawnej. */
function StoryFields({ story, busy, onChange }: { story: LessonStoryDto; busy: boolean; onChange(story: LessonStoryDto): void }) {
  return (
    <Stack gap="md">
      <Stack gap="xs">
        {story.sentences.map((sentence, i) => (
          <Group key={i} gap="xs" align="flex-end" wrap="nowrap">
            <TextInput size="md" className="pp-lesson-grow" label={numbered(t.sentenceLabel, i + 1)} value={sentence} disabled={busy}
              data-testid={`lesson-story-sentence-${i}`} onChange={(e) => onChange(setSentence(story, i, e.currentTarget.value))} />
            <ActionIcon variant="subtle" color="gray" size={44} radius="md" disabled={busy || story.sentences.length <= 1}
              aria-label={`${t.removeSentence} ${i + 1}`} data-testid={`lesson-story-sentence-remove-${i}`}
              onClick={() => onChange(removeSentence(story, i))}>
              <ParentIcon name="x" />
            </ActionIcon>
          </Group>
        ))}
        <Button size="md" variant="light" className="pp-lesson-start" leftSection={<ParentIcon name="plus" />}
          data-testid="lesson-story-add-sentence" disabled={busy || story.sentences.length >= STORY_FORM_MAX_SENTENCES}
          onClick={() => onChange(addSentence(story))}>
          {t.addSentence}
        </Button>
      </Stack>

      {story.questions.map((question, qi) => (
        <Paper key={question.id} withBorder radius="md" p="sm" data-testid={`lesson-story-question-card-${question.id}`}>
          <Stack gap="xs">
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <TextInput size="md" className="pp-lesson-grow" label={numbered(t.questionLabel, qi + 1)} value={question.question} disabled={busy}
                data-testid={`lesson-story-question-${question.id}`}
                onChange={(e) => onChange(setQuestionText(story, question.id, e.currentTarget.value))} />
              <ActionIcon variant="subtle" color="gray" size={44} radius="md" disabled={busy || story.questions.length <= 1}
                aria-label={`${t.removeQuestion} ${qi + 1}`} data-testid={`lesson-story-question-remove-${question.id}`}
                onClick={() => onChange(removeQuestion(story, question.id))}>
                <ParentIcon name="x" />
              </ActionIcon>
            </Group>
            <Radio.Group value={question.correctOption} label={t.correctOption}
              onChange={(optionId) => onChange(setCorrectOption(story, question.id, optionId))}>
              <Stack gap="xs" mt={4}>
                {question.options.map((option, oi) => {
                  // nazwa dostępna z numerem pytania: „Pytanie 2, Odpowiedź 1”
                  const optionName = `${numbered(t.questionLabel, qi + 1)}, ${numbered(t.optionLabel, oi + 1)}`;
                  return (
                  <Group key={option.id} gap="sm" wrap="nowrap">
                    <Radio value={option.id} disabled={busy} aria-label={`${t.correctOption}: ${optionName}`}
                      data-testid={`lesson-story-correct-${question.id}-${option.id}`} />
                    <TextInput size="md" className="pp-lesson-grow" aria-label={optionName}
                      placeholder={numbered(t.optionLabel, oi + 1)} value={option.text} disabled={busy}
                      data-testid={`lesson-story-option-${question.id}-${option.id}`}
                      onChange={(e) => onChange(setOptionText(story, question.id, option.id, e.currentTarget.value))} />
                  </Group>
                  );
                })}
              </Stack>
            </Radio.Group>
          </Stack>
        </Paper>
      ))}
      <Button size="md" variant="light" className="pp-lesson-start" leftSection={<ParentIcon name="plus" />}
        data-testid="lesson-story-add-question" disabled={busy || story.questions.length >= STORY_FORM_MAX_QUESTIONS}
        onClick={() => onChange(addQuestion(story))}>
        {t.addQuestion}
      </Button>
    </Stack>
  );
}

/** Podgląd historyjki wersji opublikowanej (bez pól). */
function StoryPreview({ story }: { story: LessonStoryDto }) {
  return (
    <Stack gap="sm">
      <ol className="pp-lesson-examples" data-testid="lesson-story-sentences">
        {story.sentences.map((sentence, i) => <li key={i}>{sentence}</li>)}
      </ol>
      {story.questions.map((question, qi) => (
        <div key={question.id} data-testid={`lesson-story-question-${question.id}`}>
          <Text size="sm" fw={600}>{numbered(t.questionLabel, qi + 1)}: {question.question}</Text>
          <ul className="pp-lesson-examples">
            {question.options.map((option) => (
              <li key={option.id}>
                {option.text}
                {option.id === question.correctOption && (
                  <> <span className="pp-status-badge" data-tone="success">{t.correctOption}</span></>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Stack>
  );
}
