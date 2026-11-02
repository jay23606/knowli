import { describe, expect, it } from "vitest";
import { defaultMediaSettings } from "../../config";
import { requiredAssetsFor, requiredAssetsForLessonCards, requiredAssetsForLessonExercise } from "./media-reconciliation";
import { schoolSubject } from "../../domain/lessons/subjects/school/module";
import { payloadToItem } from "./item-payload";

describe("requiredAssetsForLessonExercise — nagranie pytania (design szkoły §11.2)", () => {
  const choice = {
    exerciseType: "lesson_choice",
    instructionPl: "Wybierz odpowiedź.",
    stem: "Ile nóg ma pająk?",
    options: [{ id: "a", text: "osiem" }, { id: "b", text: "sześć" }],
    answer: "osiem",
    answerLocale: "pl-PL",
  };

  it("`ttsForPrompts` zleca `prompt_audio` po polsku z polecenia i pytania, bez opcji", () => {
    const required = requiredAssetsForLessonExercise(choice, defaultMediaSettings, { ttsForAnswers: false, ttsForPrompts: true, ttsForFeedbackSentence: false });
    expect(required.map((asset) => asset.role)).toEqual(["prompt_audio"]);
    expect(required[0]!.metadata).toMatchObject({ kind: "tts", text: "Wybierz odpowiedź. Ile nóg ma pająk?", locale: "pl-PL" });
  });

  it("zmiana treści pytania zmienia fingerprint (nowe nagranie przy edycji)", () => {
    const flags = { ttsForAnswers: false, ttsForPrompts: true, ttsForFeedbackSentence: false };
    const before = requiredAssetsForLessonExercise(choice, defaultMediaSettings, flags)[0]!.fingerprint;
    const after = requiredAssetsForLessonExercise({ ...choice, stem: "Ile nóg ma owad?" }, defaultMediaSettings, flags)[0]!.fingerprint;
    expect(after).not.toBe(before);
  });

  it("bez flag nic nie zleca; obliczenia nie mają nagrania pytania", () => {
    expect(requiredAssetsForLessonExercise(choice, defaultMediaSettings, { ttsForAnswers: false, ttsForPrompts: false, ttsForFeedbackSentence: false })).toEqual([]);
    expect(requiredAssetsForLessonExercise({ exerciseType: "lesson_calculation", instructionPl: "Oblicz.", prompt: "3/4 + 1/2", answer: "5/4", answerLocale: "pl-PL" },
      defaultMediaSettings, { ttsForAnswers: false, ttsForPrompts: true, ttsForFeedbackSentence: false })).toEqual([]);
  });

  it("`ttsForAnswers` nadal zleca `target_audio` odpowiedzi", () => {
    const required = requiredAssetsForLessonExercise({ ...choice, answerLocale: "en-GB", answer: "eight" }, defaultMediaSettings, { ttsForAnswers: true, ttsForPrompts: false, ttsForFeedbackSentence: false });
    expect(required.map((asset) => asset.role)).toEqual(["target_audio"]);
  });

  it("głos zależy od locale: angielskie słówko głosem en-GB, polskie pytanie głosem domyślnym", () => {
    const settings = { ...defaultMediaSettings, tts: { ...defaultMediaSettings.tts, voice: "pl-PL-Harper", voices: { "en-GB": "en-GB-Emily" } } };
    const [prompt] = requiredAssetsForLessonExercise(choice, settings, { ttsForAnswers: false, ttsForPrompts: true, ttsForFeedbackSentence: false });
    expect(prompt!.metadata).toMatchObject({ locale: "pl-PL", voice: "pl-PL-Harper" });
    const vocab = requiredAssetsFor(payloadToItem({ source: "czwartek", target: "Thursday", example: "Today is Thursday.", visualType: "none", sourceLocale: "pl-PL", targetLocale: "en-GB" }), settings);
    expect(vocab.map((asset) => asset.metadata.voice)).toEqual(["en-GB-Emily", "en-GB-Emily"]);
    const defaultVoice = requiredAssetsFor(payloadToItem({ source: "czwartek", target: "Thursday", visualType: "none", sourceLocale: "pl-PL", targetLocale: "en-GB" }), defaultMediaSettings);
    expect(vocab[0]!.fingerprint).not.toBe(defaultVoice[0]!.fingerprint);
  });

  it("format i instrukcja wymowy idą za locale tekstu do metadanych i fingerprintu", () => {
    const settings = {
      ...defaultMediaSettings,
      tts: { ...defaultMediaSettings.tts, format: "wav" as const, instructions: { "pl-PL": "Mów po polsku.", "en-GB": "Speak British English." } },
    };
    const [prompt] = requiredAssetsForLessonExercise(choice, settings, { ttsForAnswers: false, ttsForPrompts: true, ttsForFeedbackSentence: false });
    expect(prompt!.metadata).toMatchObject({ locale: "pl-PL", format: "wav", instructions: "Mów po polsku." });
    const vocab = requiredAssetsFor(payloadToItem({ source: "czwartek", target: "Thursday", visualType: "none", sourceLocale: "pl-PL", targetLocale: "en-GB" }), settings);
    expect(vocab[0]!.metadata).toMatchObject({ locale: "en-GB", format: "wav", instructions: "Speak British English." });
    // locale bez instrukcji nie dostaje pola, a zmiana instrukcji zmienia fingerprint
    const noFrench = requiredAssetsFor(payloadToItem({ source: "czwartek", target: "jeudi", visualType: "none", sourceLocale: "pl-PL", targetLocale: "fr-FR" }), settings);
    expect(noFrench[0]!.metadata).not.toHaveProperty("instructions");
    const otherInstruction = { ...settings, tts: { ...settings.tts, instructions: { "en-GB": "Speak American English." } } };
    const vocabOther = requiredAssetsFor(payloadToItem({ source: "czwartek", target: "Thursday", visualType: "none", sourceLocale: "pl-PL", targetLocale: "en-GB" }), otherInstruction);
    expect(vocabOther[0]!.fingerprint).not.toBe(vocab[0]!.fingerprint);
  });
});

