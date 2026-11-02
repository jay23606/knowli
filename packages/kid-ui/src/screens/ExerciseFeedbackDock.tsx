import type { ReactElement, ReactNode } from "react";
import { m, useIsPresent } from "motion/react";
import { messages } from "@learning/contracts";
import { kidDockAnimate, kidDockExit, kidDockExitTransition, kidDockInitial, kidDockOrigin, kidSpringGentle } from "../motion/kid-motion";
import { BurstParticles } from "../components/CelebrationBurst";
import { KidIcon, type KidIconName } from "../components/KidIcon";
import { ListenButton } from "../components/ListenButton";
import { SoundRing } from "../motion/SoundRing";
import type { SentenceRate } from "../session/session-controller";
import classes from "./ExerciseFeedbackDock.module.css";

/** Odczyt pełnego zdania w doku lekcji: tempo, które gra, ostatni nieudany
 * ręczny odsłuch i blokada, gdy kontroler i tak zignorowałby dotknięcie. */
export interface FeedbackDockSentenceAudio {
  playing: SentenceRate | null;
  error: { rate: SentenceRate; seq: number } | null;
  disabled: boolean;
  onPlay: (rate: SentenceRate) => void;
}

/**
 * Wyjaśnienie ćwiczenia po błędzie w lekcji (spec 2026-11-01-lesson-error-explanation §6).
 * Odsłuch nagrania (gdy jest) zachowuje się jak „Posłuchaj zdania”: wskaźnik gry,
 * ta sama blokada i błąd ręcznego odsłuchu (komunikat w regionie nad górnym wierszem
 * i poruszenie ikoną przycisku).
 */
export interface FeedbackDockExplanation {
  text: string;
  onPlay?: () => void;
  playing?: boolean;
  disabled?: boolean;
  /** Ostatni nieudany ręczny odsłuch wyjaśnienia (`seq` jak w błędzie zdania). */
  error?: { seq: number } | null;
}

const SENTENCE_BUTTONS = [
  { rate: "normal", icon: "volume", testId: "kid-sentence-audio", label: messages.kid.listenExample },
  { rate: "slow", icon: "turtle", testId: "kid-sentence-audio-slow", label: messages.kid.listenSlower },
] as const;

export type FeedbackDockTone = "correct" | "incorrect" | "partial" | "technical" | "neutral";

/** Ikona odznaki w kółku: drugi kanał informacji o wyniku obok koloru panelu. */
export const FEEDBACK_TONE_ICONS: Record<FeedbackDockTone, KidIconName> = {
  correct: "check",
  partial: "almost",
  incorrect: "close",
  technical: "info",
  neutral: "info",
};

/**
 * Wspólny dolny panel wyniku ćwiczenia: wysuwa się w stopce ramy zadania,
 * nie podmienia bodźca ani odpowiedzi. Treść i akcje pochodzą z istniejących
 * kart feedbacku; dock odpowiada wyłącznie za prezentację i jedną akcję główną.
 * Animacja wejścia: Motion (sprężyna, tylko transform i opacity).
 * `celebrate` dodaje mały wybuch gwiazdek z górnej krawędzi — dla poprawnych
 * odpowiedzi bez kafla wyboru (pismo, mowa), który ma własny wybuch.
 */
