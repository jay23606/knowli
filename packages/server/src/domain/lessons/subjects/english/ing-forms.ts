import { normalizeTokens } from "../../normalize";
import { stemsOf } from "./inflection";

/**
 * Forma -ing i czasowniki stanu dla tematu Present Continuous (design
 * „Present Continuous” §4 i §5.3): zamknięta tabela czasowników czynności
 * z pisownią brytyjską oraz wykrywanie czasowników stanu w tekście ćwiczenia.
 * Czyste funkcje nad znormalizowanymi tokenami; walidator tematu i prompty
 * korzystają z tego jednego źródła.
 */

/**
 * Klasa reguły pisowni: `plain` (play → playing), `drop_e` (make → making),
 * `double` (run → running), `ie_to_y` (lie → lying), `other` — wyjątki zależne
 * od akcentu i konwencji brytyjskiej (travel → travelling), poza celem 5.
 */
export type IngRule = "plain" | "drop_e" | "double" | "ie_to_y" | "other";

/**
 * Tabela zamiast reguł: podwojenie zależy od akcentu (visit → visiting,
 * begin → beginning), a brytyjskie „-ll” od konwencji. Czasowniki stanu (§5.3)
 * nie należą do tabeli. Kolejność wpisów jest kolejnością w promptach.
 */
const ING_ENTRIES: readonly (readonly [base: string, form: string, rule: IngRule])[] = [
  ["play", "playing", "plain"],
  ["read", "reading", "plain"],
  ["jump", "jumping", "plain"],
  ["fix", "fixing", "plain"],
  ["do", "doing", "plain"],
  ["go", "going", "plain"],
  ["walk", "walking", "plain"],
  ["talk", "talking", "plain"],
  ["eat", "eating", "plain"],
  ["drink", "drinking", "plain"],
  ["sleep", "sleeping", "plain"],
  ["cook", "cooking", "plain"],
  ["paint", "painting", "plain"],
  ["draw", "drawing", "plain"],
  ["sing", "singing", "plain"],
  ["watch", "watching", "plain"],
  ["listen", "listening", "plain"],
  ["wait", "waiting", "plain"],
  ["work", "working", "plain"],
  ["study", "studying", "plain"],
  ["climb", "climbing", "plain"],
  ["cry", "crying", "plain"],
  ["fly", "flying", "plain"],
  ["carry", "carrying", "plain"],
  ["ask", "asking", "plain"],
  ["open", "opening", "plain"],
  ["help", "helping", "plain"],
  ["wash", "washing", "plain"],
  ["clean", "cleaning", "plain"],
  ["brush", "brushing", "plain"],
  ["call", "calling", "plain"],
  ["kick", "kicking", "plain"],
  ["throw", "throwing", "plain"],
  ["catch", "catching", "plain"],
  ["pull", "pulling", "plain"],
  ["push", "pushing", "plain"],
  ["build", "building", "plain"],
  ["wear", "wearing", "plain"],
  ["laugh", "laughing", "plain"],
  ["learn", "learning", "plain"],
  ["buy", "buying", "plain"],
  ["bring", "bringing", "plain"],
  ["send", "sending", "plain"],
  ["fall", "falling", "plain"],
  ["turn", "turning", "plain"],
  ["pick", "picking", "plain"],
  ["stay", "staying", "plain"],
  ["count", "counting", "plain"],
  ["try", "trying", "plain"],
  ["hurry", "hurrying", "plain"],
  ["rain", "raining", "plain"],
  ["snow", "snowing", "plain"],
  ["make", "making", "drop_e"],
  ["write", "writing", "drop_e"],
  ["ride", "riding", "drop_e"],
  ["dance", "dancing", "drop_e"],
  ["smile", "smiling", "drop_e"],
  ["bake", "baking", "drop_e"],
  ["take", "taking", "drop_e"],
  ["come", "coming", "drop_e"],
  ["give", "giving", "drop_e"],
  ["drive", "driving", "drop_e"],
  ["skate", "skating", "drop_e"],
  ["close", "closing", "drop_e"],
  ["use", "using", "drop_e"],
  ["move", "moving", "drop_e"],
  ["share", "sharing", "drop_e"],
  ["save", "saving", "drop_e"],
  ["wave", "waving", "drop_e"],
  ["shine", "shining", "drop_e"],
  ["run", "running", "double"],
  ["swim", "swimming", "double"],
  ["sit", "sitting", "double"],
  ["get", "getting", "double"],
  ["stop", "stopping", "double"],
  ["shop", "shopping", "double"],
  ["hop", "hopping", "double"],
  ["clap", "clapping", "double"],
  ["dig", "digging", "double"],
  ["jog", "jogging", "double"],
  ["put", "putting", "double"],
  ["cut", "cutting", "double"],
  ["hit", "hitting", "double"],
  ["chat", "chatting", "double"],
  ["skip", "skipping", "double"],
  ["drop", "dropping", "double"],
  ["win", "winning", "double"],
  ["lie", "lying", "ie_to_y"],
  ["tie", "tying", "ie_to_y"],
  ["travel", "travelling", "other"],
  ["begin", "beginning", "other"],
  ["visit", "visiting", "other"],
  ["cancel", "cancelling", "other"],
];

