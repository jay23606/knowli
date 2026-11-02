import { messages, type TaskDto } from "@learning/contracts";
import type { KidIconName } from "../components/KidIcon";

export interface ExercisePresentation {
  instruction: string;
  icon: KidIconName;
}

export function getExercisePresentation(task: TaskDto): ExercisePresentation {
  switch (task.prompt.kind) {
    case "exposure":
      return { instruction: messages.kid.instructionExposure, icon: "sparkles" };
    case "picture_exposure":
      return { instruction: messages.kid.instructionExposure, icon: "sparkles" };
    case "listening":
      return { instruction: messages.kid.instructionListening, icon: "volume" };
    case "picture_listening":
      return { instruction: messages.kid.instructionListening, icon: "volume" };
    case "picture_recall":
      return { instruction: messages.kid.instructionRecall, icon: "book" };
    case "picture_recognition":
      return { instruction: messages.kid.instructionPictureRecognition, icon: "book" };
    case "reading":
      return { instruction: messages.kid.instructionReading, icon: "book" };
    case "reverse_recognition":
      return { instruction: messages.kid.instructionReverseRecognition, icon: "ear" };
    case "recall":
      return { instruction: messages.kid.instructionRecall, icon: "book" };
    case "spelling":
      return { instruction: messages.kid.instructionSpelling, icon: "pencil" };
    case "letter_completion":
      return { instruction: messages.kid.instructionLetterCompletion, icon: "letters" };
    case "speech":
      return { instruction: messages.kid.instructionSpeech, icon: "microphone" };
    case "picture_speech":
      return { instruction: messages.kid.instructionSpeech, icon: "microphone" };
    // Lekcje (design „Typy ćwiczeń i etapy” — polecenie z payloadu/katalogu).
    // Polecenie zdania bierze się z `instructionPl` promptu; tu dajemy sensowny
    // domyślny tekst i ikonę per typ.
    case "lesson_card":
      return { instruction: messages.kid.lessonCardInstruction, icon: "sparkles" };
    case "lesson_notice":
      return { instruction: task.prompt.instructionPl, icon: "ear" };
    case "lesson_choice":
      return { instruction: task.prompt.instructionPl, icon: "book" };
    case "lesson_listen_choice":
      return { instruction: messages.kid.lessonListenChoiceInstruction, icon: "ear" };
    case "lesson_order":
      return { instruction: task.prompt.instructionPl, icon: "letters" };
    case "lesson_match":
    case "lesson_group":
      return { instruction: task.prompt.instructionPl, icon: "book" };
    case "lesson_cloze":
      return { instruction: task.prompt.instructionPl, icon: "pencil" };
    case "lesson_short_answer":
      return { instruction: task.prompt.question, icon: "book" };
    case "lesson_gap":
      return { instruction: task.prompt.instructionPl, icon: "pencil" };
    case "lesson_error_fix":
      return { instruction: task.prompt.instructionPl, icon: "pencil" };
    case "lesson_transform":
      return { instruction: task.prompt.instructionPl, icon: "pencil" };
    case "lesson_open_answer":
      return { instruction: task.prompt.instructionPl, icon: "pencil" };
    case "lesson_calculation":
      return { instruction: task.prompt.instructionPl, icon: "pencil" };
    case "lesson_keywords":
      return { instruction: task.prompt.instructionPl, icon: "sparkles" };
    case "lesson_shorten":
      return { instruction: task.prompt.instructionPl, icon: "pencil" };
  }
}
