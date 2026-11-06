import { describe, expect, it } from "vitest";
import { lessonPromptStyle, sentenceCount } from "./tts-style";

describe("sentenceCount", () => {
  it("liczy zdania po normalizacji odstępów, także z końcem tekstu bez kropki", () => {
    expect(sentenceCount("  Ala ma kota.  Kot ma Alę ")).toBe(2);
    expect(sentenceCount("Ala\n\nma   kota.\tKot ma Alę")).toBe(2);
  });

  it("zwraca 0 dla pustego tekstu i samych odstępów lub interpunkcji", () => {
    expect(sentenceCount("")).toBe(0);
    expect(sentenceCount("   \n ")).toBe(0);
    expect(sentenceCount("...")).toBe(0);
  });

  it("uznaje ., !, ? i … za koniec zdania", () => {
    expect(sentenceCount("Ile? Dwa!")).toBe(2);
    expect(sentenceCount("Cisza… Słychać sowę.")).toBe(2);
  });

  it("traktuje ciąg znaków kończących jak jedną granicę", () => {
    expect(sentenceCount("Czy wiesz, że…? Sowy widzą w nocy.")).toBe(2);
    expect(sentenceCount("Co?! Naprawdę...")).toBe(2);
  });

  it("nie liczy wielokropka luki ramy w cudzysłowie jako końca zdania", () => {
    expect(sentenceCount("Zdanie „There's a … in the …” mówi, gdzie jest przedmiot.")).toBe(1);
    expect(sentenceCount('Zdanie "There is a ... in the ..." mówi, gdzie jest przedmiot.')).toBe(1);
    expect(sentenceCount("Zdanie «There's a … in the …» mówi, gdzie jest przedmiot.")).toBe(1);
    expect(sentenceCount("Zdanie „There's a … in the …” mówi, gdzie jest przedmiot. Pasuje tu sowa.")).toBe(2);
    expect(sentenceCount("Zdanie „There's a .... in the ....” mówi, gdzie jest przedmiot.")).toBe(1);
    expect(sentenceCount("Tekst „niedomknięty… Druga część.")).toBe(2);
    expect(sentenceCount("„Cisza… Słychać sowę. Potem sowa.”")).toBe(3);
  });

  it("nie dzieli na kropce w środku wyrazu lub liczby", () => {
    expect(sentenceCount("To kosztuje 3.5 zł.")).toBe(1);
  });

  it("nie dzieli po polskich skrótach z odstępem", () => {
    expect(sentenceCount("Ptaki, np. sowy, polują nocą.")).toBe(1);
    expect(sentenceCount("Sowy, sikory itp. polują nocą.")).toBe(1);
    expect(sentenceCount("Lisy, wilki itd. żyją w lesie.")).toBe(1);
    expect(sentenceCount("Sowy, tzn. ptaki nocne, polują.")).toBe(1);
    expect(sentenceCount("Ptaki, tj. sowy, polują.")).toBe(1);
    expect(sentenceCount("Są tu m.in. sowy i lisy.")).toBe(1);
    expect(sentenceCount("W 1990 r. powstał park.")).toBe(1);
    expect(sentenceCount("Mamy ok. 5 sów.")).toBe(1);
    expect(sentenceCount("Lekcja o godz. 8 się zaczyna.")).toBe(1);
    expect(sentenceCount("Mówi Dr. Nowak.")).toBe(1);
    expect(sentenceCount("Mówi dr Nowak. Sowy polują.")).toBe(2);
    expect(sentenceCount("To tzw. sowa uszata.")).toBe(1);
    expect(sentenceCount("W XV w. zbudowano zamek.")).toBe(1);
    expect(sentenceCount("W 50 r. p.n.e. Rzym rósł.")).toBe(1);
    expect(sentenceCount("W 966 r. n.e. Polska przyjęła chrzest.")).toBe(1);
    expect(sentenceCount("Czy wiesz, że św. Wojciech zginął w Prusach?")).toBe(1);
    expect(sentenceCount("Szkoła stoi przy ul. Lipowej.")).toBe(1);
    expect(sentenceCount("Ks. Jan uczył dzieci.")).toBe(1);
  });

  it("nadal liczy dwa zdania, gdy skrót nie jest przed odstępem lub tekst ma inne granice", () => {
    expect(sentenceCount("Ptaki, np. sowy, polują. Śpią w dzień.")).toBe(2);
    expect(sentenceCount("Lubię sowy itd. Ile ich jest?")).toBe(1);
    expect(sentenceCount("Sowy.Ptaki. Lisy.")).toBe(2);
    expect(sentenceCount("To mój kot. Potem sowa.")).toBe(2);
  });
});

describe("lessonPromptStyle", () => {
  it("bez tonu zwraca rolę", () => {
    expect(lessonPromptStyle("lesson_card", undefined, "A.")).toBe("lesson_card");
    expect(lessonPromptStyle("lesson_question", undefined, "A.")).toBe("lesson_question");
  });

  it("z tonem zwraca ton", () => {
    expect(lessonPromptStyle("lesson_question", "cheerful", "A.")).toBe("cheerful");
    expect(lessonPromptStyle("lesson_card", "gentle", "A.")).toBe("gentle");
    expect(lessonPromptStyle("lesson_card", "curious", "A.")).toBe("curious");
  });

  it("zamienia szept na ciekawość, gdy tekst ma mniej niż dwa zdania", () => {
    expect(lessonPromptStyle("lesson_card", "mysterious", "Czy wiesz, że sowy widzą w nocy?")).toBe("curious");
    expect(lessonPromptStyle("lesson_question", "mysterious", "")).toBe("curious");
  });

  it("zostawia szept dla karty z co najmniej dwoma zdaniami", () => {
    expect(lessonPromptStyle("lesson_card", "mysterious", "Czy wiesz, że…? Sowy widzą w nocy.")).toBe("mysterious");
  });

  it("w pytaniu nigdy nie szepcze — czytany tekst zaczyna się od polecenia", () => {
    expect(lessonPromptStyle("lesson_question", "mysterious", "Odpowiedz jednym zdaniem. Dlaczego sowy polują nocą?")).toBe("curious");
  });
});
