import { describe, expect, it } from "vitest";
import { baseNormalizer } from "../../normalize";
import { prng } from "../../testing/random-json";
import type { LessonExerciseDraft } from "../../types";
import { HINT_STOP_WORDS, hintRevealing, hintRevealsAnswer, stemMatches } from "./hint-gate";

const norm = baseNormalizer;

const openAnswerFixture: LessonExerciseDraft = {
  exerciseType: "lesson_open_answer",
  objectiveId: "school.dx.geografia",
  stem: "Podaj przykład.",
  answer: "",
  acceptedAnswers: [],
  focus: [],
};

const open = (answer: string, extra: Partial<LessonExerciseDraft> = {}): LessonExerciseDraft => ({ ...openAnswerFixture, answer, ...extra });

describe("stemMatches", () => {
  it("łączy odmiany tego samego słowa", () => {
    expect(stemMatches("Odra", "Odrze")).toBe(true);
    expect(stemMatches("Polska", "Polski")).toBe(true);
    expect(stemMatches("zmniejszony", "zmniejszenie")).toBe(true);
  });

  it("nie łączy krótkich i różnych słów", () => {
    expect(stemMatches("mapa", "mama")).toBe(false);
    expect(stemMatches("kot", "koń")).toBe(false);
  });

  it("końcówka najwyżej 3 litery: wspólne „prze” nie łączy różnych słów (pilnuje MAX_ENDING_LENGTH)", () => {
    // Prefiks 4 < 8 − 3 = 5; przy końcówce 4 litery fałszywie by pasowały.
    expect(stemMatches("przemysł", "przeciwny")).toBe(false);
  });

  it("równe słowa pasują także krótkie, a liczby tylko przy równości", () => {
    expect(stemMatches("kot", "KOT")).toBe(true);
    expect(stemMatches("1410", "1410")).toBe(true);
    expect(stemMatches("1410", "1411")).toBe(false);
  });
});

describe("hintRevealsAnswer (dzisiejszy algorytm, warunek konieczny poluzowanej bramki)", () => {
  it("odrzuca podpowiedź zawierającą odpowiedź", () => {
    expect(hintRevealsAnswer("Przykładem jest Mierzeja Wiślana", open("Mierzeja Wiślana"), norm)).toBe(true);
  });

  it("odrzuca podpowiedź zawierającą element wymagany", () => {
    expect(
      hintRevealsAnswer(
        "Użyj słów: zmniejszony, uproszczony",
        open("Mapa to obraz Ziemi", { requiredElements: [{ id: "a", text: "obraz zmniejszony" }, { id: "b", text: "uproszczony" }] }),
        norm,
      ),
    ).toBe(true);
  });

  it("zostawia podpowiedź kierującą rozumowaniem", () => {
    expect(hintRevealsAnswer("Pomyśl o rzekach w Polsce", open("Wisła i Odra"), norm)).toBe(false);
  });

  it("liczba jest słowem treściowym", () => {
    expect(hintRevealsAnswer("Bitwa była w 1410 roku", open("w 1410"), norm)).toBe(true);
  });

  it("fraza bez słów ≥ 4 liter używa wszystkich tokenów", () => {
    // „ma psa i kot” — brak słów ≥ 4 liter, więc wszystkie 4 tokeny są treściowe, próg = 2 (przy „kota” treściowe byłoby tylko „kota”)
    expect(hintRevealsAnswer("Ma psa", open("ma psa i kot"), norm)).toBe(true);
    expect(hintRevealsAnswer("Pomyśl o zwierzętach", open("ma psa i kot"), norm)).toBe(false);
  });

  it("odrzuca podpowiedź zawierającą wariant odpowiedzi", () => {
    expect(hintRevealsAnswer("Wspomnij o Krakowie", open("Warszawa", { acceptedAnswers: ["Kraków"] }), norm)).toBe(true);
  });

  it("wymaga połowy słów treściowych frazy, zaokrąglając w górę", () => {
    // słowa treściowe „burza”, „morzem”, „bałtyckim” (3) → próg 2
    expect(hintRevealsAnswer("dzieje się nad morzem", open("Burza nad morzem Bałtyckim"), norm)).toBe(false);
    expect(hintRevealsAnswer("burza nad morzem", open("Burza nad morzem Bałtyckim"), norm)).toBe(true);
  });

  it("przy jednym lub dwóch słowach treściowych wymaga wszystkich", () => {
    expect(hintRevealsAnswer("Chodzi o Mierzeję", open("Mierzeja Wiślana"), norm)).toBe(false);
  });

  it("pusta podpowiedź ani pusta fraza nie ujawniają", () => {
    expect(hintRevealsAnswer("", open("Mierzeja Wiślana"), norm)).toBe(false);
    expect(hintRevealsAnswer("Pomyśl o rzekach", open("", { acceptedAnswers: [""] }), norm)).toBe(false);
  });
});

