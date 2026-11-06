import type { LessonExerciseType, SubjectAgentPolicy, SubjectModule } from "../types";

/** Tryb rozpoznawania duplikatów w puli (`SubjectModule.poolDeduplication`; brak = `answer`). */
export type PoolDeduplication = NonNullable<SubjectModule["poolDeduplication"]>;
import { CORE_RULES } from "./core-rules";
import { LESSON_RULES } from "./lesson-rules";

/**
 * Katalog reguł walidacji lekcji (spec katalogu reguł §2). Każda deterministyczna
 * reguła ma wpis z opisem dla modelu (po angielsku), a walidator zgłasza jej
 * złamanie przez fabrykę `issueFrom` — jedyne źródło `RuleId`. Czysta domena:
 * bez bazy, sieci i zegara.
 *
 * Katalogi: rdzeń (`core-rules.ts`), lekcja (`lesson-rules.ts`) i przedmiot
 * (`SubjectModule.rules`). Katalogi silnika nie importują wartości z tego pliku
 * (ten plik importuje je do `ENGINE_CATALOGS`, więc import zwrotny byłby cyklem):
 * deklarują się przez `satisfies RuleCatalog`, a ich id sprawdza `defineRules`
 * poniżej. Między tym plikiem a `types.ts` wyłącznie `import type`.
 */

/**
 * Rodzaj reguły: `reject` odrzuca ćwiczenie, `sanitize` usuwa pole albo element
 * i daje notę, `internal` jest nieosiągalna dla agenta (kod wylicza pole) i nie
 * trafia do promptu.
 */
export type RuleKind = "reject" | "sanitize" | "internal";

/**
 * Grupy reguł najczęściej łamanych w przebiegu z 2026-11-05 (podpowiedź, cytat,
 * rodzina pytań, kształt rachunku), w tej kolejności: księga reguł
 * (`rule-book.ts`) stawia je na początku swojej sekcji.
 */
export const RULE_PRIORITY = ["hint", "quote", "family", "calculation_shape"] as const;

export type RulePriority = (typeof RULE_PRIORITY)[number];

/** Limity i flagi przedmiotu, od których zależy tekst opisu reguły (np. długość odpowiedzi). */
export interface RuleTextContext {
  readonly answerMaxLength: number;
  readonly groundingRequired: boolean;
}

/** Wpis reguły w katalogu. */
export interface LessonRule {
  /** Pole ćwiczenia (do komunikatu) albo `exercise`. */
  readonly field: string;
  readonly kind: RuleKind;
  /** Typy ćwiczeń, których reguła dotyczy; brak = wszystkie. */
  readonly types?: readonly LessonExerciseType[];
  /** Warunek obecności reguły w prompcie (kontekst przedmiotu i zagadnienia). */
  readonly when?: (ctx: RuleBookContext) => boolean;
  /** Jedno–trzy zdania po angielsku; liczby wyłącznie ze stałych sprawdzenia. */
  readonly description: string | ((ctx: RuleTextContext) => string);
  /** Nazwa stałej limitu — wymusza przypadek graniczny w rejestrze przypadków. */
  readonly limit?: string;
  /** Reguła bez `found` (stały komunikat, np. „lesson_card is not a pool exercise”). */
  readonly fixedMessage?: true;
  /** Uzasadnienie reguły `internal` (dlaczego agent nie może jej złamać). */
  readonly internalReason?: string;
  /** Grupa priorytetu w księdze reguł (`RULE_PRIORITY`); brak = zwykła kolejność po id. */
  readonly priority?: RulePriority;
  /**
   * Poza promptem (opis dostaje model w wyniku narzędzia, gdy złamie regułę): kształt rekordu (`shape.*`, ten
   * sam kształt opisuje schemat narzędzia), reguły, które tylko powtarzają listę pól karty typu albo enum,
   * typ lub limit schematu narzędzia, oraz rzadko łamane spójności identyfikatorów (np. `group.ids_unique`).
   * Budżet długości promptu (Task 8b planu katalogu reguł, przegląd końcowy I8).
   */
  readonly promptBrief?: true;
  /**
   * Reguła kilku typów, która w księdze stoi w bloku każdego pasującego typu zagadnienia zamiast w
   * regułach ogólnych (np. polskie zdanie-bodziec w `instructionPl` tylko części typów: w ogólnych
   * przeczyłaby karcie typu bez polecenia).
   */
  readonly inEachTypeBlock?: true;
}

export type RuleCatalog = Readonly<Record<string, LessonRule>>;

/** Id reguły; powstaje wyłącznie w fabryce zgłoszeń katalogu. */
export type RuleId = string & { readonly __lessonRule: unique symbol };

/** Zgłoszenie złamanej reguły. */
export interface LessonRuleIssue {
  readonly rule: RuleId;
  /** Ścieżka pola, np. `sourceRefs[1].quote`. */
  readonly field: string;
  /** Komunikat dla rodzica (po polsku). */
  readonly pl: string;
  /** Po angielsku: co konkretnie jest nie tak, z wartością (przez `clip`). */
  readonly found?: string;
}

