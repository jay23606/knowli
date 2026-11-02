// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { messages } from "@learning/contracts";
import { cleanup, fireEvent, renderKid, screen } from "../test/render-kid";
import { ExerciseFeedbackDock, FEEDBACK_TONE_ICONS } from "./ExerciseFeedbackDock";

afterEach(cleanup);

it.each(Object.entries(FEEDBACK_TONE_ICONS))("shows the %s tone with the %s icon badge", (tone, icon) => {
  renderKid(
    <ExerciseFeedbackDock tone={tone as keyof typeof FEEDBACK_TONE_ICONS} primary={<span>Dalej</span>}>
      <p>Wynik</p>
    </ExerciseFeedbackDock>,
  );
  const badge = screen.getByTestId("kid-feedback-tone-icon");
  expect(badge.getAttribute("data-icon")).toBe(icon);
  expect(badge.getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByTestId("kid-feedback-dock").getAttribute("data-tone")).toBe(tone);
});

it("maps every tone to its icon", () => {
  expect(FEEDBACK_TONE_ICONS).toEqual({ correct: "check", partial: "almost", incorrect: "close", technical: "info", neutral: "info" });
});

it("renders the guidance next to the badge inside the dock", () => {
  renderKid(
    <ExerciseFeedbackDock tone="partial" primary={<span>Dalej</span>} guidance={<button type="button" data-testid="kid-guidance-play">Odsłuchaj</button>}>
      <p>Prawie!</p>
    </ExerciseFeedbackDock>,
  );
  const dock = screen.getByTestId("kid-feedback-dock");
  expect(dock.contains(screen.getByTestId("kid-guidance-play"))).toBe(true);
  expect(dock.contains(screen.getByTestId("kid-feedback-tone-icon"))).toBe(true);
});

const idleSentence = { playing: null, error: null, disabled: false } as const;

