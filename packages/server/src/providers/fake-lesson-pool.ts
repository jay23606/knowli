import type { LessonObjectiveAgentInput, LessonPoolInput } from "../ports/ai";
import { stageOf } from "../domain/lessons/stages";
import { objectiveCardWords, objectiveFrames } from "../domain/lessons/subjects/english-chapter/agent-policy";
import { checkElement, materialLexicon } from "../domain/lessons/subjects/english-chapter/lexicon";
import { mentions, parseMaterialLexicon } from "../domain/lessons/subjects/english-chapter/material-lexicon";
import { englishChapterSubject } from "../domain/lessons/subjects/english-chapter/module";
import { TRANSLATION_INSTRUCTION } from "../domain/lessons/subjects/english-chapter/validators";
import { schoolSubject } from "../domain/lessons/subjects/school/module";
import type { LessonExerciseType } from "../domain/lessons/types";
import { materializeGeneratedCalculations } from "./lesson-calculations";

/**
 * Deterministyczny generator ćwiczeń lekcji dla fake'ów (testy, E2E, `UMIEM_FAKE_PROVIDERS=1`):
 * czyste funkcje bez sieci i stanu. `fakeObjectiveExercises` buduje zgłoszenie jednego zagadnienia
 * dla fake'a agenta puli (etap 3 PR 2 #237, spec §5.2) tak, żeby przeszło prawdziwe przyjmowanie.
 * Nie jest adapterem żadnej usługi.
 */

/**
 * Materiał lekcji z tym znacznikiem wydłuża pierwszy krok każdego zagadnienia fake agenta do co najmniej
 * FAKE_SLOW_DELAY_MS, przerywalnie, niezależnie od skonfigurowanego opóźnienia kroku
 * (`UMIEM_FAKE_LESSON_DELAY_MS`): E2E generuje lekcje bez sztucznego opóźnienia, a test restartu
 * trwającej generacji nadal ją widzi.
 */
export const FAKE_SLOW_MARKER = "[fake-slow]";
export const FAKE_SLOW_DELAY_MS = 3_000;

/** Stałe zdanie bez odpowiedzi ćwiczenia: spełnia reguły treści wyjaśnienia (jedno zdanie, zwykły tekst, ≤ 120). */
export const FAKE_EXPLANATION = "Ta reguła mówi, jak zbudować poprawne zdanie.";

type FakeStage = "guided" | "productive" | "independent";
type StageCounts = Record<FakeStage, number>;
const STAGES: readonly FakeStage[] = ["guided", "productive", "independent"];

/** Deterministyczne słowo z materiału (pierwszy token) dla danego indeksu. */
function materialWord(material: string, index: number): string {
  const words = material
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const base = words.length > 0 ? words[index % words.length]! : "word";
  // Unikalność odpowiedzi w puli: dołączamy sufiks indeksu (po normalizacji
  // nadal jeden token, bo cyfry są częścią tokenu).
  return index === 0 ? base.toLowerCase() : `${base.toLowerCase()}${index}`;
}

/** Typy ćwiczeń fake'a według etapu: budowany jest pierwszy typ dozwolony przez cel. */
const FAKE_STAGE_TYPES: Record<FakeStage, readonly string[]> = {
  guided: ["lesson_choice", "lesson_short_answer", "lesson_order"],
  productive: ["lesson_gap", "lesson_error_fix", "lesson_transform"],
  independent: ["lesson_open_answer"],
};

/**
 * Słowa treści materiału rozdziału w kolejności występowania, bez powtórzeń:
 * wyłącznie takie, które przechodzą walidację słownikową przedmiotu (są
 * w słowniku materiału i nie są słowami funkcyjnymi), więc ćwiczenia fake'a
 * nie są odrzucane przez `refineGeneratedPool`.
 */
function chapterContentWords(material: string): string[] {
  const lexicon = materialLexicon(material);
  const words: string[] = [];
  for (const token of material.normalize("NFC").toLowerCase().match(/\p{L}{3,}/gu) ?? []) {
    if (!words.includes(token) && checkElement(token, lexicon).ok) words.push(token);
  }
  return words;
}

/** Zdanie do porównania z `avoidSentences`: małe litery, bez spacji na brzegach i bez końcowej kropki. */
function avoidKey(sentence: string): string {
  return sentence.toLowerCase().trim().replace(/\.$/u, "");
}

