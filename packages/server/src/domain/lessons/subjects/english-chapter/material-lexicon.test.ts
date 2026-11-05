import { describe, expect, it } from "vitest";
import { frameKey, mentions, parseMaterialLexicon, plainText } from "./material-lexicon";

describe("parseMaterialLexicon", () => {
  it("wyciąga słowa z linii „en — pl” i ramy z sekcji zwrotów", () => {
    const material = "Pokój:\nbed — łóżko\nliving room — salon\nWhere is it? — Gdzie to jest?\nZwroty:\nThere's a … in the …";
    expect(parseMaterialLexicon(material)).toEqual({ words: ["bed", "living room"], frames: ["There's a … in the …"] });
  });

  it("materiał bez list daje puste wyniki", () => {
    expect(parseMaterialLexicon("Tekst bez list.")).toEqual({ words: [], frames: [] });
  });

  it("pomija pytania i długie zdania w liście słów, rozpoznaje także nagłówek „Ramy zdaniowe:”", () => {
    const material = "Słówka:\nlamp — lampa\nI like my new lamp very much — Lubię moją lampę\nRamy zdaniowe:\nI'm wearing a …";
    expect(parseMaterialLexicon(material)).toEqual({ words: ["lamp"], frames: ["I'm wearing a …"] });
  });

  it("obsługuje końce linii CRLF i puste linie", () => {
    expect(parseMaterialLexicon("Zwroty:\r\n\r\nThere's a … in the …\r\n")).toEqual({ words: [], frames: ["There's a … in the …"] });
  });

  it("usuwa punktory, numerację i cudzysłowy z brzegów słów i ram", () => {
    const material = [
      "Słówka:",
      "- lamp — lampa",
      "1. bed — łóżko",
      "2) chair — krzesło",
      "• \"desk\" — biurko",
      "„living room” — salon",
      "Zwroty:",
      "- I'm wearing a …",
      "* „Where's the …?”",
      "-",
    ].join("\n");
    expect(parseMaterialLexicon(material)).toEqual({
      words: ["lamp", "bed", "chair", "desk", "living room"],
      frames: ["I'm wearing a …", "Where's the …?"],
    });
  });

  it("usuwa pary pojedynczych cudzysłowów, ale zostawia apostrofy w słowach", () => {
    const material = ["Słówka:", "'bed' — łóżko", "‘lamp’ — lampa", "dogs' — psów", "Zwroty:", "'I'm wearing a …'", "I'm hungry."].join("\n");
    expect(parseMaterialLexicon(material)).toEqual({
      words: ["bed", "lamp", "dogs'"],
      frames: ["I'm wearing a …", "I'm hungry."],
    });
  });
});

describe("plainText", () => {
  it("zwija wielkość liter, apostrofy typograficzne, interpunkcję i spacje", () => {
    expect(plainText("  There’s a   bed, in the room! ")).toBe("there's a bed in the room");
  });
});

describe("frameKey", () => {
  it("to najdłuższy fragment ramy bez wielokropka", () => {
    expect(frameKey("There's a … in the …")).toBe("there's a");
    expect(frameKey("I'm wearing ...")).toBe("i'm wearing");
  });
});

describe("mentions", () => {
  it("dopasowuje całe słowo z końcówką liczby mnogiej", () => {
    expect(mentions("I have beds", "bed")).toBe(true);
    expect(mentions("I have boxes", "box")).toBe(true);
  });

  it("nie dopasowuje słowa wewnątrz innego", () => {
    expect(mentions("bedroom", "bed")).toBe(false);
  });

  it("dopasowuje frazy wielowyrazowe i znaki specjalne regexu", () => {
    expect(mentions("There is a living room.", "living room")).toBe(true);
    expect(mentions("what (a) day", "(a) day")).toBe(true);
  });

  it("traktuje apostrof typograficzny jak prosty", () => {
    expect(mentions("it’s a lamp", "it's")).toBe(true);
  });
});
