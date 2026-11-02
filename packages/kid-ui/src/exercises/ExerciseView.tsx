import type { ExerciseProps } from "./types";
import { ExposureView } from "./ExposureView";
import { ListeningView } from "./ListeningView";
import { ReadingView } from "./ReadingView";
import { SpeechView } from "./SpeechView";
import { WrittenView } from "./WrittenView";
import { LetterCompletionView } from "./LetterCompletionView";
import { LessonCardView } from "./lesson/LessonCardView";
import { LessonNoticeView } from "./lesson/LessonNoticeView";
import { LessonChoiceView } from "./lesson/LessonChoiceView";
import { LessonListenChoiceView } from "./lesson/LessonListenChoiceView";
import { LessonShortAnswerView } from "./lesson/LessonShortAnswerView";
import { LessonOrderView } from "./lesson/LessonOrderView";
import { LessonGapView } from "./lesson/LessonGapView";
import { LessonSentenceView } from "./lesson/LessonSentenceView";
import { LessonKeywordsView } from "./lesson/LessonKeywordsView";
import { LessonMatchView } from "./lesson/LessonMatchView";
import { LessonGroupView } from "./lesson/LessonGroupView";
import { LessonClozeView } from "./lesson/LessonClozeView";
import { LessonShortenView } from "./lesson/LessonShortenView";
import { PictureExposureView } from "./PictureExposureView";
import { PictureListeningView } from "./PictureListeningView";
import { PictureRecallView } from "./PictureRecallView";
import { PictureRecognitionView } from "./PictureRecognitionView";
import { PictureSpeechView } from "./PictureSpeechView";

/**
 * Dyspozytor widoku ćwiczenia po rodzaju promptu (= typie zadania).
 * Wyczerpujący: strażnik `never` w gałęzi domyślnej jest błędem kompilacji,
 * gdy dojdzie nowy typ ćwiczenia bez widoku (przegląd zadania 8).
 */
export function ExerciseView(props: ExerciseProps) {
  const kind = props.task.prompt.kind;
  switch (kind) {
    case "exposure":
      return <ExposureView {...props} />;
    case "picture_exposure":
      return <PictureExposureView {...props} />;
    case "listening":
      return <ListeningView {...props} />;
    case "picture_listening":
      return <PictureListeningView {...props} />;
    case "picture_recall":
      return <PictureRecallView key={props.task.taskId} {...props} />;
    case "picture_recognition":
      return <PictureRecognitionView key={props.task.taskId} {...props} />;
    case "reading":
    case "reverse_recognition":
      return <ReadingView {...props} />;
    case "recall":
    case "spelling":
      return <WrittenView key={props.task.taskId} {...props} />;
    case "letter_completion":
      // Nowe zadanie ma puste luki; kolejna próba tego samego zachowuje wpis.
      return <LetterCompletionView key={props.task.taskId} {...props} />;
    case "speech":
      return <SpeechView key={props.task.taskId} {...props} />;
    case "picture_speech":
      return <PictureSpeechView key={props.task.taskId} {...props} />;
    // Lekcje (design „Typy ćwiczeń i etapy”). Pola edycji resetują się przy
    // zmianie zadania, dlatego `key` po `taskId`.
    case "lesson_card":
      return <LessonCardView key={props.task.taskId} {...props} />;
    case "lesson_notice":
      return <LessonNoticeView key={props.task.taskId} {...props} />;
    case "lesson_choice":
      return <LessonChoiceView key={props.task.taskId} {...props} />;
    case "lesson_listen_choice":
      return <LessonListenChoiceView key={props.task.taskId} {...props} />;
    case "lesson_short_answer":
      return <LessonShortAnswerView key={props.task.taskId} {...props} />;
    case "lesson_order":
      return <LessonOrderView key={props.task.taskId} {...props} />;
    // Pary i grupy (design szkoły §10.5): przypisania stukaniem.
    case "lesson_match":
      return <LessonMatchView key={props.task.taskId} {...props} />;
    case "lesson_group":
      return <LessonGroupView key={props.task.taskId} {...props} />;
    // Luki z bankiem słów (design szkoły §13.5): te same reguły stukania co pary.
    case "lesson_cloze":
      return <LessonClozeView key={props.task.taskId} {...props} />;
    case "lesson_gap":
      return <LessonGapView key={props.task.taskId} {...props} />;
    case "lesson_error_fix":
    case "lesson_transform":
    case "lesson_open_answer":
    case "lesson_calculation":
      return <LessonSentenceView key={props.task.taskId} {...props} />;
    // Trener precyzji: wybór pojęć kluczowych i „Skróć odpowiedź” (zadanie
    // `lesson_open_answer` z promptem `lesson_shorten`).
    case "lesson_keywords":
      return <LessonKeywordsView key={props.task.taskId} {...props} />;
    case "lesson_shorten":
      return <LessonShortenView key={props.task.taskId} {...props} />;
    default: {
      // Strażnik wyczerpania: dodanie nowego typu bez gałęzi wyżej nie skompiluje się.
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
