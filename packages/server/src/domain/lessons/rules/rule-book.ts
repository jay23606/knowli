import { MAX_LESSON_ANSWER_LENGTH, MAX_LESSON_TEXT_LENGTH } from "@learning/contracts";
import type { LessonExerciseType, SubjectModule } from "../types";
import {
  describeRule,
  ENGINE_CATALOGS,
  RULE_PRIORITY,
  type LessonRule,
  type RuleBookContext,
  type RuleCatalog,
  type RuleTextContext,
} from "./catalog";
import { LESSON_RULES } from "./lesson-rules";
import { subjectFeatures, TYPE_CARDS } from "./type-cards";

/**
 * Księga reguł agenta puli (spec katalogu reguł §3): karty typów i reguły
 * pasujące do przedmiotu, typów dozwolonych w zagadnieniu i warunków `when`.
 * Adapter tylko ją renderuje. Czysta funkcja: ten sam wynik dla tego samego
 * wejścia (kolejność stała, bez zegara i losowości).
 *
 * Sekcje:
 * - `checks` — kontrole innymi modelami (reguły lekcji z obszaru `check`);
 * - `lesson` — pozostałe reguły lekcji (cała pula, limity, ujawnienia);
 * - `types` — blok każdego dozwolonego typu (karta typu, reguła typu przedmiotu i
 *   reguły, które w zagadnieniu dotyczą wyłącznie tego typu, oraz reguły `inEachTypeBlock`
 *   w bloku każdego swojego typu);
 * - `general` — reguły rdzenia i przedmiotu bez typów albo wspólne kilku typom
 *   zagadnienia (opis wtedy sam wymienia typy). Poza regułami `inEachTypeBlock` żaden opis się nie powtarza,
 *   a te w kolejnych blokach mają `repeatOf` (renderer odsyła do pierwszego bloku).
 *
 * W każdej sekcji najpierw reguły grup `RULE_PRIORITY` (w kolejności grup), potem
 * reszta po id. Reguły `internal` nigdy nie trafiają do księgi. Opis z dopiskiem
 * przedmiotu (`agentPolicy.ruleNotes`).
 */

export interface RuleLine {
  readonly id: string;
  readonly text: string;
  /** Reguła z `promptBrief`: renderer promptu jej nie wymienia (opis trafia do wyniku narzędzia). */
  readonly brief?: true;
  /**
   * Reguła `inEachTypeBlock` opisana już w bloku wcześniejszego typu: renderer odsyła do niego zamiast
   * powtarzać pełny opis (`text` zostaje pełny).
   */
  readonly repeatOf?: LessonExerciseType;
}

export interface TypeBlock {
  readonly type: LessonExerciseType;
  readonly summary: string;
  /** Przykład rekordu w JSON (z `objectiveId` zastępczym), gdy karta ma przykład dla cech przedmiotu. */
  readonly example?: string;
  /** Semantyka typu z profilu promptów przedmiotu (`prompts.typeRules`). */
  readonly subjectRule?: string;
  readonly rules: readonly RuleLine[];
}

export interface RuleBook {
  readonly general: readonly RuleLine[];
  readonly types: readonly TypeBlock[];
  readonly lesson: readonly RuleLine[];
  readonly checks: readonly RuleLine[];
}

/** Zastępczy `objectiveId` przykładu karty: model wpisuje id swojego zagadnienia. */
export const EXAMPLE_OBJECTIVE_ID = "<objective id>";

/** Obszar id reguł kontroli innymi modelami. */
const CHECK_AREA = "check";

/** Typ bez bloku: karta pochodzi z tematu, nie z puli. */
const CARD_TYPE: LessonExerciseType = "lesson_card";

/** Stała kolejność bloków typów: kolejność kart. */
const TYPE_ORDER = Object.keys(TYPE_CARDS) as LessonExerciseType[];

type Placement =
  | { readonly section: "general" | "lesson" | "checks" }
  | { readonly section: "type"; readonly types: readonly LessonExerciseType[] };

interface PlacedRule {
  readonly id: string;
  readonly rule: LessonRule;
  readonly placement: Placement;
}

/** Czy reguła trafia do księgi przy tych typach i kontekście. */
function matches(rule: LessonRule, allowed: readonly LessonExerciseType[], ctx: RuleBookContext): boolean {
  if (rule.kind === "internal") return false;
  if (rule.types !== undefined && !rule.types.some((type) => allowed.includes(type))) return false;
  return rule.when === undefined || rule.when(ctx);
}

/**
 * Sekcja reguły: lekcja i kontrole po katalogu, reszta do bloku jedynego pasującego typu (albo każdego
 * pasującego, gdy reguła ma `inEachTypeBlock`) albo ogólnych.
 */
function placementOf(id: string, rule: LessonRule, catalog: RuleCatalog, blockTypes: readonly LessonExerciseType[]): Placement {
  if (catalog === LESSON_RULES) {
    return { section: id.split(".")[0] === CHECK_AREA ? "checks" : "lesson" };
  }
  const matching = rule.types?.filter((type) => blockTypes.includes(type)) ?? [];
  if (rule.types === undefined || matching.length === 0) return { section: "general" };
  if (matching.length === 1 || rule.inEachTypeBlock === true) return { section: "type", types: matching };
  return { section: "general" };
}

/** Pozycja grupy priorytetu; reguły bez grupy po wszystkich grupach. */
function priorityRank(rule: LessonRule): number {
  return rule.priority === undefined ? RULE_PRIORITY.length : RULE_PRIORITY.indexOf(rule.priority);
}