const ING_BY_BASE: ReadonlyMap<string, { form: string; rule: IngRule }> = new Map(
  ING_ENTRIES.map(([base, form, rule]) => [base, { form, rule }]),
);

const BASE_BY_ING_FORM: ReadonlyMap<string, string> = new Map(
  ING_ENTRIES.map(([base, form]) => [form, base]),
);

/** Forma -ing czasownika z tabeli; `undefined` dla czasownika spoza tabeli. */
export function ingFormOf(base: string): string | undefined {
  return ING_BY_BASE.get(base)?.form;
}

/** Klasa reguły pisowni czasownika z tabeli; `undefined` dla czasownika spoza tabeli. */
export function ingRuleOf(base: string): IngRule | undefined {
  return ING_BY_BASE.get(base)?.rule;
}

/** Odwrotność tabeli: forma podstawowa dla formy -ing (`running` → `run`). */
export function baseOfIngForm(form: string): string | undefined {
  return BASE_BY_ING_FORM.get(form);
}

/** Czy token jest formą -ing z tabeli (odróżnia ją od „morning”, „sing”, „thing”). */
export function isIngFormInTable(token: string): boolean {
  return BASE_BY_ING_FORM.has(token);
}

/** Formy podstawowe czasowników z podanych klas w kolejności tabeli (do promptu). */
export function ingVerbsByRule(rules: readonly IngRule[]): readonly string[] {
  return ING_ENTRIES.filter(([, , rule]) => rules.includes(rule)).map(([base]) => base);
}

/**
 * Czasowniki stanu (§5.3), które nie występują w Present Continuous. „be” nie
 * należy do listy: am/is/are budują sam czas, a rozpoznawane jest tylko „being”.
 */
export const STATE_VERBS: ReadonlySet<string> = new Set([
  "like", "love", "hate", "prefer", "want", "need", "wish", "know", "understand",
  "believe", "remember", "forget", "recognise", "mean", "seem", "sound", "cost",
  "own", "belong", "think", "see", "hear", "feel", "taste", "smell", "have", "look",
]);

/** Forma spoza prostej odmiany (`stemsOf` jej nie wyprowadzi). */
const IRREGULAR_STATE_FORMS: ReadonlyMap<string, string> = new Map([["has", "have"]]);

/** Tokeny, które heurystyka `stemsOf` myli z czasownikiem stanu („seeds” → „see”). */
const NOT_STATE_FORMS: ReadonlySet<string> = new Set(["seed", "seeds", "seeded"]);

/** Wyrazy po „have”, przy których czasownik nie jest stanem („have lunch”, „have a bath”). */
const HAVE_SINGLE_OBJECTS: ReadonlySet<string> = new Set(["breakfast", "lunch", "dinner", "fun"]);
const HAVE_ARTICLE_OBJECTS: ReadonlySet<string> = new Set(["bath", "shower", "party"]);
const LOOK_PREPOSITIONS: ReadonlySet<string> = new Set(["at", "for"]);

