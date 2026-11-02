// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderKid, screen } from "../../test/render-kid";
import type { TaskDto, TaskPrompt } from "@learning/contracts";
import { makeExerciseProps } from "../../test/exercise-fixtures";
import { ExerciseGuidanceProvider } from "../exercise-guidance";
import { LessonCardView } from "./LessonCardView";
import { LessonChoiceView } from "./LessonChoiceView";
import { LessonClozeView } from "./LessonClozeView";
import { LessonGapView } from "./LessonGapView";
import { LessonGroupView } from "./LessonGroupView";
import { LessonListenChoiceView } from "./LessonListenChoiceView";
import { LessonMatchView } from "./LessonMatchView";
import { LessonNoticeView } from "./LessonNoticeView";
import { LessonOrderView } from "./LessonOrderView";
import { LessonSentenceView } from "./LessonSentenceView";
import { LessonShortAnswerView } from "./LessonShortAnswerView";
import { LessonStoryView } from "./LessonStoryView";
import { LessonStoryQuestionView } from "./LessonStoryQuestionView";

afterEach(cleanup);

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function task(prompt: TaskPrompt): TaskDto {
  return { taskId: id(1), sessionId: id(2), ordinal: 1, exerciseType: prompt.kind as TaskDto["exerciseType"], direction: null, state: "issued", prompt, remainingAssessed: 1 };
}

