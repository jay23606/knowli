// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { messages, type GenerationDto, type LessonStoryDto } from "@learning/contracts";
import LessonStorySection from "./LessonStorySection";
import { parentTheme } from "../theme";

const RUN_ID = "00000000-0000-4000-8000-0000000000aa";
const t = messages.lessons.story;

const story = (): LessonStoryDto => ({
  sentences: ["Sam has a red bike.", "He rides it to the park.", "The bike is fast.", "Sam is happy."],
  questions: [{
    id: "q1",
    question: "Jaki rower ma Sam?",
    options: [{ id: "a", text: "czerwony" }, { id: "b", text: "niebieski" }, { id: "c", text: "zielony" }],
    correctOption: "a",
  }],
});

const run = (state: GenerationDto["state"]): GenerationDto => ({
  id: RUN_ID, deckId: null, deckVersionId: null, state, attempts: 1, errorCode: state === "failed" ? "provider" : null,
});

type Props = Parameters<typeof LessonStorySection>[0];

function renderSection(overrides: Partial<Props> = {}) {
  const props: Props = {
    story: story(),
    editable: true,
    errors: [],
    generation: null,
    busy: false,
    locked: false,
    hasExercises: true,
    onChange: vi.fn(),
    onGenerate: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  render(
    <MantineProvider theme={parentTheme}>
      <ModalsProvider>
        <LessonStorySection {...props} />
      </ModalsProvider>
    </MantineProvider>,
  );
  return props;
}

const generateButton = () => screen.getByTestId("lesson-story-generate") as HTMLButtonElement;

describe("LessonStorySection", () => {
  beforeEach(() => {
    if (typeof window.matchMedia !== "function") {
      window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => undefined, removeEventListener: () => undefined,
        addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
      })) as typeof window.matchMedia;
    }
  });
  afterEach(cleanup);

  it("shows empty state and generate button when no story", () => {
    const props = renderSection({ story: null });
    expect(screen.getByTestId("lesson-story-section").textContent).toContain(t.title);
    expect(screen.getByText(t.empty)).toBeTruthy();
    expect(screen.queryByTestId("lesson-story-sentence-0")).toBeNull();
    expect(screen.queryByTestId("lesson-story-remove")).toBeNull();
    expect(generateButton().textContent).toContain(t.generate);
    fireEvent.click(generateButton());
    // bez historyjki nie ma czego zastępować — bez potwierdzenia
    expect(props.onGenerate).toHaveBeenCalledTimes(1);
  });

  it("generate button disabled when locked or generation running", () => {
    renderSection({ story: null, locked: true });
    expect(generateButton().disabled).toBe(true);
    cleanup();
    renderSection({ story: null, generation: run("running") });
    expect(generateButton().disabled).toBe(true);
    cleanup();
    renderSection({ story: null, generation: run("queued") });
    expect(generateButton().disabled).toBe(true);
    cleanup();
    renderSection({ story: null, busy: true });
    expect(generateButton().disabled).toBe(true);
    cleanup();
    renderSection({ story: null, generation: run("succeeded") });
    expect(generateButton().disabled).toBe(false);
  });

  it("regenerate asks for confirmation when story exists", async () => {
    const props = renderSection();
    expect(generateButton().textContent).toContain(t.regenerate);
    fireEvent.click(generateButton());
    expect(props.onGenerate).not.toHaveBeenCalled();
    expect(await screen.findByText(t.regenerateConfirm)).toBeTruthy();
    fireEvent.click(screen.getByTestId("lesson-story-regenerate-confirm"));
    await waitFor(() => expect(props.onGenerate).toHaveBeenCalledTimes(1));
  });

  it("editing sentence calls onChange with updated story", () => {
    const props = renderSection();
    const input = screen.getByTestId("lesson-story-sentence-0") as HTMLInputElement;
    expect(input.value).toBe("Sam has a red bike.");
    fireEvent.change(input, { target: { value: "Sam has a big red bike." } });
    expect(props.onChange).toHaveBeenLastCalledWith({ ...story(), sentences: ["Sam has a big red bike.", ...story().sentences.slice(1)] });

    fireEvent.change(screen.getByTestId("lesson-story-option-q1-b"), { target: { value: "granatowy" } });
    const changed = (props.onChange as ReturnType<typeof vi.fn>).mock.lastCall![0] as LessonStoryDto;
    expect(changed.questions[0]!.options[1]).toEqual({ id: "b", text: "granatowy" });

    fireEvent.click(screen.getByTestId("lesson-story-correct-q1-c"));
    const correct = (props.onChange as ReturnType<typeof vi.fn>).mock.lastCall![0] as LessonStoryDto;
    expect(correct.questions[0]!.correctOption).toBe("c");
    expect((screen.getByTestId("lesson-story-question-q1") as HTMLInputElement).value).toBe("Jaki rower ma Sam?");
  });

  it("locks story fields and remove while the story run is queued or running", () => {
    for (const state of ["queued", "running"] as const) {
      renderSection({ generation: run(state) });
      const section = screen.getByTestId("lesson-story-section");
      // Wyjątek: ponowienie zawieszonego runu (`running`) zostaje dostępne.
      const controls = ([...section.querySelectorAll("input, button")] as (HTMLInputElement | HTMLButtonElement)[])
        .filter((control) => control.getAttribute("data-testid") !== "lesson-story-retry-stalled");
      expect(controls.length).toBeGreaterThan(10);
      for (const control of controls) expect(control.disabled, control.getAttribute("data-testid") ?? control.outerHTML).toBe(true);
      cleanup();
    }
    // po zakończeniu runu pola wracają
    renderSection({ generation: run("succeeded") });
    expect((screen.getByTestId("lesson-story-sentence-0") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId("lesson-story-remove") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("lesson-story-add-sentence") as HTMLButtonElement).disabled).toBe(false);
  });

  it("option inputs and correct-answer radios name the question number", () => {
    renderSection({ story: { ...story(), questions: [...story().questions, { ...story().questions[0]!, id: "q2" }] } });
    const q2 = `${t.questionLabel.replace("{n}", "2")}, ${t.optionLabel.replace("{n}", "1")}`;
    expect(q2).toBe("Pytanie 2, Odpowiedź 1");
    expect(screen.getByTestId("lesson-story-option-q2-a").getAttribute("aria-label")).toBe(q2);
    expect(screen.getByTestId("lesson-story-correct-q2-a").getAttribute("aria-label")).toBe(`${t.correctOption}: ${q2}`);
    expect(screen.getByTestId("lesson-story-option-q1-c").getAttribute("aria-label")).toBe("Pytanie 1, Odpowiedź 3");
  });

  it("remove story calls onChange(null)", () => {
    const props = renderSection();
    fireEvent.click(screen.getByTestId("lesson-story-remove"));
    expect(props.onChange).toHaveBeenCalledWith(null);
  });

  it("shows server errors list", () => {
    renderSection({ errors: ["Historyjka ma mieć od 4 do 6 zdań.", "Pytanie 1 jest puste."] });
    const errors = screen.getByTestId("lesson-story-errors");
    expect(errors.textContent).toContain("Historyjka ma mieć od 4 do 6 zdań.");
    expect(errors.textContent).toContain("Pytanie 1 jest puste.");
    cleanup();
    renderSection();
    expect(screen.queryByTestId("lesson-story-errors")).toBeNull();
  });

  it("shows generating and failed states with retry", () => {
    renderSection({ story: null, generation: run("running") });
    expect(screen.getByTestId("lesson-story-generating").textContent).toContain(t.generating);
    expect(screen.queryByTestId("lesson-story-failed")).toBeNull();
    cleanup();
    const props = renderSection({ story: null, generation: run("failed") });
    expect(screen.getByTestId("lesson-story-failed").textContent).toContain(t.failed);
    expect(screen.queryByTestId("lesson-story-generating")).toBeNull();
    const retry = screen.getByTestId("lesson-story-retry") as HTMLButtonElement;
    expect(retry.textContent).toContain(t.retry);
    fireEvent.click(retry);
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("retry of a failed run asks for confirmation when a story exists", async () => {
    const props = renderSection({ generation: run("failed") });
    fireEvent.click(screen.getByTestId("lesson-story-retry"));
    expect(props.onRetry).not.toHaveBeenCalled();
    expect(await screen.findByText(t.regenerateConfirm)).toBeTruthy();
    fireEvent.click(screen.getByTestId("lesson-story-regenerate-confirm"));
    await waitFor(() => expect(props.onRetry).toHaveBeenCalledTimes(1));
    expect(props.onGenerate).not.toHaveBeenCalled();
  });

  it("running run offers a stalled-run retry with hint, guarded like other actions", async () => {
    const props = renderSection({ story: null, generation: run("running") });
    const section = screen.getByTestId("lesson-story-generating");
    expect(section.textContent).toContain(messages.lessons.stalledGenerationHint);
    const stalled = screen.getByTestId("lesson-story-retry-stalled") as HTMLButtonElement;
    expect(stalled.textContent).toContain(t.retry);
    expect(stalled.disabled).toBe(false);
    fireEvent.click(stalled);
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    cleanup();

    // queued: run czeka na workera, nie ma czego odblokowywać
    renderSection({ story: null, generation: run("queued") });
    expect(screen.queryByTestId("lesson-story-retry-stalled")).toBeNull();
    cleanup();

    for (const guard of [{ locked: true }, { busy: true }]) {
      renderSection({ story: null, generation: run("running"), ...guard });
      expect((screen.getByTestId("lesson-story-retry-stalled") as HTMLButtonElement).disabled).toBe(true);
      cleanup();
    }

    // z historyjką ponowienie ją zastąpi — najpierw potwierdzenie
    const withStory = renderSection({ generation: run("running") });
    fireEvent.click(screen.getByTestId("lesson-story-retry-stalled"));
    expect(withStory.onRetry).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("lesson-story-regenerate-confirm"));
    await waitFor(() => expect(withStory.onRetry).toHaveBeenCalledTimes(1));
  });

  it("generate is disabled while the draft has no exercises; writing stays available", () => {
    renderSection({ story: null, hasExercises: false });
    expect(generateButton().disabled).toBe(true);
    expect((screen.getByTestId("lesson-story-write") as HTMLButtonElement).disabled).toBe(false);
  });

  it("read-only with publishedHint when not editable", () => {
    renderSection({ editable: false });
    const section = screen.getByTestId("lesson-story-section");
    expect(section.textContent).toContain(t.publishedHint);
    expect(section.textContent).toContain("Sam has a red bike.");
    expect(section.textContent).toContain("Jaki rower ma Sam?");
    expect(section.textContent).toContain("czerwony");
    expect(section.querySelector("input")).toBeNull();
    expect(screen.queryByTestId("lesson-story-generate")).toBeNull();
    expect(screen.queryByTestId("lesson-story-remove")).toBeNull();
    cleanup();
    renderSection({ editable: false, story: null });
    expect(screen.getByTestId("lesson-story-section").textContent).toContain(t.empty);
  });
});
