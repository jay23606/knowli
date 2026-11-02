// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderKid, screen } from "../test/render-kid";
import { ExerciseInstruction } from "./ExerciseInstruction";

afterEach(cleanup);

it("replaces the decorative icon with one accessible playback action and preserves its ref", () => {
  const onPlay = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  const view = (disabled: boolean) => <ExerciseInstruction instruction="Posłuchaj i wybierz" icon="volume"
    audio={{ onPlay, disabled, ref }} />;
  const { rerender } = renderKid(view(false));
  const header = screen.getByTestId("kid-instruction");
  const button = screen.getByTestId("kid-play");
  expect(header.contains(button)).toBe(true);
  expect(header.querySelectorAll("svg")).toHaveLength(1);
  expect(button.getAttribute("aria-label")).toBeTruthy();
  expect(ref.current).toBe(button);
  fireEvent.click(button);
  expect(onPlay).toHaveBeenCalledTimes(1);
  rerender(view(true));
  fireEvent.click(button);
  expect(onPlay).toHaveBeenCalledTimes(1);
});

it("keeps instructions without audio free of playback controls", () => {
  renderKid(<ExerciseInstruction instruction="Wpisz odpowiedź" icon="pencil" />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByTestId("kid-instruction").textContent).toBe("Wpisz odpowiedź");
});

it("puts the guidance slot after the instruction text", () => {
  renderKid(<ExerciseInstruction instruction="Wpisz odpowiedź" icon="pencil"
    guidance={<button type="button" data-testid="kid-guidance-play">Odsłuchaj</button>} />);
  const header = screen.getByTestId("kid-instruction");
  const text = header.querySelector("span")!;
  const guidance = screen.getByTestId("kid-guidance-play");
  expect(header.contains(guidance)).toBe(true);
  expect(text.compareDocumentPosition(guidance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("shows the sound ring and the active marker while the stimulus plays, and an attention marker", () => {
  const { rerender } = renderKid(<ExerciseInstruction instruction="Posłuchaj" icon="ear" audio={{ onPlay: vi.fn(), disabled: false }} />);
  const button = screen.getByTestId("kid-play");
  expect(button.hasAttribute("data-sound-active")).toBe(false);
  expect(screen.queryByTestId("kid-sound-ring")).toBeNull();
  expect(button.hasAttribute("data-attention")).toBe(false);
  rerender(<ExerciseInstruction instruction="Posłuchaj" icon="ear" audio={{ onPlay: vi.fn(), disabled: false, playing: true, attention: true }} />);
  expect(button.getAttribute("data-sound-active")).toBe("true");
  expect(screen.getByTestId("kid-sound-ring")).toBeTruthy();
  expect(button.getAttribute("data-attention")).toBe("true");
});