describe("lesson exercise views", () => {
  it("lesson card completes the presentation and uses the shared action button", () => {
    const props = makeExerciseProps(task({ kind: "lesson_card", card: { title: "Reguła", body: "Dodaj -s", examples: ["He plays."] } }));
    renderKid(<LessonCardView {...props} />);
    expect(screen.getByTestId("kid-lesson-card-title").textContent).toBe("Reguła");
    const next = screen.getByTestId("kid-lesson-next");
    expect(next.tagName).toBe("BUTTON");
    fireEvent.click(next);
    expect(props.handlers.onComplete).toHaveBeenCalledOnce();
  });

  it("lesson card puts „Posłuchaj karty” in the card header, not in the instruction row (design szkoły §12.4)", () => {
    const props = makeExerciseProps(task({ kind: "lesson_card", card: { title: "Reguła", body: "Dodaj -s", examples: [] } }));
    renderKid(
      <ExerciseGuidanceProvider value={<button type="button" data-testid="listen-card">listen</button>}>
        <LessonCardView {...props} />
      </ExerciseGuidanceProvider>,
    );
    const listen = screen.getByTestId("listen-card");
    expect(screen.getByTestId("kid-lesson-card-header").contains(listen)).toBe(true);
    expect(screen.getAllByTestId("listen-card")).toHaveLength(1);
  });

  it("lesson card without recording has no header row", () => {
    renderKid(<LessonCardView {...makeExerciseProps(task({ kind: "lesson_card", card: { title: "Reguła", body: "Dodaj -s", examples: [] } }))} />);
    expect(screen.queryByTestId("kid-lesson-card-header")).toBeNull();
  });

  const story = (questionAudioAssetId?: string): TaskPrompt => ({
    kind: "lesson_story",
    story: { sentences: ["Sam has a red bike.", "He rides it to school."] },
    contentLocale: "en-GB",
    ...(questionAudioAssetId === undefined ? {} : { questionAudioAssetId }),
  });

  it("story view renders the title, sentences with lang, the questions lead-in and next", () => {
    renderKid(<LessonStoryView {...makeExerciseProps(task(story()))} />);
    const article = screen.getByTestId("kid-lesson-story");
    expect(article.tagName).toBe("ARTICLE");
    const title = screen.getByTestId("kid-lesson-story-title");
    expect(title.textContent).toBe("Historyjka");
    expect(title.id).not.toBe("");
    expect(article.getAttribute("aria-labelledby")).toBe(title.id);
    const text = screen.getByTestId("kid-lesson-story-text");
    expect(text.textContent).toBe("Sam has a red bike. He rides it to school.");
    expect(text.getAttribute("lang")).toBe("en-GB");
    const lead = screen.getByTestId("kid-lesson-story-lead");
    expect(lead.textContent).toBe("Potem odpowiesz na pytania.");
    expect(lead.getAttribute("lang")).toBeNull();
    const next = screen.getByTestId("kid-lesson-next");
    expect(next.tagName).toBe("BUTTON");
    expect(next.textContent).toBe("Dalej");
    expect(document.activeElement).toBe(next);
  });

  it("story view shows the listen button beside the title only with a recording", () => {
    renderKid(
      <ExerciseGuidanceProvider value={<button type="button" data-testid="listen-story">listen</button>}>
        <LessonStoryView {...makeExerciseProps(task(story("asset-story")))} />
      </ExerciseGuidanceProvider>,
    );
    const listen = screen.getByTestId("listen-story");
    expect(screen.getByTestId("kid-lesson-story-listen").contains(listen)).toBe(true);
    expect(screen.getByTestId("kid-lesson-story-header").contains(listen)).toBe(true);
    // Odsłuch tylko w nagłówku, nie drugi raz w wierszu instrukcji ramy.
    expect(screen.getAllByTestId("listen-story")).toHaveLength(1);
  });

  it("story view keeps the empty listen column without a recording", () => {
    renderKid(<LessonStoryView {...makeExerciseProps(task(story()))} />);
    const header = screen.getByTestId("kid-lesson-story-header");
    const column = screen.getByTestId("kid-lesson-story-listen");
    expect(header.contains(column)).toBe(true);
    expect(column.childElementCount).toBe(0);
    expect(header.contains(screen.getByTestId("kid-lesson-story-title"))).toBe(true);
  });

  it("story view next completes the presentation", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const props = makeExerciseProps(task(story("asset-story")));
      renderKid(<LessonStoryView {...props} />);
      act(() => { vi.advanceTimersByTime(300); });
      fireEvent.click(screen.getByTestId("kid-lesson-next"));
      expect(props.handlers.onComplete).toHaveBeenCalledOnce();
      expect(props.handlers.onAnswerChoice).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("story view next ignores activation during the cooldown after mount", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const props = makeExerciseProps(task(story()));
      renderKid(<LessonStoryView {...props} />);
      const next = screen.getByTestId("kid-lesson-next");
      // Drugie dotknięcie podwójnego dotyku „Dalej” poprzedniego wyniku trafia w nowy przycisk.
      expect(next.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(next);
      fireEvent.keyDown(next, { key: "Enter" });
      act(() => { vi.advanceTimersByTime(200); });
      fireEvent.click(next);
      expect(props.handlers.onComplete).not.toHaveBeenCalled();

      act(() => { vi.advanceTimersByTime(100); });
      expect(next.getAttribute("aria-disabled")).toBeNull();
      fireEvent.click(next);
      expect(props.handlers.onComplete).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  const storyQuestion = (): TaskPrompt => ({
    kind: "lesson_story_question",
    question: "Kto ma rower?",
    options: [{ id: id(3), text: "Sam" }, { id: id(4), text: "Jego siostra" }, { id: id(5), text: "Nikt" }],
    story: { sentences: ["Sam has a red bike.", "He rides it to school."] },
    contentLocale: "en-GB",
    questionAudioAssetId: "asset-story",
  });
  const follows = (first: Node, second: Node) => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("story question renders question, then options, then the story in DOM order", () => {
    renderKid(<LessonStoryQuestionView {...makeExerciseProps(task(storyQuestion()))} />);
    const instruction = screen.getByTestId("kid-instruction");
    expect(instruction.textContent).toContain("Kto ma rower?");
    const options = screen.getAllByTestId("kid-option");
    expect(options.map((option) => option.textContent)).toEqual(["Sam", "Jego siostra", "Nikt"]);
    const reread = screen.getByTestId("kid-lesson-story-reread");
    expect(reread.tagName).toBe("SECTION");
    expect(follows(instruction, options[0]!)).toBe(true);
    expect(follows(options[2]!, reread)).toBe(true);
    expect(reread.contains(screen.getByTestId("kid-lesson-story-text"))).toBe(true);
    expect(screen.getByTestId("kid-lesson-story-text").textContent).toBe("Sam has a red bike. He rides it to school.");
  });

  it("story question text and options have no English lang; story text has lang", () => {
    renderKid(<LessonStoryQuestionView {...makeExerciseProps(task(storyQuestion()))} />);
    const notEnglish = (element: Element) => element.closest("[lang]")?.getAttribute("lang") !== "en-GB";
    expect(notEnglish(screen.getByTestId("kid-instruction"))).toBe(true);
    for (const option of screen.getAllByTestId("kid-option")) {
      expect(option.getAttribute("lang")).toBeNull();
      expect(notEnglish(option)).toBe(true);
    }
    expect(screen.getByTestId("kid-lesson-story-text").getAttribute("lang")).toBe("en-GB");
    expect(notEnglish(screen.getByTestId("kid-lesson-story-title"))).toBe(true);
  });

  it("choosing an option answers immediately", () => {
    const props = makeExerciseProps(task(storyQuestion()));
    renderKid(<LessonStoryQuestionView {...props} />);
    fireEvent.click(screen.getAllByTestId("kid-option")[1]!);
    expect(props.handlers.onAnswerChoice).toHaveBeenCalledWith(id(4));
    expect(props.handlers.onComplete).not.toHaveBeenCalled();
  });

  it("options are disabled while busy", () => {
    const props = makeExerciseProps(task(storyQuestion()), { busy: true });
    renderKid(<LessonStoryQuestionView {...props} />);
    const options = screen.getAllByTestId("kid-option");
    for (const option of options) expect((option as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(options[0]!);
    expect(props.handlers.onAnswerChoice).not.toHaveBeenCalled();
  });

  it("story question has no dont-remember, skip or check action", () => {
    renderKid(<LessonStoryQuestionView {...makeExerciseProps(task(storyQuestion()))} />);
    expect(screen.queryByTestId("kid-not-remember")).toBeNull();
    expect(screen.queryByTestId("kid-skip")).toBeNull();
    expect(screen.queryByTestId("kid-lesson-check")).toBeNull();
    expect(screen.queryByTestId("kid-lesson-next")).toBeNull();
  });

  it("reread section is labelled by its title", () => {
    renderKid(
      <ExerciseGuidanceProvider value={<button type="button" data-testid="listen-story">listen</button>}>
        <LessonStoryQuestionView {...makeExerciseProps(task(storyQuestion()))} />
      </ExerciseGuidanceProvider>,
    );
    const reread = screen.getByTestId("kid-lesson-story-reread");
    const title = screen.getByTestId("kid-lesson-story-title");
    expect(title.textContent).toBe("Historyjka — przeczytaj jeszcze raz");
    expect(title.id).not.toBe("");
    expect(reread.getAttribute("aria-labelledby")).toBe(title.id);
    // Odsłuch historyjki w nagłówku bloku, nie drugi raz w wierszu pytania.
    const listen = screen.getByTestId("listen-story");
    expect(screen.getByTestId("kid-lesson-story-listen").contains(listen)).toBe(true);
    expect(screen.getAllByTestId("listen-story")).toHaveLength(1);
    expect(screen.getByTestId("kid-instruction").contains(listen)).toBe(false);
  });

  it("story question leaves the listen column empty without guidance", () => {
    const { questionAudioAssetId: _omit, ...prompt } = storyQuestion() as Extract<TaskPrompt, { kind: "lesson_story_question" }>;
    renderKid(<LessonStoryQuestionView {...makeExerciseProps(task(prompt))} />);
    expect(screen.getByTestId("kid-lesson-story-listen").childElementCount).toBe(0);
  });

  it("choice answers immediately by option id", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_choice", instructionPl: "Wybierz", stem: "He ___ football.",
      options: [{ id: id(3), text: "plays" }, { id: id(4), text: "play" }],
    }));
    renderKid(<LessonChoiceView {...props} />);
    fireEvent.click(screen.getAllByTestId("kid-option")[0]!);
    expect(props.handlers.onAnswerChoice).toHaveBeenCalledWith(id(3));
    expect(screen.queryByTestId("kid-lesson-check")).toBeNull();
  });

  it("choice with a person pictogram shows the pictogram above the stem", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_choice", instructionPl: "Kto to jest? Wybierz", visualSubject: "girl", stem: "___ is happy.",
      options: [{ id: id(3), text: "She" }, { id: id(4), text: "He" }],
    }));
    renderKid(<LessonChoiceView {...props} />);
    expect(screen.getByTestId("kid-lesson-visual").textContent).toBe("👧");
    expect(screen.getByTestId("kid-lesson-visual").getAttribute("aria-label")).toBe("Dziewczynka");
    expect(screen.getByTestId("kid-lesson-stem").textContent).toBe("___ is happy.");
  });

  it("notice word sends its segment id without local grading", () => {
    const props = makeExerciseProps(task({ kind: "lesson_notice", instructionPl: "Dotknij", segments: [[{ id: id(3), text: "He" }]] }));
    renderKid(<LessonNoticeView {...props} />);
    fireEvent.click(screen.getByTestId("kid-lesson-notice-word"));
    expect(props.handlers.onAnswerChoice).toHaveBeenCalledWith(id(3));
    expect(screen.getByTestId("kid-lesson-notice-word").className).not.toMatch(/correct|wrong/);
  });

  it("notice word marks a server outcome with an icon, never a text glyph", () => {
    const outcomes = new Map<string, "correct" | "wrong">([[id(3), "correct"], [id(4), "wrong"]]);
    const props = makeExerciseProps(
      task({ kind: "lesson_notice", instructionPl: "Dotknij", segments: [[{ id: id(3), text: "He" }, { id: id(4), text: "plays" }, { id: id(5), text: "ball" }]] }),
      { optionOutcomes: outcomes },
    );
    renderKid(<LessonNoticeView {...props} />);
    const words = screen.getAllByTestId("kid-lesson-notice-word");
    const markers = screen.getAllByTestId("kid-lesson-notice-outcome");
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(marker.getAttribute("aria-hidden")).toBe("true");
      expect(marker.querySelector("svg.kid-icon")).not.toBeNull();
      expect(marker.textContent).toBe("");
    }
    expect(markers[0]!.getAttribute("data-outcome")).toBe("correct");
    expect(markers[1]!.getAttribute("data-outcome")).toBe("wrong");
    expect(words[2]!.querySelector("[data-testid='kid-lesson-notice-outcome']")).toBeNull();
    expect(words.map((word) => word.textContent)).toEqual(["He", "plays", "ball"]);
  });

  it("short answer sends a choice immediately", () => {
    const props = makeExerciseProps(task({ kind: "lesson_short_answer", question: "Does he play?", options: [{ id: id(5), text: "Yes" }] }));
    renderKid(<LessonShortAnswerView {...props} />);
    expect(screen.getByTestId("kid-lesson-short-answer").tagName).toBe("UL");
    fireEvent.click(screen.getByTestId("kid-option"));
    expect(props.handlers.onAnswerChoice).toHaveBeenCalledWith(id(5));
  });

  it("order submits ordered item ids, including duplicate visible words", () => {
    const props = makeExerciseProps(task({ kind: "lesson_order", instructionPl: "Ułóż", items: [{ id: id(3), text: "play" }, { id: id(4), text: "play" }] }));
    renderKid(<LessonOrderView {...props} />);
    fireEvent.click(screen.getAllByTestId("kid-lesson-order-block")[1]!);
    fireEvent.click(screen.getAllByTestId("kid-lesson-order-block")[0]!);
    fireEvent.click(screen.getByTestId("kid-lesson-check"));
    expect(props.handlers.onAnswerSequence).toHaveBeenCalledWith([id(4), id(3)]);
  });

  const matchTask = () => task({
    kind: "lesson_match", instructionPl: "Połącz",
    left: [{ id: id(3), text: "równik" }, { id: id(4), text: "południk" }, { id: id(5), text: "biegun" }],
    right: [{ id: id(6), text: "łączy bieguny" }, { id: id(7), text: "dzieli półkule" }, { id: id(8), text: "koniec osi" }, { id: id(9), text: "nad morzem" }],
  });
  const leftTile = (i: number) => screen.getAllByTestId("kid-lesson-match-left")[i]! as HTMLButtonElement;
  const rightTile = (i: number) => screen.getAllByTestId("kid-lesson-match-right")[i]! as HTMLButtonElement;
  const matchHint = () => screen.getByTestId("kid-lesson-match-hint");
  const matchLines = () => screen.queryAllByTestId("kid-lesson-match-line");
  const pressedTiles = () => document.querySelectorAll("[data-testid^='kid-lesson-match-'][aria-pressed='true']");

  it("match: łączenie od lewej i od prawej, „Sprawdź” przy komplecie z wolnym dystraktorem", () => {
    const props = makeExerciseProps(matchTask());
    renderKid(<LessonMatchView {...props} />);
    const check = screen.getByTestId("kid-lesson-check") as HTMLButtonElement;
    expect(pressedTiles()).toHaveLength(0);
    expect(matchHint().textContent).toBe("");
    expect(leftTile(0).getAttribute("data-item-id")).toBe(id(3));
    expect(rightTile(3).getAttribute("data-item-id")).toBe(id(9));
    fireEvent.click(leftTile(0));
    expect(leftTile(0).getAttribute("aria-pressed")).toBe("true");
    expect(leftTile(0).classList.contains("kid-lesson-pair__item--selected")).toBe(true);
    expect(matchHint().textContent).toBe("Teraz dotknij tego, co pasuje.");
    expect(props.handlers.onEdit).toHaveBeenCalled();
    fireEvent.click(rightTile(1));
    expect(matchLines()).toHaveLength(1);
    expect(matchHint().textContent).toBe("");
    expect(leftTile(0).classList.contains("kid-lesson-block--placed")).toBe(true);
    expect(rightTile(1).classList.contains("kid-lesson-block--placed")).toBe(true);
    // Od prawej: najpierw odpowiedź, potem pojęcie.
    fireEvent.click(rightTile(0));
    fireEvent.click(leftTile(1));
    expect(matchLines()).toHaveLength(2);
    expect(check.disabled).toBe(true);
    fireEvent.click(leftTile(2));
    fireEvent.click(rightTile(2));
    expect(matchLines()).toHaveLength(3);
    expect(rightTile(3).classList.contains("kid-lesson-block--placed")).toBe(false);
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    expect(props.handlers.onAnswerAssignment).toHaveBeenCalledWith([
      { itemId: id(3), targetId: id(7) }, { itemId: id(4), targetId: id(6) }, { itemId: id(5), targetId: id(8) },
    ]);
  });

  it("match: zaznaczenie przez kliknięcia — zdjęcie i przeniesienie w kolumnie", () => {
    renderKid(<LessonMatchView {...makeExerciseProps(matchTask())} />);
    fireEvent.click(leftTile(0));
    fireEvent.click(leftTile(0));
    expect(pressedTiles()).toHaveLength(0);
    fireEvent.click(leftTile(0));
    fireEvent.click(leftTile(1));
    expect([...pressedTiles()]).toEqual([leftTile(1)]);
    expect(leftTile(0).classList.contains("kid-lesson-pair__item--selected")).toBe(false);
    expect(matchLines()).toHaveLength(0);
  });

  it("match: nowa para zastępuje stare pary obu kafelków", () => {
    renderKid(<LessonMatchView {...makeExerciseProps(task({
      kind: "lesson_match", instructionPl: "Połącz",
      left: [{ id: id(3), text: "a" }, { id: id(4), text: "b" }, { id: id(5), text: "c" }],
      right: [{ id: id(6), text: "x" }, { id: id(7), text: "y" }, { id: id(8), text: "z" }],
    }))} />);
    fireEvent.click(leftTile(0));
    fireEvent.click(rightTile(0));
    fireEvent.click(leftTile(1));
    fireEvent.click(rightTile(1));
    expect(matchLines()).toHaveLength(2);
    fireEvent.click(leftTile(0));
    fireEvent.click(rightTile(1));
    expect(matchLines().map((line) => [line.getAttribute("data-left-id"), line.getAttribute("data-right-id")])).toEqual([[id(3), id(7)]]);
    expect(leftTile(1).classList.contains("kid-lesson-block--placed")).toBe(false);
    expect(rightTile(0).classList.contains("kid-lesson-block--placed")).toBe(false);
  });

  it("match: nazwy dostępne z treści", () => {
    const en = "en-GB" as const;
    // jsdom zwraca pusty `display` spanów, więc dom-accessibility-api wstawia spację
    // między elementami („pies , połącz z: dog”); przeglądarka liczy spany inline bez
    // separatora, czyli jak `textContent` — sprawdzamy oba.
    const named = (expected: string) => {
      const button = screen.getByRole("button", { name: (name) => name.replace(/\s+(?=,)/g, "") === expected });
      expect(button.textContent).toBe(expected);
      return button;
    };
    renderKid(<LessonMatchView {...makeExerciseProps(task({
      kind: "lesson_match", instructionPl: "Połącz", contentLocale: en,
      left: [{ id: id(3), text: "dog" }, { id: id(4), text: "cat" }, { id: id(5), text: "fish" }],
      right: [{ id: id(6), text: "pies" }, { id: id(7), text: "kot" }, { id: id(8), text: "ryba" }],
    }))} />);
    for (const tile of screen.getAllByTestId("kid-lesson-match-left")) {
      expect(tile.tagName).toBe("BUTTON");
      expect(tile.hasAttribute("lang")).toBe(false);
      expect(tile.hasAttribute("aria-label")).toBe(false);
      const spans = tile.querySelectorAll("span");
      expect(spans).toHaveLength(1);
      expect(spans[0]!.getAttribute("lang")).toBe(en);
    }
    for (const tile of screen.getAllByTestId("kid-lesson-match-right")) {
      expect(tile.tagName).toBe("BUTTON");
      expect(tile.hasAttribute("lang")).toBe(false);
      expect(tile.hasAttribute("aria-label")).toBe(false);
      expect(tile.querySelectorAll("span")).toHaveLength(1);
      expect(tile.querySelectorAll("[lang]")).toHaveLength(0);
    }
    fireEvent.click(leftTile(0));
    expect(named("pies, połącz z: dog")).toBe(rightTile(0));
    expect(rightTile(0).querySelector(".kid-visually-hidden span[lang]")?.getAttribute("lang")).toBe(en);
    expect(screen.getByRole("button", { name: "dog" })).toBe(leftTile(0));
    fireEvent.click(rightTile(0));
    expect(named("dog, połączone z: pies")).toBe(leftTile(0));
    expect(named("pies, połączone z: dog")).toBe(rightTile(0));
    expect(leftTile(0).querySelector(".kid-visually-hidden [lang]")).toBeNull();
    expect(screen.getByRole("button", { name: "cat" })).toBe(leftTile(1));
    expect(screen.getByRole("list", { name: "Słowa do połączenia" }).contains(leftTile(0))).toBe(true);
    expect(screen.getByRole("list", { name: "Odpowiedzi do połączenia" }).contains(rightTile(0))).toBe(true);
  });

  it("match: wysłanie czyści zaznaczenie; dok i busy wyłączają kafelki i podpowiedź", () => {
    const props = makeExerciseProps(matchTask());
    const view = renderKid(<LessonMatchView {...props} />);
    for (const i of [0, 1, 2]) {
      fireEvent.click(leftTile(i));
      fireEvent.click(rightTile(i));
    }
    fireEvent.click(rightTile(3));
    expect(rightTile(3).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("kid-lesson-check"));
    expect(props.handlers.onAnswerAssignment).toHaveBeenCalledOnce();
    expect(pressedTiles()).toHaveLength(0);
    expect(matchHint().textContent).toBe("");
    view.rerender(<LessonMatchView {...props} dock={<span>wynik</span>} />);
    const tiles = [...screen.getAllByTestId("kid-lesson-match-left"), ...screen.getAllByTestId("kid-lesson-match-right")];
    expect(tiles.every((tile) => (tile as HTMLButtonElement).disabled)).toBe(true);
    expect(matchLines()).toHaveLength(3);
    view.unmount();

    const busyView = renderKid(<LessonMatchView {...props} />);
    fireEvent.click(leftTile(0));
    expect(matchHint().textContent).toBe("Teraz dotknij tego, co pasuje.");
    busyView.rerender(<LessonMatchView {...props} busy />);
    expect(matchHint().textContent).toBe("");
    expect(leftTile(0).disabled).toBe(true);
  });

  it("match: po retry pary i linie znikają, a fokus stoi na pierwszym kafelku", () => {
    const props = makeExerciseProps(matchTask());
    const view = renderKid(<LessonMatchView {...props} />);
    fireEvent.click(leftTile(0));
    fireEvent.click(rightTile(0));
    fireEvent.click(rightTile(1));
    expect(matchLines()).toHaveLength(1);
    view.rerender(<LessonMatchView {...props} dock={<span>wynik</span>} />);
    view.rerender(<LessonMatchView {...props} />);
    expect(matchLines()).toHaveLength(0);
    expect(pressedTiles()).toHaveLength(0);
    expect(document.querySelectorAll(".kid-lesson-block--placed")).toHaveLength(0);
    expect(document.activeElement).toBe(leftTile(0));
  });

  it("group: elementy trafiają do aktywnej grupy, a „Sprawdź” wysyła przypisania element → grupa", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_group", instructionPl: "Pogrupuj",
      groups: [{ id: id(3), text: "ssaki" }, { id: id(4), text: "ptaki" }],
      items: [{ id: id(5), text: "sowa" }, { id: id(6), text: "pies" }, { id: id(7), text: "kot" }, { id: id(8), text: "wróbel" }],
    }));
    renderKid(<LessonGroupView {...props} />);
    const check = screen.getByTestId("kid-lesson-check") as HTMLButtonElement;
    fireEvent.click(screen.getByText("pies"));
    fireEvent.click(screen.getByText("kot"));
    fireEvent.click(screen.getAllByTestId("kid-lesson-group-target")[1]!);
    expect(screen.getAllByTestId("kid-lesson-group-target")[1]!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("sowa"));
    expect(check.disabled).toBe(true);
    fireEvent.click(screen.getByText("wróbel"));
    fireEvent.click(check);
    expect(props.handlers.onAnswerAssignment).toHaveBeenCalledWith([
      { itemId: id(5), targetId: id(4) }, { itemId: id(6), targetId: id(3) }, { itemId: id(7), targetId: id(3) }, { itemId: id(8), targetId: id(4) },
    ]);
  });

  it("group: po wyniku (dock) przyciski są wyłączone", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_group", instructionPl: "Pogrupuj",
      groups: [{ id: id(3), text: "ssaki" }, { id: id(4), text: "ptaki" }],
      items: [{ id: id(5), text: "sowa" }, { id: id(6), text: "pies" }, { id: id(7), text: "kot" }, { id: id(8), text: "wróbel" }],
    }));
    renderKid(<LessonGroupView {...props} dock={<span>wynik</span>} />);
    expect(screen.getAllByTestId("kid-lesson-group-item").every((el) => (el as HTMLButtonElement).disabled)).toBe(true);
  });

  const clozeTask = () => task({
    kind: "lesson_cloze", instructionPl: "Uzupełnij tekst",
    segments: [{ text: "Roślina pobiera " }, { gapId: id(3) }, { text: " z powietrza i " }, { gapId: id(4) }, { text: " z gleby." }],
    words: [{ id: id(5), text: "wodę" }, { id: id(6), text: "tlen" }, { id: id(7), text: "dwutlenek węgla" }],
  });

  it("cloze: luki są przyciskami w tekście; słowo trafia do aktywnej luki, a aktywna przechodzi dalej", () => {
    const props = makeExerciseProps(clozeTask());
    renderKid(<LessonClozeView {...props} />);
    const text = screen.getByTestId("kid-lesson-cloze-text");
    expect(text.querySelectorAll("button")).toHaveLength(2);
    expect(document.querySelectorAll("[data-testid^='kid-lesson-cloze-'][data-testid$='-slot']")).toHaveLength(0);
    const check = screen.getByTestId("kid-lesson-check") as HTMLButtonElement;
    const [first, second] = screen.getAllByTestId("kid-lesson-cloze-gap");
    expect(first!.getAttribute("aria-pressed")).toBe("true");
    expect(first!.classList.contains("kid-lesson-cloze__gap--active")).toBe(true);
    expect(first!.querySelector(".kid-lesson-cloze__gap-mark")!.textContent).toBe("?");
    expect(second!.classList.contains("kid-lesson-cloze__gap--empty")).toBe(true);
    expect(screen.getByRole("button", { name: "Luka 2: pusta, wybierz słowo" })).toBe(second);
    fireEvent.click(screen.getByText("dwutlenek węgla"));
    const filled = screen.getByRole("button", { name: "Luka 1: dwutlenek węgla" });
    expect(filled.classList.contains("kid-lesson-cloze__gap--filled")).toBe(true);
    expect(filled.classList.contains("kid-lesson-cloze__gap--empty")).toBe(false);
    expect(screen.getAllByTestId("kid-lesson-cloze-gap")[1]!.getAttribute("aria-pressed")).toBe("true");
    for (const gap of screen.getAllByTestId("kid-lesson-cloze-gap")) expect(gap.hasAttribute("aria-label")).toBe(false);
    expect(check.disabled).toBe(true);
    fireEvent.click(screen.getByText("wodę"));
    fireEvent.click(check);
    expect(props.handlers.onAnswerAssignment).toHaveBeenCalledWith([
      { itemId: id(3), targetId: id(7) }, { itemId: id(4), targetId: id(5) },
    ]);
  });

  it("cloze: stuknięcie pustej, nieaktywnej luki czyni ją aktywną", () => {
    const props = makeExerciseProps(clozeTask());
    renderKid(<LessonClozeView {...props} />);
    fireEvent.click(screen.getAllByTestId("kid-lesson-cloze-gap")[1]!);
    const [first, second] = screen.getAllByTestId("kid-lesson-cloze-gap");
    expect(first!.getAttribute("aria-pressed")).toBe("false");
    expect(second!.getAttribute("aria-pressed")).toBe("true");
    expect(second!.querySelector(".kid-lesson-cloze__gap-mark")).not.toBeNull();
    expect(first!.querySelector(".kid-lesson-cloze__gap-mark")).toBeNull();
    expect(props.handlers.onEdit).toHaveBeenCalled();
  });

  it("cloze: wiersz podpowiedzi jest zawsze w DOM; tekst tylko przy komplecie z wolnymi słowami i bez blokady", () => {
    const props = makeExerciseProps(clozeTask());
    const view = renderKid(<LessonClozeView {...props} />);
    expect(screen.getByTestId("kid-lesson-cloze-hint").textContent).toBe("");
    fireEvent.click(screen.getByText("dwutlenek węgla"));
    fireEvent.click(screen.getByText("wodę"));
    expect(screen.getByTestId("kid-lesson-cloze-hint").textContent).toBe("Dotknij luki, żeby zmienić słowo.");
    const [tlen] = screen.getAllByTestId("kid-lesson-cloze-option");
    expect((tlen as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<LessonClozeView {...props} dock={<span>wynik</span>} />);
    expect(screen.getByTestId("kid-lesson-cloze-hint").textContent).toBe("");
    view.rerender(<LessonClozeView {...props} busy />);
    expect(screen.getByTestId("kid-lesson-cloze-hint").textContent).toBe("");
  });

  it("cloze: stuknięcie wypełnionej luki oddaje słowo; dok i busy wyłączają luki i bank", () => {
    const props = makeExerciseProps(clozeTask());
    const view = renderKid(<LessonClozeView {...props} />);
    fireEvent.click(screen.getByText("tlen"));
    expect(screen.getAllByTestId("kid-lesson-cloze-option")).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId("kid-lesson-cloze-gap")[0]!);
    expect(screen.getAllByTestId("kid-lesson-cloze-option")).toHaveLength(3);
    const disabledAll = () => [...screen.getAllByTestId("kid-lesson-cloze-gap"), ...screen.getAllByTestId("kid-lesson-cloze-option")]
      .every((el) => (el as HTMLButtonElement).disabled);
    expect(disabledAll()).toBe(false);
    view.rerender(<LessonClozeView {...props} dock={<span>wynik</span>} />);
    expect(disabledAll()).toBe(true);
    view.rerender(<LessonClozeView {...props} busy />);
    expect(disabledAll()).toBe(true);
  });

  it("cloze: po retry luki są puste, a fokus stoi na pierwszej luce", () => {
    const props = makeExerciseProps(clozeTask());
    const view = renderKid(<LessonClozeView {...props} />);
    fireEvent.click(screen.getByText("tlen"));
    fireEvent.click(screen.getByText("wodę"));
    expect(screen.getAllByTestId("kid-lesson-cloze-gap").every((gap) => gap.classList.contains("kid-lesson-cloze__gap--filled"))).toBe(true);
    view.rerender(<LessonClozeView {...props} dock={<span>wynik</span>} />);
    view.rerender(<LessonClozeView {...props} />);
    const gaps = screen.getAllByTestId("kid-lesson-cloze-gap");
    expect(gaps.some((gap) => gap.classList.contains("kid-lesson-cloze__gap--filled"))).toBe(false);
    expect(gaps[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(gaps[0]);
  });

  it("order keeps placed blocks when the same task arrives as a fresh prompt object", () => {
    const items = [{ id: id(3), text: "He" }, { id: id(4), text: "plays" }];
    const props = makeExerciseProps(task({ kind: "lesson_order", instructionPl: "Ułóż", items }));
    const view = renderKid(<LessonOrderView {...props} />);
    fireEvent.click(screen.getAllByTestId("kid-lesson-order-block")[0]!);
    expect(screen.getByTestId("kid-lesson-order-sentence").querySelectorAll("[data-testid='kid-lesson-order-placed']")).toHaveLength(1);
    const refreshed = makeExerciseProps(task({ kind: "lesson_order", instructionPl: "Ułóż", items: items.map((item) => ({ ...item })) }));
    view.rerender(<LessonOrderView {...refreshed} handlers={props.handlers} />);
    expect(screen.getByTestId("kid-lesson-order-sentence").querySelectorAll("[data-testid='kid-lesson-order-placed']")).toHaveLength(1);
  });

  it("order clears placed blocks and restores focus after retry", () => {
    const props = makeExerciseProps(task({ kind: "lesson_order", instructionPl: "U\u0142\u00f3\u017c", items: [{ id: id(3), text: "He" }, { id: id(4), text: "plays" }] }));
    const view = renderKid(<LessonOrderView {...props} />);
    fireEvent.click(screen.getAllByTestId("kid-lesson-order-block")[0]!);
    expect(screen.getAllByTestId("kid-lesson-order-placed")).toHaveLength(1);
    view.rerender(<LessonOrderView {...props} dock={<span>wynik</span>} />);
    view.rerender(<LessonOrderView {...props} />);
    expect(screen.queryAllByTestId("kid-lesson-order-placed")).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getAllByTestId("kid-lesson-order-block")[0]);
  });

  it("gap and sentence clear the draft and restore focus after retry", () => {
    const gapProps = makeExerciseProps(task({ kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "He ___ (play)." }));
    const gapView = renderKid(<LessonGapView {...gapProps} />);
    fireEvent.change(screen.getByTestId("kid-lesson-gap-input"), { target: { value: "plays" } });
    gapView.rerender(<LessonGapView {...gapProps} dock={<span>wynik</span>} />);
    const gapInput = screen.getByTestId("kid-lesson-gap-input") as HTMLInputElement;
    gapInput.blur();
    gapView.rerender(<LessonGapView {...gapProps} />);
    expect(gapInput.value).toBe("");
    expect(document.activeElement).toBe(gapInput);
    gapView.unmount();

    const sentenceProps = makeExerciseProps(task({ kind: "lesson_error_fix", instructionPl: "Popraw", statement: "He play." }));
    const sentenceView = renderKid(<LessonSentenceView {...sentenceProps} />);
    fireEvent.change(screen.getByTestId("kid-lesson-input"), { target: { value: "He plays." } });
    sentenceView.rerender(<LessonSentenceView {...sentenceProps} dock={<span>wynik</span>} />);
    const sentenceInput = screen.getByTestId("kid-lesson-input") as HTMLInputElement;
    sentenceInput.blur();
    sentenceView.rerender(<LessonSentenceView {...sentenceProps} />);
    expect(sentenceInput.value).toBe("");
    expect(document.activeElement).toBe(sentenceInput);
  });

  it("gap and sentence forms keep text payloads and only play issued audio", () => {
    const gapProps = makeExerciseProps(task({ kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "He ___ (play)." }));
    const { unmount } = renderKid(<LessonGapView {...gapProps} />);
    expect(screen.queryByTestId("kid-lesson-listen")).toBeNull();
    fireEvent.change(screen.getByTestId("kid-lesson-gap-input"), { target: { value: "plays" } });
    fireEvent.click(screen.getByTestId("kid-lesson-check"));
    expect(gapProps.handlers.onSubmitText).toHaveBeenCalledWith("plays");
    unmount();

    const sentenceProps = makeExerciseProps(task({ kind: "lesson_error_fix", instructionPl: "Popraw", statement: "He play.", audioAssetId: id(9) }));
    renderKid(<LessonSentenceView {...sentenceProps} />);
    expect(screen.getByTestId("kid-lesson-listen").tagName).toBe("BUTTON");
    fireEvent.click(screen.getByTestId("kid-lesson-listen"));
    expect(sentenceProps.handlers.onPlay).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByTestId("kid-lesson-input"), { target: { value: "He plays." } });
    fireEvent.click(screen.getByTestId("kid-lesson-check"));
    expect(sentenceProps.handlers.onSubmitText).toHaveBeenCalledWith("He plays.");
  });

  it("open answer uses the prompt locale when the server knows it, otherwise keeps en-GB", () => {
    const school = renderKid(<LessonSentenceView {...makeExerciseProps(task({ kind: "lesson_open_answer", instructionPl: "Odpowiedz.", prompt: "Co to jest skala?", promptLocale: "pl-PL" }))} />);
    expect(screen.getByTestId("kid-lesson-source").getAttribute("lang")).toBe("pl-PL");
    expect(screen.getByTestId("kid-lesson-input").getAttribute("lang")).toBe("pl-PL");
    school.unmount();
    renderKid(<LessonSentenceView {...makeExerciseProps(task({ kind: "lesson_open_answer", instructionPl: "Napisz.", prompt: "Write about your day." }))} />);
    expect(screen.getByTestId("kid-lesson-source").getAttribute("lang")).toBe("en-GB");
    expect(screen.getByTestId("kid-lesson-input").hasAttribute("lang")).toBe(false);
  });

  it("calculation shows the Polish prompt and sends the typed result verbatim by click or Enter", () => {
    const calculation = task({ kind: "lesson_calculation", instructionPl: "Oblicz.", prompt: "Na mapie w skali 1:25 000 odcinek ma 3 cm. Oblicz odległość w terenie w m." });
    const props = makeExerciseProps(calculation);
    const { unmount } = renderKid(<LessonSentenceView {...props} />);
    const source = screen.getByTestId("kid-lesson-source");
    expect(source.textContent).toContain("1:25 000");
    expect(source.getAttribute("lang")).toBe("pl-PL");
    const input = screen.getByTestId("kid-lesson-input") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.maxLength).toBe(600);
    expect(input.getAttribute("lang")).toBe("pl-PL");
    expect(screen.queryByTestId("kid-lesson-listen")).toBeNull();
    fireEvent.change(input, { target: { value: "0,75 km" } });
    fireEvent.click(screen.getByTestId("kid-lesson-check"));
    expect(props.handlers.onSubmitText).toHaveBeenCalledWith("0,75 km");
    fireEvent.change(input, { target: { value: "1 250 m" } });
    fireEvent.submit(input.closest("form")!);
    expect(props.handlers.onSubmitText).toHaveBeenLastCalledWith("1 250 m");
    // Uproszczone akcje sesji (#145): w zadaniu zostaje tylko „Nie pamiętam”.
    expect(screen.queryByTestId("kid-skip")).toBeNull();
    fireEvent.click(screen.getByTestId("kid-not-remember"));
    expect(props.handlers.onNotRemember).toHaveBeenCalledOnce();
    unmount();

    const busyProps = makeExerciseProps(calculation, { busy: true });
    renderKid(<LessonSentenceView {...busyProps} />);
    const busyInput = screen.getByTestId("kid-lesson-input") as HTMLInputElement;
    expect(busyInput.disabled).toBe(true);
    // Non-empty text, so only the busy guard can stop the submission.
    fireEvent.change(busyInput, { target: { value: "0,75 km" } });
    fireEvent.submit(busyInput.closest("form")!);
    expect((screen.getByTestId("kid-lesson-check") as HTMLButtonElement).disabled).toBe(true);
    expect(busyProps.handlers.onSubmitText).not.toHaveBeenCalled();
  });
});