/**
 * Kontekst składania reguł do promptu (warunki `when`, `lessonRuleBook`).
 * Wypełnia go wejście agenta; tu tylko kształt. `exerciseTypes` — typy
 * dozwolone w zagadnieniu; `listenChoice` — czy `lesson_listen_choice` jest
 * dostępny zagadnieniu (nie: czy zostało miejsce w przydziale).
 */
export interface RuleBookContext {
  readonly exerciseTypes: readonly LessonExerciseType[];
  readonly text: RuleTextContext;
  readonly policy: SubjectAgentPolicy;
  readonly listenChoice: boolean;
  readonly voiceTones: boolean;
  readonly exerciseExplanations: boolean;
  /** Czy przedmiot używa pól payloadu v3 (`SubjectModule.usesV3Payload`). */
  readonly usesV3Payload: boolean;
  /**
   * Tryb duplikatów puli przedmiotu, którym posługuje się `validatePoolIssues`
   * (`subject.poolDeduplication ?? "answer"`); wypełnia go wejście agenta (Task 8a).
   */
  readonly deduplication: PoolDeduplication;
  /**
   * Id tematu lekcji: reguły jednego tematu przedmiotu (np. formy `to be`) trafiają do księgi tylko
   * w nim. Warunek na id tematu żyje w katalogu przedmiotu, nigdy w silniku.
   */
  readonly topicId: string;
  /** Id zagadnienia księgi: wybiera przykłady typów przedmiotu (`SubjectAgentPolicy.typeExamples`). */
  readonly objectiveId: string;
}

/** Id reguły: literał `obszar.nazwa` z co najmniej jedną kropką, tylko `[a-z0-9_]` w segmentach. */
const RULE_ID_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** Deklaruje katalog reguł; rzuca przy id spoza wzorca `obszar.nazwa`. */
export function defineRules<const C extends RuleCatalog>(catalog: C): C {
  for (const id of Object.keys(catalog)) {
    if (!RULE_ID_PATTERN.test(id)) {
      throw new Error(`Katalog reguł: niepoprawny identyfikator reguły „${id}” (wzorzec obszar.nazwa, [a-z0-9_.])`);
    }
  }
  return catalog;
}

/**
 * Fabryka zgłoszeń katalogu: przyjmuje tylko klucze katalogu, a `field`
 * domyślnie bierze z wpisu reguły.
 */
export function issueFrom<C extends RuleCatalog>(
  catalog: C,
): (id: keyof C & string, details: { readonly field?: string; readonly pl: string; readonly found?: string }) => LessonRuleIssue {
  return (id, details) => {
    const rule: LessonRule | undefined = catalog[id];
    if (rule === undefined) {
      throw new Error(`Katalog reguł: nieznana reguła „${id}”`);
    }
    return {
      rule: id as string as RuleId,
      field: details.field ?? rule.field,
      pl: details.pl,
      ...(details.found === undefined ? {} : { found: details.found }),
    };
  };
}

/** Domyślna długość treści wycinka w `found`. */
const CLIP_MAX = 120;

/**
 * Wycinek tekstu ćwiczenia do `found`: nowe linie i tabulatory na spację,
 * zwinięte spacje, najwyżej `max` znaków treści z `…`, domyślnie w cudzysłowie.
 */
export function clip(text: string, max: number = CLIP_MAX, options: { readonly quote?: boolean } = {}): string {
  const flat = text.replace(/[\r\n\t]/g, " ").replace(/ {2,}/g, " ");
  const chars = Array.from(flat);
  const body = chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
  return options.quote === false ? body : `"${body}"`;
}

/**
 * Komunikaty dla rodzica (`pl`) — dzisiejsze napisy walidatorów. Komunikat
 * identyczny z wcześniejszym na liście jest pomijany (kolejność zostaje): kilka
 * reguł może dzielić dzisiejszy tekst (np. rodzina różna odpowiedzią i elementami).
 */
export function messagesOf(issues: readonly LessonRuleIssue[]): string[] {
  return [...new Set(issues.map((issue) => issue.pl))];
}

/** Katalogi silnika: rdzeń i lekcja. */
export const ENGINE_CATALOGS: readonly RuleCatalog[] = [defineRules(CORE_RULES), defineRules(LESSON_RULES)];

/**
 * Wpis reguły po id (rdzeń ∪ lekcja ∪ przedmiot). `undefined`, gdy reguły nie
 * ma — wołający pomija wtedy opis; test kompletności pilnuje, że to się nie zdarza.
 */
export function ruleOf(
  subject: Pick<SubjectModule, "rules">,
  id: RuleId,
): (LessonRule & { readonly id: RuleId }) | undefined {
  for (const catalog of [...ENGINE_CATALOGS, subject.rules]) {
    if (Object.hasOwn(catalog, id)) {
      const rule = catalog[id];
      if (rule !== undefined) {
        return { ...rule, id };
      }
    }
  }
  return undefined;
}

/** Opis reguły dla modelu w danym kontekście, z opcjonalnym dopiskiem przedmiotu po spacji. */
export function describeRule(rule: LessonRule, ctx: RuleTextContext, note?: string): string {
  const text = typeof rule.description === "string" ? rule.description : rule.description(ctx);
  return note === undefined ? text : `${text} ${note}`;
}
