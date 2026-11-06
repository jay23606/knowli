import { describe, expect, it } from "vitest";
import { messages, type SubjectCatalogDto } from "@learning/contracts";
import { subjectServiceInfo } from "./lesson-service-info";

type CatalogSubject = SubjectCatalogDto["subjects"][number];

const CHECK = "openrouter.ai · checker";
const OPEN = "openrouter.ai · grader";
const school: CatalogSubject = {
  id: "school", titlePl: "Szkoła", creation: "material", subjectTitleRequired: true, topics: [],
};

describe("subjectServiceInfo (komunikaty o usługach agenta puli)", () => {
  it("wariant z materiałem: nowy tekst drugiego modelu i komunikat o ocenie pytań otwartych", () => {
    const info = subjectServiceInfo({
      ...school, generationServices: ["openrouter.ai · a"], checkService: CHECK, checkServiceIncludesMaterial: true, openCheckService: OPEN,
    });
    expect(info.check).toBe(messages.lessons.checkServiceInfoWithMaterial.replace("{service}", CHECK));
    // Treść jasno mówi, że to próbne odpowiedzi modelu, i zapewnia o danych dziecka.
    expect(info.check).toBe(
      `Podczas przygotowania lekcji drugi model (${CHECK}) rozwiązuje ćwiczenia na próbę, sprawdza podpowiedzi i pisze próbne odpowiedzi na pytania otwarte. Dostaje ćwiczenia i materiał lekcji — nigdy imienia, wieku ani odpowiedzi dziecka.`,
    );
    expect(info.openCheck).toBe(messages.lessons.openCheckServiceInfo.replace("{service}", OPEN));
    expect(info.openCheck).toContain(OPEN);
  });

  it("bez openCheckService: openCheck null", () => {
    expect(subjectServiceInfo({ ...school, checkService: CHECK, checkServiceIncludesMaterial: true }).openCheck).toBeNull();
  });

  it("bez checkService oraz bez przedmiotu: openCheck null, pozostałe pola bez zmian", () => {
    expect(subjectServiceInfo({ ...school, openCheckService: OPEN })).toMatchObject({ check: null, openCheck: null });
    expect(subjectServiceInfo(undefined)).toEqual({
      generationServices: null, themesService: null, generation: null, check: null, openCheck: null,
    });
  });

  it("wartość {service} z dolarem jest wstawiana dosłownie", () => {
    const info = subjectServiceInfo({ ...school, checkService: CHECK, openCheckService: "h · m$&" });
    expect(info.openCheck).toContain("h · m$&");
  });
});
