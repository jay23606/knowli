import { useEffect, useRef } from "react";
import { messages } from "@learning/contracts";
import { ActionButton } from "../../components/ActionButton";
import { AnswerGrid } from "../../components/AnswerGrid";
import { ExerciseFrame } from "../ExerciseFrame";
import type { ExerciseProps } from "../types";
import { useChoiceKeyboard } from "../useChoiceKeyboard";
import { splitGap } from "./gap";

/**
 * „Posłuchaj i wybierz” (`lesson_listen_choice`): lektor czyta zdanie z luką,
 * dziecko wybiera brakujące słowo. Przycisk odsłuchu stoi w poleceniu; opcje są
 * nieaktywne, dopóki kontroler sesji nie zgłosi `open` (koniec pierwszego
 * odsłuchu) — brak stanu traktujemy jak `pending` (fail closed), bo bez
 * wydanego nagrania odpowiedź byłaby nieoceniona. Po odpowiedzi ten sam
 * przycisk odtwarza nagranie z feedbacku (`feedbackAudio`), jeśli jest.
 */
export function LessonListenChoiceView({ task, busy, optionOutcomes, dock, feedbackAudio, listenStimulus, handlers }: ExerciseProps) {
  const prompt = task.prompt.kind === "lesson_listen_choice" ? task.prompt : null;
  const options = prompt ? prompt.options : [];
  const playRef = useRef<HTMLButtonElement>(null);
  const state = listenStimulus?.state ?? "pending";
  const optionsLocked = busy || state !== "open";
  // Odsłuch jest wyłączony tylko w trakcie wysyłania odpowiedzi i po niej bez nagrania w feedbacku.
  const playDisabled = busy && !feedbackAudio;
  const onPlay = feedbackAudio?.onPlay ?? handlers.onPlay;
  const optionRefs = useChoiceKeyboard({
    options,
    busy: optionsLocked,
    playBusy: playDisabled,
    onChoice: handlers.onAnswerChoice,
    onPlay,
    // Spacja na innym przycisku („Pomiń”, „Dalej”) zostaje temu przyciskowi.
    playRef,
  });

  useEffect(() => {
    if (task.prompt.kind === "lesson_listen_choice") playRef.current?.focus({ preventScroll: true });
  }, [task.taskId, task.prompt.kind]);

  if (task.prompt.kind !== "lesson_listen_choice") return null;
  const { before, after, hasGap } = splitGap(task.prompt.stem);

  return (
    <ExerciseFrame
      task={task}
      feedbackLayout="flow"
      instructionAudio={{
        ref: playRef,
        disabled: playDisabled,
        onPlay,
        label: messages.kid.listenExample,
        playing: listenStimulus?.playing === true,
        attention: state === "blocked",
      }}
      content={(
        <>
          <p className="kid-lesson-stem" data-testid="kid-lesson-stem" lang={task.prompt.contentLocale}>
            {before}
            {hasGap && (
              <span className="kid-listen-gap" role="img" lang="pl-PL" aria-label={messages.kid.lessonListenGap} data-testid="kid-listen-gap" />
            )}
            {after}
          </p>
          <AnswerGrid
            className="kid-options"
            options={options.map((option) => ({ id: option.id, label: option.text, content: null }))}
            outcomes={optionOutcomes}
            disabled={optionsLocked}
            optionRefs={optionRefs}
            optionLang={task.prompt.contentLocale}
            onChoose={handlers.onAnswerChoice}
          />
          {/* Status zawsze zamontowany (żywy region istnieje przed treścią), pusty poza blokadą. Stoi pod
              opcjami: pojawienie się tekstu nie przesuwa zdania ani opcji, a pusty nie zabiera wysokości,
              więc dok wyniku nie zabiera ramie odstępu od góry. */}
          <p className="kid-hint kid-listen-status" role="status" data-testid="kid-listen-status">
            {state === "blocked" ? messages.kid.listenStimulusBlocked : ""}
          </p>
        </>
      )}
      dock={dock}
      secondaryActions={state === "unavailable" && (
        <div className="kid-secondary-actions">
          <ActionButton priority="secondary" fullWidth={false} size="sm" type="button" data-testid="kid-listen-skip" disabled={busy} onClick={handlers.onSkip}>
            {messages.kid.skip}
          </ActionButton>
        </div>
      )}
    />
  );
}
