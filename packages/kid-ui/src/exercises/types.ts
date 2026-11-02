import type { ReactNode } from "react";
import type { Assignment, RecordingModeDto, TaskDto } from "@learning/contracts";
import type { OptionOutcome } from "./option-outcome";

export interface ExerciseHandlers {
  /** Content-free activity signal for an actual edit or block move. */
  onInteraction(): void;
  /** Edycja pola/układanie odpowiedzi: licznik zmian bez treści wpisów. */
  onEdit(): void;
  onPlay(): void;
  /** Odsłuch zdania przykładowego prezentacji (SPEC §22). */
  onPlayExample(): void;
  onAnswerChoice(optionId: string): void;
  /** `speech` = tekst pochodzi z dyktowania w tym zadaniu (domyślnie klawiatura). */
  onSubmitText(text: string, inputMethod?: "keyboard" | "speech"): void;
  /** Ułożona kolejność klocków (`lesson_order`) — odpowiedź `sequence`. */
  onAnswerSequence(itemIds: string[]): void;
  /** Zaznaczone pojęcia (`lesson_keywords`) — odpowiedź `selection`, kolejność bez znaczenia. */
  onAnswerSelection(itemIds: string[]): void;
  /** Przypisania (`lesson_match`, `lesson_group`, `lesson_cloze`) — odpowiedź `assignment`. */
  onAnswerAssignment(assignments: Assignment[]): void;
  onNotRemember(): void;
  onSkip(): void;
  /** „Rozumiem” — zamknięcie prezentacji przez complete-presentation. */
  onComplete(): void;
  onRecord(): void;
  onStopRecording(): void;
  onCancelRecording(): void;
  onPrepareRecording(): void;
}

export interface ExerciseProps {
  mockTest?: boolean;
  task: TaskDto;
  /** Krótkotrwały szkic luk; zachowuje pola gdy widok zadania ustępuje feedbackowi. */
  letterDraft?: Readonly<Record<number, string>>;
  onLetterDraftChange?: (letters: Record<number, string>) => void;
  busy: boolean;
  recording: boolean;
  automaticRecording?: boolean;
  recordingPhase: "idle" | "preparing" | "starting" | "recording" | "stopping";
  microphoneReady: boolean;
  inputLevel: number | null;
  recordingNotice: string | null;
  /** Nagrywanie nie powiodło się technicznie lub nie wykryto mowy. */
  technicalRecordingIssue?: boolean;
  recordingMode: RecordingModeDto;
  /** Mikrofon dostępny: sesja włączona i brak odmowy. */
  micAvailable: boolean;
  /** URL niezmiennej ilustracji karty (route media hosta). */
  mediaUrl: (assetId: string) => string;
  /** Podświetlenia opcji po próbie wyboru; puste poza feedbackiem. */
  optionOutcomes: ReadonlyMap<string, OptionOutcome>;
  /**
   * Odsłuch poprawnego słowa w feedbacku `picture_recognition`: identyfikator
   * ujawniony serwerowo dopiero wraz z oceną (audio_issued przed HTTP).
   */
  feedbackAudio?: { assetId: string; onPlay: () => void } | null;
  /**
   * Stan bodźca „Posłuchaj i wybierz” z kontrolera sesji; brak (`null`) =
   * `pending` (opcje zablokowane — widok nie odblokowuje się sam).
   */
  listenStimulus?: { state: "pending" | "blocked" | "unavailable" | "open"; playing: boolean } | null;
  /**
   * Ostatni wynik dyktowania tego zadania (lekcje z `speechInput`): widok
   * wstawia `text` do pola raz na `seq`.
   */
  dictation?: { taskId: string; seq: number; status: string; text?: string; failures: number } | null;
  /** Panel wyniku w stopce ramy; bodziec i odpowiedzi pozostają w treści zadania. */
  dock?: ReactNode;
  handlers: ExerciseHandlers;
}
