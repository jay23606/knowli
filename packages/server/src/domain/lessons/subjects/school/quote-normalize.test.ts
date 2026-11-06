import { LessonExerciseInputSchema, MAX_SOURCE_QUOTE_LENGTH, MIN_SOURCE_QUOTE_LENGTH } from "@learning/contracts";
import { describe, expect, it } from "vitest";
import { prng } from "../../testing/random-json";
import type { LessonExerciseDraft } from "../../types";
import { groundedQuoteLength, normalizeQuote, quoteGrounding, snapQuote } from "./quote-normalize";
import { schoolSubject } from "./module";
import { validateSchoolPool } from "./validators";

const OBJECTIVE = "school.quotes.wisla";

function openWithQuote(quote: string, extra: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft {
  return {
    exerciseType: "lesson_open_answer",
    objectiveId: OBJECTIVE,
    prompt: "Jaka jest Wisła?",
    answer: "Wisła jest najdłuższą rzeką Polski.",
    acceptedAnswers: [],
    focus: [],
    sourceRefs: [{ quote }],
    ...extra,
  };
}

/** Zgłoszenia reguł cytatów z prawdziwego haka puli. */
function quoteRules(quote: string, material: string): string[] {
  return [...validateSchoolPool([openWithQuote(quote)], { material }).values()].flat().map((issue) => issue.rule);
}

/** Cytat przechodzi walidację puli i kontrakt pola `sourceRefs`. */
function expectValidQuote(quote: string, material: string): void {
  expect(quoteRules(quote, material), quote).toEqual([]);
  expect(LessonExerciseInputSchema.shape.sourceRefs.safeParse([{ quote }]).success, quote).toBe(true);
}

/** Cytat przechodzi, a jego wyrównanie to `expected`, które samo przechodzi walidację. */
function expectSnapped(quote: string, material: string, expected: string): void {
  expectValidQuote(quote, material);
  const snapped = snapQuote(quote, material);
  expect(snapped).toBe(expected);
  expectValidQuote(snapped!, material);
}

describe("normalizeQuote", () => {
  it("mapuje znaki znormalizowane na początki grafemów (także rozwinięcia i usunięte znaki)", () => {
    const { text, map } = normalizeQuote("A\u00AD…  „B”");
    expect(text).toBe("a... \"b\"");
    // „a” z 0, miękki dywiz pominięty, „...” z „…” (indeks 2), spacja z pierwszej spacji serii (3), „„” z 5.
    expect(map).toEqual([0, 2, 2, 2, 3, 5, 6, 7]);
  });

  it("NFC liczone na całym tekście: materiał w NFD daje ten sam tekst co w NFC", () => {
    const nfc = "Mieszko przyjął chrzest";
    expect(normalizeQuote(nfc.normalize("NFD")).text).toBe(normalizeQuote(nfc).text);
    expect(normalizeQuote(nfc.normalize("NFD")).map).toEqual(normalizeQuote(nfc).map);
  });

  it("zmiana długości przy małych literach („İ” → „i̇”) mapuje oba znaki na ten sam grafem", () => {
    const { text, map } = normalizeQuote("İz");
    expect(text).toBe("i̇z");
    expect(map).toEqual([0, 0, 1]);
  });
});

describe("dopasowanie i wyrównanie cytatu (spec §5.2)", () => {
  const BASE = "Wisła jest najdłuższą rzeką Polski. Płynie przez Kraków i Warszawę.";

  it("wielkość liter", () => {
    expectSnapped("wisła jest najdłuższą rzeką polski", BASE, "Wisła jest najdłuższą rzeką Polski");
  });

  it.each(["„", "”", "“", "«", "»"])("cudzysłów podwójny %s ↔ prosty", (mark) => {
    const material = `Nazywano go ${mark}Ojcem Ojczyzny${mark} od dawna.`;
    expectSnapped("Nazywano go \"Ojcem Ojczyzny\" od dawna", material, `Nazywano go ${mark}Ojcem Ojczyzny${mark} od dawna`);
    expectSnapped(`nazywano go ${mark}ojcem ojczyzny${mark}`, "Nazywano go \"Ojcem Ojczyzny\" od dawna.", "Nazywano go \"Ojcem Ojczyzny\"");
  });

  it.each(["‚", "‘", "’"])("cudzysłów pojedynczy %s ↔ prosty", (mark) => {
    const material = `Nazywano go ${mark}Ojcem Ojczyzny${mark} od dawna.`;
    expectSnapped("Nazywano go 'Ojcem Ojczyzny' od dawna", material, `Nazywano go ${mark}Ojcem Ojczyzny${mark} od dawna`);
  });

  it.each(["‐", "‑", "‒", "–", "—", "―", "−"])("łącznik albo myślnik %s ↔ „-”", (dash) => {
    const material = `Bitwa ${dash} rok 1410 ${dash} pod Grunwaldem.`;
    expectSnapped("Bitwa - rok 1410 - pod Grunwaldem", material, `Bitwa ${dash} rok 1410 ${dash} pod Grunwaldem`);
    expectSnapped(`bitwa ${dash} rok 1410`, "Bitwa - rok 1410 - pod Grunwaldem.", "Bitwa - rok 1410");
  });

  it("„…” w materiale i „...” w cytacie oraz odwrotnie", () => {
    expectSnapped("I wtedy... nastała noc", "I wtedy… nastała noc nad miastem.", "I wtedy… nastała noc");
    expectSnapped("I wtedy… nastała noc", "I wtedy... nastała noc nad miastem.", "I wtedy... nastała noc");
  });

  it.each([
    ["miękki dywiz", "naj\u00ADdłuższą"],
    ["spacja zerowej szerokości", "naj\u200Bdłuższą"],
    ["rozdzielacz zerowej szerokości", "naj\u200Cdłuższą"],
    ["łącznik zerowej szerokości", "naj\u200Ddłuższą"],
    ["BOM", "naj\uFEFFdłuższą"],
  ])("znak niewidoczny w materiale: %s", (_label, word) => {
    expectSnapped("Wisła jest najdłuższą rzeką", `Wisła jest ${word} rzeką Polski.`, "Wisła jest najdłuższą rzeką");
  });

  it("twarda spacja w materiale i w cytacie", () => {
    expectSnapped("Wisła jest najdłuższą rzeką", "Wisła jest najdłuższą rzeką Polski.", "Wisła jest najdłuższą rzeką");
    expectSnapped("Wisła jest najdłuższą rzeką", BASE, "Wisła jest najdłuższą rzeką");
  });

  it.each(["- ", "• ", "•", "* ", "1. ", "12. ", "3) "])("wiodący znacznik listy w cytacie „%s”", (marker) => {
    expectSnapped(`${marker}Wisła jest najdłuższą rzeką`, BASE, "Wisła jest najdłuższą rzeką");
  });

  it("liczba dłuższa niż numer porządkowy to treść cytatu, nie znacznik listy (także w walidacji rodzica)", () => {
    const material = "Bitwa pod Grunwaldem zakończyła się zwycięstwem.";
    const yearQuote = "1411. Bitwa pod Grunwaldem zakończyła się";
    expect(quoteRules(yearQuote, material)).toEqual(["school.quote_in_material"]);
    expect(snapQuote(yearQuote, material)).toBeNull();
    expect([...schoolSubject.validatePoolExtra!([openWithQuote(yearQuote)], { material }).values()].flat().map((issue) => issue.rule))
      .toEqual(["school.quote_in_material"]);
    const ordinalQuote = "1. Bitwa pod Grunwaldem zakończyła się";
    expectSnapped(ordinalQuote, material, "Bitwa pod Grunwaldem zakończyła się");
    expect(schoolSubject.validatePoolExtra!([openWithQuote(ordinalQuote)], { material }).size).toBe(0);
  });

  it("\\r\\n i podwójna spacja w materiale", () => {
    expectSnapped("Wisła jest najdłuższą rzeką", "Wisła jest\r\nnajdłuższą  rzeką Polski.", "Wisła jest najdłuższą rzeką");
  });

  it("materiał w NFD: wycinek w NFC; cytat w NFD do materiału w NFC", () => {
    const material = "Mieszko I przyjął chrzest w 966 roku.";
    expectSnapped("przyjął chrzest w 966", material.normalize("NFD"), "przyjął chrzest w 966");
    expectSnapped("przyjął chrzest w 966".normalize("NFD"), material, "przyjął chrzest w 966");
  });

  it("„İ”: wycinek z całym grafemem materiału", () => {
    expectSnapped("miasto İZMIR leży nad morzem", "Miasto İzmir leży nad morzem.", "Miasto İzmir leży nad morzem");
  });

  it("„…” na granicy wycinka: grafem materiału w całości", () => {
    expectSnapped("Długo czekali.", "Długo czekali… aż przyszła wiosna.", "Długo czekali…");
    expectSnapped("Długo czekali...", "Długo czekali… aż przyszła wiosna.", "Długo czekali…");
  });

  it.each([
    ["inne słowo", "Wisła jest najkrótszą rzeką Polski"],
    ["brakujące słowo", "Wisła jest rzeką Polski"],
    ["inna liczba", "przyjął chrzest w 967 roku"],
    ["dwa fragmenty zszyte „...”", "Wisła jest najdłuższą ... przez Kraków"],
  ])("odpada: %s", (_label, quote) => {
    const material = `${BASE} Mieszko I przyjął chrzest w 966 roku.`;
    expect(quoteRules(quote, material)).toEqual(["school.quote_in_material"]);
    expect(snapQuote(quote, material)).toBeNull();
  });

  it("wycinek ponad MAX_SOURCE_QUOTE_LENGTH: cytat przechodzi, a wyrównanie daje null (zostaje cytat modelu)", () => {
    // „…” w cytacie to „...” w materiale: wycinek jest o dwa znaki na wielokropek dłuższy od cytatu.
    const body = "a".repeat(MAX_SOURCE_QUOTE_LENGTH - 3);
    const quote = `${body}……`;
    const material = `${body}...... koniec`;
    expect(quote.length).toBeLessThanOrEqual(MAX_SOURCE_QUOTE_LENGTH);
    expectValidQuote(quote, material);
    expect(snapQuote(quote, material)).toBeNull();
  });

  it("długość minimalna jak dotąd: po zwinięciu białych znaków, przed normalizacją do dopasowania", () => {
    const material = "Długo czekali… aż przyszła wiosna.";
    const short = "Długo cze".slice(0, MIN_SOURCE_QUOTE_LENGTH - 1);
    expect(quoteRules(short, material)).toEqual(["school.quote_too_short"]);
    expect(quoteRules("Długo czek".slice(0, MIN_SOURCE_QUOTE_LENGTH), material)).toEqual([]);
    // „…” liczy się jako jeden znak (dziś), choć do dopasowania daje „...”.
    expect(quoteRules("czekali…", material)).toEqual(["school.quote_too_short"]);
    expect(quoteRules("  Długo   czekali  ", material)).toEqual([]);
  });

  it("cytat rodzica (`parentAdded`) bez zmian: pomijany przez walidację puli", () => {
    const parent = openWithQuote("Zdanie spoza materiału, dopisane przez rodzica.", {
      sourceRefs: [{ quote: "Zdanie spoza materiału, dopisane przez rodzica.", parentAdded: true }],
    });
    expect(validateSchoolPool([parent], { material: BASE }).size).toBe(0);
  });

  it("found reguły `school.quote_in_material` zawiera najdłuższy pasujący początek (tekst materiału)", () => {
    const [issue] = [...validateSchoolPool([openWithQuote("wisła jest najkrótszą rzeką")], { material: BASE }).values()].flat();
    expect(issue).toMatchObject({ rule: "school.quote_in_material", pl: "sourceRefs: cytat nie występuje w materiale źródłowym" });
    expect(issue!.found).toBe('quote 0 "wisła jest najkrótszą rzeką" does not occur in the material; the material matches it only up to "Wisła jest naj"');
    const none = quoteGrounding("Xyzzy qwerty plugh", BASE);
    expect(none).toEqual({ kind: "not_in_material", matchedPrefix: "" });
  });

  it("porównanie treści pytań rodziny bez zmian: różnica cudzysłowu to inne pytanie, różnica wielkości liter — to samo", () => {
    const material = "Fotosynteza to proces wytwarzania cukrów przez rośliny.";
    const member = (prompt: string) =>
      openWithQuote("Fotosynteza to proces", { familyId: "fam", prompt, answer: "Proces wytwarzania cukrów." });
    const rulesOf = (second: string) =>
      (validateSchoolPool([member("Co to jest „fotosynteza”?"), member(second)], { material }).get(1) ?? []).map((issue) => issue.rule);
    expect(rulesOf("Co to jest \"fotosynteza\"?")).toEqual([]);
    expect(rulesOf("co to jest „FOTOSYNTEZA”?")).toEqual(["school.family_prompt_repeated"]);
  });

  it("własność: fragment losowego materiału z losowymi zmianami typograficznymi wyrównuje się do tekstu, który przechodzi walidację i kontrakt", () => {
    const words = [
      "Wisła", "płynie", "przez", "Kraków", "„Ojciec", "Ojczyzny”", "–", "—", "rok", "966", "chrzest…", "Mieszko",
      "«dawno»", "‚tak’", "naj\u00ADdłuższa", "zero\u200Bwidth", "Żółć", "ŁÓDŹ", "İzmir", "państwo", "1410", "‐", "−",
    ];
    const separators = [" ", " ", " ", "  ", " ", "\r\n", "\n", "\t"];
    const next = prng(5112026);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
    const typographic = (text: string): string => {
      let out = text;
      if (next() < 0.5) out = out.replace(/[„”“«»]/gu, "\"").replace(/[‚‘’]/gu, "'");
      if (next() < 0.5) out = out.replace(/[‐‑‒–—―−]/gu, "-");
      if (next() < 0.5) out = out.replace(/…/gu, "...");
      if (next() < 0.5) out = out.replace(/[\u00AD\u200B-\u200D\uFEFF]/gu, "");
      if (next() < 0.3) out = out.toLocaleUpperCase("pl");
      else if (next() < 0.3) out = out.toLocaleLowerCase("pl");
      if (next() < 0.3) out = out.replace(/ /gu, "  ");
      if (next() < 0.3) out = out.normalize("NFD");
      if (next() < 0.2) out = `- ${out}`;
      return out;
    };
    let checked = 0;
    for (let run = 0; run < 400; run += 1) {
      const tokens = Array.from({ length: 8 + Math.floor(next() * 20) }, () => pick(words));
      const material = tokens.map((token, index) => (index === 0 ? token : `${pick(separators)}${token}`)).join("");
      const from = Math.floor(next() * (tokens.length - 3));
      const to = from + 3 + Math.floor(next() * (tokens.length - from - 3));
      const fragment = tokens.slice(from, to).join(" ");
      // Wycinek bez znaków niewidocznych i bez wiodącego myślnika (zdejmowanego jak znacznik listy) musi
      // sam mieć długość minimalną; krótszy daje `null` z założenia (zostaje cytat modelu).
      const visible = fragment.replace(/[\u00AD\u200B-\u200D\uFEFF]/gu, "");
      if (/^[‐‑‒–—―−]/u.test(fragment) || groundedQuoteLength(visible) < MIN_SOURCE_QUOTE_LENGTH) continue;
      const quote = typographic(fragment);
      if (quote.length > MAX_SOURCE_QUOTE_LENGTH || quoteGrounding(quote, material).kind === "too_short") continue;
      const snapped = snapQuote(quote, material);
      expect(snapped, JSON.stringify({ material, quote })).not.toBeNull();
      expectValidQuote(snapped!, material);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(200);
  });
});