/** Przy fladze `exerciseExplanations` każde ćwiczenie dostaje przewidywalne wyjaśnienie (infrastruktura testowa). */
function withFakeExplanations(exercises: Record<string, unknown>[], input: LessonPoolInput): Record<string, unknown>[] {
  if (input.exerciseExplanations !== true) return exercises;
  return exercises.map((exercise) => ({ ...exercise, explanationPl: FAKE_EXPLANATION }));
}

/** Typ wyboru ze słuchu: dodatek poza podziałem etapów. */
const LISTEN_CHOICE_TYPE = "lesson_listen_choice";

/** Słowa dystraktorów fake'a: brzmią inaczej niż jakikolwiek token materiału testów. */
const FAKE_LISTEN_DISTRACTORS: readonly string[] = ["orange", "window"];

/**
 * Ćwiczenie wyboru ze słuchu: zdanie z jedną luką, dwie słyszalnie różne opcje, odpowiedź = tekst poprawnej
 * opcji. Bez polecenia, podpowiedzi i piktogramu (jak po `stripListenChoiceExtras`); zdanie z lukiem
 * wypełnioną poprawną opcją nie może równać się odpowiedzi ćwiczenia tekstowego puli.
 */
function fakeListenChoice(objectiveId: string, stem: string, answer: string, other: string): Record<string, unknown> {
  return {
    exerciseType: LISTEN_CHOICE_TYPE,
    objectiveId,
    stem,
    answer,
    acceptedAnswers: [],
    focus: [answer],
    options: [
      { id: "a", text: answer },
      { id: "b", text: other },
    ],
    correctOption: "a",
  };
}

/** Pola v3 dla fake puli przedmiotu szkolnego (uziemienie = początek materiału). */
function schoolFieldsForFake(type: string, answer: string, material: string): Record<string, unknown> {
  const quote = material.trim().slice(0, 120);
  const base: Record<string, unknown> = { sourceRefs: [{ quote }] };
  if (type === "lesson_open_answer") {
    return {
      ...base,
      questionType: "fact",
      requiredElements: [{ id: "e1", text: `Podaje: ${answer}`.slice(0, 120) }],
      supplementaryElements: [],
      commonErrors: [],
      expectedForm: "short",
    };
  }
  return base;
}

/** Jedno poprawne ćwiczenie danego typu (lub najbliższe poprawnemu). */
function fakeExercise(
  type: string,
  objectiveId: string,
  answer: string,
  input: LessonPoolInput,
  sequence: number,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    exerciseType: type,
    objectiveId,
    instructionPl: "Uzupełnij.",
    answer,
    acceptedAnswers: [],
    focus: [answer],
    ...(input.subjectId === schoolSubject.id ? schoolFieldsForFake(type, answer, input.material) : {}),
  };
  switch (type) {
    case "lesson_choice":
    case "lesson_short_answer":
      return {
        ...base,
        focus: [],
        stem: `Wybierz poprawną odpowiedź (${sequence + 1}).`,
        options: [
          { id: "a", text: answer },
          { id: "b", text: `${answer}x` },
        ],
        correctOption: "a",
      };
    case "lesson_order":
      return {
        ...base,
        focus: [],
        answer: `${answer} one two`,
        items: [
          { id: "i1", text: answer },
          { id: "i2", text: "one" },
          { id: "i3", text: "two" },
        ],
      };
    case "lesson_gap":
      // bez `hint`: unikamy reguły przedmiotu wiążącej odpowiedź z czasownikiem.
      return { ...base, stem: `___ here (${answer}).` };
    case "lesson_error_fix":
      return { ...base, statement: `${answer}x wrong.` };
    case "lesson_transform":
      return {
        ...base,
        transformId: input.transforms[0]?.id ?? "unknown_transform",
        statement: `Przekształć zdanie (${sequence + 1}).`,
      };
    case "lesson_notice":
      return {
        exerciseType: type,
        objectiveId,
        instructionPl: "Wskaż słowo.",
        answer,
        acceptedAnswers: [],
        focus: [],
        noticeSegments: [[answer, "one"], ["two", "three"]],
        correctOption: answer,
      };
    case "lesson_open_answer":
    default:
      return { ...base, prompt: `Przetłumacz zdanie (${sequence + 1}).` };
  }
}

// ---------------------------------------------------------------------------------------------
// Zgłoszenie jednego zagadnienia dla fake'a agenta puli.

/** Zamówienie kroku: liczby etapów, wymagane typy (po jednym ćwiczeniu z grupy) i dodatek słuchowy. */
interface StepRequest {
  readonly stages: StageCounts;
  /** Wybrany typ każdej grupy wymaganej (pierwszy dozwolony i obsługiwany), bez powtórzeń. */
  readonly required: readonly string[];
  readonly listen: number;
}

