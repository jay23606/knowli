import { describe, expect, it } from "vitest";
import { lessonGapCount, lessonGapParts, splitLessonGap } from "./lesson-gap";

describe("splitLessonGap — podział zdania wokół luki (lesson_gap)", () => {
  it("dzieli na część przed i po pierwszym ciągu podkreśleń", () => {
    expect(splitLessonGap("He ___ (play).")).toEqual({ before: "He ", after: " (play).", hasGap: true });
  });

  it("obsługuje lukę na początku i na końcu", () => {
    expect(splitLessonGap("___ plays football.")).toEqual({ before: "", after: " plays football.", hasGap: true });
    expect(splitLessonGap("She plays ___")).toEqual({ before: "She plays ", after: "", hasGap: true });
  });

  it("bez luki zwraca całe zdanie przed polem (hasGap=false)", () => {
    expect(splitLessonGap("Brak luki tutaj.")).toEqual({ before: "Brak luki tutaj.", after: "", hasGap: false });
  });

  it("dzieli tylko na pierwszej luce", () => {
    expect(splitLessonGap("A ___ i B ___")).toEqual({ before: "A ", after: " i B ___", hasGap: true });
  });
});

describe("lessonGapCount — ta sama luka co na ekranie dziecka (#322)", () => {
  it("długi ciąg podkreśleń to jedna luka", () => {
    expect(lessonGapCount("She ______ happy.")).toBe(1);
  });

  it("liczy też krótką lukę „__”, którą ekran pokazuje", () => {
    expect(lessonGapCount("I ___ like __ it")).toBe(2);
  });

  it("pojedyncze podkreślenie nie jest luką", () => {
    expect(lessonGapCount("snake_case")).toBe(0);
    expect(lessonGapParts("a ___ b ____ c")).toEqual(["a ", " b ", " c"]);
  });
});