/** Kolejność w sekcji: grupa priorytetu, potem id (porównanie kodów znaków, niezależne od locale). */
function byPriorityThenId(a: PlacedRule, b: PlacedRule): number {
  const rank = priorityRank(a.rule) - priorityRank(b.rule);
  if (rank !== 0) return rank;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Księga reguł przedmiotu dla zagadnienia o typach `ctx.exerciseTypes`. */
export function lessonRuleBook(subject: SubjectModule, ctx: RuleBookContext): RuleBook {
  const allowed = ctx.exerciseTypes.filter((type) => subject.exerciseTypes.includes(type));
  const blockTypes = TYPE_ORDER.filter((type) => type !== CARD_TYPE && allowed.includes(type));
  const notes = ctx.policy.ruleNotes ?? {};

  const placed: PlacedRule[] = [];
  const seen = new Set<string>();
  for (const catalog of [...ENGINE_CATALOGS, subject.rules]) {
    for (const [id, rule] of Object.entries(catalog)) {
      if (seen.has(id) || !matches(rule, allowed, ctx)) continue;
      seen.add(id);
      placed.push({ id, rule, placement: placementOf(id, rule, catalog, blockTypes) });
    }
  }
  placed.sort(byPriorityThenId);

  const line = ({ id, rule }: PlacedRule): RuleLine => ({
    id,
    text: describeRule(rule, ctx.text, notes[id]),
    ...(rule.promptBrief === true ? { brief: true as const } : {}),
  });
  const section = (name: "general" | "lesson" | "checks"): RuleLine[] =>
    placed.filter((entry) => entry.placement.section === name).map(line);

  // Pierwszy blok typu z pełnym opisem reguły `inEachTypeBlock`; kolejne bloki odsyłają do niego.
  const firstBlockOf = new Map<string, LessonExerciseType>();
  const typeLine = (entry: PlacedRule, type: LessonExerciseType): RuleLine => {
    const first = firstBlockOf.get(entry.id);
    if (first === undefined) firstBlockOf.set(entry.id, type);
    return first === undefined ? line(entry) : { ...line(entry), repeatOf: first };
  };
  const types = blockTypes.map((type): TypeBlock => {
    const card = TYPE_CARDS[type];
    const example = typeExample(subject, ctx, type);
    const subjectRule = subject.prompts.typeRules?.[type]?.trim();
    return {
      type,
      summary: card.summary,
      ...(example === undefined ? {} : { example: exampleJson(example) }),
      ...(subjectRule === undefined || subjectRule === "" ? {} : { subjectRule }),
      rules: placed
        .filter((entry) => entry.placement.section === "type" && entry.placement.types.includes(type))
        .map((entry) => typeLine(entry, type)),
    };
  });

  return { general: section("general"), types, lesson: section("lesson"), checks: section("checks") };
}

/**
 * Przykład typu w zagadnieniu: przykład przedmiotu dla tematu i zagadnienia (`agentPolicy.typeExamples`),
 * a bez niego przykład karty typu dla cech przedmiotu. `undefined` — typ bez przykładu.
 */
export function typeExample(
  subject: SubjectModule,
  at: Pick<RuleBookContext, "topicId" | "objectiveId">,
  type: LessonExerciseType,
): Readonly<Record<string, unknown>> | undefined {
  const own = subject.agentPolicy.typeExamples?.({ topicId: at.topicId, objectiveId: at.objectiveId })?.[type];
  return own ?? TYPE_CARDS[type].example?.(subjectFeatures(subject));
}

/**
 * Limity i flagi przedmiotu do tekstów opisów reguł — te same, którymi posługuje się walidacja:
 * odpowiedź przedmiotu z payloadem v3 ma limit kontraktu odpowiedzi, pozostałe limit tekstu.
 */
export function ruleTextContextOf(subject: Pick<SubjectModule, "usesV3Payload" | "sourceQuotes">): RuleTextContext {
  return {
    answerMaxLength: subject.usesV3Payload === true ? MAX_LESSON_ANSWER_LENGTH : MAX_LESSON_TEXT_LENGTH,
    groundingRequired: subject.sourceQuotes === true,
  };
}

/**
 * Pełny kontekst księgi reguł przedmiotu dla zagadnienia `objectiveId` tematu `topicId`: `exerciseTypes` — typy
 * dozwolone w zagadnieniu, `listenChoice` — czy `lesson_listen_choice` jest dostępny zagadnieniu (nie: czy
 * zostało miejsce w przydziale). Pozostałe pola pochodzą z przedmiotu.
 */
export function ruleBookContextFor(
  subject: SubjectModule,
  topicId: string,
  objectiveId: string,
  exerciseTypes: readonly LessonExerciseType[],
  listenChoice: boolean,
): RuleBookContext {
  return {
    topicId,
    objectiveId,
    exerciseTypes,
    text: ruleTextContextOf(subject),
    policy: subject.agentPolicy,
    listenChoice,
    voiceTones: subject.ttsForPrompts === true,
    exerciseExplanations: subject.exerciseExplanations,
    usesV3Payload: subject.usesV3Payload === true,
    deduplication: subject.poolDeduplication ?? "answer",
  };
}

/** Przykład w JSON: `exerciseType`, zastępczy `objectiveId`, potem pola karty. */
function exampleJson(example: Readonly<Record<string, unknown>>): string {
  const { exerciseType, ...rest } = example;
  return JSON.stringify({ exerciseType, objectiveId: EXAMPLE_OBJECTIVE_ID, ...rest });
}
