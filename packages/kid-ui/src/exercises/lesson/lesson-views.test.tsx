// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderKid, screen } from "../../test/render-kid";
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

  it("match: miejsca przyjmują elementy z puli, „Sprawdź” dopiero po komplecie, przypisania lewy → prawy", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_match", instructionPl: "Połącz",
      left: [{ id: id(3), text: "równik" }, { id: id(4), text: "południk" }, { id: id(5), text: "biegun" }],
      right: [{ id: id(6), text: "łączy bieguny" }, { id: id(7), text: "dzieli półkule" }, { id: id(8), text: "koniec osi" }, { id: id(9), text: "nad morzem" }],
    }));
    renderKid(<LessonMatchView {...props} />);
    const check = screen.getByTestId("kid-lesson-check") as HTMLButtonElement;
    expect(screen.getAllByTestId("kid-lesson-match-slot")[0]!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("dzieli półkule"));
    fireEvent.click(screen.getByText("łączy bieguny"));
    expect(check.disabled).toBe(true);
    fireEvent.click(screen.getByText("koniec osi"));
    expect(screen.getAllByTestId("kid-lesson-match-option").map((el) => el.textContent)).toEqual(["nad morzem"]);
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    expect(props.handlers.onAnswerAssignment).toHaveBeenCalledWith([
      { itemId: id(3), targetId: id(7) }, { itemId: id(4), targetId: id(6) }, { itemId: id(5), targetId: id(8) },
    ]);
  });

  it("match: dotknięcie zajętego miejsca oddaje element do puli", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_match", instructionPl: "Połącz",
      left: [{ id: id(3), text: "a" }, { id: id(4), text: "b" }, { id: id(5), text: "c" }],
      right: [{ id: id(6), text: "x" }, { id: id(7), text: "y" }, { id: id(8), text: "z" }],
    }));
    renderKid(<LessonMatchView {...props} />);
    fireEvent.click(screen.getByText("x"));
    expect(screen.getAllByTestId("kid-lesson-match-option")).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId("kid-lesson-match-slot")[0]!);
    expect(screen.getAllByTestId("kid-lesson-match-option")).toHaveLength(3);
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

  it("cloze: luki w tekście nie są przyciskami, miejsca przyjmują słowa z banku, przypisania luka → słowo", () => {
    const props = makeExerciseProps(clozeTask());
    renderKid(<LessonClozeView {...props} />);
    const text = screen.getByTestId("kid-lesson-cloze-text");
    expect(text.querySelectorAll("button")).toHaveLength(0);
    expect(text.textContent).toContain("luka 1, pusta");
    const check = screen.getByTestId("kid-lesson-check") as HTMLButtonElement;
    const slots = screen.getAllByTestId("kid-lesson-cloze-slot");
    expect(slots).toHaveLength(2);
    expect(slots[0]!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("dwutlenek węgla"));
    expect(screen.getAllByTestId("kid-lesson-cloze-slot")[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(check.disabled).toBe(true);
    fireEvent.click(screen.getByText("wodę"));
    expect(text.textContent).toContain("luka 2: wodę");
    expect(screen.getAllByTestId("kid-lesson-cloze-option").map((el) => el.textContent)).toEqual(["tlen"]);
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    expect(props.handlers.onAnswerAssignment).toHaveBeenCalledWith([
      { itemId: id(3), targetId: id(7) }, { itemId: id(4), targetId: id(5) },
    ]);
  });

  it("cloze: dotknięcie zajętego miejsca oddaje słowo do banku, a po wyniku przyciski są wyłączone", () => {
    const props = makeExerciseProps(clozeTask());
    const view = renderKid(<LessonClozeView {...props} />);
    fireEvent.click(screen.getByText("tlen"));
    expect(screen.getAllByTestId("kid-lesson-cloze-option")).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId("kid-lesson-cloze-slot")[0]!);
    expect(screen.getAllByTestId("kid-lesson-cloze-option")).toHaveLength(3);
    view.rerender(<LessonClozeView {...props} dock={<span>wynik</span>} />);
    expect(screen.getAllByTestId("kid-lesson-cloze-option").every((el) => (el as HTMLButtonElement).disabled)).toBe(true);
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

  it("match marks the left column only; the right column (meaning or answer) stays unmarked", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_match", instructionPl: "Połącz", contentLocale: en,
      left: [{ id: id(3), text: "dog" }, { id: id(4), text: "cat" }, { id: id(5), text: "fish" }],
      right: [{ id: id(6), text: "pies" }, { id: id(7), text: "kot" }, { id: id(8), text: "ryba" }],
    }));
    renderKid(<LessonMatchView {...props} />);
    expect(screen.getAllByTestId("kid-lesson-match-left").map(langOf)).toEqual([en, en, en]);
    for (const option of screen.getAllByTestId("kid-lesson-match-option")) expect(option.hasAttribute("lang")).toBe(false);
    fireEvent.click(screen.getByText("pies"));
    for (const slot of screen.getAllByTestId("kid-lesson-match-slot")) expect(slot.hasAttribute("lang")).toBe(false);
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

  it("cloze marks text segments, filled gaps, filled slots and the word bank", () => {
    const props = makeExerciseProps(task({
      kind: "lesson_cloze", instructionPl: "Uzupełnij tekst", contentLocale: en,
      segments: [{ text: "I " }, { gapId: id(3) }, { text: " a dog and " }, { gapId: id(4) }, { text: " a cat." }],
      words: [{ id: id(5), text: "have" }, { id: id(6), text: "like" }, { id: id(7), text: "has" }],
    }));
    renderKid(<LessonClozeView {...props} />);
    expect(screen.getAllByTestId("kid-lesson-cloze-segment").map(langOf)).toEqual([en, en, en]);
    expect(screen.getAllByTestId("kid-lesson-cloze-option").map(langOf)).toEqual([en, en, en]);
    fireEvent.click(screen.getByText("have"));
    const [firstGap] = screen.getAllByTestId("kid-lesson-cloze-gap");
    const visibleGap = firstGap!.querySelector("[aria-hidden='true']")!;
    expect(visibleGap.textContent).toContain("have");
    expect(langOf(visibleGap)).toBe(en);
    expect(langOf(screen.getAllByTestId("kid-lesson-cloze-slot")[0]!)).toBe(en);
    expect(screen.getAllByTestId("kid-lesson-cloze-slot")[1]!.hasAttribute("lang")).toBe(false);
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