/**
 * Wykrzyknik „Look!” / „Look,” na początku tekstu lub zdania, także w cudzysłowie i po dwukropku
 * albo przecinku („Tom shouts, "Look! …"”) — nie jest czasownikiem stanu.
 */
const LOOK_EXCLAMATION = /(^|[.!?:,]\s*)["'“”„«‘’]?look\s*[!,]/gi;

/** Zaimki dzierżawcze: „own” po nich to przymiotnik („his own bike”). */
const POSSESSIVES: ReadonlySet<string> = new Set(["my", "your", "his", "her", "its", "our", "their"]);

/** Słowa, po których „like a…” to czasownik („I like a good book”); poza nimi to porównanie („swims like a fish”). */
const LIKE_VERB_BEFORE: ReadonlySet<string> = new Set(["i", "you", "we", "they", "not", "do", "to", "would"]);

/** Czy token na pozycji `index` to inna część mowy niż czasownik stanu: „own” po dzierżawczym, „like” w porównaniu. */
function isNotStateVerb(token: string, tokens: readonly string[], index: number): boolean {
  const previous = tokens[index - 1] ?? "";
  if (token === "own") return POSSESSIVES.has(previous);
  return token === "like" && index > 0 && ["a", "an"].includes(tokens[index + 1] ?? "") && !LIKE_VERB_BEFORE.has(previous);
}

/** Czy po czasowniku stanu `base` na pozycji `index` stoi kolokacja dozwolona w §5.3. */
function isStateCollocation(base: string, tokens: readonly string[], index: number): boolean {
  const next = tokens[index + 1];
  if (next === undefined) return false;
  if (base === "look") return LOOK_PREPOSITIONS.has(next);
  if (base !== "have") return false;
  if (HAVE_SINGLE_OBJECTS.has(next)) return true;
  const afterArticle = tokens[index + 2];
  return next === "a" && afterArticle !== undefined && HAVE_ARTICLE_OBJECTS.has(afterArticle);
}

/** Forma podstawowa czasownika stanu, którego formą jest token (`likes`, `liking`, `has`); inaczej `undefined`. */
function stateVerbOfToken(token: string, mode: "any_form" | "ing_form"): string | undefined {
  if (token === "being") return "be";
  if (NOT_STATE_FORMS.has(token)) return undefined;
  if (mode === "any_form") {
    if (STATE_VERBS.has(token)) return token;
    const irregular = IRREGULAR_STATE_FORMS.get(token);
    if (irregular !== undefined) return irregular;
  } else if (!token.endsWith("ing")) {
    return undefined;
  }
  return stemsOf(token).find((stem) => STATE_VERBS.has(stem));
}

/**
 * Pierwszy czasownik stanu w tekście (forma podstawowa) albo `undefined`.
 * `any_form` łapie każdą formę (`likes`, `has`, `liking`), `ing_form` tylko
 * formę -ing; „being” daje `"be"` w obu trybach. Wyjątki §5.3: „have” + posiłek,
 * kąpiel, zabawa, „look at/for” i wykrzyknik „Look!”.
 */
export function stateVerbIn(text: string, mode: "any_form" | "ing_form"): string | undefined {
  const tokens = normalizeTokens(text.replace(LOOK_EXCLAMATION, "$1 "));
  for (const [index, token] of tokens.entries()) {
    const verb = stateVerbOfToken(token, mode);
    if (verb === undefined || isStateCollocation(verb, tokens, index) || isNotStateVerb(token, tokens, index)) continue;
    return verb;
  }
  return undefined;
}

/** Czasowniki stanu z formą -ing dozwoloną w kolokacji (§4, wyjątek; poza celem 5). */
export const COLLOCATION_ING_FORMS: Readonly<Record<string, string>> = { have: "having", look: "looking" };

/**
 * Czy token na pozycji `index` to forma -ing z kolokacji dozwolonej poza tabelą:
 * „having” + breakfast / lunch / dinner / a bath / a shower / fun / a party
 * albo „looking” + at / for (§4, wyjątek).
 */
export function isCollocationIngForm(tokens: readonly string[], index: number): boolean {
  const token = tokens[index];
  if (token === "having") return isStateCollocation("have", tokens, index);
  if (token === "looking") return isStateCollocation("look", tokens, index);
  return false;
}
