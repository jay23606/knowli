import type { LessonExerciseType, LessonStage } from "./types";

/**
 * Mapa typu ćwiczenia na etap nauki (design: tabela „Typy ćwiczeń i etapy”).
 * Karta i wskazanie = intro; wybór, klocki, krótka odpowiedź = guided;
 * luka, error_fix, transform = productive; open_answer i calculation = independent.
 */
export const STAGE_BY_TYPE: Readonly<Record<LessonExerciseType, LessonStage>> = {
  lesson_card: "intro",
  lesson_notice: "intro",
  lesson_choice: "guided",
  lesson_order: "guided",
  lesson_short_answer: "guided",
  lesson_gap: "productive",
  lesson_error_fix: "productive",
  lesson_transform: "productive",
  lesson_open_answer: "independent",
  lesson_calculation: "independent",
  // Wybór pojęć przed odpowiedzią otwartą: zawsze wspomagany.
  lesson_keywords: "guided",
  // Pary i grupy: elementy widoczne, rozpoznanie zamiast przypomnienia (design szkoły §10.3).
  lesson_match: "guided",
  lesson_group: "guided",
  // Luki z bankiem słów: bank widoczny, rozpoznanie w kontekście (design szkoły §13.3).
  lesson_cloze: "guided",
  // Wybór brakującej formy ze słuchu: opcje widoczne, rozpoznanie ze wsparciem nagrania (#198).
  lesson_listen_choice: "guided",
};

/**
 * Typy poza ścieżką etapów: nie wchodzą do kolejki etapów celu (intro → guided →
 * productive → independent), tylko dochodzą do puli jako dodatek (słuchowy wybór
 * wymaga gotowego nagrania, słowa kluczowe — odpowiedzi otwartej).
 */
export function outsideStagePath(type: LessonExerciseType): boolean {
  return type === "lesson_listen_choice" || type === "lesson_keywords";
}

/** Etapy oceniane (poza intro-kartą): guided, productive, independent. */
export const ASSESSED_STAGES: readonly LessonStage[] = ["guided", "productive", "independent"];

/** Etap ćwiczenia danego typu. */
export function stageOf(type: LessonExerciseType): LessonStage {
  return STAGE_BY_TYPE[type];
}

/**
 * Czy typ ćwiczenia jest oceniany. Karta (`lesson_card`) jest prezentacją bez
 * oceny; każdy inny typ (w tym wskazanie) ma werdykt.
 */
export function isAssessed(type: LessonExerciseType): boolean {
  return type !== "lesson_card";
}