it("renders the sentence replay group with the normal and slow listen buttons", () => {
  const onPlay = vi.fn();
  renderKid(
    <ExerciseFeedbackDock tone="correct" primary={<span>Dalej</span>} sentenceAudio={{ ...idleSentence, onPlay }}>
      <p>Świetnie!</p>
    </ExerciseFeedbackDock>,
  );
  const dock = screen.getByTestId("kid-feedback-dock");
  const group = screen.getByTestId("kid-sentence-audio-group");
  expect(dock.contains(group)).toBe(true);
  const sentence = screen.getByTestId("kid-sentence-audio");
  const slow = screen.getByTestId("kid-sentence-audio-slow");
  expect(group.contains(sentence)).toBe(true);
  expect(group.contains(slow)).toBe(true);
  // Zdanie przed żółwiem: ta kolejność w wierszu i w kolumnie.
  expect(sentence.compareDocumentPosition(slow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(sentence.getAttribute("aria-label")).toBe("Posłuchaj zdania");
  expect(sentence.getAttribute("title")).toBe("Posłuchaj zdania");
  expect(slow.getAttribute("aria-label")).toBe("Posłuchaj wolniej");
  expect(slow.getAttribute("title")).toBe("Posłuchaj wolniej");
  expect(sentence.classList.contains("kid-listen")).toBe(true);
  expect(slow.classList.contains("kid-listen")).toBe(true);
  expect(sentence.querySelector("svg")?.getAttribute("data-icon")).toBe("volume");
  expect(slow.querySelector("svg")?.getAttribute("data-icon")).toBe("turtle");
  fireEvent.click(sentence);
  fireEvent.click(slow);
  expect(onPlay.mock.calls).toEqual([["normal"], ["slow"]]);
});

it("shows the sound ring only on the button whose rate is playing", () => {
  renderKid(
    <ExerciseFeedbackDock tone="correct" primary={<span>Dalej</span>} sentenceAudio={{ ...idleSentence, playing: "slow", onPlay: vi.fn() }}>
      <p>Świetnie!</p>
    </ExerciseFeedbackDock>,
  );
  const sentence = screen.getByTestId("kid-sentence-audio");
  const slow = screen.getByTestId("kid-sentence-audio-slow");
  expect(slow.getAttribute("data-sound-active")).toBe("true");
  expect(slow.querySelector(".kid-sound-ring")).not.toBeNull();
  expect(sentence.hasAttribute("data-sound-active")).toBe(false);
  expect(sentence.querySelector(".kid-sound-ring")).toBeNull();
});

it("marks the failed button and fills the polite error region", () => {
  renderKid(
    <ExerciseFeedbackDock tone="incorrect" primary={<span>Dalej</span>} sentenceAudio={{ ...idleSentence, error: { rate: "slow", seq: 3 }, onPlay: vi.fn() }}>
      <p>Spróbuj jeszcze raz</p>
    </ExerciseFeedbackDock>,
  );
  const slow = screen.getByTestId("kid-sentence-audio-slow");
  expect(slow.getAttribute("data-audio-failed")).toBe("3");
  expect(slow.querySelector("[data-fail-key]")?.getAttribute("data-fail-key")).toBe("3");
  expect(screen.getByTestId("kid-sentence-audio").hasAttribute("data-audio-failed")).toBe(false);
  const region = screen.getByTestId("kid-sentence-audio-error");
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(region.hasAttribute("role")).toBe(false);
  expect(region.textContent).toBe(messages.kid.sentenceAudioFailed);
  // W DOM region stoi za górnym wierszem i przed „Dalej” (czytnik czyta wynik,
  // potem błąd), nie w grupie przycisków; położenie wizualne ustala CSS `order`.
  // `order` działa tylko na dziecku doku (kolumny flex), więc region nie może zejść niżej.
  expect(region.parentElement).toBe(screen.getByTestId("kid-feedback-dock"));
  expect(screen.getByTestId("kid-sentence-audio-group").contains(region)).toBe(false);
  expect(region.compareDocumentPosition(screen.getByTestId("kid-feedback-tone-icon")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  expect(region.compareDocumentPosition(screen.getByText("Dalej")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("re-mounts the error text for every failure so the live region announces a repeat", () => {
  const props = { tone: "incorrect" as const, primary: <span>Dalej</span>, children: <p>Spróbuj jeszcze raz</p> };
  const { rerender } = renderKid(<ExerciseFeedbackDock {...props} sentenceAudio={{ ...idleSentence, error: { rate: "slow", seq: 1 }, onPlay: vi.fn() }} />);
  const region = screen.getByTestId("kid-sentence-audio-error");
  const firstText = region.firstElementChild;
  expect(firstText?.textContent).toBe(messages.kid.sentenceAudioFailed);
  rerender(<ExerciseFeedbackDock {...props} sentenceAudio={{ ...idleSentence, error: { rate: "slow", seq: 2 }, onPlay: vi.fn() }} />);
  const secondText = screen.getByTestId("kid-sentence-audio-error").firstElementChild;
  expect(secondText?.textContent).toBe(messages.kid.sentenceAudioFailed);
  expect(secondText).not.toBe(firstText);
  expect(firstText?.isConnected).toBe(false);
});

it("keeps an empty error region in the dock while the sentence buttons are shown", () => {
  renderKid(
    <ExerciseFeedbackDock tone="correct" primary={<span>Dalej</span>} sentenceAudio={{ ...idleSentence, onPlay: vi.fn() }}>
      <p>Świetnie!</p>
    </ExerciseFeedbackDock>,
  );
  const region = screen.getByTestId("kid-sentence-audio-error");
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(region.textContent).toBe("");
  expect(region.childElementCount).toBe(0);
});

it("disables both sentence buttons when the controller would ignore the tap", () => {
  const onPlay = vi.fn();
  renderKid(
    <ExerciseFeedbackDock tone="correct" primary={<span>Dalej</span>} sentenceAudio={{ ...idleSentence, disabled: true, onPlay }}>
      <p>Świetnie!</p>
    </ExerciseFeedbackDock>,
  );
  const sentence = screen.getByTestId("kid-sentence-audio") as HTMLButtonElement;
  const slow = screen.getByTestId("kid-sentence-audio-slow") as HTMLButtonElement;
  expect(sentence.disabled).toBe(true);
  expect(slow.disabled).toBe(true);
  fireEvent.click(sentence);
  fireEvent.click(slow);
  expect(onPlay).not.toHaveBeenCalled();
});

it("renders no sentence replay without the prop", () => {
  renderKid(
    <ExerciseFeedbackDock tone="correct" primary={<span>Dalej</span>} sentenceAudio={null}>
      <p>Świetnie!</p>
    </ExerciseFeedbackDock>,
  );
  expect(screen.queryByRole("button", { name: "Posłuchaj zdania" })).toBeNull();
  expect(screen.queryByTestId("kid-sentence-audio")).toBeNull();
  expect(screen.queryByTestId("kid-sentence-audio-slow")).toBeNull();
  expect(screen.queryByTestId("kid-sentence-audio-group")).toBeNull();
  expect(screen.queryByTestId("kid-sentence-audio-error")).toBeNull();
});

it("renders the explanation row with a listen button that calls onPlay", () => {
  const onPlay = vi.fn();
  renderKid(
    <ExerciseFeedbackDock tone="incorrect" primary={<span>Dalej</span>}
      explanation={{ text: "Po he dodajemy -s do czasownika.", onPlay }}>
      <p>Spróbuj jeszcze raz</p>
    </ExerciseFeedbackDock>,
  );
  const dock = screen.getByTestId("kid-feedback-dock");
  const text = screen.getByTestId("kid-explanation-text");
  expect(text.textContent).toBe("Po he dodajemy -s do czasownika.");
  expect(dock.contains(text)).toBe(true);
  const button = screen.getByRole("button", { name: "Posłuchaj wyjaśnienia" });
  expect(button.getAttribute("data-testid")).toBe("kid-explanation-audio");
  expect(button.getAttribute("title")).toBe("Posłuchaj wyjaśnienia");
  expect(button.classList.contains("kid-listen")).toBe(true);
  // przycisk na początku wiersza, przed tekstem
  expect(button.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(button);
  expect(onPlay).toHaveBeenCalledOnce();
});

it("renders the explanation text without a listen button when there is no recording", () => {
  renderKid(
    <ExerciseFeedbackDock tone="incorrect" primary={<span>Dalej</span>} explanation={{ text: "Po he dodajemy -s." }}>
      <p>Spróbuj jeszcze raz</p>
    </ExerciseFeedbackDock>,
  );
  expect(screen.getByTestId("kid-explanation-text").textContent).toBe("Po he dodajemy -s.");
  expect(screen.queryByTestId("kid-explanation-audio")).toBeNull();
  expect(screen.queryByRole("button", { name: "Posłuchaj wyjaśnienia" })).toBeNull();
});

it("renders no explanation row without the prop", () => {
  renderKid(
    <ExerciseFeedbackDock tone="incorrect" primary={<span>Dalej</span>} explanation={null}>
      <p>Spróbuj jeszcze raz</p>
    </ExerciseFeedbackDock>,
  );
  expect(screen.queryByTestId("kid-explanation-text")).toBeNull();
  expect(screen.queryByTestId("kid-explanation")).toBeNull();
});

it("pins the explanation row outside the top row, between it and the actions", () => {
  renderKid(
    <ExerciseFeedbackDock tone="incorrect" primary={<span data-testid="dock-primary">Dalej</span>}
      explanation={{ text: "Po he dodajemy -s.", onPlay: vi.fn() }}>
      <p>Spróbuj jeszcze raz</p>
    </ExerciseFeedbackDock>,
  );
  const dock = screen.getByTestId("kid-feedback-dock");
  const row = screen.getByTestId("kid-explanation");
  const badge = screen.getByTestId("kid-feedback-tone-icon");
  // Wiersz jest dzieckiem doku (nie przewijanego górnego wiersza z kartą wyniku).
  expect(row.parentElement).toBe(dock);
  expect(row.classList.contains("kid-feedback-pinned")).toBe(true);
  expect(row.contains(badge)).toBe(false);
  expect(badge.parentElement!.contains(row)).toBe(false);
  expect(badge.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(row.compareDocumentPosition(screen.getByTestId("dock-primary")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(dock.querySelector(".kid-feedback-scroll-limited")).toBeNull();
});

it("announces the explanation text through a polite live region", () => {
  renderKid(
    <ExerciseFeedbackDock tone="incorrect" primary={<span>Dalej</span>} explanation={{ text: "Po he dodajemy -s." }}>
      <p>Spróbuj jeszcze raz</p>
    </ExerciseFeedbackDock>,
  );
  expect(screen.getByTestId("kid-explanation-text").getAttribute("aria-live")).toBe("polite");
});

it("shows the playing ring on the explanation button like the sentence buttons", () => {
  const props = { tone: "incorrect" as const, primary: <span>Dalej</span>, children: <p>Spróbuj jeszcze raz</p> };
  const { rerender } = renderKid(<ExerciseFeedbackDock {...props} explanation={{ text: "Po he dodajemy -s.", onPlay: vi.fn(), playing: false }} />);
  const button = screen.getByTestId("kid-explanation-audio");
  expect(button.hasAttribute("data-sound-active")).toBe(false);
  expect(button.querySelector("[data-testid='kid-sound-ring']")).toBeNull();
  rerender(<ExerciseFeedbackDock {...props} explanation={{ text: "Po he dodajemy -s.", onPlay: vi.fn(), playing: true }} />);
  const playing = screen.getByTestId("kid-explanation-audio");
  expect(playing.getAttribute("data-sound-active")).toBe("true");
  expect(playing.querySelector("[data-testid='kid-sound-ring']")).not.toBeNull();
});

it("disables the explanation button when the controller would ignore the tap", () => {
  const onPlay = vi.fn();
  renderKid(
    <ExerciseFeedbackDock tone="incorrect" primary={<span>Dalej</span>} explanation={{ text: "Po he dodajemy -s.", onPlay, disabled: true }}>
      <p>Spróbuj jeszcze raz</p>
    </ExerciseFeedbackDock>,
  );
  const button = screen.getByTestId("kid-explanation-audio") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(onPlay).not.toHaveBeenCalled();
});

it("a failed explanation replay shows the shared message and wobbles only the explanation button", () => {
  renderKid(
    <ExerciseFeedbackDock tone="incorrect" primary={<span>Dalej</span>}
      sentenceAudio={{ ...idleSentence, onPlay: vi.fn() }}
      explanation={{ text: "Po he dodajemy -s.", onPlay: vi.fn(), error: { seq: 3 } }}>
      <p>Spróbuj jeszcze raz</p>
    </ExerciseFeedbackDock>,
  );
  const region = screen.getByTestId("kid-sentence-audio-error");
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(region.textContent).toBe(messages.kid.sentenceAudioFailed);
  expect(screen.getByTestId("kid-explanation-audio").getAttribute("data-audio-failed")).toBe("3");
  expect(screen.getByTestId("kid-sentence-audio").hasAttribute("data-audio-failed")).toBe(false);
  expect(screen.getByTestId("kid-sentence-audio-slow").hasAttribute("data-audio-failed")).toBe(false);
});

it("keeps the error region with an explanation recording even without the sentence recording", () => {
  const props = { tone: "incorrect" as const, primary: <span>Dalej</span>, children: <p>Spróbuj jeszcze raz</p> };
  const { rerender } = renderKid(<ExerciseFeedbackDock {...props} explanation={{ text: "Po he dodajemy -s.", onPlay: vi.fn() }} />);
  expect(screen.getByTestId("kid-sentence-audio-error").textContent).toBe("");
  rerender(<ExerciseFeedbackDock {...props} explanation={{ text: "Po he dodajemy -s.", onPlay: vi.fn(), error: { seq: 1 } }} />);
  expect(screen.getByTestId("kid-sentence-audio-error").textContent).toBe(messages.kid.sentenceAudioFailed);
  // Bez nagrania (sam tekst) region nie powstaje.
  rerender(<ExerciseFeedbackDock {...props} explanation={{ text: "Po he dodajemy -s." }} />);
  expect(screen.queryByTestId("kid-sentence-audio-error")).toBeNull();
});

it("reads the result, then the replay error, then the explanation row (DOM order)", () => {
  renderKid(
    <ExerciseFeedbackDock tone="incorrect" primary={<span data-testid="dock-primary">Dalej</span>}
      sentenceAudio={{ ...idleSentence, onPlay: vi.fn() }}
      explanation={{ text: "Po he dodajemy -s.", onPlay: vi.fn(), error: { seq: 2 } }}>
      <p>Spróbuj jeszcze raz</p>
    </ExerciseFeedbackDock>,
  );
  const dock = screen.getByTestId("kid-feedback-dock");
  const topRow = screen.getByTestId("kid-feedback-tone-icon").parentElement!;
  const error = screen.getByTestId("kid-sentence-audio-error");
  const row = screen.getByTestId("kid-explanation");
  // Wynik → błąd odsłuchu (wizualnie przesuwa go CSS `order`) → wyjaśnienie → akcje.
  expect(error.parentElement).toBe(dock);
  expect(topRow.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(error.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(row.compareDocumentPosition(screen.getByTestId("dock-primary")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
