import { describe, expect, it, vi } from "vitest";
import { messages } from "@learning/contracts";
import PromptAudioControls, { cardAudioTargetLabel, promptAudioRegenerateInput, VoiceToneSelect } from "./PromptAudioControls";
import { renderParentMarkup } from "../test-render";

const ASSET_ID = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const PREVIOUS_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const DRAFT_ID = "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e";

function controls(audio: Parameters<typeof PromptAudioControls>[0]["audio"], targetLabel: string) {
  return renderParentMarkup(
    <PromptAudioControls audio={audio} target={{ kind: "prompt", itemRevisionId: ASSET_ID }} targetLabel={targetLabel}
      lessonDraftId={DRAFT_ID} deckId={DRAFT_ID} canRegenerate locked={false} testId="audio" onPlay={vi.fn()} />,
  );
}

describe("PromptAudioControls — nazwy dostępności", () => {
  it("„Posłuchaj” i „Nagraj ponownie” mówią, którego ćwiczenia dotyczą, a widoczny tekst zostaje", () => {
    const markup = controls({ state: "ready", assetId: ASSET_ID }, "Ćwiczenie 3");
    expect(markup).toContain('aria-label="Posłuchaj: Ćwiczenie 3"');
    expect(markup).toContain('aria-label="Nagraj ponownie: Ćwiczenie 3"');
    expect(markup).toContain(`>${messages.lessons.promptAudioListen}<`);
    expect(markup).toContain(`>${messages.lessons.promptAudioRegenerate}<`);
  });

  it("„Posłuchaj poprzedniego” przy trwającym nagraniu też ma cel w nazwie", () => {
    const markup = controls({ state: "pending", previousAssetId: PREVIOUS_ID }, "Ptaki, karta 2 — Sowy");
    expect(markup).toContain('aria-label="Posłuchaj poprzedniego: Ptaki, karta 2 — Sowy"');
    expect(markup).not.toContain('aria-label="Posłuchaj: ');
  });

  it("cel z `$&` wstawiony dosłownie", () => {
    expect(controls({ state: "ready", assetId: ASSET_ID }, "karta 1 — A $& B")).toContain('aria-label="Posłuchaj: karta 1 — A $&amp; B"');
  });
});

describe("PromptAudioControls — nagranie wyjaśnienia", () => {
  it("kontrolki wyjaśnienia mają odrębną nazwę dostępności i własny testId", () => {
    const markup = renderParentMarkup(
      <PromptAudioControls audio={{ state: "ready", assetId: ASSET_ID }} target={{ kind: "prompt", itemRevisionId: ASSET_ID }} role="explanation_audio"
        targetLabel={messages.lessons.explanationAudioTarget.replace("{exercise}", "Ćwiczenie 3")}
        lessonDraftId={DRAFT_ID} deckId={DRAFT_ID} canRegenerate locked={false} testId="lesson-explanation-audio" onPlay={vi.fn()} />,
    );
    expect(markup).toContain('data-testid="lesson-explanation-audio"');
    expect(markup).toContain('aria-label="Posłuchaj: wyjaśnienie — Ćwiczenie 3"');
    expect(markup).toContain('aria-label="Nagraj ponownie: wyjaśnienie — Ćwiczenie 3"');
    expect(markup).not.toContain('aria-label="Posłuchaj: Ćwiczenie 3"');
  });

  it("rola explanation_audio idzie do mutacji; pytanie wysyła wejście jak dotąd, bez roli", () => {
    expect(promptAudioRegenerateInput(DRAFT_ID, ASSET_ID, "explanation_audio")).toEqual({ lessonDraftId: DRAFT_ID, itemRevisionId: ASSET_ID, role: "explanation_audio" });
    expect(promptAudioRegenerateInput(DRAFT_ID, ASSET_ID, undefined)).toEqual({ lessonDraftId: DRAFT_ID, itemRevisionId: ASSET_ID });
    expect(promptAudioRegenerateInput(DRAFT_ID, ASSET_ID, "prompt_audio")).toEqual({ lessonDraftId: DRAFT_ID, itemRevisionId: ASSET_ID });
  });
});

describe("cardAudioTargetLabel", () => {
  it("zagadnienie, numer karty od 1 i jej tytuł — dwie karty 1 o tym samym tytule w różnych zagadnieniach się różnią", () => {
    expect(cardAudioTargetLabel(1, " Sowy ", " Ptaki ")).toBe("Ptaki, karta 2 — Sowy");
    expect(cardAudioTargetLabel(0, "Wprowadzenie", "Ptaki")).not.toBe(cardAudioTargetLabel(0, "Wprowadzenie", "Ssaki"));
  });

  it("pusty tytuł karty albo brak zagadnienia pomija część razem z separatorem", () => {
    expect(cardAudioTargetLabel(0, "  ", "Ptaki")).toBe("Ptaki, karta 1");
    expect(cardAudioTargetLabel(0, "Sowy", undefined)).toBe("karta 1 — Sowy");
    expect(cardAudioTargetLabel(0, "", "")).toBe("karta 1");
  });
});

describe("VoiceToneSelect — podpowiedź", () => {
  const select = (styleEnabled: boolean) => renderParentMarkup(
    <VoiceToneSelect value={undefined} disabled={false} styleEnabled={styleEnabled} hint={messages.lessons.voiceToneCardHint} whisper
      testId="tone" onChange={vi.fn()} />,
  );

  it("przy włączonym stylu: podpowiedź karty z regułą „Tajemniczo” od dwóch zdań", () => {
    const markup = select(true);
    expect(markup).toContain("Tajemniczo” szepcze tekst od dwóch zdań");
    expect(markup).not.toContain("UMIEM_TTS_STYLE=none");
  });

  it("przy UMIEM_TTS_STYLE=none: mówi, że ton nie zmieni nagrań", () => {
    const markup = select(false);
    expect(markup).toContain(messages.lessons.voiceToneStyleOff);
    expect(markup).not.toContain("szepcze tekst od dwóch zdań");
  });
});
