// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderKid, screen } from "../test/render-kid";
import { QuestionAudioButton } from "./QuestionAudioButton";

afterEach(cleanup);

describe("QuestionAudioButton (design szkoły §11.4)", () => {
  it("nazwany głośnik „Posłuchaj pytania” odtwarza na żądanie", () => {
    const onPlay = vi.fn(async () => {});
    renderKid(<QuestionAudioButton onPlay={onPlay} disabled={false} />);
    const button = screen.getByTestId("kid-question-audio");
    expect(button.getAttribute("aria-label")).toBe("Posłuchaj pytania");
    expect(onPlay).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onPlay).toHaveBeenCalledOnce();
  });

  it("jest nieaktywny, gdy zadanie nie przyjmuje odsłuchu (np. nagrywanie)", () => {
    renderKid(<QuestionAudioButton onPlay={async () => {}} disabled />);
    expect((screen.getByTestId("kid-question-audio") as HTMLButtonElement).disabled).toBe(true);
  });

  it("błąd odtwarzania nie zostawia komunikatu w wierszu instrukcji (pokazuje go pasek statusu)", async () => {
    const onPlay = vi.fn(async () => { throw new Error("playback failed"); });
    renderKid(<QuestionAudioButton onPlay={onPlay} disabled={false} />);
    const button = screen.getByTestId("kid-question-audio");
    await act(async () => { fireEvent.click(button); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button.getAttribute("data-sound-active")).toBeNull();
  });

  it("controlled playing prop shows the ring", () => {
    const onPlay = vi.fn(async () => {});
    const { rerender } = renderKid(<QuestionAudioButton onPlay={onPlay} disabled={false} playing />);
    const button = screen.getByTestId("kid-question-audio");
    // Odtwarzanie rozpoczęte przez kontroler (autoodtwarzanie historyjki) — bez kliknięcia.
    expect(onPlay).not.toHaveBeenCalled();
    expect(button.getAttribute("data-sound-active")).toBe("true");
    expect(button.querySelector("[data-testid='kid-sound-ring']")).not.toBeNull();
    rerender(<QuestionAudioButton onPlay={onPlay} disabled={false} playing={false} />);
    expect(button.getAttribute("data-sound-active")).toBeNull();
    expect(button.querySelector("[data-testid='kid-sound-ring']")).toBeNull();
  });

  it("without the prop the button behaves as before", async () => {
    let release!: () => void;
    const onPlay = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    renderKid(<QuestionAudioButton onPlay={onPlay} disabled={false} />);
    const button = screen.getByTestId("kid-question-audio");
    expect(button.getAttribute("data-sound-active")).toBeNull();
    await act(async () => { fireEvent.click(button); });
    expect(button.getAttribute("data-sound-active")).toBe("true");
    expect(button.querySelector("[data-testid='kid-sound-ring']")).not.toBeNull();
    await act(async () => { release(); });
    expect(button.getAttribute("data-sound-active")).toBeNull();
  });

  it("ponowne dotknięcie: koniec poprzedniego odtwarzania nie gasi wskaźnika nowego", async () => {
    const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
    const onPlay = vi.fn(() => new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }); }));
    renderKid(<QuestionAudioButton onPlay={onPlay} disabled={false} />);
    const button = screen.getByTestId("kid-question-audio");
    await act(async () => { fireEvent.click(button); });
    await act(async () => { fireEvent.click(button); });
    // Zatrzymanie pierwszego odtwarzania przez drugie dotknięcie domyka jego obietnicę (także błędem).
    await act(async () => { pending[0]!.reject(new Error("stopped")); });
    expect(button.getAttribute("data-sound-active")).toBe("true");
    await act(async () => { pending[1]!.resolve(); });
    expect(button.getAttribute("data-sound-active")).toBeNull();
  });
});