describe("lesson content language (lang attributes)", () => {
  const langOf = (element: Element) => element.getAttribute("lang");
  const en = "en-GB" as const;

  it("choice marks the stem and every option with the content locale", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_choice", instructionPl: "Wybierz", stem: "He ___ football.", contentLocale: en,
      options: [{ id: id(3), text: "plays" }, { id: id(4), text: "play" }],
    }));
    renderKid(<LessonChoiceView {...props} />);
    expect(langOf(screen.getByTestId("kid-lesson-stem"))).toBe(en);
    expect(screen.getAllByTestId("kid-option").map(langOf)).toEqual([en, en]);
  });

  it("order marks pool and placed blocks", () => {
    const props = makeExerciseProps(task({ kind: "lesson_order", instructionPl: "Ułóż", contentLocale: en, items: [{ id: id(3), text: "He" }, { id: id(4), text: "plays" }] }));
    renderKid(<LessonOrderView {...props} />);
    expect(screen.getAllByTestId("kid-lesson-order-block").map(langOf)).toEqual([en, en]);
    fireEvent.click(screen.getAllByTestId("kid-lesson-order-block")[0]!);
    expect(screen.getAllByTestId("kid-lesson-order-placed").map(langOf)).toEqual([en]);
    expect(screen.getAllByTestId("kid-lesson-order-block").map(langOf)).toEqual([en]);
  });

  it("group marks pool and placed items; group labels stay unmarked", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_group", instructionPl: "Pogrupuj", contentLocale: en,
      groups: [{ id: id(3), text: "zwierzęta" }, { id: id(4), text: "jedzenie" }],
      items: [{ id: id(5), text: "dog" }, { id: id(6), text: "cat" }, { id: id(7), text: "bread" }, { id: id(8), text: "milk" }],
    }));
    renderKid(<LessonGroupView {...props} />);
    expect(screen.getAllByTestId("kid-lesson-group-item").map(langOf)).toEqual([en, en, en, en]);
    fireEvent.click(screen.getByText("dog"));
    expect(screen.getAllByTestId("kid-lesson-group-member").map(langOf)).toEqual([en]);
    for (const target of screen.getAllByTestId("kid-lesson-group-target")) expect(target.hasAttribute("lang")).toBe(false);
    for (const bin of screen.getAllByTestId("kid-lesson-group-bin")) expect(bin.hasAttribute("lang")).toBe(false);
  });

  it("cloze marks text segments, the word inside a filled gap and the word bank; gap buttons stay unmarked", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_cloze", instructionPl: "Uzupełnij tekst", contentLocale: en,
      segments: [{ text: "I " }, { gapId: id(3) }, { text: " a dog and " }, { gapId: id(4) }, { text: " a cat." }],
      words: [{ id: id(5), text: "have" }, { id: id(6), text: "like" }, { id: id(7), text: "has" }],
    }));
    renderKid(<LessonClozeView {...props} />);
    expect(screen.getAllByTestId("kid-lesson-cloze-segment").map(langOf)).toEqual([en, en, en]);
    expect(screen.getAllByTestId("kid-lesson-cloze-option").map(langOf)).toEqual([en, en, en]);
    fireEvent.click(screen.getByText("have"));
    const [firstGap, secondGap] = screen.getAllByTestId("kid-lesson-cloze-gap");
    const word = firstGap!.querySelector("span[lang]")!;
    expect(word.textContent).toBe("have");
    expect(langOf(word)).toBe(en);
    expect(firstGap!.hasAttribute("lang")).toBe(false);
    expect(secondGap!.hasAttribute("lang")).toBe(false);
  });

  it("gap marks the sentence parts around the field and the field itself (answer language)", () => {
    const props = makeExerciseProps(task({ kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "He ___ (play) football.", contentLocale: en }));
    renderKid(<LessonGapView {...props} />);
    expect(langOf(screen.getByTestId("kid-lesson-gap-before"))).toBe(en);
    expect(langOf(screen.getByTestId("kid-lesson-gap-after"))).toBe(en);
    const input = screen.getByTestId("kid-lesson-gap-input");
    expect(input.tagName).toBe("INPUT");
    expect(langOf(input)).toBe(en);
  });

  it("a pl-PL content locale marks the content with pl-PL", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_choice", instructionPl: "Wybierz", stem: "Ile nóg ma pająk?", contentLocale: "pl-PL",
      options: [{ id: id(3), text: "osiem" }, { id: id(4), text: "sześć" }],
    }));
    renderKid(<LessonChoiceView {...props} />);
    expect(langOf(screen.getByTestId("kid-lesson-stem"))).toBe("pl-PL");
    expect(screen.getAllByTestId("kid-option").map(langOf)).toEqual(["pl-PL", "pl-PL"]);
  });

  it("without contentLocale no lang attribute appears on the content (older servers)", () => {
    const views = [
      <LessonChoiceView key="c" {...makeExerciseProps(task({ kind: "lesson_choice", instructionPl: "Wybierz", stem: "He ___.", options: [{ id: id(3), text: "plays" }, { id: id(4), text: "play" }] }))} />,
      <LessonOrderView key="o" {...makeExerciseProps(task({ kind: "lesson_order", instructionPl: "Ułóż", items: [{ id: id(3), text: "He" }, { id: id(4), text: "plays" }] }))} />,
      <LessonGapView key="g" {...makeExerciseProps(task({ kind: "lesson_gap", instructionPl: "Uzupełnij", stemWithGap: "He ___ (play)." }))} />,
      <LessonMatchView key="m" {...makeExerciseProps(task({
        kind: "lesson_match", instructionPl: "Połącz",
        left: [{ id: id(3), text: "a" }, { id: id(4), text: "b" }, { id: id(5), text: "c" }],
        right: [{ id: id(6), text: "x" }, { id: id(7), text: "y" }, { id: id(8), text: "z" }],
      }))} />,
      <LessonGroupView key="r" {...makeExerciseProps(task({
        kind: "lesson_group", instructionPl: "Pogrupuj",
        groups: [{ id: id(3), text: "g1" }, { id: id(4), text: "g2" }],
        items: [{ id: id(5), text: "a" }, { id: id(6), text: "b" }, { id: id(7), text: "c" }, { id: id(8), text: "d" }],
      }))} />,
      <LessonClozeView key="z" {...makeExerciseProps(task({
        kind: "lesson_cloze", instructionPl: "Uzupełnij tekst",
        segments: [{ text: "A " }, { gapId: id(3) }, { text: " b " }, { gapId: id(4) }],
        words: [{ id: id(5), text: "x" }, { id: id(6), text: "y" }, { id: id(7), text: "z" }],
      }))} />,
    ];
    for (const view of views) {
      const { container, unmount } = renderKid(view);
      expect(container.querySelectorAll("[lang]")).toHaveLength(0);
      unmount();
    }
  });

  it("open answer: the source follows promptLocale and the answer field follows answerLocale", () => {
    renderKid(<LessonSentenceView {...makeExerciseProps(task({ kind: "lesson_open_answer", instructionPl: "Przetłumacz.", prompt: "Ona gra w piłkę.", promptLocale: "pl-PL", answerLocale: en }))} />);
    expect(langOf(screen.getByTestId("kid-lesson-source"))).toBe("pl-PL");
    expect(langOf(screen.getByTestId("kid-lesson-input"))).toBe(en);
  });

  it("open answer: answerLocale alone marks the field and keeps the default en-GB source", () => {
    renderKid(<LessonSentenceView {...makeExerciseProps(task({ kind: "lesson_open_answer", instructionPl: "Napisz.", prompt: "Write about your day.", answerLocale: en }))} />);
    expect(langOf(screen.getByTestId("kid-lesson-source"))).toBe(en);
    expect(langOf(screen.getByTestId("kid-lesson-input"))).toBe(en);
  });
});

