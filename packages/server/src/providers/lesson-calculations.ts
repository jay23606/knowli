import { materializeRawExercise } from "../domain/lessons/raw-materialize";

/**
 * Materializacja rachunków dla fake'a agenta i testu integracyjnego (opakowanie
 * domenowego `materializeRawExercise` z dzisiejszym zachowaniem): kod liczy
 * odpowiedź i treść także wtedy, gdy rekord niesie `answer`, a wadliwy rekord
 * dostaje `answer: undefined`, więc narzędzia agenta odrzucą go pojedynczo.
 */
export function materializeGeneratedCalculations(exercises: unknown[]): unknown[] {
  return exercises.map((raw) => {
    if (!raw || typeof raw !== "object" || (raw as { exerciseType?: unknown }).exerciseType !== "lesson_calculation") return raw;
    const record = { ...(raw as Record<string, unknown>), answer: undefined };
    const result = materializeRawExercise(record);
    return result.ok ? result.record : record;
  });
}
