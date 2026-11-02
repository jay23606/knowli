import type { ReactNode, Ref } from "react";
import { messages } from "@learning/contracts";
import { KidIcon, type KidIconName } from "./KidIcon";
import { ListenButton } from "./ListenButton";
import { SoundRing } from "../motion/SoundRing";
import classes from "./ExerciseInstruction.module.css";

export interface ExerciseInstructionAudio {
  onPlay: () => void;
  disabled: boolean;
  ref?: Ref<HTMLButtonElement>;
  /** Nagranie gra teraz: pierścień dźwięku i `data-sound-active` jak w `GuidanceButton`. */
  playing?: boolean;
  /** Własna etykieta dostępności (domyślnie `messages.kid.listen`). */
  label?: string;
  /** Przycisk wyróżniony (dziecko ma go nacisnąć, np. zablokowane autoodtwarzanie). */
  attention?: boolean;
}

/** Instrukcja zadania, opcjonalny odsłuch bodźca przez kontroler sesji (z przodu)
 * i opcjonalny odsłuch samej instrukcji (`guidance`, za tekstem). */
export function ExerciseInstruction({ instruction, icon, audio, guidance }: {
  instruction: string;
  icon: KidIconName;
  audio?: ExerciseInstructionAudio;
  guidance?: ReactNode;
}) {
  return (
    <header className={`kid-exercise-instruction ${classes.root}`} data-testid="kid-instruction">
      {audio ? (
        <ListenButton ref={audio.ref} disabled={audio.disabled} onClick={audio.onPlay}
          aria-label={audio.label ?? messages.kid.listen} data-testid="kid-play"
          data-sound-active={audio.playing || undefined} data-attention={audio.attention || undefined}>
          {audio.playing && <SoundRing />}
        </ListenButton>
      ) : <KidIcon name={icon} className="kid-exercise-instruction-icon" />}
      <span className={classes.text}>{instruction}</span>
      {guidance}
    </header>
  );
}
