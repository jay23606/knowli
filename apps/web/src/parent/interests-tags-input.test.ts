import { describe, expect, it } from "vitest";
import { splitInterestCandidates, splitInterestNotice } from "./InterestsTagsInput";

/** Komunikat po rozbiciu tekstu, gdy w polu zostaje to, co zostawiłby Mantine (dokładne powtórzenia usunięte, lista ucięta do 5). */
function noticeFor(current: string[], text: string): ReturnType<typeof splitInterestNotice> {
  const candidates = splitInterestCandidates(current, text);
  const kept: string[] = [];
  for (const entry of candidates.map((item) => item.trim()).filter((item) => item !== "")) {
    if (!kept.some((item) => item.toLowerCase() === entry.toLowerCase())) kept.push(entry);
  }
  return splitInterestNotice(candidates, kept.slice(0, 5));
}

describe("splitInterestNotice", () => {
  it("lista w limicie bez powtórzeń nie daje komunikatu", () => {
    expect(noticeFor([], "a,b,c,d,e")).toBeNull();
    expect(noticeFor(["a", "b", "c", "d"], " e ,,")).toBeNull();
  });

  it("temat ucięty przez limit daje komunikat o limicie, także przy pełnym polu", () => {
    expect(noticeFor([], "a,b,c,d,e,f")).toBe("limit");
    expect(noticeFor(["a", "b", "c", "d", "e"], "f")).toBe("limit");
  });

  it("wpisy różniące się spacjami lub zapisem Unicode zajmują miejsce u Mantine, ale nie zwalniają limitu", () => {
    expect(noticeFor(["a", "b", "c"], "x y, x  y, x   y, z")).toBe("limit");
    expect(noticeFor(["a", "b", "c"], "żaba, żaba, z")).toBe("limit");
  });

  it("powtórzenie bez utraty tematu daje komunikat o powtórzeniu", () => {
    expect(noticeFor(["a"], "A, b")).toBe("duplicate");
    expect(noticeFor([], "x y, x  y")).toBe("duplicate");
    expect(noticeFor(["a", "b", "c", "d", "e"], "A")).toBe("duplicate");
  });
});