describe("hintRevealing (poluzowana bramka, spec §5.1)", () => {
  const reveal = (hint: string, draft: LessonExerciseDraft) => hintRevealing(hint, draft, norm);

  it("słowo elementu wymaganego spoza pytania: dopasowanie z celem i słowami", () => {
    const draft = open("Południki łączą przeciwległe punkty.", {
      prompt: "Co łączą południki?",
      requiredElements: [{ id: "e1", text: "biegun północny" }],
    });
    expect(reveal("Pomyśl o biegunie północnym", draft)).toEqual({
      target: "requiredElement",
      text: "biegun północny",
      words: ["biegun", "północny"],
    });
  });

  it("słowa wspólne z pytaniem nie liczą się do zdrady", () => {
    // Dzisiejszy algorytm: „wisła”, „płynie”, „przez” to 3 z 5 słów treściowych → zdrada.
    const draft = open("Wisła płynie przez Warszawę i Kraków", { prompt: "Przez które miasta płynie Wisła?" });
    expect(hintRevealsAnswer("Wisła płynie przez stolicę", draft, norm)).toBe(true);
    expect(reveal("Wisła płynie przez stolicę", draft)).toBeNull();
  });

  it("same słowa pomocnicze nie zdradzają (cel bez słów treściowych nie może zostać zdradzony)", () => {
    const draft = open("Jest, była i będzie");
    expect(hintRevealsAnswer("Jest i była", draft, norm)).toBe(true);
    expect(reveal("Jest i była", draft)).toBeNull();
  });

  it("element złożony wyłącznie ze słów pytania nie zdradza", () => {
    const draft = open("Piaszczysty pas lądu", {
      prompt: "Czym jest Mierzeja Wiślana?",
      requiredElements: [{ id: "e1", text: "Mierzeja Wiślana" }],
    });
    expect(hintRevealsAnswer("To Mierzeja Wiślana", draft, norm)).toBe(true);
    expect(reveal("To Mierzeja Wiślana", draft)).toBeNull();
  });

  it("„1410” w pytaniu i odpowiedzi nie zdradza; tylko w odpowiedzi i podpowiedzi — zdradza", () => {
    expect(reveal("Bitwa była w 1410 roku", open("w 1410", { prompt: "Co stało się pod Grunwaldem w 1410?" }))).toBeNull();
    expect(reveal("Bitwa była w 1410 roku", open("w 1410", { prompt: "Kiedy była bitwa pod Grunwaldem?" }))).toEqual({
      target: "answer",
      text: "w 1410",
      words: ["1410"],
    });
  });

  it("próg: 1–2 słowa — wszystkie, więcej — połowa w górę z tego, co zostało", () => {
    // 1 słowo
    expect(reveal("Chodzi o Wisłę", open("Wisła"))).not.toBeNull();
    // 2 słowa: jedno nie wystarcza
    expect(reveal("Chodzi o Mierzeję", open("Mierzeja Wiślana"))).toBeNull();
    expect(reveal("Mierzeja Wiślana", open("Mierzeja Wiślana"))).not.toBeNull();
    // 3 słowa → 2
    expect(reveal("burza nad morzem", open("Burza nad morzem Bałtyckim"))).not.toBeNull();
    expect(reveal("dzieje się nad morzem", open("Burza nad morzem Bałtyckim"))).toBeNull();
    // 5 słów → 3
    expect(reveal("Wisła płynie obok", open("Wisła płynie obok Krakowa Warszawy"))).not.toBeNull();
    expect(reveal("Wisła płynie", open("Wisła płynie obok Krakowa Warszawy"))).toBeNull();
    // Próg liczony z tego, co zostało po słowach pytania: 4 słowa − 2 z pytania = 2 → oba.
    const draft = open("Kopernik opisał ruch planet", { prompt: "Co opisał Kopernik?" });
    expect(reveal("Pomyśl o ruchu planet", draft)).toEqual({ target: "answer", text: draft.answer, words: ["ruch", "planet"] });
    expect(reveal("Pomyśl o planetach", draft)).toBeNull();
  });

  it("monotoniczność: 5 słów, 3 w pytaniu, podpowiedź z 2 pozostałymi — bez usunięcia (dzisiejszy algorytm nie zgłasza)", () => {
    const draft = open("Mieszko przyjął chrzest roku 966", { prompt: "Kiedy Mieszko przyjął chrzest?" });
    expect(hintRevealsAnswer("Pomyśl o roku 966", draft, norm)).toBe(false);
    expect(reveal("Pomyśl o roku 966", draft)).toBeNull();
  });

  describe("przykłady z audytu reguł agenta (§2.1): dziś odrzucane, po poluzowaniu zostają", () => {
    it.each([
      [
        "ruch obrotowy Ziemi",
        "Pomyśl, jak Ziemia się porusza — obraca się wokół własnej osi.",
        open("Z powodu ruchu obrotowego Ziemi.", {
          prompt: "Dlaczego na Ziemi następuje dzień i noc?",
          requiredElements: [{ id: "e1", text: "ruch obrotowy Ziemi" }],
        }),
      ],
      [
        "południki",
        "Pomyśl o tym, co łączy ze sobą południki.",
        open("Południki łączą biegun północny z południowym.", { prompt: "Co łączą południki?" }),
      ],
      [
        "równik",
        "Pomyśl, która linia jest najdłuższa.",
        open("Równik jest najdłuższym równoleżnikiem.", { prompt: "Który równoleżnik jest najdłuższy?" }),
      ],
    ])("%s", (_label, hint, draft) => {
      expect(hintRevealsAnswer(hint, draft, norm)).toBe(true);
      expect(reveal(hint, draft)).toBeNull();
    });
  });

  it("HINT_STOP_WORDS są w postaci po normalizatorze i bez duplikatów", () => {
    for (const word of HINT_STOP_WORDS) expect(norm.normalize(word), word).toEqual([[word]]);
    expect(new Set(HINT_STOP_WORDS).size).toBe(HINT_STOP_WORDS.length);
  });

  it("pusta podpowiedź i puste cele nie zdradzają", () => {
    expect(reveal("", open("Mierzeja Wiślana"))).toBeNull();
    expect(reveal("Pomyśl o rzekach", open("", { acceptedAnswers: [""], requiredElements: [{ id: "e1", text: "" }] }))).toBeNull();
  });

  it("własność: zgłasza tylko wtedy, gdy zgłasza dzisiejszy algorytm (ziarno → ten sam przebieg)", () => {
    const vocabulary = [
      "Wisła", "Wisły", "płynie", "Kraków", "Krakowie", "Warszawa", "rzeka", "rzeki", "jest", "była", "przez", "które",
      "się", "nad", "morzem", "morze", "Bałtyk", "1410", "966", "rok", "roku", "ma", "psa", "kot", "Ziemia", "Ziemi",
      "obraca", "obrotowy", "ruch", "południki", "biegun", "północny", "równik", "najdłuższy", "najdłuższa", "Mieszko",
    ];
    const next = prng(20261106);
    const words = (max: number) =>
      Array.from({ length: Math.floor(next() * (max + 1)) }, () => vocabulary[Math.floor(next() * vocabulary.length)]!).join(" ");
    let revealed = 0;
    let relaxed = 0;
    for (let run = 0; run < 3000; run += 1) {
      const draft = open(words(6), {
        prompt: words(5),
        acceptedAnswers: Array.from({ length: Math.floor(next() * 3) }, () => words(4)),
        requiredElements: Array.from({ length: Math.floor(next() * 3) }, (_, index) => ({ id: `e${index}`, text: words(4) })),
      });
      const hint = words(6);
      const today = hintRevealsAnswer(hint, draft, norm);
      const match = reveal(hint, draft);
      if (match !== null) {
        expect(today, JSON.stringify({ hint, draft })).toBe(true);
        expect(match.words.length).toBeGreaterThan(0);
        revealed += 1;
      } else if (today) {
        relaxed += 1;
      }
    }
    // Generator trafia w oba przypadki (inaczej własność byłaby pusta).
    expect(revealed).toBeGreaterThan(50);
    expect(relaxed).toBeGreaterThan(50);
  });
});
