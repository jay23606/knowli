import { describe, expect, it } from "vitest";
import { presentSimpleBaseOf, presentSimpleFormFor, tenseTokens, verbGroupsIn } from "./present-continuous-tense-choice";

describe("presentSimpleFormFor", () => {
  it("3. osoba liczby pojedynczej: forma z -s albo doesn't / does not", () => {
    expect(presentSimpleFormFor("read", true, false)).toEqual(["reads"]);
    expect(presentSimpleFormFor("watch", true, false)).toEqual(["watches"]);
    expect(presentSimpleFormFor("study", true, false)).toEqual(["studies"]);
    expect(presentSimpleFormFor("have", true, false)).toEqual(["has"]);
    expect(presentSimpleFormFor("watch", true, true)).toEqual(["doesn't watch", "does not watch"]);
  });

  it("pozostałe osoby: forma podstawowa albo don't / do not", () => {
    expect(presentSimpleFormFor("read", false, false)).toEqual(["read"]);
    expect(presentSimpleFormFor("play", false, true)).toEqual(["don't play", "do not play"]);
  });
});

describe("presentSimpleBaseOf", () => {
  it("forma podstawowa czasownika z tabeli, kolokacji albo listy stanu", () => {
    expect(presentSimpleBaseOf("reads")).toBe("read");
    expect(presentSimpleBaseOf("watches")).toBe("watch");
    expect(presentSimpleBaseOf("cries")).toBe("cry");
    expect(presentSimpleBaseOf("has")).toBe("have");
    expect(presentSimpleBaseOf("likes")).toBe("like");
    expect(presentSimpleBaseOf("play")).toBe("play");
    expect(presentSimpleBaseOf("comics")).toBeUndefined();
    expect(presentSimpleBaseOf("is")).toBeUndefined();
  });
});

describe("verbGroupsIn", () => {
  const groups = (text: string) => verbGroupsIn(tenseTokens(text)).map(({ tense, base, operator, subject }) => ({ tense, base, operator, subject }));

  it("Present Simple bez operatora, z operatorem i w pytaniu", () => {
    expect(groups("Every day Ola reads a comic")).toEqual([{ tense: "simple", base: "read", operator: undefined, subject: ["every", "day", "ola"] }]);
    expect(groups("She doesn't watch TV every morning")).toEqual([{ tense: "simple", base: "watch", operator: "does", subject: ["she"] }]);
    expect(groups("Does Ola play football on Saturdays")).toEqual([{ tense: "simple", base: "play", operator: "does", subject: ["ola"] }]);
    expect(groups("Ola does her homework every day")).toEqual([{ tense: "simple", base: "do", operator: undefined, subject: ["ola"] }]);
  });

  it("Present Continuous: jedna grupa na zdanie składowe, rzeczownik w dopełnieniu się nie liczy", () => {
    expect(groups("She is wearing a watch now").map((group) => group.tense)).toEqual(["continuous"]);
    expect(groups("Ola is reading and writing now").map((group) => group.tense)).toEqual(["continuous"]);
  });

  it("dwa zdania składowe i podmiot złożony", () => {
    expect(groups("Mum cooks dinner and Dad reads every evening")).toEqual([
      { tense: "simple", base: "cook", operator: undefined, subject: ["mum"] },
      { tense: "simple", base: "read", operator: undefined, subject: ["dad"] },
    ]);
    expect(groups("Tom and Ola play football every day")).toEqual([
      { tense: "simple", base: "play", operator: undefined, subject: ["tom", "and", "ola"] },
    ]);
  });

  it("czasownik tuż po spójniku za orzeczeniem ma wspólny podmiot (także rzeczownik na -s: ćwiczenie wtedy odpada)", () => {
    expect(groups("Look Tom is eating bread and drinks milk")).toEqual([
      { tense: "continuous", base: undefined, operator: undefined, subject: ["look", "tom"] },
      { tense: "simple", base: "drink", operator: undefined, subject: ["look", "tom"] },
    ]);
    expect(groups("Ola is reading and writing now").map((group) => group.tense)).toEqual(["continuous"]);
  });

  it("forma czasownika po określniku, przyimku albo na początku zdania nie jest orzeczeniem", () => {
    expect(groups("The cook and the waiter")).toEqual([]);
    expect(groups("Listen, Tom and Ola")).toEqual([]);
    expect(groups("After work Dad cooks dinner")).toEqual([{ tense: "simple", base: "cook", operator: undefined, subject: ["after", "work", "dad"] }]);
  });
});