/** Typy, które generator potrafi zbudować poprawnie dla gramatyki i szkoły. */
const STAGED_TYPES: ReadonlySet<string> = new Set([...STAGES.flatMap((stage) => FAKE_STAGE_TYPES[stage]), "lesson_notice", LISTEN_CHOICE_TYPE]);
/** Typy, które generator potrafi zbudować poprawnie dla rozdziału (bramki słów i ram zagadnienia). */
const CHAPTER_TYPES: ReadonlySet<string> = new Set([
  "lesson_match",
  "lesson_cloze",
  "lesson_order",
  "lesson_choice",
  "lesson_gap",
  "lesson_open_answer",
  LISTEN_CHOICE_TYPE,
]);

function stageOfType(type: string): FakeStage | undefined {
  const stage = stageOf(type as LessonExerciseType);
  return stage === "intro" || type === LISTEN_CHOICE_TYPE ? undefined : stage;
}

function stepRequest(
  input: LessonObjectiveAgentInput,
  counts: Partial<StageCounts> | undefined,
  requiredTypes: readonly (readonly string[])[] | undefined,
  allowed: ReadonlySet<string>,
  supported: ReadonlySet<string>,
): StepRequest {
  const stages: StageCounts =
    counts === undefined
      ? { ...input.pool.stageCounts }
      : { guided: counts.guided ?? 0, productive: counts.productive ?? 0, independent: counts.independent ?? 0 };
  const groups = requiredTypes ?? (counts === undefined ? input.targets.requiredTypes : []);
  const required = [
    ...new Set(groups.flatMap((group) => group.find((type) => allowed.has(type) && supported.has(type)) ?? [])),
  ];
  const listen = counts === undefined ? input.targets.listenAllowance : 0;
  return { stages, required, listen: required.includes(LISTEN_CHOICE_TYPE) ? Math.max(1, listen) : listen };
}

/**
 * Typy kolejnych ćwiczeń etapu: najpierw wymagane typy tego etapu (liczą się do jego liczby, ale
 * zawsze po jednym), potem pierwszy dozwolony typ etapu do zamówionej liczby.
 */
function stageTypes(stage: FakeStage, request: StepRequest, allowed: ReadonlySet<string>): string[] {
  const required = request.required.filter((type) => stageOfType(type) === stage);
  const filler = FAKE_STAGE_TYPES[stage].find((type) => allowed.has(type));
  const rest = filler === undefined ? 0 : Math.max(0, request.stages[stage] - required.length);
  return [...required, ...Array.from({ length: rest }, () => filler!)];
}

/** Gramatyka i szkoła: odpowiedzi ze słów materiału z sufiksem numeru, numeracja od `offset`. */
function stagedObjectiveExercises(input: LessonObjectiveAgentInput, offset: number, request: StepRequest, allowed: ReadonlySet<string>) {
  const pool = input.pool;
  const objectiveId = input.objective.id;
  const exercises: Record<string, unknown>[] = [];
  let seq = offset;
  const nextAnswer = () => materialWord(pool.material, seq++);
  for (const stage of STAGES) {
    for (const type of stageTypes(stage, request, allowed)) exercises.push(fakeExercise(type, objectiveId, nextAnswer(), pool, offset + exercises.length));
  }
  if (allowed.has(LISTEN_CHOICE_TYPE)) {
    for (let i = 0; i < request.listen; i++) {
      const answer = nextAnswer();
      const number = offset + exercises.length + 1;
      exercises.push(fakeListenChoice(objectiveId, `Listen and choose: ___ (${number}).`, answer, FAKE_LISTEN_DISTRACTORS.find((word) => word !== answer)!));
    }
  }
  // Gwarancja ≥ 1 ćwiczenia: cel bez typów etapów dostaje pierwszy dozwolony typ.
  if (exercises.length === 0) {
    const type = pool.objectives.find((objective) => objective.id === objectiveId)?.exerciseTypes[0] ?? "lesson_open_answer";
    exercises.push(fakeExercise(type, objectiveId, nextAnswer(), pool, offset));
  }
  // Przykładowy ton lektora (etap B): tylko gdy generator ma go zwracać.
  if (pool.voiceTones === true) exercises[0] = { ...exercises[0]!, voiceTone: "curious" };
  return { exercises, examples: [`Example for ${objectiveId}.`] };
}