describe("requiredAssetsForLessonCards — nagrania kart nauki (design szkoły §12.2)", () => {
  const topic = schoolSubject.buildDynamicTopic!({
    titlePl: "Rośliny",
    objectives: [
      {
        id: "school.ddeck.fotosynteza",
        titlePl: "Fotosynteza",
        descriptionEn: "Photosynthesis.",
        cards: [{ title: "Fotosynteza", body: "Rośliny wytwarzają pokarm {{examples}}." }, { title: "Wzór", body: "Połowa to 1/2." }],
      },
      { id: "school.ddeck.korzenie", titlePl: "Korzenie", descriptionEn: "Roots.", cards: [{ title: "Korzenie", body: "Korzeń pobiera wodę." }] },
    ],
  });
  const context = { objectiveIds: ["school.ddeck.fotosynteza"], examples: { "school.ddeck.fotosynteza": ["Liść jest zielony"] } };

  it("karta wybranego zagadnienia z przykładami; karta ze wzorem i zagadnienie spoza wersji bez nagrania", () => {
    const required = requiredAssetsForLessonCards(topic, context, defaultMediaSettings, { ttsForPrompts: true });
    expect(required.map((card) => [card.objectiveId, card.cardIndex])).toEqual([["school.ddeck.fotosynteza", 0]]);
    expect(required[0]!.asset.metadata).toMatchObject({ kind: "tts", text: "Fotosynteza. Rośliny wytwarzają pokarm. Liść jest zielony.", locale: "pl-PL" });
  });

  it("zmiana treści karty zmienia fingerprint; bez `ttsForPrompts` brak nagrań", () => {
    const before = requiredAssetsForLessonCards(topic, context, defaultMediaSettings, { ttsForPrompts: true })[0]!.asset.fingerprint;
    const after = requiredAssetsForLessonCards(topic, { ...context, examples: {} }, defaultMediaSettings, { ttsForPrompts: true })[0]!.asset.fingerprint;
    expect(after).not.toBe(before);
    expect(requiredAssetsForLessonCards(topic, context, defaultMediaSettings, { ttsForPrompts: false })).toEqual([]);
  });
});

