import { messages, type SubjectCatalogDto } from "@learning/contracts";

type CatalogSubject = SubjectCatalogDto["subjects"][number];

/**
 * Informacje o usługach, do których trafia lekcja przedmiotu generowanego agentem puli
 * (wpis katalogu z `checkService`). Pola `null`, gdy przedmiot nie ma nadpisania — wtedy
 * obowiązuje dotychczasowy komunikat (usługa katalogowa).
 */
export interface SubjectServiceInfo {
  /** Usługi generujące, np. „host · model, host · model”. */
  generationServices: string | null;
  /**
   * Usługa, do której trafiają tematy zdań: sam model agenta (pierwsza z `generationServices`; usługa
   * etapu zagadnień i runu historyjki tematów nie dostaje).
   */
  themesService: string | null;
  /** Komunikat o generowaniu (materiał trafia do usług z `generationServices`). */
  generation: string | null;
  /** Komunikat o drugim modelu rozwiązującym ćwiczenia; wariant z materiałem wg polityki checkera. */
  check: string | null;
  /** Komunikat o usłudze oceniającej odpowiedzi próbne do pytań otwartych (grader); tylko przy `check`. */
  openCheck: string | null;
}

export function subjectServiceInfo(subject: CatalogSubject | undefined): SubjectServiceInfo {
  const checkService = subject?.checkService;
  const list = subject?.generationServices ?? [];
  const services = list.length > 0 ? list.join(", ") : null;
  const themesService = list[0] ?? null;
  if (!checkService) return { generationServices: services, themesService, generation: null, check: null, openCheck: null };
  const checkTemplate = subject.checkServiceIncludesMaterial ? messages.lessons.checkServiceInfoWithMaterial : messages.lessons.checkServiceInfo;
  // Kilka usług (agent i UMIEM_LLM) — liczba mnoga.
  const generationTemplate = list.length > 1 ? messages.lessons.generationServicesInfo : messages.lessons.generationServiceInfo;
  return {
    generationServices: services,
    themesService,
    generation: services ? generationTemplate.replace("{service}", () => services) : null,
    check: checkTemplate.replace("{service}", () => checkService),
    openCheck: subject.openCheckService ? messages.lessons.openCheckServiceInfo.replace("{service}", () => subject.openCheckService!) : null,
  };
}
