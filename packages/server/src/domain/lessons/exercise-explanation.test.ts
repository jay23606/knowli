import { describe, expect, it } from "vitest";
import { computeTargetKey } from "../target-key";
import {
  MAX_EXPLANATION_LENGTH,
  explanationExposureKeyFinder,
  explanationExposureKeys,
  explanationTextErrors,
} from "./exercise-explanation";
import { MAX_TEXT_LENGTH } from "./pool-validation";
import { englishChapterSubject } from "./subjects/english-chapter/module";

describe("explanationTextErrors", () => {
  it("limit wyjaśnienia jest równy limitowi pól tekstowych ćwiczenia", () => {
    expect(MAX_EXPLANATION_LENGTH).toBe(MAX_TEXT_LENGTH);
  });

  it("przyjmuje jedno zdanie zwykłego tekstu", () => {
    expect(explanationTextErrors("Przy he, she, it dodajemy -s: he plays.")).toEqual([]);
  });

  it("skrót z kropką nie dzieli zdania", () => {
    expect(explanationTextErrors("Np. he plays.")).toEqual([]);
  });

  it("odrzuca tekst pusty lub same spacje", () => {
    const errors = explanationTextErrors("  ");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^explanationPl:/);
  });

  it("odrzuca tekst dłuższy niż 120 znaków", () => {
    const errors = explanationTextErrors("a".repeat(121));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^explanationPl:.*120/);
    expect(explanationTextErrors("a".repeat(120))).toEqual([]);
  });

  it("odrzuca łamanie wiersza", () => {
    const errors = explanationTextErrors("a\nb");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^explanationPl:/);
  });

  it("odrzuca znaczniki gwiazdki i podkreślenia", () => {
    for (const text of ["*he*", "he_plays"]) {
      const errors = explanationTextErrors(text);
      expect(errors, text).toHaveLength(1);
      expect(errors[0]).toMatch(/^explanationPl:/);
    }
  });

  it("odrzuca więcej niż jedno zdanie", () => {
    const errors = explanationTextErrors("Dodajemy -s. Tak mówimy.");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^explanationPl:/);
  });
});

describe("explanationExposureKeys", () => {
  const subject = {};
  const target = (text: string) => ({ exposureText: text, targetKey: computeTargetKey(text, "en-GB") });
  const own = target("he plays");

  it("usuwa własny tekst; „Do” jest polskim słowem, więc nie daje ekspozycji", () => {
    const others = [target("Do"), target("he"), target("plays")];
    expect(explanationExposureKeys("Do nie łączy się z he plays.", own, others, subject)).toEqual([]);
  });

  it("pomija jednowyrazowy homograf „Do”, a cytowane „plays” nadal liczy", () => {
    const does = target("he does");
    const doTarget = target("Do");
    const plays = target("plays");
    expect(explanationExposureKeys("Do nie dodajemy -s, a plays tak.", does, [doTarget, plays], subject)).toEqual([plays.targetKey]);
  });

  it("pomija wszystkie jednowyrazowe homografy, ale nie wielowyrazowe cele z nimi", () => {
    const homographs = ["a", "i", "o", "u", "w", "z", "do", "to", "on", "no", "na", "my", "we", "go", "ja", "ze", "po", "od"];
    const explanation = `Słowa ${homographs.join(" ")} i I go home są w zdaniu.`;
    const targets = [...homographs.map(target), target("I")];
    expect(explanationExposureKeys(explanation, own, targets, subject)).toEqual([]);
    const sentence = target("I go home");
    expect(explanationExposureKeys(explanation, own, [sentence], subject)).toEqual([sentence.targetKey]);
  });

  it("wariant wsadowy daje te same klucze co pojedyncze wywołania", () => {
    const targets = [own, target("Do"), target("plays"), target("she plays")];
    const keysFor = explanationExposureKeyFinder(targets, subject);
    const explanation = "Zapamiętaj she plays i he plays.";
    targets.forEach((ownTarget, index) => {
      const others = targets.filter((_, other) => other !== index);
      expect(keysFor(explanation, index)).toEqual(explanationExposureKeys(explanation, ownTarget, others, subject));
    });
    expect(keysFor(explanation, 0)).toEqual([targets[2]!.targetKey, targets[3]!.targetKey]);
  });

  it("dopasowuje na granicach słów: „display” nie zawiera „plays”", () => {
    expect(explanationExposureKeys("Rzeczownik display jest inny.", own, [target("plays")], subject)).toEqual([]);
  });

  it("ignoruje wielkość liter: „She Plays” pasuje do „plays”", () => {
    const plays = target("plays");
    expect(explanationExposureKeys("Zapamiętaj She Plays z -s.", own, [plays], subject)).toEqual([plays.targetKey]);
  });

  it("pomija inny cel z tym samym kluczem co własny", () => {
    // Tekst bliźniaka nie znika razem z własnym, więc pomija go dopiero sprawdzenie klucza.
    const twin = { exposureText: "plays", targetKey: own.targetKey };
    expect(explanationExposureKeys("Zapamiętaj plays.", own, [twin], subject)).toEqual([]);
  });

  it("cytat dłuższego celu zawierającego własny tekst też daje ekspozycję", () => {
    const snowing = target("It's snowing");
    const longer = target("It's snowing today");
    expect(explanationExposureKeys("Zapamiętaj It's snowing today.", snowing, [longer], subject)).toEqual([longer.targetKey]);
    // Samo własne zdanie w wyjaśnieniu nie ujawnia dłuższego celu.
    expect(explanationExposureKeys("Zapamiętaj It's snowing.", snowing, [longer], subject)).toEqual([]);
  });

  it("nie powtarza kluczy i zachowuje kolejność innych ćwiczeń", () => {
    const a = target("are");
    const b = target("is");
    const result = explanationExposureKeys("Po is i po are używamy is.", own, [a, b, { ...b }], subject);
    expect(result).toEqual([a.targetKey, b.targetKey]);
  });

  it("zwraca pustą listę bez trafień", () => {
    expect(explanationExposureKeys("Dodajemy końcówkę -s.", own, [target("does")], subject)).toEqual([]);
  });

  it("stosuje normalizację ekspozycji przedmiotu po obu stronach", () => {
    const sentence = target("It's snowing.");
    // Apostrof typograficzny i końcowa kropka znikają w normalizacji rozdziału.
    const keys = explanationExposureKeys("Powiedz It’s snowing zamiast tego.", own, [sentence], englishChapterSubject);
    expect(keys).toEqual([sentence.targetKey]);
  });
});
