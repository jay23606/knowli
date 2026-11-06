import { APOSTROPHE_VARIANTS, normalizeTokens } from "../../normalize";

/**
 * Wskaźniki czasu tematu Present Continuous (design §5.1): zamknięte listy
 * i klasyfikacja tekstu na grupy „teraz” / „zwykle” oraz wskaźniki zakazane
 * (przyszłość i dwuznaczność). Czysta funkcja: bez bazy, sieci i zegara.
 * Listy są jedynym źródłem — z nich budowane są wzorce dopasowania i teksty
 * promptu, więc nie rozjadą się ze sobą.
 *
 * Składnia wpisu listy:
 * - `Look!` — wykrzyknienie: na początku surowego tekstu albo zdania (po `.`, `!`, `?`),
 *   po nim `!` (w angielskim także `,`: „Listen, the baby is crying”; normalizacja tokenów
 *   usuwa `!`, więc sprawdzane jest surowe wejście);
 * - `Look at …!` — wykrzyknienie z dopełnieniem: słowa wpisu na początku zdania, dalej
 *   dowolne słowa do `!` kończącego to zdanie („Look at Tom!”, „Spójrz na Tomka!”);
 * - `Gdzie jest …` — fraza tylko na początku tekstu (pierwsze tokeny);
 * - `N times a week` — `N` to liczebnik (two…ten) albo liczba cyfrowa;
 * - pozostałe wpisy to frazy dopasowywane po tokenach `normalizeTokens`.
 */

export type MarkerGroup = "now" | "usually";

export interface MarkerScan {
  readonly groups: ReadonlySet<MarkerGroup>;
  /** Dopasowane wpisy listy „teraz” (`nowEn` / `nowPl`, w kolejności listy). */
  readonly nowMarkers: readonly string[];
  /**
   * Mocny wskaźnik „teraz”: wpis spoza `BARE_NOW_MARKERS` (right now, at the moment, Look!, Cicho!,
   * w tej chwili, Gdzie jest …). Goły „now” bywa „obecnie” (Tom doesn't watch TV now.).
   */
  readonly strongNow: boolean;
  /** Znormalizowane (małe litery) zakazane frazy w kolejności występowania, bez powtórzeń. */
  readonly forbidden: readonly string[];
}

const EN_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** Rzeczowniki czasu po „next” (przyszłość); „next to” (obok) nie jest wskaźnikiem. */
const EN_NEXT_NOUNS = [
  "week",
  "month",
  "year",
  "weekend",
  "summer",
  "winter",
  "spring",
  "autumn",
  "holidays",
  "time",
  "morning",
  "evening",
  "night",
];
const EN_EVERY_NOUNS = [
  "day",
  "week",
  "month",
  "year",
  "morning",
  "afternoon",
  "evening",
  "night",
  "weekend",
  "summer",
  "winter",
  "spring",
  "autumn",
];
/** „co” + biernik dnia tygodnia („co niedzielę”). */
const PL_WEEKDAYS_EVERY = [
  "co poniedziałek",
  "co wtorek",
  "co środę",
  "co czwartek",
  "co piątek",
  "co sobotę",
  "co niedzielę",
];
const PL_WEEKDAYS_LOCATIVE = [
  "w poniedziałki",
  "we wtorki",
  "w środy",
  "w czwartki",
  "w piątki",
  "w soboty",
  "w niedziele",
];