/** Wyrazy, po których rama nie dostaje „the” przed wstawionym słowem („Put on your coat”). */
const DETERMINERS: ReadonlySet<string> = new Set(["a", "an", "the", "my", "your", "his", "her", "its", "our", "their", "this", "that", "some"]);
const ELLIPSIS = /…|\.\.\./gu;

/**
 * Zdanie z ramy: pierwszy wielokropek dostaje `phrase`, kolejne — `filler`; przed słowem bez
 * określnika w ramie stoi „the”. Stała część ramy zostaje bez zmian, więc bramka ramy ją znajdzie.
 */
function fillFrame(frame: string, phrase: string, filler: string): string {
  let first = true;
  return frame.replace(ELLIPSIS, (_match: string, at: number) => {
    const before = frame.slice(0, at).trim().split(/\s+/u).at(-1)?.toLowerCase() ?? "";
    const words = first ? phrase : filler;
    first = false;
    return DETERMINERS.has(before) ? words : `the ${words}`;
  });
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Końcowa interpunkcja zdania; pętla zamiast `/[.!?…]+$/` (wyrażenie z nawrotami, S8786). */
const FINAL_PUNCTUATION: ReadonlySet<string> = new Set([".", "!", "?", "…"]);

function withoutFinalPunctuation(text: string): string {
  let result = text.trim();
  while (result.length > 0 && FINAL_PUNCTUATION.has(result.at(-1)!)) result = result.slice(0, -1);
  return result.trim();
}

/** Słowa bez powtórzeń i bez par zawartych jedno w drugim (pary, opcje i bank luk muszą się różnić). */
function distinct(words: readonly string[]): string[] {
  const result: string[] = [];
  for (const word of words) if (result.every((kept) => !confusable(kept, word))) result.push(word);
  return result;
}

function confusable(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.includes(y) || y.includes(x);
}

/** Lista od pozycji `start` po kolei z zawinięciem. */
function rotated<T>(items: readonly T[], start: number): T[] {
  return items.map((_item, index) => items[(start + index) % items.length]!);
}

/** Słownik zagadnienia rozdziału: słowa materiału, słowa kart (zagadnienie słów) i ramy kart (zagadnienie ramy). */
interface ChapterVocabulary {
  readonly words: readonly string[];
  /** Słowa sprawdzane: słowa kart zagadnienia słów, a bez nich słowa materiału. */
  readonly focus: readonly string[];
  readonly cardWords: readonly string[];
  readonly frames: readonly string[];
  /** Słowo w dalszych wielokropkach ramy (poza bankiem luk). */
  readonly filler: string;
}

function chapterVocabulary(input: LessonObjectiveAgentInput): ChapterVocabulary {
  const material = input.pool.material;
  const lexicon = materialLexicon(material);
  const listed = parseMaterialLexicon(material).words.filter((word) => checkElement(word, lexicon).ok);
  const words = distinct(listed.length > 0 ? listed : chapterContentWords(material));
  const cards = { cards: input.objective.cards };
  const cardWords = input.objective.kind === "words" ? objectiveCardWords(cards, material).filter((word) => words.includes(word)) : [];
  const frames = input.objective.kind === "frame" ? objectiveFrames(cards, material) : [];
  return { words, focus: cardWords.length > 0 ? cardWords : words, cardWords, frames, filler: words.at(-1) ?? "" };
}

/**
 * Rozdział (Rozstrzygnięcie 3): słowa z kart zagadnienia słów, w zagadnieniu ramy zdania z ramą kart,
 * po jednym ćwiczeniu każdego wymaganego typu, słowa kart w parach. Tłumaczenia przeplatane po
 * zagadnieniach (`i = k · liczba zagadnień + index`), więc zagadnienia jednej lekcji ich nie dzielą.
 */
function chapterObjectiveExercises(input: LessonObjectiveAgentInput, offset: number, request: StepRequest, allowed: ReadonlySet<string>) {
  const vocabulary = chapterVocabulary(input);
  const { words, focus, frames, filler } = vocabulary;
  const objectiveId = input.objective.id;
  const exercises: Record<string, unknown>[] = [];
  if (words.length === 0) return { exercises, examples: [] };

  const frameAt = (k: number): string | undefined => (frames.length === 0 ? undefined : frames[k % frames.length]);
  const gapStem = (k: number, plain: string): string => {
    const frame = frameAt(k);
    return frame === undefined ? plain : asSentence(fillFrame(frame, "___", filler));
  };
  const sentenceWith = (k: number, phrase: string, plain: string): string => {
    const frame = frameAt(k);
    return withoutFinalPunctuation(frame === undefined ? plain : fillFrame(frame, phrase, filler));
  };
  const others = (answer: string): string[] => words.filter((word) => !confusable(word, answer));

  const avoid = new Set([...(input.pool.avoidSentences ?? []), ...input.cardSentences].map(avoidKey));
  const used = new Set<string>();
  const objectiveCount = input.otherObjectives.length + 1;
  const position = input.objective.index;
  // Numer tłumaczenia w zagadnieniu (rośnie z przesunięciem kroku), przeplatany po zagadnieniach lekcji.
  let k = Math.max(0, offset - position * 1000);

  const translation = (): { sentence: string; focus: string } => {
    const candidate = (number: number): { sentence: string; focus: string } => {
      let first: string;
      let second: string | undefined;
      if (vocabulary.cardWords.length > 0) {
        // Słowo kart tego zagadnienia (bramka), drugie z reszty materiału przesunięte o pozycję zagadnienia.
        first = vocabulary.cardWords[number % vocabulary.cardWords.length]!;
        const rest = others(first);
        second = rest.length === 0 ? undefined : rest[(Math.floor(number / vocabulary.cardWords.length) + position) % rest.length];
      } else {
        const n = words.length;
        const i = number * objectiveCount + position;
        if (n < 2) {
          first = words[0]!;
        } else {
          // Para (pierwsze, przesunięcie drugiego) jest różnowartościowa dla p < n·(n−1).
          const p = i % (n * (n - 1));
          first = words[p % n]!;
          second = words[(p % n + 1 + Math.floor(p / n)) % n];
        }
      }
      const phrase = second === undefined ? first : `${first} and the ${second}`;
      return { sentence: sentenceWith(number, phrase, `We have the ${phrase}`), focus: first };
    };
    let result = candidate(k);
    // Pętla kończy się: kandydatów jest skończenie wiele, a zbiory do unikania są skończone.
    for (let guard = 0; guard < words.length * words.length + avoid.size + used.size + 1; guard++) {
      const key = avoidKey(result.sentence);
      if (!avoid.has(key) && !used.has(key)) break;
      k += 1;
      result = candidate(k);
    }
    k += 1;
    used.add(avoidKey(result.sentence));
    return result;
  };

  const build = (type: string, sequence: number): Record<string, unknown> | undefined => {
    const number = sequence + 1;
    const answer = focus[sequence % focus.length]!;
    const base = { exerciseType: type, objectiveId, acceptedAnswers: [] as string[] };
    switch (type) {
      case "lesson_choice": {
        const options = [answer, ...others(answer)].slice(0, 3);
        if (options.length < 2) return undefined;
        return {
          ...base,
          instructionPl: `Zdanie numer ${number} ma lukę. Wybierz słowo.`,
          stem: gapStem(sequence, "I can see the ___."),
          answer,
          focus: [],
          options: options.map((text, index) => ({ id: String.fromCharCode(97 + index), text })),
          correctOption: "a",
        };
      }
      case "lesson_gap":
        return {
          ...base,
          instructionPl: `Zdanie numer ${number} ma lukę. Wpisz brakujące słowo.`,
          stem: gapStem(sequence, "I have the ___."),
          answer,
          focus: [answer],
        };
      case "lesson_order": {
        const sentence = sentenceWith(sequence, answer, `I have the ${answer}`);
        const tokens = sentence.split(/\s+/u);
        const unique = (parts: readonly string[]) => new Set(parts.map((part) => part.toLowerCase())).size === parts.length;
        // Powtórzone słowo w klockach daje fałszywy błąd oceny: wtedy trzy klocki (początek, środek, koniec).
        const items = unique(tokens) ? tokens : [tokens[0]!, tokens.slice(1, -1).join(" "), tokens.at(-1)!];
        if (items.length < 3 || !unique(items)) return undefined;
        return {
          ...base,
          instructionPl: `Zdanie numer ${number}: ułóż zdanie z klocków.`,
          answer: items.join(" "),
          focus: [],
          items: items.map((text, index) => ({ id: `i${index + 1}`, text })),
        };
      }
      case "lesson_cloze": {
        const frame = frameAt(sequence);
        // Słowa banku nie mogą stać w widocznym tekście (rama, słowo dalszych wielokropków); w zagadnieniu
        // słów `frame` nie ma, więc pierwsza luka to zawsze sprawdzane słowo kart.
        const withFiller = frame !== undefined && (frame.match(ELLIPSIS) ?? []).length > 1;
        const bankable = (word: string) => frame === undefined || (!mentions(frame, word) && !(withFiller && confusable(word, filler)));
        const bank = distinct([answer, ...rotated(words, words.indexOf(answer) + 1)].filter(bankable)).slice(0, 3);
        if (bank.length < 3) return undefined;
        const sentence = frame === undefined ? "I have the ___." : asSentence(fillFrame(frame, "___", filler));
        return {
          ...base,
          instructionPl: `Zdanie numer ${number} ma luki. Uzupełnij tekst.`,
          clozeText: `${sentence} ${sentence}`,
          gapAnswers: [bank[0]!, bank[1]!],
          extraWords: [bank[2]!],
          answer: `${bank[0]}, ${bank[1]}`,
          focus: [],
        };
      }
      case "lesson_match": {
        // Słowa kart najpierw (bramka par: co najmniej dwa słowa kart), potem reszta materiału.
        const lefts = distinct([...rotated(focus, sequence), ...words]).slice(0, 5);
        if (lefts.length < 3) return undefined;
        return {
          ...base,
          instructionPl: "Połącz słowa w pary.",
          pairs: lefts.map((left, index) => ({ left, right: `tłumaczenie ${index + 1}` })),
          answer: lefts.join(", "),
          focus: [],
        };
      }
      case LISTEN_CHOICE_TYPE: {
        const other = others(answer)[0];
        if (other === undefined) return undefined;
        return fakeListenChoice(objectiveId, gapStem(sequence, sequence % 2 === 0 ? "I can see the ___." : "I have the ___."), answer, other);
      }
      case "lesson_open_answer": {
        const result = translation();
        return {
          ...base,
          instructionPl: TRANSLATION_INSTRUCTION,
          prompt: `Przetłumacz zdanie numer ${number}.`,
          answer: result.sentence,
          focus: [result.focus],
        };
      }
      default:
        return undefined;
    }
  };

  const push = (type: string) => {
    const exercise = build(type, offset + exercises.length);
    if (exercise !== undefined) exercises.push(exercise);
  };
  for (const stage of STAGES) for (const type of stageTypes(stage, request, allowed)) push(type);
  if (allowed.has(LISTEN_CHOICE_TYPE)) for (let i = 0; i < request.listen; i++) push(LISTEN_CHOICE_TYPE);

  const examples =
    frames.length > 0
      ? frames.slice(0, 3).map((frame, index) => asSentence(fillFrame(frame, focus[index % focus.length]!, filler)))
      : focus.slice(0, 3).map((word) => `I have the ${word}.`);
  return { exercises, examples };
}

/**
 * Zgłoszenie jednego kroku podagenta zagadnienia `input.objective` (surowe rekordy po
 * `materializeGeneratedCalculations`, jak z adaptera modelu). Numeracja i dobór odpowiedzi od `offset`
 * (pętla fake'a agenta: `index · 1000`, przy „+N” `index · 1000 + 500 + existingCount · 2`, kolejne
 * kroki +100), więc zagadnienia lekcji i kroki nie powtarzają odpowiedzi.
 *
 * Bez `counts`: liczby etapów z `pool.stageCounts`, każdy typ z `targets.requiredTypes` i dodatek
 * słuchowy `targets.listenAllowance`. Z `counts`: tylko zamówione etapy i wymagane typy z
 * `requiredTypes` (po jednym ćwiczeniu z grupy). Przykłady kart pominięte przy `examplesFromPlan`.
 */
export function fakeObjectiveExercises(
  input: LessonObjectiveAgentInput,
  offset: number,
  counts?: Partial<Record<FakeStage, number>>,
  requiredTypes?: readonly (readonly string[])[],
): { exercises: unknown[]; examples?: string[] } {
  const pool = input.pool;
  const allowed = new Set(pool.objectives.find((objective) => objective.id === input.objective.id)?.exerciseTypes ?? []);
  const chapter = pool.subjectId === englishChapterSubject.id;
  const request = stepRequest(input, counts, requiredTypes, allowed, chapter ? CHAPTER_TYPES : STAGED_TYPES);
  const generated = chapter
    ? chapterObjectiveExercises(input, offset, request, allowed)
    : stagedObjectiveExercises(input, offset, request, allowed);
  const exercises = materializeGeneratedCalculations(withFakeExplanations(generated.exercises, pool));
  return input.objective.examplesFromPlan ? { exercises } : { exercises, examples: generated.examples };
}