describe("requiredAssetsForLessonExercise — zdanie feedbacku (feedback_audio)", () => {
  const gap = {
    exerciseType: "lesson_gap",
    instructionPl: "Uzupełnij zdanie.",
    stem: "She ___ football.",
    answer: "plays",
    answerLocale: "en-GB",
  };
  const on = { ttsForAnswers: false, ttsForPrompts: false, ttsForFeedbackSentence: true };

  it("luka z flagą zleca feedback_audio z pełnym zdaniem, bez stylu wypowiedzi", () => {
    const settings = {
      ...defaultMediaSettings,
      tts: { ...defaultMediaSettings.tts, instructions: { "pl-PL": "Mów po polsku.", "en-GB": "Speak British English." } },
    };
    const required = requiredAssetsForLessonExercise(gap, settings, on);
    expect(required.map((asset) => asset.role)).toEqual(["feedback_audio"]);
    expect(required[0]!.metadata).toMatchObject({ kind: "tts", text: "She plays football.", locale: "en-GB", instructions: "Speak British English." });
  });

  it("lesson_listen_choice zleca feedback_audio z pełnym zdaniem; zmiana poprawnej opcji zmienia fingerprint", () => {
    const listen = {
      exerciseType: "lesson_listen_choice", stem: "She ___ milk.", answerLocale: "en-GB",
      options: [{ id: "a", text: "likes" }, { id: "b", text: "doesn't like" }], correctOption: "b",
    };
    const required = requiredAssetsForLessonExercise(listen, defaultMediaSettings, on);
    expect(required.map((asset) => asset.role)).toEqual(["feedback_audio"]);
    expect(required[0]!.metadata).toMatchObject({ kind: "tts", text: "She doesn't like milk.", locale: "en-GB" });
    const changed = requiredAssetsForLessonExercise({ ...listen, correctOption: "a" }, defaultMediaSettings, on);
    expect(changed[0]!.fingerprint).not.toBe(required[0]!.fingerprint);
  });

  it("flaga false nie zleca feedback_audio; lesson_match nie ma zdania", () => {
    expect(requiredAssetsForLessonExercise(gap, defaultMediaSettings, { ...on, ttsForFeedbackSentence: false })).toEqual([]);
    expect(requiredAssetsForLessonExercise({ ...gap, exerciseType: "lesson_match" }, defaultMediaSettings, on)).toEqual([]);
  });

  it("zmiana odpowiedzi zmienia fingerprint", () => {
    const before = requiredAssetsForLessonExercise(gap, defaultMediaSettings, on)[0]!.fingerprint;
    const after = requiredAssetsForLessonExercise({ ...gap, answer: "kicks" }, defaultMediaSettings, on)[0]!.fingerprint;
    expect(after).not.toBe(before);
  });

  it("lesson_choice składa zdanie z tekstu poprawnej opcji, lesson_order z klocków w kolejności", () => {
    const choice = requiredAssetsForLessonExercise({
      exerciseType: "lesson_choice", stem: "She ___ football.", answerLocale: "en-GB",
      options: [{ id: "a", text: "play" }, { id: "b", text: "plays" }], correctOption: "b",
    }, defaultMediaSettings, on);
    expect(choice[0]!.metadata).toMatchObject({ text: "She plays football." });
    const order = requiredAssetsForLessonExercise({
      exerciseType: "lesson_order", answerLocale: "en-GB",
      items: [{ id: "1", text: "She" }, { id: "2", text: "plays" }, { id: "3", text: "football." }],
    }, defaultMediaSettings, on);
    expect(order[0]!.metadata).toMatchObject({ text: "She plays football.", locale: "en-GB" });
  });

  it("lesson_cloze składa tekst ze słów luk (jak `filledText` omówienia), bez stylu pl-PL", () => {
    const settings = {
      ...defaultMediaSettings,
      tts: { ...defaultMediaSettings.tts, style: "instructions" as const, instructions: { "pl-PL": "Mów po polsku.", "en-GB": "Speak British English." } },
    };
    const cloze = {
      exerciseType: "lesson_cloze", answerLocale: "en-GB", instructionPl: "Dziś jest słonecznie. Uzupełnij tekst.",
      clozeText: "It's ___ today. I'm wearing my ___.", gapAnswers: ["sunny", "T-shirt"], extraWords: ["boots"], answer: "sunny, T-shirt",
    };
    const required = requiredAssetsForLessonExercise(cloze, settings, on);
    expect(required.map((asset) => asset.role)).toEqual(["feedback_audio"]);
    expect(required[0]!.metadata).toEqual({
      kind: "tts", text: "It's sunny today. I'm wearing my T-shirt.", locale: "en-GB",
      voice: expect.any(String), format: settings.tts.format, instructions: "Speak British English.",
    });
    // Inne słowo luki to inne nagranie; niekompletne luki albo uszkodzony payload — bez nagrania.
    const other = requiredAssetsForLessonExercise({ ...cloze, gapAnswers: ["windy", "T-shirt"] }, settings, on)[0]!;
    expect(other.fingerprint).not.toBe(required[0]!.fingerprint);
    expect(requiredAssetsForLessonExercise({ ...cloze, gapAnswers: ["sunny"] }, settings, on)).toEqual([]);
    expect(requiredAssetsForLessonExercise({ ...cloze, gapAnswers: ["sunny", 7] }, settings, on)).toEqual([]);
    expect(requiredAssetsForLessonExercise({ ...cloze, gapAnswers: "sunny, T-shirt" }, settings, on)).toEqual([]);
  });

  it("lesson_cloze z flagami szkoły (ttsForFeedbackSentence: false) nie zleca feedback_audio", () => {
    const flags = {
      ttsForAnswers: schoolSubject.ttsForAnswers, ttsForPrompts: schoolSubject.ttsForPrompts, ttsForFeedbackSentence: schoolSubject.ttsForFeedbackSentence,
    };
    expect(flags.ttsForFeedbackSentence).toBe(false);
    const cloze = {
      exerciseType: "lesson_cloze", answerLocale: "pl-PL", instructionPl: "Uzupełnij tekst.",
      clozeText: "Roślina pobiera ___ z powietrza.", gapAnswers: ["dwutlenek węgla"], extraWords: ["tlen"], answer: "dwutlenek węgla",
    };
    const roles = requiredAssetsForLessonExercise(cloze, defaultMediaSettings, flags).map((asset) => asset.role);
    expect(roles).not.toContain("feedback_audio");
    // To samo ćwiczenie z flagą odczytu zdania zleca nagranie — brak wynika z flagi, nie z payloadu.
    expect(requiredAssetsForLessonExercise(cloze, defaultMediaSettings, { ...flags, ttsForFeedbackSentence: true }).map((asset) => asset.role)).toContain("feedback_audio");
  });

  it("lesson_choice bez luki w zdaniu nie ma zdania do przeczytania", () => {
    expect(requiredAssetsForLessonExercise({
      exerciseType: "lesson_choice", stem: "What's the weather like?", answerLocale: "en-GB",
      options: [{ id: "a", text: "It's sunny." }, { id: "b", text: "It's a coat." }], correctOption: "a",
    }, defaultMediaSettings, on)).toEqual([]);
  });
});