export function ExerciseFeedbackDock({
  tone,
  kind = "answer",
  compact = false,
  children,
  primary,
  secondary,
  celebrate = false,
  guidance,
  sentenceAudio = null,
  explanation = null,
}: {
  tone: FeedbackDockTone;
  kind?: "answer" | "speech";
  compact?: boolean;
  children: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  celebrate?: boolean;
  /** Przycisk odsłuchu komunikatu o wyniku, za treścią w górnym wierszu (po odznace tonu). */
  guidance?: ReactNode;
  /** Powtórka nagrania pełnego zdania w feedbacku lekcji: „Posłuchaj zdania”
   * i „Posłuchaj wolniej” w grupie, za górnym wierszem region błędu
   * (położenie wizualne ustala CSS `order`). */
  sentenceAudio?: FeedbackDockSentenceAudio | null;
  /**
   * Wyjaśnienie ćwiczenia po błędzie w lekcji: osobny wiersz na całą szerokość
   * między górnym wierszem a akcjami, poza przewijaną kartą wyniku — zawsze
   * widoczny; „Posłuchaj wyjaśnienia” na początku, gdy jest nagranie.
   */
  explanation?: FeedbackDockExplanation | null;
}): ReactElement {
  const isPresent = useIsPresent();
  // Region błędu ręcznego odsłuchu: przy nagraniu zdania albo wyjaśnienia.
  const hasRecording = sentenceAudio !== null || explanation?.onPlay !== undefined;
  const audioError = sentenceAudio?.error ?? explanation?.error ?? null;
  const explanationFailKey = explanation?.error?.seq;
  return (
    <m.div
      initial={kidDockInitial}
      animate={kidDockAnimate}
      exit={{ ...kidDockExit, transition: kidDockExitTransition }}
      transition={kidSpringGentle}
      inert={!isPresent}
      style={{ pointerEvents: isPresent ? "auto" : "none", transformOrigin: kidDockOrigin }}
      data-testid="kid-feedback-dock"
      data-tone={tone}
      data-dock-kind={kind}
      data-compact={compact || undefined}
      className={`${classes.dock} ${compact ? classes.compact : ""} ${classes[tone]}`}
    >
      <div className={classes.scroll}>
        <span className={classes.badge} data-testid="kid-feedback-tone-icon" data-icon={FEEDBACK_TONE_ICONS[tone]} aria-hidden="true">
          <KidIcon name={FEEDBACK_TONE_ICONS[tone]} />
        </span>
        <div className={classes.content}>{children}</div>
        {sentenceAudio && (
          <div className={classes.sentenceGroup} data-testid="kid-sentence-audio-group">
            {SENTENCE_BUTTONS.map(({ rate, icon, testId, label }) => {
              const playing = sentenceAudio.playing === rate;
              const failKey = sentenceAudio.error?.rate === rate ? sentenceAudio.error.seq : undefined;
              return (
                <ListenButton key={rate} data-testid={testId} icon={icon} aria-label={label} title={label}
                  disabled={sentenceAudio.disabled} data-sound-active={playing || undefined}
                  {...(failKey !== undefined ? { failKey } : {})} onClick={() => sentenceAudio.onPlay(rate)}>
                  {playing && <SoundRing />}
                </ListenButton>
              );
            })}
          </div>
        )}
        {guidance && <div className={classes.guidance}>{guidance}</div>}
      </div>
      {/* Stały region błędu ręcznego odsłuchu (zdanie albo wyjaśnienie) za górnym
          wierszem — w DOM po wyniku, więc czytnik czyta najpierw wynik, potem błąd,
          a dopiero potem wiersz wyjaśnienia. Wizualnie stoi tam, gdzie pojawiający
          się tekst nie przesuwa przycisków zdania pod palcem (CSS `order`, moduł
          doku). Pusty nie zajmuje miejsca; tekst w elemencie kluczowanym `seq`
          montuje się od nowa, więc czytnik ogłasza każdy błąd. */}
      {hasRecording && (
        <div className={classes.sentenceError} aria-live="polite" data-testid="kid-sentence-audio-error">
          {audioError !== null ? <span key={audioError.seq}>{messages.kid.sentenceAudioFailed}</span> : null}
        </div>
      )}
      {/* Wiersz wyjaśnienia poza przewijaną kartą: dziecko widzi go bez przewijania, a karta
          wyniku dostaje mniejszy limit (`--kid-feedback-pinned-height`, ExerciseFrame). Tekst
          w regionie `aria-live` — karta wyniku ma własny region statusu. */}
      {explanation && (
        <div className={`${classes.explanation} kid-feedback-pinned`} data-testid="kid-explanation">
          {explanation.onPlay && (
            <ListenButton data-testid="kid-explanation-audio" aria-label={messages.kid.listenExplanation}
              title={messages.kid.listenExplanation} disabled={explanation.disabled === true}
              data-sound-active={explanation.playing === true || undefined}
              {...(explanationFailKey !== undefined ? { failKey: explanationFailKey } : {})} onClick={explanation.onPlay}>
              {explanation.playing === true && <SoundRing />}
            </ListenButton>
          )}
          <p className={classes.explanationText} data-testid="kid-explanation-text" aria-live="polite">{explanation.text}</p>
        </div>
      )}
      <div className={classes.actions}>
        {primary}
      </div>
      {celebrate && (
        <span className={classes.burstAnchor} aria-hidden="true">
          <BurstParticles size="sm" transient testId="kid-answer-burst" />
        </span>
      )}
      {secondary !== undefined && secondary !== null && (
        <div className={classes.secondary}>
          {secondary}
        </div>
      )}
    </m.div>
  );
}
