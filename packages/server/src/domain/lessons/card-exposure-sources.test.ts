import { describe, expect, it } from "vitest";
import { cardExposureSources } from "./card-exposure-sources";
import { englishGrammarSubject } from "./subjects/english-grammar/module";
import { schoolSubject } from "./subjects/school/module";
import type { LearningObjective, LessonTopic, SubjectModule } from "./types";

function objective(id: string, body: string): LearningObjective {
  return {
    id,
    titlePl: id,
    descriptionEn: id,
    cards: [{ title: "Karta", body }],
    errorCategories: [],
    hints: {},
    exerciseTypes: [],
  };
}

const topic: Pick<LessonTopic, "objectives"> = {
  objectives: [objective("o1", "Card one."), objective("o2", "Card two."), objective("o3", "x")],
};

const subject: Pick<SubjectModule, "cardExposureTexts"> = {
  cardExposureTexts: (cards) => cards.map((card) => card.body).filter((body) => body.endsWith(".")),
};

describe("cardExposureSources", () => {
  it("zagadnienie → teksty z kart; zagadnienia bez tekstów pomijane", () => {
    expect(cardExposureSources(subject, topic)).toEqual({ o1: ["Card one."], o2: ["Card two."] });
  });

  it("przedmiot bez haka nie daje źródeł", () => {
    expect(cardExposureSources({}, topic)).toEqual({});
  });

  it("gramatyka i przedmioty szkolne nie mają haka", () => {
    expect(englishGrammarSubject.cardExposureTexts).toBeUndefined();
    expect(schoolSubject.cardExposureTexts).toBeUndefined();
  });
});