export const TIME_MARKER_LISTS = {
  nowEn: ["now", "right now", "at the moment", "Look!", "Listen!", "Shh!", "Shhh!", "Be quiet!", "Look at …!"],
  usuallyEn: [
    ...[...EN_EVERY_NOUNS, ...EN_WEEKDAYS].map((noun) => `every ${noun}`),
    "usually",
    "always",
    "often",
    "sometimes",
    "never",
    ...EN_WEEKDAYS.map((day) => `on ${day}s`),
    "at weekends",
    "once a week",
    "twice a week",
    "once a day",
    "twice a day",
    "N times a week",
    "N times a day",
  ],
  nowPl: [
    "teraz",
    "właśnie",
    "w tej chwili",
    "w tym momencie",
    "akurat",
    "Cicho!",
    "Ciii!",
    "Patrz!",
    "Popatrz!",
    "Spójrz!",
    "Zobacz!",
    "Posłuchaj!",
    "Słuchaj!",
    "Spójrz na …!",
    "Popatrz na …!",
    "Gdzie jest …",
    "Gdzie są …",
  ],
  usuallyPl: [
    "codziennie",
    "każdego dnia",
    "każdego ranka",
    "każdego wieczoru",
    "co rano",
    "co wieczór",
    "co tydzień",
    ...PL_WEEKDAYS_EVERY,
    "w każdy",
    "w każdą",
    "w każde",
    ...PL_WEEKDAYS_LOCATIVE,
    "w weekendy",
    "zwykle",
    "zazwyczaj",
    "zawsze",
    "często",
    "czasem",
    "czasami",
    "rzadko",
    "nigdy",
  ],
  forbidden: [
    "tomorrow",
    "tonight",
    ...[...EN_NEXT_NOUNS, ...EN_WEEKDAYS].map((noun) => `next ${noun}`),
    "this evening",
    "this morning",
    "this afternoon",
    "today",
    ...EN_WEEKDAYS.map((day) => `on ${day}`),
    "at the weekend",
    "jutro",
    "wieczorem",
    "dzisiaj",
    "dziś",
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * Wskaźniki „teraz”, które same nie wystarczają w przeczeniach i celach porównania (standard „Środek”
 * właściciela, 2026-11-06): goły „now” i polskie przysłówki bywają „obecnie, ostatnio” („Tom doesn't
 * watch TV now.”, „Mój brat teraz nie pracuje.”).
 */
export const BARE_NOW_MARKERS: ReadonlySet<string> = new Set(["now", "teraz", "właśnie", "akurat"]);

const NUMBER_WORDS = new Set(["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);

interface Phrase {
  /** Wpis listy, z którego powstała fraza. */
  readonly entry: string;
  readonly tokens: readonly string[];
  readonly kind: "anywhere" | "start" | "exclamation" | "exclamation_object";
}

function phraseKind(entry: string): Phrase["kind"] {
  if (entry.endsWith("…!")) return "exclamation_object";
  if (entry.endsWith("!")) return "exclamation";
  return entry.endsWith("…") ? "start" : "anywhere";
}

/** Wpis listy → fraza: rodzaj wynika ze składni wpisu, tokeny z `normalizeTokens`. */
function compile(entry: string): Phrase {
  const tokens = entry
    .split(" ")
    .flatMap((word) => (word === "N" ? [word] : normalizeTokens(word)));
  return { entry, tokens, kind: phraseKind(entry) };
}

function compileAll(entries: readonly string[]): Phrase[] {
  return entries.map(compile);
}

const PATTERNS = {
  en: {
    now: compileAll(TIME_MARKER_LISTS.nowEn),
    usually: compileAll(TIME_MARKER_LISTS.usuallyEn),
  },
  pl: {
    now: compileAll(TIME_MARKER_LISTS.nowPl),
    usually: compileAll(TIME_MARKER_LISTS.usuallyPl),
  },
} as const;

const FORBIDDEN_PATTERNS = compileAll(TIME_MARKER_LISTS.forbidden);

function tokenMatches(pattern: string, token: string): boolean {
  if (pattern === "N") return NUMBER_WORDS.has(token) || /^\d+$/.test(token);
  return pattern === token;
}

function matchesAt(tokens: readonly string[], index: number, phrase: readonly string[]): boolean {
  if (index + phrase.length > tokens.length) return false;
  return phrase.every((part, offset) => tokenMatches(part, tokens[index + offset]!));
}

function matchesAnywhere(tokens: readonly string[], phrase: Phrase): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    if (matchesAt(tokens, i, phrase.tokens)) return true;
  }
  return false;
}

/** Surowy tekst bez wiodących znaków innych niż litera/cyfra (cudzysłów, myślnik), małymi literami. */
function rawLead(text: string): string {
  return text
    .normalize("NFC")
    .replace(APOSTROPHE_VARIANTS, "'")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "");
}

/** Znaki zamykające po końcu zdania (cudzysłów, nawias), np. `."` w „He said "Look!" Then…”. */
const CLOSING_MARKS = new Set(['"', "'", "”", "“", "’", "»", ")"]);

/** Cudzysłowy otwierające cytat po dwukropku albo przecinku. */
const OPENING_QUOTES = new Set(['"', "'", "“", "„", "«", "‘"]);

/**
 * Początki zdań surowego tekstu: cały tekst, reszta po każdym końcu zdania (`.`, `!`, `?`,
 * opcjonalnie znaki zamykające, potem odstęp) i cytat po dwukropku albo przecinku
 * („Tom shouts, "Look! …"”), małymi literami, bez wiodącej interpunkcji.
 * Pętla zamiast jednego wyrażenia `[.!?]+…\s+`: to cofało się kwadratowo na ciągach `!!!…`.
 */
function sentenceLeads(text: string): string[] {
  const leads = [rawLead(text)];
  for (const gap of text.matchAll(/\s+/gu)) {
    const rest = text.slice(gap.index + gap[0].length);
    let end = gap.index - 1;
    while (end >= 0 && CLOSING_MARKS.has(text.charAt(end))) end -= 1;
    const sentenceEnd = end >= 0 && ".!?".includes(text.charAt(end));
    const quoteStart = gap.index > 0 && ",:".includes(text.charAt(gap.index - 1)) && OPENING_QUOTES.has(rest.charAt(0));
    if (sentenceEnd || quoteStart) leads.push(rawLead(rest));
  }
  return leads;
}

/**
 * Wykrzyknienie na początku zdania surowego tekstu: słowa frazy, potem `!`;
 * w angielskim także `,` („Listen, the baby is crying”). Po polsku przecinek
 * nie wystarcza: „Posłuchaj, a potem wybierz.” i „Zobacz, która forma
 * pasuje.” to polecenia, nie scenki. Fraza z dopełnieniem („Look at …!”)
 * dopuszcza dowolne słowa przed `!` w tym samym zdaniu.
 */
function startsWithExclamation(leads: readonly string[], phrase: Phrase, lang: "en" | "pl"): boolean {
  const words = phrase.tokens.join(String.raw`\s+`);
  const end = phrase.kind === "exclamation_object" ? String.raw`\s+[^.!?]+!` : lang === "en" ? String.raw`\s*[!,]` : String.raw`\s*!`;
  const pattern = new RegExp(`^${words}${end}`, "u");
  return leads.some((lead) => pattern.test(lead));
}

/** Wpisy list, których frazy występują w tekście. */
function matchedEntries(
  phrases: readonly Phrase[],
  tokens: readonly string[],
  leads: readonly string[],
  lang: "en" | "pl",
): string[] {
  return phrases.filter((phrase) => {
    if (phrase.kind === "exclamation" || phrase.kind === "exclamation_object") return startsWithExclamation(leads, phrase, lang);
    if (phrase.kind === "start") return matchesAt(tokens, 0, phrase.tokens);
    return matchesAnywhere(tokens, phrase);
  }).map((phrase) => phrase.entry);
}

/** Słowa czasu, które w poleceniu bywają częścią instrukcji zadania („Teraz uzupełnij zdanie.”). */
const INSTRUCTION_TIME_WORDS: ReadonlySet<string> = new Set(["teraz", "właśnie", "zawsze", "zwykle", "zazwyczaj"]);

/**
 * Polecenia zadania, przy których słowo czasu dotyczy zadania, a nie scenki
 * („Teraz wybierz…”, „Zawsze czytaj…”).
 */
const INSTRUCTION_IMPERATIVES: ReadonlySet<string> = new Set([
  "uzupełnij", "wybierz", "napisz", "popraw", "przetłumacz", "ułóż", "zaznacz", "wskaż", "przeczytaj", "czytaj", "posłuchaj", "pamiętaj",
]);

const RELATIVE_PRONOUNS: ReadonlySet<string> = new Set(["która", "który", "które"]);

/**
 * Zdanie względne o formie, nie o scenie: „forma, która właśnie pasuje”,
 * „zdanie, które teraz brzmi dobrze”, „forma, która teraz jest dobra”. Samo
 * „które teraz” to scenka („Dzieci, które teraz są w parku…”).
 */
function isRelativeAboutForm(tokens: readonly string[], i: number): boolean {
  if (!RELATIVE_PRONOUNS.has(tokens[i - 1] ?? "")) return false;
  const next = tokens[i + 1] ?? "";
  return next === "pasuje" || next === "brzmi" || (next === "jest" && /^dobr[aey]$/u.test(tokens[i + 2] ?? ""));
}

/** Tokeny polecenia bez słów czasu stojących tuż przy poleceniu zadania albo w zdaniu względnym o formie. */
function withoutInstructionTimeWords(tokens: readonly string[]): string[] {
  return tokens.map((token, i) => {
    const instruction = INSTRUCTION_TIME_WORDS.has(token) &&
      (INSTRUCTION_IMPERATIVES.has(tokens[i - 1] ?? "") || INSTRUCTION_IMPERATIVES.has(tokens[i + 1] ?? "") || isRelativeAboutForm(tokens, i));
    return instruction ? "" : token;
  });
}

function findForbidden(tokens: readonly string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    for (const phrase of FORBIDDEN_PATTERNS) {
      if (!matchesAt(tokens, i, phrase.tokens)) continue;
      const matched = tokens.slice(i, i + phrase.tokens.length).join(" ");
      if (!found.includes(matched)) found.push(matched);
    }
  }
  return found;
}

