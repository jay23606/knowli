// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderKid, screen } from "../test/render-kid";
import { answerTokens, LessonAnswerComparison } from "./AnswerSegments";

afterEach(cleanup);

describe("answerTokens", () => {
  it("skleja segmenty jednego słowa i oddziela odstępy", () => {
    expect(answerTokens([
      { text: "I live in a h", state: "plain" },
      { text: "a", state: "pill" },
      { text: "useboat.", state: "plain" },
    ])).toEqual([
      { kind: "word", parts: [{ text: "I", state: "plain" }] },
      { kind: "space", text: " " },
      { kind: "word", parts: [{ text: "live", state: "plain" }] },
      { kind: "space", text: " " },
      { kind: "word", parts: [{ text: "in", state: "plain" }] },
      { kind: "space", text: " " },
      { kind: "word", parts: [{ text: "a", state: "plain" }] },
      { kind: "space", text: " " },
      { kind: "word", parts: [{ text: "h", state: "plain" }, { text: "a", state: "pill" }, { text: "useboat.", state: "plain" }] },
    ]);
  });

  it("fragment „nie na temat” zostaje jednym zaznaczeniem", () => {
    const offTopic = { text: "Wczoraj grałem w piłkę.", state: "offtopic" as const };
    expect(answerTokens([{ text: "Południk. ", state: "plain" }, offTopic])).toEqual([
      { kind: "word", parts: [{ text: "Południk.", state: "plain" }] },
      { kind: "space", text: " " },
      { kind: "offtopic", segment: offTopic },
    ]);
  });
});

describe("LessonAnswerComparison", () => {
  it("krótka odpowiedź: etykiety z boku, zaznaczona tylko inna litera w obu odpowiedziach", () => {
    renderKid(<LessonAnswerComparison
      answerSegments={[{ text: "h", state: "plain" }, { text: "a", state: "pill" }, { text: "useboat", state: "plain" }]}
      correctText="houseboat"
      correctSegments={[{ text: "h", state: "plain" }, { text: "o", state: "pill" }, { text: "useboat", state: "plain" }]}
    />);
    expect(screen.getByTestId("kid-lesson-compare").dataset.layout).toBe("inline");
    const given = screen.getByTestId("kid-lesson-answer-segments");
    const correct = screen.getByTestId("kid-lesson-correct");
    // Czytnik ekranu dostaje całe słowo naraz; kawałki z zaznaczeniem są ukryte przed nim.
    expect(given.querySelector(".kid-visually-hidden")?.textContent).toBe("hauseboat");
    expect(correct.querySelector(".kid-visually-hidden")?.textContent).toBe("houseboat");
    expect(given.querySelector("[aria-hidden='true']")?.textContent).toBe("hauseboat");
    expect([...given.querySelectorAll("[data-testid='kid-spelling-pill']")].map((pill) => pill.textContent)).toEqual(["a"]);
    expect([...correct.querySelectorAll("[data-testid='kid-spelling-pill']")].map((pill) => pill.textContent)).toEqual(["o"]);
    // Słowo to jeden element — nie łamie się między literami.
    expect(given.querySelectorAll(".kid-lesson-word")).toHaveLength(1);
  });

  it("dłuższa odpowiedź: etykiety nad tekstem; poprawna bez zaznaczeń, gdy serwer ich nie dał", () => {
    renderKid(<LessonAnswerComparison
      answerSegments={[{ text: "she ", state: "plain" }, { text: "play", state: "pill" }, { text: " football", state: "plain" }]}
      correctText="she plays football"
      correctSegments={null}
    />);
    expect(screen.getByTestId("kid-lesson-compare").dataset.layout).toBe("stacked");
    const correct = screen.getByTestId("kid-lesson-correct");
    expect(correct.querySelector(".kid-visually-hidden")?.textContent).toBe("she plays football");
    expect(correct.querySelectorAll("[data-testid='kid-spelling-pill']")).toHaveLength(0);
  });

  it("długie pojedyncze słowo stoi pod etykietą na całą szerokość", () => {
    renderKid(<LessonAnswerComparison
      answerSegments={[{ text: "unfortunatly", state: "pill" }]}
      correctText="unfortunately"
      correctSegments={null}
    />);
    expect(screen.getByTestId("kid-lesson-compare").dataset.layout).toBe("stacked");
  });

  it("zaznaczenie kilku słów (lekcja szkolna) to zaznaczenie każdego słowa, a czytnik dostaje cały tekst", () => {
    renderKid(<LessonAnswerComparison
      answerSegments={[{ text: "Roślina robi cukry", state: "plain" }, { text: " i jest zielona.", state: "pill" }]}
      correctText={null}
      correctSegments={null}
    />);
    const given = screen.getByTestId("kid-lesson-answer-segments");
    expect([...given.querySelectorAll("[data-testid='kid-spelling-pill']")].map((pill) => pill.textContent)).toEqual(["i", "jest", "zielona."]);
    expect(given.querySelector(".kid-visually-hidden")?.textContent).toBe("Roślina robi cukry i jest zielona.");
  });
});
