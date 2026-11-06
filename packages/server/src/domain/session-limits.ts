/**
 * Czyste limity czasu sesji nauki. Reguła jest współdzielona przez koordynację
 * sesji, przyjmowanie prób (kartkówki) i raportowanie aktywności, dlatego nie
 * mieszka w module wykonawczym sesji — konsumenci nie muszą importować jego
 * zapytań ani transakcji, aby policzyć ten sam limit.
 */

/** Okno wznowienia aktywnej sesji od ostatniego zdarzenia (arch §9.1). */
export const RESUME_WINDOW_MS = 30 * 60_000;
/** Miękki minimalny limit czasu sesji — egzekwowany tylko między zadaniami (arch §9.3). */
export const SESSION_TIME_LIMIT_MS = 10 * 60_000;
/** Przyrost limitu na każde zadanie budżetu (zob. `sessionTimeLimitMs`). */
export const SESSION_TIME_PER_TASK_MS = 45_000;
/**
 * Efektywny limit czasu sesji: skaluje się z budżetem zadań ocenianych sesji
 * (45 s na zadanie, minimum 10 minut). Budżety ≤ 13 zachowują 10 minut;
 * budżet 20 → 15 minut. Liczymy od budżetu sesji (maksymalna obietnica
 * wydawania), nie od liczby już wydanych zadań.
 */
export function sessionTimeLimitMs(taskBudget: number): number {
  return Math.max(SESSION_TIME_LIMIT_MS, taskBudget * SESSION_TIME_PER_TASK_MS);
}
