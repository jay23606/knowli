/**
 * Publiczne API obszaru reporting. Raportowanie: modele odczytu postępu i aktywności (bez własności źródłowych ocen).
 * Inne obszary importują wyłącznie stąd; wewnątrz obszaru obowiązują
 * bezpośrednie importy plików. Kolejność i zakres pilnuje test granic modułów.
 */
export { readParentCosts } from "./costs";
export { listKidDecks, listKidProfiles } from "./kid";
export { getLearningOverview } from "./learning-overview";
export { readParentWorkCard } from "./parent-work-card";
export { getProgress } from "./reporting";
