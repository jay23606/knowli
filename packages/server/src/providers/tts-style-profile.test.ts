import { describe, expect, it } from "vitest";
import { LessonVoiceToneSchema, type LessonVoiceTone } from "@learning/contracts";
import { ttsInstructionsFor } from "../config";
import type { TtsRoleStyle } from "../domain/tts-style";
import { fakeMediaSettings } from "./fake";
import { STYLE_SENTENCES_PL, ttsRequestInstructions } from "./tts-style-profile";

const LANGUAGE = "Mów po polsku, z polską wymową.";
const styled = {
  ...fakeMediaSettings.tts,
  style: "instructions" as const,
  instructions: { "pl-PL": LANGUAGE },
};

describe("ttsRequestInstructions", () => {
  it("łączy instrukcję języka ze zdaniem stylu jedną spacją", () => {
    expect(ttsRequestInstructions(styled, "pl-PL", "ui_praise")).toBe(
      "Mów po polsku, z polską wymową. Powiedz radośnie, z uśmiechem w głosie, jak do ośmiolatka.",
    );
  });

  it("bez stylu zwraca dokładnie instrukcję języka", () => {
    expect(ttsRequestInstructions(styled, "pl-PL")).toBe(LANGUAGE);
    expect(ttsRequestInstructions(styled, "pl-PL", undefined)).toBe(ttsInstructionsFor(styled, "pl-PL"));
  });

  it("dla locale innego niż pl-PL zwraca instrukcję języka, także ze stylem", () => {
    expect(ttsRequestInstructions(styled, "en-GB", "ui_praise")).toBe(ttsInstructionsFor(styled, "en-GB"));
    expect(ttsRequestInstructions(styled, "en-GB", "ui_praise")).toBeUndefined();
    const withEnglish = { ...styled, instructions: { ...styled.instructions, "en-GB": "Speak British." } };
    expect(ttsRequestInstructions(withEnglish, "en-GB", "ui_praise")).toBe("Speak British.");
  });

  it("gdy tts.style nie jest 'instructions', zwraca instrukcję języka", () => {
    const off = { ...styled, style: undefined };
    expect(ttsRequestInstructions(off, "pl-PL", "ui_praise")).toBe(ttsInstructionsFor(off, "pl-PL"));
    const explicitNone = { ...styled, style: "none" as never };
    expect(ttsRequestInstructions(explicitNone, "pl-PL", "ui_praise")).toBe(LANGUAGE);
  });

  it("bez instrukcji języka ze stylem zwraca samo zdanie stylu", () => {
    const noLanguage = { ...fakeMediaSettings.tts, style: "instructions" as const };
    expect(ttsRequestInstructions(noLanguage, "pl-PL", "ui_gentle")).toBe(STYLE_SENTENCES_PL.ui_gentle);
  });

  it("nigdy nie zwraca pustego łańcucha", () => {
    const empty = { ...styled, instructions: { "pl-PL": "" } };
    expect(ttsRequestInstructions(empty, "pl-PL", "ui_gentle")).toBe(STYLE_SENTENCES_PL.ui_gentle);
    const nothing = { ...fakeMediaSettings.tts, style: "instructions" as const };
    expect(ttsRequestInstructions(nothing, "pl-PL")).toBeUndefined();
    expect(ttsRequestInstructions(nothing, "en-GB", "ui_praise")).toBeUndefined();
  });

  it("składa tekst dla każdego stylu roli", () => {
    const roles: TtsRoleStyle[] = [
      "ui_praise", "ui_gentle", "ui_guidance", "ui_closing", "lesson_question", "lesson_card", "lesson_explanation",
    ];
    expect(Object.fromEntries(roles.map((role) => [role, ttsRequestInstructions(styled, "pl-PL", role)]))).toMatchInlineSnapshot(`
      {
        "lesson_card": "Mów po polsku, z polską wymową. Przeczytaj jak ciepły nauczyciel, który opowiada, spokojnym tempem.",
        "lesson_explanation": "Mów po polsku, z polską wymową. Wyjaśnij spokojnie i życzliwie jak cierpliwy nauczyciel; angielskie słowa wymów po angielsku.",
        "lesson_question": "Mów po polsku, z polską wymową. Przeczytaj przyjaźnie, spokojnym tempem i wyraźnie.",
        "ui_closing": "Mów po polsku, z polską wymową. Powiedz ciepło i z zadowoleniem.",
        "ui_gentle": "Mów po polsku, z polską wymową. Powiedz ciepło i spokojnie, bez rozczarowania w głosie.",
        "ui_guidance": "Mów po polsku, z polską wymową. Powiedz przyjaźnie i zachęcająco, wyraźnie.",
        "ui_praise": "Mów po polsku, z polską wymową. Powiedz radośnie, z uśmiechem w głosie, jak do ośmiolatka.",
      }
    `);
  });

  it("kończy instrukcję zdaniem tonu ze specyfikacji dla każdego tonu lekcji", () => {
    const expected: Record<LessonVoiceTone, string> = {
      cheerful: "Przeczytaj radośnie, z entuzjazmem i uśmiechem w głosie, wyraźnie.",
      curious: "Przeczytaj z wyraźną ciekawością, pytająco, jakbyś zapraszał do zgadywania.",
      gentle: "Przeczytaj bardzo łagodnie i wolniej, ciepłym, kojącym głosem.",
      mysterious: "Pierwsze zdanie powiedz szeptem, jak sekret; resztę tajemniczo, ale wyraźnie i spokojnie.",
    };
    for (const tone of Object.keys(expected) as LessonVoiceTone[]) {
      const instructions = ttsRequestInstructions(styled, "pl-PL", tone);
      expect(instructions).toBe(`${LANGUAGE} ${expected[tone]}`);
      expect(instructions?.endsWith(expected[tone])).toBe(true);
    }
  });

  it("składa tekst dla każdego tonu lekcji", () => {
    const tones = LessonVoiceToneSchema.options;
    expect(Object.fromEntries(tones.map((tone) => [tone, ttsRequestInstructions(styled, "pl-PL", tone)]))).toMatchInlineSnapshot(`
      {
        "cheerful": "Mów po polsku, z polską wymową. Przeczytaj radośnie, z entuzjazmem i uśmiechem w głosie, wyraźnie.",
        "curious": "Mów po polsku, z polską wymową. Przeczytaj z wyraźną ciekawością, pytająco, jakbyś zapraszał do zgadywania.",
        "gentle": "Mów po polsku, z polską wymową. Przeczytaj bardzo łagodnie i wolniej, ciepłym, kojącym głosem.",
        "mysterious": "Mów po polsku, z polską wymową. Pierwsze zdanie powiedz szeptem, jak sekret; resztę tajemniczo, ale wyraźnie i spokojnie.",
      }
    `);
  });

  it("trzyma każde zdanie stylu w limicie 120 znaków", () => {
    for (const sentence of Object.values(STYLE_SENTENCES_PL)) {
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence.length).toBeLessThanOrEqual(120);
    }
  });

  it("zdanie stylu wyjaśnienia błędu jest takie jak w specyfikacji", () => {
    expect(STYLE_SENTENCES_PL.lesson_explanation).toBe("Wyjaśnij spokojnie i życzliwie jak cierpliwy nauczyciel; angielskie słowa wymów po angielsku.");
  });
});