describe("listen-choice view (lesson_listen_choice)", () => {
  const en = "en-GB" as const;
  const listenTask = () => task({
    kind: "lesson_listen_choice", stem: "He ___ football.", contentLocale: en,
    options: [{ id: id(3), text: "plays" }, { id: id(4), text: "play" }],
  });
  const render = (state: "pending" | "blocked" | "unavailable" | "open" | null, overrides: Partial<ReturnType<typeof makeExerciseProps>> = {}) => {
    const props = makeExerciseProps(listenTask(), {
      listenStimulus: state === null ? null : { state, playing: false },
      ...overrides,
    });
    renderKid(<LessonListenChoiceView {...props} />);
    return props;
  };

  it("locks the options until the first listen finishes, while the play button stays active and focused", () => {
    render("pending");
    for (const option of screen.getAllByTestId("kid-option")) expect((option as HTMLButtonElement).disabled).toBe(true);
    const play = screen.getByTestId("kid-play") as HTMLButtonElement;
    expect(play.disabled).toBe(false);
    expect(document.activeElement).toBe(play);
    expect(play.getAttribute("aria-label")).toBe("Posłuchaj zdania");
    expect(screen.getByTestId("kid-instruction").textContent).toContain("Posłuchaj i wybierz, czego brakuje.");
  });

  it("fails closed without a stimulus state", () => {
    render(null);
    for (const option of screen.getAllByTestId("kid-option")) expect((option as HTMLButtonElement).disabled).toBe(true);
  });

  it("answers immediately by option id once the stimulus is open", () => {
    const props = render("open");
    fireEvent.click(screen.getAllByTestId("kid-option")[0]!);
    expect(props.handlers.onAnswerChoice).toHaveBeenCalledWith(id(3));
    expect(screen.queryByTestId("kid-lesson-check")).toBeNull();
    expect(screen.getByTestId("kid-listen-status").textContent).toBe("");
  });

  it("explains a blocked autoplay politely and keeps the options locked", () => {
    render("blocked");
    expect(screen.getByRole("status").textContent).toBe("Dotknij głośnika, aby posłuchać.");
    for (const option of screen.getAllByTestId("kid-option")) expect((option as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps one status line mounted in every state, filled only when autoplay is blocked", () => {
    for (const state of ["pending", "open", "unavailable", "blocked"] as const) {
      const { unmount } = renderKid(<LessonListenChoiceView {...makeExerciseProps(listenTask(), { listenStimulus: { state, playing: false } })} />);
      const status = screen.getByTestId("kid-listen-status");
      expect(status.getAttribute("role")).toBe("status");
      expect(status.textContent).toBe(state === "blocked" ? "Dotknij głośnika, aby posłuchać." : "");
      unmount();
    }
  });

  it("offers „Pomiń” when the recording is unavailable", () => {
    const props = render("unavailable");
    for (const option of screen.getAllByTestId("kid-option")) expect((option as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("kid-listen-skip"));
    expect(screen.getByTestId("kid-listen-skip").textContent).toBe("Pomiń");
    expect(props.handlers.onSkip).toHaveBeenCalledOnce();
  });

  it("does not show „Pomiń” in the other states", () => {
    for (const state of ["pending", "blocked", "open"] as const) {
      const { unmount } = renderKid(<LessonListenChoiceView {...makeExerciseProps(listenTask(), { listenStimulus: { state, playing: false } })} />);
      expect(screen.queryByTestId("kid-listen-skip")).toBeNull();
      unmount();
    }
  });

  it("Space on a focused „Pomiń” is left to the button; on an option or the play button it replays", () => {
    const props = render("unavailable");
    const skip = screen.getByTestId("kid-listen-skip");
    skip.focus();
    const onSkipButton = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
    skip.dispatchEvent(onSkipButton);
    expect(onSkipButton.defaultPrevented).toBe(false);
    expect(props.handlers.onPlay).not.toHaveBeenCalled();
    screen.getByTestId("kid-play").focus();
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(props.handlers.onPlay).toHaveBeenCalledTimes(1);
    (screen.getAllByTestId("kid-option")[0] as HTMLButtonElement).focus();
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(props.handlers.onPlay).toHaveBeenCalledTimes(2);
  });

  it("renders the gap as a named blank, not as raw underscores", () => {
    render("open");
    const stem = screen.getByTestId("kid-lesson-stem");
    expect(stem.textContent).not.toContain("___");
    const gap = screen.getByTestId("kid-listen-gap");
    expect(gap.getAttribute("aria-label")).toBe("luka");
    expect(gap.getAttribute("lang")).toBe("pl-PL");
    expect(stem.contains(gap)).toBe(true);
    expect(stem.textContent).toBe("He  football.");
  });

  it("marks the stem and every option with the content locale", () => {
    render("open");
    expect(screen.getByTestId("kid-lesson-stem").getAttribute("lang")).toBe(en);
    expect(screen.getAllByTestId("kid-option").map((option) => option.getAttribute("lang"))).toEqual([en, en]);
  });

  it("replays the stimulus with the play button and with Space, also while the options are locked", () => {
    const props = render("pending");
    fireEvent.click(screen.getByTestId("kid-play"));
    expect(props.handlers.onPlay).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(props.handlers.onPlay).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "1", code: "Digit1" });
    expect(props.handlers.onAnswerChoice).not.toHaveBeenCalled();
  });

  it("shows the playing state on the play button", () => {
    const props = makeExerciseProps(listenTask(), { listenStimulus: { state: "pending", playing: true } });
    renderKid(<LessonListenChoiceView {...props} />);
    expect(screen.getByTestId("kid-play").getAttribute("data-sound-active")).toBe("true");
    expect(screen.getByTestId("kid-sound-ring")).toBeTruthy();
  });

  it("after the answer the button replays the feedback recording; without one it is inactive", () => {
    const onFeedbackPlay = vi.fn();
    const withAudio = makeExerciseProps(listenTask(), {
      busy: true, listenStimulus: { state: "open", playing: false },
      feedbackAudio: { assetId: id(9), onPlay: onFeedbackPlay },
    });
    const { unmount } = renderKid(<LessonListenChoiceView {...withAudio} />);
    const play = screen.getByTestId("kid-play") as HTMLButtonElement;
    expect(play.disabled).toBe(false);
    fireEvent.click(play);
    expect(onFeedbackPlay).toHaveBeenCalledOnce();
    expect(withAudio.handlers.onPlay).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(onFeedbackPlay).toHaveBeenCalledTimes(2);
    unmount();

    const without = makeExerciseProps(listenTask(), { busy: true, listenStimulus: { state: "open", playing: false } });
    renderKid(<LessonListenChoiceView {...without} />);
    expect((screen.getByTestId("kid-play") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(without.handlers.onPlay).not.toHaveBeenCalled();
  });
});
