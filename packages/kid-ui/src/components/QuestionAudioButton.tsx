import { useRef, useState } from "react";
import { messages } from "@learning/contracts";
import { ListenButton } from "./ListenButton";
import { SoundRing } from "../motion/SoundRing";

/** „Posłuchaj pytania” (design szkoły §11.4): odsłuch nagrania polecenia
 * i pytania na żądanie, w wierszu instrukcji za tekstem; na karcie nauki
 * „Posłuchaj karty” w nagłówku za tytułem (§12.4), na historyjce „Posłuchaj
 * historyjki”. Ponowne dotknięcie zaczyna od początku. Komunikat błędu pokazuje
 * ekran nauki w pasku statusu (`questionAudioError`), nie ten wiersz — jak
 * odsłuch polecenia. `playing` (opcjonalny, sterowany) zapala pierścień dla
 * odtwarzania rozpoczętego bez kliknięcia (autoodtwarzanie historyjki); własny
 * stan kliknięcia działa niezależnie od niego. */
export function QuestionAudioButton({ onPlay, disabled, label = messages.kid.listenLessonQuestion, playing: controlledPlaying }: {
  onPlay: () => Promise<void>;
  disabled: boolean;
  label?: string;
  /** Odtwarzanie tego nagrania rozpoczęte przez kontroler sesji. */
  playing?: boolean;
}) {
  const [clickPlaying, setPlaying] = useState(false);
  const playing = controlledPlaying === true || clickPlaying;
  // Ponowne dotknięcie zatrzymuje poprzednie odtwarzanie i domyka jego obietnicę;
  // wskaźnik gasi tylko ostatnie wywołanie, żeby nie zgasić nowego odsłuchu.
  const latest = useRef(0);
  const play = async () => {
    const run = ++latest.current;
    setPlaying(true);
    try {
      await onPlay();
    } catch {
      // Błąd odtwarzania raportuje kontroler sesji (`questionAudioError`).
    } finally {
      if (run === latest.current) setPlaying(false);
    }
  };
  return (
    <ListenButton data-testid="kid-question-audio" disabled={disabled}
      aria-label={label} data-sound-active={playing || undefined} onClick={() => void play()}>
      {playing && <SoundRing />}
    </ListenButton>
  );
}
