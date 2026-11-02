import { useEffect, useRef, useState } from "react";
import { messages, type UiAudioKey } from "@learning/contracts";
import { ExerciseView } from "../exercises/ExerciseView";
import type { ExerciseHandlers } from "../exercises/types";
import { optionOutcomes, type OptionOutcome } from "../exercises/option-outcome";
import { format } from "../format";
import { AnswerFeedbackActions, AnswerFeedbackContent, AnswerFeedbackSecondaryActions, feedbackTone } from "./AnswerFeedback";
import { ExerciseFeedbackDock, type FeedbackDockSentenceAudio, type FeedbackDockTone } from "./ExerciseFeedbackDock";
import { ExerciseFrame } from "../exercises/ExerciseFrame";
import { ExerciseGuidanceProvider } from "../exercises/exercise-guidance";
import { KidIcon } from "../components/KidIcon";
import { ListenButton } from "../components/ListenButton";
import { GuidanceButton } from "../components/GuidanceButton";
import { QuestionAudioButton } from "../components/QuestionAudioButton";
import { MeaningVisualView } from "../visuals/MeaningVisualView";
import { SpeechFeedbackActions, SpeechFeedbackContent, SpeechFeedbackReferenceAction, SpeechFeedbackSecondaryActions } from "./SpeechFeedbackCard";
import { lessonFeedbackView } from "./lesson-feedback-view";
import { describeSpeechFeedback } from "./speech-feedback-view";
import { isLessonTask, questionAudioOf, type LearningSessionController, type LearningScreen as LearningScreenState } from "../session/session-controller";
import { useFeedbackCooldown } from "./useFeedbackCooldown";
import { SessionProgress } from "../components/SessionProgress";
import { advanceSessionProgress, initialSessionProgress, progressAttempt, progressDone, resultOutcome } from "../components/session-progress-state";
import { kidStreakLength } from "../motion/kid-motion";
import { TaskTransition } from "../motion/TaskTransition";
import { ActionButton } from "../components/ActionButton";
import { IconActionButton } from "../components/IconActionButton";
import { EndSessionConfirm } from "../components/EndSessionConfirm";

/** Brak podświetleń poza feedbackem próby wyboru. */
const EMPTY_OUTCOMES: ReadonlyMap<string, OptionOutcome> = new Map();

function RevealActions({ onConfirm, busy }: { onConfirm: () => void; busy: boolean }) {
  const { buttonRef, onKeyDown } = useFeedbackCooldown<HTMLButtonElement>(onConfirm, [], true);
  return (
    <ActionButton
      ref={buttonRef}
      onKeyDown={onKeyDown}
      type="button"
      className="kid-primary"
      data-testid="kid-next"
      idleNudge
      disabled={busy}
      onClick={onConfirm}
    >
      {messages.kid.understand}
    </ActionButton>
  );
}

function answerDockTone(dto: Parameters<typeof feedbackTone>[0]): FeedbackDockTone {
  switch (dto?.kind) {
    case "great":
    case "capitalization_hint":
    case "lesson_precision_hint": return "correct";
    case "incorrect": return "incorrect";
    case "almost":
    case "spelling_hint":
    case "lesson_almost":
    case "lesson_hint": return "partial";
    case "not_assessed": return "technical";
    default: return "neutral";
  }
}

/**
 * Ekran nauki: jedno jasne zadanie na ekranie. Po utracie sieci treść
 * zadania znika (ukrycie wzorców), odsłuchy i oceniane próby są zablokowane,
 * a sukces może pochodzić wyłącznie z odpowiedzi serwera (plan zadania 9).
 * Wynik próby pokazuje wspólny dock w stopce ramy — bodziec i odpowiedzi
 * nie zmieniają miejsca po ocenie.
 */