/**
 * Klasyfikuje wskaźniki czasu w tekście ćwiczenia (jedno pole). `lang` wybiera
 * listy grup; wskaźniki zakazane (przyszłość, dwuznaczność) są wspólne.
 * `instruction` (polskie polecenie, `instructionPl`): słowa teraz / właśnie /
 * zawsze / zwykle / zazwyczaj tuż przy poleceniu zadania albo między która /
 * który / które a pasuje / brzmi / jest dobra nie są wskaźnikiem („Teraz
 * uzupełnij zdanie.”, „forma, która właśnie pasuje”).
 */
export function scanTimeMarkers(text: string, lang: "en" | "pl", options: { readonly instruction?: boolean } = {}): MarkerScan {
  const tokens = normalizeTokens(text);
  const groupTokens = options.instruction === true ? withoutInstructionTimeWords(tokens) : tokens;
  const leads = sentenceLeads(text);
  const patterns = PATTERNS[lang];
  const nowMarkers = matchedEntries(patterns.now, groupTokens, leads, lang);
  const groups = new Set<MarkerGroup>();
  if (nowMarkers.length > 0) groups.add("now");
  if (matchedEntries(patterns.usually, groupTokens, leads, lang).length > 0) groups.add("usually");
  const strongNow = nowMarkers.some((entry) => !BARE_NOW_MARKERS.has(entry));
  return { groups, nowMarkers, strongNow, forbidden: findForbidden(tokens) };
}

/**
 * Przysłówki częstotliwości, które w zdaniu dziecka stoją tylko między podmiotem a czasownikiem (Ola always
 * reads, nie „Always Ola reads”; „never” na początku wymaga inwersji). usually, often i sometimes mogą stać też
 * na początku albo na końcu zdania („Sometimes Ola reads.”, „Ola reads comics often.”), więc są przestawialne.
 */
export const FIXED_POSITION_ADVERBS: ReadonlySet<string> = new Set(["always", "never"]);

/**
 * Angielskie wskaźniki czasu tekstu, które mogą stać na początku albo na końcu zdania (now, at the moment,
 * every day, on Mondays, usually…): frazy list „teraz” i „zwykle” bez wykrzyknień (stoją tylko na początku)
 * i bez `FIXED_POSITION_ADVERBS`; wpisy w kolejności list.
 */
export function movableTimeMarkers(text: string): string[] {
  const tokens = normalizeTokens(text);
  return [...PATTERNS.en.now, ...PATTERNS.en.usually]
    .filter((phrase) => phrase.kind === "anywhere" && !FIXED_POSITION_ADVERBS.has(phrase.entry) && matchesAnywhere(tokens, phrase))
    .map((phrase) => phrase.entry);
}