export function LearnScreen({
  screen,
  controller,
}: {
  screen: LearningScreenState;
  controller: LearningSessionController;
}) {
  const { task, offline, busy } = screen;
  const [letterDraft, setLetterDraft] = useState<{ taskId: string; letters: Record<number, string> } | null>(null);
  // ✕ w nagłówku pyta przed zakończeniem; „Koniec” w komunikatach o błędzie audio kończy od razu.
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const endButtonRef = useRef<HTMLButtonElement>(null);
  const openEndConfirm = () => {
    controller.holdForEndConfirm();
    setEndConfirmOpen(true);
  };
  const closeEndConfirm = () => {
    controller.releaseEndConfirm();
    setEndConfirmOpen(false);
    endButtonRef.current?.focus({ preventScroll: true });
  };
  // The panel closes before ending, so a failed /end shows its error and retry.
  const confirmEnd = () => {
    controller.releaseEndConfirm();
    setEndConfirmOpen(false);
    void controller.endNow();
  };
  // Leaving the session screen with the panel open must not keep auto-capture held.
  useEffect(() => () => controller.releaseEndConfirm(), [controller]);
  const activeLetterDraft = task?.prompt.kind === "letter_completion" && letterDraft?.taskId === task.taskId
    ? letterDraft.letters
    : {};
  const remaining = controller.remainingFor(task);
  const taskGuidanceKey: UiAudioKey | null = task?.prompt.kind === "picture_exposure" ? "exposure"
    : task?.prompt.kind === "picture_listening" ? "listening"
      : task?.prompt.kind === "picture_speech" ? "speech"
        : task?.prompt.kind === "picture_recall" ? "recall" : null;
  const feedback = screen.feedback;
  const feedbackGuidanceKey: UiAudioKey | null = feedback === null ? null
    : feedback.modality === "skip" ? "skip"
      : feedback.modality === "dont_remember" ? "dont_remember"
        : feedback.dto?.kind === "great" || feedback.dto?.kind === "capitalization_hint" || feedback.dto?.kind === "content_matched" || feedback.dto?.kind === "lesson_precision_hint" ? "correct"
          : feedback.dto?.kind === "almost" || feedback.dto?.kind === "spelling_hint" || feedback.dto?.kind === "lesson_almost" || feedback.dto?.kind === "lesson_hint" ? "partial"
            : feedback.dto?.kind === "incorrect" ? "incorrect" : "unevaluated";
  const instructionAudioKey = feedbackGuidanceKey ?? taskGuidanceKey;
  // Odczyt pełnego zdania w doku lekcji (zwykłe tempo i żółw); obok niego
  // komunikat dostaje „?”, nie drugi głośnik — tak samo zawsze przy głośniku
  // polecenia „Posłuchaj i wybierz” (także po „Pomiń”, gdy feedback nie ma odczytu).
  // Stan odtwarzania i błędu trzyma kontroler, bo autoodczyt startuje bez kliknięcia.
  const sentenceReadback = feedback !== null && feedback.modality !== "audio" && isLessonTask(task) && feedback.dto?.correctAudioAssetId !== undefined;
  // „Posłuchaj i wybierz”: odczyt zdania odtwarza przycisk w poleceniu (bez drugiego głośnika w doku).
  const listenChoice = task?.prompt.kind === "lesson_listen_choice";
  const sentenceAudio: FeedbackDockSentenceAudio | null = sentenceReadback && !listenChoice && feedback !== null
    ? {
        playing: feedback.sentencePlaying ?? null,
        error: feedback.sentenceAudioError ?? null,
        // Te same warunki co strażnik kontrolera (`#playSentence`) i odsłuch pytania.
        disabled: busy || offline || screen.recordingPhase !== "idle",
        onPlay: (rate) => void controller.playSentenceAudio(rate),
      }
    : null;
  const guidanceButton = instructionAudioKey
    ? <GuidanceButton audioKey={instructionAudioKey} onPlay={(key) => controller.playGuidance(key)} testId="kid-guidance-play" showError={false}
        {...(sentenceReadback || listenChoice ? { icon: "question" as const } : {})} />
    : null;
  // W wierszu instrukcji obok odsłuchu słowa: obrysowany „?”, nie drugi głośnik.
  const instructionGuidanceButton = instructionAudioKey
    ? <GuidanceButton audioKey={instructionAudioKey} onPlay={(key) => controller.playGuidance(key)} testId="kid-guidance-play" showError={false} placement="instruction" />
    : null;
  // Komunikaty błędu z akcjami (audio zadania / instrukcji) rozpychają pasek
  // statusu i włączają przewijanie ramy ćwiczenia — styluje to styles.css.
  // „Posłuchaj pytania” (design szkoły §11.4) w tym samym miejscu co odsłuch polecenia;
  // karta nauki stawia go w nagłówku za tytułem jako „Posłuchaj karty” (§12.4).
  const questionAudioButton = task !== null && questionAudioOf(task) !== null
    ? <QuestionAudioButton key={task.taskId} onPlay={() => controller.playQuestionAudio()}
        label={task.prompt.kind === "lesson_card" ? messages.kid.listenLessonCard : messages.kid.listenLessonQuestion}
        disabled={offline || busy || screen.processing || screen.recordingPhase !== "idle"} />
    : null;
  const questionAudioError = questionAudioButton !== null && screen.questionAudioError === true;
  const cardAudio = task?.prompt.kind === "lesson_card";
  const actionNotice = screen.taskAudioError != null || (screen.guidanceError && instructionAudioKey) || questionAudioError ? "true" : "false";
  const micAvailable = screen.session.mode !== "mock_test" && screen.session.microphoneEnabled && !screen.micDenied;
  const micState = screen.session.mode === "mock_test" ? "off"
    : !screen.session.microphoneEnabled ? "off"
      : screen.micDenied ? "unavailable"
        : screen.recordingNotice === messages.kid.recordingUnavailable ? "unavailable"
          : screen.microphoneReady ? "ready" : "pending";
  const micLabel = micState === "unavailable" ? messages.kid.microphoneUnavailable
    : micState === "off" ? messages.kid.microphoneOff
      : micState === "ready" ? messages.kid.microphoneReady : messages.kid.microphonePending;
  const micHint = micState === "unavailable" ? messages.kid.microphoneUnavailableHint
    : micState === "off" ? messages.kid.microphoneOffHint
      : micState === "ready" ? messages.kid.microphoneReadyHint : messages.kid.microphonePendingHint;
  const hasFeedback = feedback !== null && !offline && screen.error === null;
  const speechFeedback = hasFeedback && feedback.modality === "audio";
  // podświetlenia opcji żyją tylko przy feedbacku próby wyboru
  let outcomes =
    task !== null && screen.feedback?.chosenOptionId !== undefined
      ? optionOutcomes(
          screen.feedback.dto,
          screen.feedback.chosenOptionId,
          "options" in task.prompt ? task.prompt.options : [],
        )
      : EMPTY_OUTCOMES;
  if (screen.pendingChoiceId) {
    outcomes = new Map([...outcomes, [screen.pendingChoiceId, "pending" as const]]);
  }
  const handlers: ExerciseHandlers = {
    onInteraction: () => controller.recordInteraction(),
    onEdit: () => controller.recordEdit(),
    onPlay: () => void controller.playTaskAudio(),
    onPlayExample: () => void controller.playExampleAudio(),
    onAnswerChoice: (optionId) => void controller.answerChoice(optionId),
    onSubmitText: (text, inputMethod) => void controller.answerText(text, inputMethod),
    onAnswerSequence: (itemIds) => void controller.answerSequence(itemIds),
    onAnswerSelection: (itemIds) => void controller.answerSelection(itemIds),
    onAnswerAssignment: (assignments) => void controller.answerAssignment(assignments),
    onNotRemember: () => void controller.notRemember(),
    onSkip: () => void controller.skip(),
    onComplete: () => void controller.completePresentation(),
    onRecord: () => void controller.startRecording(),
    onStopRecording: () => void controller.stopRecording(),
    onCancelRecording: () => controller.cancelRecording(),
    onPrepareRecording: () => void controller.prepareMicrophone(),
  };

  // Auto-nagrywanie mowy (quick 261021-lsw, D-01): na świeżo wyświetlonym
  // zadaniu speech/picture_speech nagrywanie startuje samo, bez naciskania
  // przycisku. Jedyny punkt wiringu auto-startu, wspólny dla SpeechView i
  // PictureSpeechView — logika żyje w kontrolerze sesji i media/vad.ts.
  // Wiring odpala się raz na zamontowanie panelu nowego zadania
  // i nigdy po „Nagraj jeszcze raz”
  // (SPEC §16). Podwójne wywołanie (np. StrictMode) jest bezpieczne —
  // synchroniczne ustawienie fazy preparing przez prepareMicrophone i latch
  // taskId w kontrolerze czynią drugie wywołanie no-opem.
  const autoPromptKind = task?.prompt.kind;
  // Auto-start odpala TaskPane po zamontowaniu nowego panelu (patrz niżej),
  // nie efekt keyed taskId: przy AnimatePresence mode="wait" nowy panel
  // montuje się dopiero po wyjściu poprzedniego, a nagrywanie nie może
  // wystartować przed pokazaniem bodźca.
  const handlePaneMount = (mountedTaskId: string) => {
    if (mountedTaskId === task?.taskId && (autoPromptKind === "speech" || autoPromptKind === "picture_speech")) {
      void controller.autoCaptureSpeech();
    }
  };

  const speechFeedbackProps = feedback !== null && task !== null ? {
    dto: feedback.dto,
    retry: feedback.retry,
    busy: busy || screen.processing,
    audioAvailable: feedback.dto?.referenceAudioAvailable === true,
    audioError: feedback.audioError === true,
    exerciseType: task.exerciseType,
    onPlay: () => void controller.playFeedbackAudio(),
    onRetry: () => void controller.continueLearning(),
    onSkip: () => void controller.skip(),
    onNext: () => void controller.continueLearning(),
  } : null;

  const speechTone = speechFeedback && feedback !== null
    ? describeSpeechFeedback(feedback.dto, task?.exerciseType ?? "").tone
    : null;
  const speechDockTone: FeedbackDockTone = speechTone === "correct" ? "correct"
    : speechTone === "practice" ? "partial"
      : speechTone === "technical" ? "technical" : "neutral";

  // The tone of the result actually shown drives every reward, so a burst or
  // a streak never contradicts the dock (e.g. pronunciation to practise).
  const shownTone: FeedbackDockTone | null = !hasFeedback || feedback === null ? null
    : speechFeedback ? speechDockTone : answerDockTone(feedback.dto);
  // Choice tiles burst on their own; written and spoken answers burst from the dock.
  const celebrateInDock = feedback !== null && shownTone !== null && feedback.chosenOptionId === undefined
    && resultOutcome(shownTone, feedback.modality) === "correct";

  // Decorative progress fill and correct-answer streak; advancing is
  // idempotent per attempt, so re-renders (and StrictMode) never double count.
  const progressRef = useRef(initialSessionProgress);
  progressRef.current = advanceSessionProgress(progressRef.current, {
    sessionId: screen.session.sessionId,
    remainingAssessed: task?.remainingAssessed ?? null,
    attempt: progressAttempt({
      taskId: task?.taskId ?? null,
      feedback,
      feedbackTone: shownTone,
      revealShown: screen.reveal !== null,
    }),
  }, kidStreakLength);
  const progress = progressRef.current;

  // Odsłuch stoi w panelu wyniku, gdy ten jest widoczny; w pozostałych stanach
  // (zadanie, odsłonięcie wzorca) — obok tekstu instrukcji.
  const guidanceInDock = hasFeedback && feedback !== null && screen.reveal === null;

  const dock = !hasFeedback || feedback === null ? undefined
    : speechFeedback && speechFeedbackProps !== null ? (
      <ExerciseFeedbackDock
        kind="speech"
        tone={speechDockTone}
        celebrate={celebrateInDock}
        guidance={guidanceButton}
        primary={<SpeechFeedbackActions {...speechFeedbackProps} />}
        secondary={speechFeedbackProps.audioAvailable || speechFeedbackProps.retry ? (
          <div className="kid-feedback-dock-secondary-actions">
            <SpeechFeedbackReferenceAction {...speechFeedbackProps} />
            <SpeechFeedbackSecondaryActions {...speechFeedbackProps} />
          </div>
        ) : undefined}
      >
        <SpeechFeedbackContent {...speechFeedbackProps} inDock />
      </ExerciseFeedbackDock>
    ) : (
      <ExerciseFeedbackDock
        compact={task?.prompt.kind === "picture_listening" || task?.prompt.kind === "picture_recognition"}
        tone={answerDockTone(feedback.dto)}
        celebrate={celebrateInDock}
        guidance={guidanceButton}
        sentenceAudio={sentenceAudio}
        primary={<AnswerFeedbackActions dto={feedback.dto} retry={feedback.retry} busy={busy}
          onNext={() => void controller.continueLearning()} />}
        secondary={lessonFeedbackView(feedback.dto)?.technical === true && feedback.retry ? (
          <AnswerFeedbackSecondaryActions dto={feedback.dto} retry={feedback.retry} busy={busy}
            onNext={() => void controller.continueLearning()} onSkip={() => void controller.skip()} />
        ) : undefined}
      >
        <AnswerFeedbackContent dto={feedback.dto} busy={busy} />
      </ExerciseFeedbackDock>
    );

  return (
    <main className="kid-screen kid-learning" data-task-id={task?.taskId ?? undefined} data-action-notice={actionNotice}>
      <header className="kid-header">
        <IconActionButton ref={endButtonRef} variant="text" data-testid="kid-end" aria-label={messages.kid.end} title={messages.kid.end} aria-haspopup="dialog" aria-expanded={endConfirmOpen} disabled={busy} onClick={openEndConfirm}>
          <KidIcon name="close" />
        </IconActionButton>
        <SessionProgress remaining={remaining} total={progress.total} done={progressDone(progress.total, task?.remainingAssessed ?? null)} milestone={progress.milestone} />
        <details className="kid-microphone-status" data-microphone-state={micState}>
          <summary aria-label={micLabel} data-testid="kid-microphone-status">
            <KidIcon name={micState === "off" || micState === "unavailable" ? "microphone-off" : "microphone"} />
          </summary>
          <p className="kid-microphone-hint" data-testid={micState === "unavailable" ? "kid-mic-denied" : "kid-microphone-hint"}>
            {micHint}
          </p>
        </details>
      </header>
      <div className="kid-session-status" data-testid="kid-session-status" data-mode={screen.session.mode} role="status" aria-live="polite">
        {screen.session.mode === "mock_test" && <p className="kid-notice">{messages.kid.mockTestInfo}</p>}
        {screen.answerSaved && <p className="kid-notice">{messages.kid.answerSaved}</p>}
        {screen.processing && (
          <p className="kid-notice" data-testid="kid-processing">
            {messages.kid.processing}
          </p>
        )}
        {screen.guidanceError && instructionAudioKey && <div className="kid-notice" data-testid="kid-guidance-error"><p>{messages.errors.picture_guidance_unavailable}</p><ActionButton priority="secondary" fullWidth={false} size="sm" type="button" onClick={() => void controller.playGuidance(instructionAudioKey).catch(() => undefined)}>{messages.errors.picture_audio_retry}</ActionButton><ActionButton priority="secondary" fullWidth={false} size="sm" type="button" onClick={() => void controller.endNow()}>{messages.kid.end}</ActionButton></div>}
        {questionAudioError && <div className="kid-notice" role="alert" data-testid="kid-question-audio-error"><p>{cardAudio ? messages.kid.cardAudioUnavailable : messages.kid.questionAudioUnavailable}</p><ActionButton priority="secondary" fullWidth={false} size="sm" type="button" data-testid="kid-question-audio-retry" onClick={() => void controller.playQuestionAudio()}>{cardAudio ? messages.kid.cardAudioRetry : messages.kid.questionAudioRetry}</ActionButton></div>}
        {/* „Posłuchaj i wybierz”: sam komunikat — ponawia głośnik w poleceniu, a „Pomiń” jest w zadaniu. */}
        {screen.taskAudioError && listenChoice && <div className="kid-notice" role="alert" data-testid="kid-task-audio-error"><p>{messages.kid.listenStimulusFailed}</p></div>}
        {screen.taskAudioError && !listenChoice && <div className="kid-notice" role="alert" data-testid="kid-task-audio-error"><p>{screen.taskAudioError === "blocked" ? messages.errors.picture_audio_blocked : messages.errors.picture_audio_unavailable}</p><ActionButton priority="secondary" fullWidth={false} size="sm" type="button" data-testid="kid-task-audio-retry" onClick={() => void controller.playTaskAudio()}>{messages.errors.picture_audio_retry}</ActionButton><ActionButton priority="secondary" fullWidth={false} size="sm" type="button" onClick={() => void controller.endNow()}>{messages.kid.end}</ActionButton></div>}
      </div>

      {offline ? (
        <section className="kid-card kid-offline" data-testid="kid-offline">
          <p>{messages.kid.offlineMessage}</p>
          <ActionButton type="button" className="kid-primary" data-testid="kid-retry" onClick={() => void controller.retry()}>
            {messages.kid.offlineRetry}
          </ActionButton>
        </section>
      ) : screen.error !== null ? (
        <section className="kid-card kid-error" data-testid="kid-error">
          <p>{screen.error}</p>
          <ActionButton type="button" className="kid-primary" data-testid="kid-retry" onClick={() => void controller.retry()}>
            {messages.kid.offlineRetry}
          </ActionButton>
        </section>
      ) : (
        task !== null && (
          <div className="kid-task">
            <TaskTransition taskId={task.taskId} onPaneMount={handlePaneMount}>
            <ExerciseGuidanceProvider value={guidanceInDock ? null : instructionGuidanceButton ?? questionAudioButton}>
            {screen.reveal !== null ? (
              <ExerciseFrame task={task} content={(
                <section className="kid-card kid-reveal" data-testid="kid-reveal">
                  <p>{messages.kid.revealTitle}</p>
                  {screen.reveal.visual && <MeaningVisualView visual={screen.reveal.visual} mediaUrl={(assetId) => controller.mediaUrl(assetId)} />}
                  <p className="kid-word">{screen.reveal.target}</p>
                  {screen.reveal.audioAssetId && <ListenButton size="lg" data-testid="kid-reveal-audio" onClick={() => void controller.playRevealAudio()} aria-label={messages.kid.listen} />}
                </section>
              )} actions={<RevealActions busy={busy} onConfirm={() => void controller.confirmReveal()} />} />
            ) : (
              <ExerciseView
                mockTest={screen.session.mode === "mock_test"}
                task={task}
                letterDraft={activeLetterDraft}
                onLetterDraftChange={(letters) => setLetterDraft({ taskId: task.taskId, letters })}
                busy={busy || screen.feedback !== null || screen.reveal !== null}
                recording={screen.recording}
                automaticRecording={screen.automaticRecording}
                recordingPhase={screen.recordingPhase}
                microphoneReady={screen.microphoneReady}
                inputLevel={screen.inputLevel}
                recordingNotice={screen.recordingNotice}
                technicalRecordingIssue={screen.technicalRecordingIssue}
                recordingMode={screen.recordingMode}
                micAvailable={micAvailable}
                dictation={screen.dictation?.taskId === task.taskId ? screen.dictation : null}
                mediaUrl={(assetId) => controller.mediaUrl(assetId)}
                optionOutcomes={outcomes}
                dock={screen.reveal === null ? dock : undefined}
                listenStimulus={screen.listenStimulus?.taskId === task.taskId ? screen.listenStimulus : null}
                feedbackAudio={hasFeedback && feedback !== null && listenChoice && feedback.dto?.correctAudioAssetId !== undefined
                  ? { assetId: feedback.dto.correctAudioAssetId, onPlay: () => void controller.playSentenceAudio() }
                  : hasFeedback && feedback !== null && feedback.chosenOptionId !== undefined && feedback.dto?.correctAudioAssetId !== undefined
                    ? { assetId: feedback.dto.correctAudioAssetId, onPlay: () => void controller.playCorrectOptionAudio() }
                    : null}
                handlers={handlers}
              />
            )}
            </ExerciseGuidanceProvider>
            </TaskTransition>
          </div>
        )
      )}

      {task === null && !offline && screen.error === null && (
        <p className="kid-hint" data-testid="kid-loading-step">
          {messages.kid.loading}
        </p>
      )}

      <EndSessionConfirm
        open={endConfirmOpen}
        mockTest={screen.session.mode === "mock_test"}
        busy={busy}
        onContinue={closeEndConfirm}
        onEnd={confirmEnd}
      />
    </main>
  );
}
