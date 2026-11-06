import { exerciseExposureText } from "../exposure-key";
import { findExposureLeaks, type ExposureLeak } from "../exposure-leaks";
import { withoutOrphanKeywords } from "../keyword-families";
import {
  agentReanalysisDraft,
  answersEquivalent,
  MAX_TEXT_LENGTH,
  validateLessonExerciseIssues,
  validatePoolIssues,
} from "../pool-validation";
import { clip, issueFrom, type LessonRuleIssue, type RuleId } from "../rules/catalog";
import { LESSON_RULES } from "../rules/lesson-rules";
import { formatRuleReason, formatVictimReason, type RuleReason } from "../rules/rule-reason";
import type { AgentObjective, LessonExerciseDraft, SubjectModule } from "../types";
import { blindMatches, blindMismatchFound } from "./solver";
import {
  allExamples,
  orderedEntries,
  poolOf,
  takeIds,
  withExamples,
  withPool,
  type AgentPoolEntry,
  type LessonAgentState,
  type OrderedLessonEntry,
} from "./state";

/**
 * Przyjmowanie paczki ćwiczeń agenta (spec §3.3): każdy kandydat przechodzi
 * kontrole na CAŁEJ lekcji (`fixed` + pule wszystkich zagadnień), a odrzucenie
 * wraca do modelu z nazwanym kodem i powodami z id reguł (spec katalogu reguł
 * §4.1). Czyste funkcje nad jawnym stanem.
 */

/** Fabryka zgłoszeń reguł lekcji: limity, ujawnienia i kontrole modelami. */
const lessonIssue = issueFrom(LESSON_RULES);

/** Limity zagadnienia (§3.5): `maxExercises` = `targetCount` + `listenAllowance` + `slack`. */
export interface ObjectiveAgentLimits {
  readonly targetCount: number;
  readonly listenAllowance: number;
  readonly maxExercises: number;
}

/** Kontekst kontroli (§3.2). */
export interface AgentCheckContext {
  readonly subject: SubjectModule;
  readonly material: string;
  readonly limits: ReadonlyMap<string, ObjectiveAgentLimits>;
}

/** Wynik kroku checkera: `na` — krok nie dotyczy; `unavailable` — błąd lub termin checkera (krok przechodzi). */
export type CheckResult<T> =
  | { readonly kind: "na" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "done"; readonly value: T };

/** Werdykt sędziego podpowiedzi (etap 2b §6.4); `reason` ≤ 200 znaków, tylko dla modelu agenta. */
export type AgentHintVerdict =
  | { readonly verdict: "ok" }
  | { readonly verdict: "unsupported" | "language" | "reveals"; readonly reason: string };

/** Wynik jednej odpowiedzi kontroli otwartej: ocena wiedzy plus teksty braków i błędów (nigdy do Kid DTO). */
export interface OpenGraded {
  readonly answer: string;
  readonly knowledge: "correct" | "partial" | "incorrect";
  /** Teksty brakujących elementów wymaganych. */
  readonly missing: readonly string[];
  /** Błędne stwierdzenia i pomylone pojęcia (jako „said → meant”). */
  readonly wrong: readonly string[];
}

/** Kontrola otwarta jest `done` tylko, gdy obie odpowiedzi (dwóch rozwiązujących) mają wynik. */
export interface OpenCheckOutcome {
  readonly answers: readonly [OpenGraded, OpenGraded];
}

export interface CandidateChecks {
  readonly solve: CheckResult<readonly string[]>;
  readonly variants: CheckResult<readonly boolean[]>;
  readonly hint: CheckResult<AgentHintVerdict>;
  readonly open: CheckResult<OpenCheckOutcome>;
}

/**
 * Odrzucenie ćwiczenia: stały kod (logi, histogram `rejectedReasons`), zgłoszenia złamanych reguł
 * i powody dla modelu (`[id] pole: found`, po angielsku, mogą zawierać treść ćwiczenia — nigdy do
 * logów). `ruleIds` — id reguł zgłoszeń bez powtórzeń, w kolejności zgłoszeń (logi bez treści).
 */
export interface Rejection {
  readonly kind: "shape" | "rule" | "lesson" | "leak" | "blind" | "hint" | "open" | "limit";
  readonly code: string;
  readonly reasons: readonly RuleReason[];
  readonly issues: readonly LessonRuleIssue[];
  readonly ruleIds: readonly RuleId[];
}

/** Odrzucenie ze zgłoszeń; powody domyślnie `formatRuleReason` każdego zgłoszenia (w tej kolejności). */
export function rejectionOf(
  kind: Rejection["kind"],
  code: string,
  issues: readonly LessonRuleIssue[],
  reasons: readonly RuleReason[] = issues.map(formatRuleReason),
): Rejection {
  return { kind, code, reasons, issues, ruleIds: [...new Set(issues.map((issue) => issue.rule))] };
}

export type PrecheckEntry =
  | {
      readonly pass: true;
      readonly draft: LessonExerciseDraft;
      readonly sanitized: readonly string[];
      /** Zgłoszenia reguł `sanitize` przedmiotu (np. usunięta podpowiedź) — noty dla modelu. */
      readonly notes: readonly LessonRuleIssue[];
      /** Cytaty zastąpione dokładnym fragmentem materiału przez sanityzację przedmiotu. */
      readonly quotesSnapped: number;
    }
  | { readonly pass: false; readonly rejection: Rejection };

export type AdmitEntry =
  | {
      readonly accepted: string;
      readonly sanitized: readonly string[];
      readonly unchecked: boolean;
      /** Noty sanityzacji i usuniętych wariantów (`check.variants`). */
      readonly notes: readonly LessonRuleIssue[];
      /** Warianty odpowiedzi usunięte, bo checker uznał je za nierównoważne (spec katalogu reguł §5.3). */
      readonly removedVariants: readonly string[];
      readonly quotesSnapped: number;
    }
  | { readonly rejected: Rejection };

/** Odrzucenia reguł lekcji i ujawnienia — po referencji szkicu (wadliwe `fixed` nie blokuje kandydatów). */
export interface LessonSnapshot {
  readonly entries: readonly OrderedLessonEntry[];
  readonly poolRejected: ReadonlyMap<LessonExerciseDraft, readonly LessonRuleIssue[]>;
  readonly extraRejected: ReadonlyMap<LessonExerciseDraft, readonly LessonRuleIssue[]>;
  readonly leaked: ReadonlyMap<LessonExerciseDraft, ExposureLeak>;
}

type LessonRules = Omit<LessonSnapshot, "leaked">;

/** Rodziny pytań otwartych odrzuconych w bieżącym wywołaniu (kaskada słów kluczowych przedmiotu). */
type RejectedFamilies = ReadonlySet<string>;

const NO_REJECTED_FAMILIES: RejectedFamilies = new Set();

function lessonRules(state: LessonAgentState, ctx: AgentCheckContext, rejectedFamilies: RejectedFamilies = NO_REJECTED_FAMILIES): LessonRules {
  const entries = orderedEntries(state);
  const lesson = entries.map((entry) => entry.draft);
  const pool = validatePoolIssues(lesson, ctx.subject, state.topic, { existingExercises: [], agent: true });
  const poolRejected = new Map(pool.rejected.map((item) => [item.exercise, item.issues] as const));
  const extraRejected = new Map<LessonExerciseDraft, readonly LessonRuleIssue[]>();
  const extraCtx = rejectedFamilies.size === 0 ? { material: ctx.material } : { material: ctx.material, rejectedFamilies };
  for (const [index, issues] of ctx.subject.validatePoolExtra?.(lesson, extraCtx) ?? []) {
    const draft = lesson[index];
    if (draft !== undefined && issues.length > 0) extraRejected.set(draft, issues);
  }
  return { entries, poolRejected, extraRejected };
}

/**
 * Tryb porównań ujawnień w przyjmowaniu: `generation` (równoważność odpowiedzi po normalizatorze
 * przedmiotu, także warianty ofiary) — „Where is the box?”
 * ujawnia przykład „Where's the box?”, a wariant tłumaczenia równy zdaniu innego ćwiczenia też jest
 * ujawnieniem. Ostrzejszy od `coverage` (równość `target_key`), więc pula przyjęta tak jest czysta także
 * w pokryciu i w ostrzeżeniach szkicu. Ten sam tryb w migawce, bezpieczniku i kontroli końcowej.
 */
const ADMISSION_LEAK_MODE = "generation";

function lessonLeaks(state: LessonAgentState, entries: readonly OrderedLessonEntry[], ctx: AgentCheckContext): Map<LessonExerciseDraft, ExposureLeak> {
  const leaks = findExposureLeaks({
    exercises: entries.map((entry) => entry.draft),
    examples: allExamples(state),
    objectiveOrder: state.objectives.map((objective) => objective.id),
    subject: ctx.subject,
    mode: ADMISSION_LEAK_MODE,
    // Rodzina pytań otwartych (ta sama odpowiedź wzorcowa) nie ujawnia rozwiązania samej sobie — jak w szkicu.
    familyRepeatsAllowed: true,
  });
  return new Map(leaks.map((leak) => [entries[leak.index]!.draft, leak] as const));
}

export function snapshotOf(state: LessonAgentState, ctx: AgentCheckContext): LessonSnapshot {
  const rules = lessonRules(state, ctx);
  return { ...rules, leaked: lessonLeaks(state, rules.entries, ctx) };
}

/** Kolejność przetwarzania paczki: słowa kluczowe na końcu (po pytaniach otwartych swojej rodziny), stabilnie. */
function processingOrder(keywords: readonly boolean[]): number[] {
  const indexes = keywords.map((_flag, index) => index);
  return [...indexes.filter((index) => !keywords[index]), ...indexes.filter((index) => keywords[index])];
}

function isKeywords(draft: LessonExerciseDraft): boolean {
  return draft.exerciseType === "lesson_keywords";
}

/** Rodzina odrzuconego kandydata, której słowa kluczowe z tej samej paczki dostają regułę kaskady. */
function openFamilyOf(draft: LessonExerciseDraft): string | undefined {
  return draft.exerciseType === "lesson_open_answer" && draft.familyId ? draft.familyId : undefined;
}

function objectiveOf(state: LessonAgentState, objectiveId: string): AgentObjective {
  const objective = state.objectives.find((item) => item.id === objectiveId);
  if (objective === undefined) throw new Error(`unknown objective ${objectiveId}`);
  return objective;
}

function limitsOf(ctx: AgentCheckContext, objectiveId: string): ObjectiveAgentLimits {
  const limits = ctx.limits.get(objectiveId);
  if (limits === undefined) throw new Error(`no limits for objective ${objectiveId}`);
  return limits;
}

/** Sanityzacja polityki, potem `refineGeneratedPool` przedmiotu (może odrzucić albo oczyścić szkic). */
function sanitizeCandidate(
  draft: LessonExerciseDraft,
  ctx: AgentCheckContext,
):
  | {
      ok: true;
      draft: LessonExerciseDraft;
      sanitized: readonly string[];
      notes: readonly LessonRuleIssue[];
      quotesSnapped: number;
    }
  | { ok: false; rejection: Rejection } {
  const sanitizedResult = ctx.subject.agentPolicy.sanitize?.(draft, { material: ctx.material }) ?? { draft, removed: [] };
  const clean = {
    sanitized: sanitizedResult.removed,
    notes: sanitizedResult.notes ?? [],
    quotesSnapped: sanitizedResult.quotesSnapped ?? 0,
  };
  const refine = ctx.subject.refineGeneratedPool;
  if (refine === undefined) return { ok: true, draft: sanitizedResult.draft, ...clean };
  const refined = refine([sanitizedResult.draft], { material: ctx.material });
  const kept = refined.kept[0];
  if (refined.rejected.length > 0 || kept === undefined) {
    const named = refined.rejected.flatMap((item) => item.issues);
    // Kontrakt haka: odrzucenie nazywa złamaną regułę przedmiotu. Bez niej (błąd przedmiotu) zagadnienie nie
    // pada na wyjątku: ćwiczenie odpada z ogólnym powodem bezpiecznika.
    const issues = named.length > 0
      ? named
      : [lessonIssue("lesson.refine_unnamed", {
          pl: "ćwiczenie odrzucone przez regułę przedmiotu",
          found: "the subject rejected this exercise without naming a rule",
        })];
    return { ok: false, rejection: rejectionOf("rule", "refine", issues) };
  }
  return { ok: true, draft: kept, ...clean };
}

function entryLabel(entry: OrderedLessonEntry | undefined): string {
  return entry?.id ? `exercise ${entry.id}` : "an existing exercise";
}

function quoted(text: string): string {
  return `"${text}"`;
}

function leakVictimIssue(leak: ExposureLeak, after: readonly OrderedLessonEntry[], ctx: AgentCheckContext): LessonRuleIssue {
  const pl = "answer: odpowiedź ćwiczenia samodzielnego jest już widoczna wcześniej w lekcji";
  if (leak.source.kind === "card_example") {
    return lessonIssue("lesson.leak", { pl, found: `the child already sees this answer in the card example ${clip(leak.source.text)}` });
  }
  const source = after[leak.source.index];
  const text = source ? exerciseExposureText(ctx.subject, source.draft) : "";
  const where = leak.kind === "soft" ? "an earlier independent exercise" : entryLabel(source);
  return lessonIssue("lesson.leak", { pl, found: `the child already sees this answer in ${where} ${clip(text)}` });
}

function leakSourceIssue(victim: OrderedLessonEntry, ctx: AgentCheckContext): LessonRuleIssue {
  return lessonIssue("lesson.leak_source", {
    pl: "answer: ćwiczenie ujawniłoby odpowiedź ćwiczenia samodzielnego w lekcji",
    found: `it would reveal the answer of ${entryLabel(victim)} ${clip(exerciseExposureText(ctx.subject, victim.draft))}`,
  });
}

function newlyRejected(
  after: ReadonlyMap<LessonExerciseDraft, readonly LessonRuleIssue[]>,
  before: ReadonlyMap<LessonExerciseDraft, readonly LessonRuleIssue[]>,
  candidate: LessonExerciseDraft,
): [LessonExerciseDraft, readonly LessonRuleIssue[]][] {
  return [...after].filter(([draft]) => draft !== candidate && !before.has(draft));
}

/** Odrzucenie z ofiarami: zgłoszenia ofiar, a powody z prefiksem ofiary (`formatVictimReason`). */
function victimRejection(
  code: "lesson_pool" | "lesson_extra",
  victims: readonly [LessonExerciseDraft, readonly LessonRuleIssue[]][],
  entries: readonly OrderedLessonEntry[],
): Rejection {
  const issues = victims.flatMap(([, victimIssues]) => victimIssues);
  const reasons = victims.flatMap(([draft, victimIssues]) => {
    const label = entryLabel(entries.find((item) => item.draft === draft));
    return victimIssues.map((issue) => formatVictimReason(label, issue));
  });
  return rejectionOf("lesson", code, issues, reasons);
}

type StepOutcome =
  | { readonly ok: true; readonly id: string; readonly state: LessonAgentState; readonly snapshot: LessonSnapshot }
  | { readonly ok: false; readonly rejection: Rejection };

/**
 * Reguły ćwiczenia (krok 2): kontrakt, rdzeń i przedmiot ścieżką agenta i bramka przedmiotu —
 * wszystko w jednym odrzuceniu. Gdy kontrakt odrzuca wyłącznie puste napisy w polach opcjonalnych,
 * reguły dalsze i bramka liczą się na kopii bez tych pól (spec katalogu reguł §4.2); przy innych
 * błędach kontraktu zostają same jego zgłoszenia. Kod: pierwszego ustalenia bramki, inaczej `rule_exercise`.
 */
function exerciseRejection(
  draft: LessonExerciseDraft,
  objective: AgentObjective,
  state: LessonAgentState,
  ctx: AgentCheckContext,
): Rejection | undefined {
  const issues = validateLessonExerciseIssues(draft, ctx.subject, state.topic, { agent: true });
  // Bramka zakłada poprawny kształt szkicu, więc dostaje szkic spełniający kontrakt albo żaden.
  const gateDraft = agentReanalysisDraft(draft);
  const findings = gateDraft === null
    ? []
    : (ctx.subject.agentPolicy.exerciseGate?.(gateDraft.draft, objective, { material: ctx.material }) ?? [])
      .filter((finding) => !gateDraft.stripped.includes(finding.issue.field));
  const all = [...issues, ...findings.map((finding) => finding.issue)];
  if (all.length === 0) return undefined;
  return findings.length > 0 ? reject("rule", findings[0]!.code, all).rejection : reject("rule", "rule_exercise", all).rejection;
}

/**
 * Kroki 1–4 dla jednego (już oczyszczonego) kandydata na bieżącym stanie.
 * `before` to migawka bieżącego stanu; przy sukcesie zwracana migawka `after`
 * staje się `before` następnego kandydata (każda liczona raz).
 */
function deterministicSteps(
  state: LessonAgentState,
  objectiveId: string,
  draft: LessonExerciseDraft,
  before: LessonSnapshot,
  ctx: AgentCheckContext,
  rejectedFamilies: RejectedFamilies,
): StepOutcome {
  if (draft.objectiveId !== objectiveId) throw new Error(`draft objective ${draft.objectiveId} differs from ${objectiveId}`);
  const objective = objectiveOf(state, objectiveId);
  const limits = limitsOf(ctx, objectiveId);
  const pool = poolOf(state, objectiveId);

  // 1. Limity.
  if (pool.length >= limits.maxExercises) {
    return reject("limit", "limit_full", [
      lessonIssue("lesson.limit_full", {
        pl: "exercise: zagadnienie ma już komplet ćwiczeń (limit puli)",
        found: `this objective already has ${pool.length} exercises (limit ${limits.maxExercises}); remove an exercise before submitting another`,
      }),
    ]);
  }
  if (draft.exerciseType === "lesson_listen_choice") {
    const isOwnListen = (item: LessonExerciseDraft) => item.objectiveId === objectiveId && item.exerciseType === "lesson_listen_choice";
    const listenCount = pool.filter((entry) => isOwnListen(entry.draft)).length + state.fixed.filter(isOwnListen).length;
    if (listenCount >= limits.listenAllowance) {
      return reject("limit", "limit_listen", [
        lessonIssue("lesson.limit_listen", {
          pl: "exerciseType: zagadnienie wyczerpało limit ćwiczeń słuchowych",
          found: `this objective already has ${listenCount} lesson_listen_choice exercises (allowance ${limits.listenAllowance}); submit other exercise types`,
        }),
      ]);
    }
  }

  // 2. Reguły ćwiczenia i bramka przedmiotu.
  const exerciseRejected = exerciseRejection(draft, objective, state, ctx);
  if (exerciseRejected !== undefined) return { ok: false, rejection: exerciseRejected };

  // Kandydat jako własny obiekt (ochronnie): porównania zbiorów po referencji odróżniają go od
  // reszty lekcji, nawet gdy wołający przekaże ten sam obiekt drugi raz.
  const candidate: LessonExerciseDraft = { ...draft };
  const taken = takeIds(state, 1);
  const id = taken.ids[0]!;
  const entry: AgentPoolEntry = { id, draft: candidate };
  const next = withPool(taken.state, objectiveId, [...pool, entry]);

  // 3. Reguły lekcji: kandydat odrzucony albo nowe odrzucenie innego ćwiczenia.
  const rules = lessonRules(next, ctx, rejectedFamilies);
  const ownPoolIssues = rules.poolRejected.get(candidate);
  if (ownPoolIssues !== undefined) return reject("lesson", "lesson_pool", ownPoolIssues);
  const ownExtraIssues = rules.extraRejected.get(candidate);
  if (ownExtraIssues !== undefined) return reject("lesson", "lesson_extra", ownExtraIssues);
  const extraVictims = newlyRejected(rules.extraRejected, before.extraRejected, candidate);
  if (extraVictims.length > 0) return { ok: false, rejection: victimRejection("lesson_extra", extraVictims, rules.entries) };
  const poolVictims = newlyRejected(rules.poolRejected, before.poolRejected, candidate);
  if (poolVictims.length > 0) return { ok: false, rejection: victimRejection("lesson_pool", poolVictims, rules.entries) };

  // 4. Ujawnienia (tryb generation): kandydat ofiarą albo nowa ofiara (także `fixed`).
  const leaked = lessonLeaks(next, rules.entries, ctx);
  const ownLeak = leaked.get(candidate);
  if (ownLeak !== undefined) return reject("leak", "leak_victim", [leakVictimIssue(ownLeak, rules.entries, ctx)]);
  const leakVictims = rules.entries.filter((item) => leaked.has(item.draft) && !before.leaked.has(item.draft));
  if (leakVictims.length > 0) return reject("leak", "leak_source", leakVictims.map((victim) => leakSourceIssue(victim, ctx)));

  return { ok: true, id, state: next, snapshot: { ...rules, leaked } };
}

function reject(kind: Rejection["kind"], code: string, issues: readonly LessonRuleIssue[]): { ok: false; rejection: Rejection } {
  return { ok: false, rejection: rejectionOf(kind, code, issues) };
}

/**
 * Sanityzacja i kroki 1–4 dla paczki (§3.3) na roboczej kopii stanu: kolejni
 * kandydaci są do niej dokładani, więc duplikat w paczce odpada już tutaj.
 * Słowa kluczowe idą na końcu paczki; wyniki w indeksach wejścia. Rodziny
 * pytań otwartych odrzuconych wcześniej w paczce dostają słowa kluczowe jako
 * kaskadę (`rejectedFamilies` w `validatePoolExtra`). Stan wejściowy się nie zmienia.
 */
export function precheckBatch(
  state: LessonAgentState,
  objectiveId: string,
  drafts: readonly LessonExerciseDraft[],
  ctx: AgentCheckContext,
): PrecheckEntry[] {
  const results: PrecheckEntry[] = new Array(drafts.length);
  const rejectedFamilies = new Set<string>();
  let working = state;
  let before = snapshotOf(state, ctx);
  for (const index of processingOrder(drafts.map(isKeywords))) {
    const draft = drafts[index]!;
    const rejectWith = (rejection: Rejection) => {
      const family = openFamilyOf(draft);
      if (family !== undefined) rejectedFamilies.add(family);
      results[index] = { pass: false, rejection };
    };
    const sanitized = sanitizeCandidate(draft, ctx);
    if (!sanitized.ok) {
      rejectWith(sanitized.rejection);
      continue;
    }
    const outcome = deterministicSteps(working, objectiveId, sanitized.draft, before, ctx, rejectedFamilies);
    if (!outcome.ok) {
      rejectWith(outcome.rejection);
      continue;
    }
    working = outcome.state;
    before = outcome.snapshot;
    results[index] = {
      pass: true,
      draft: sanitized.draft,
      sanitized: sanitized.sanitized,
      notes: sanitized.notes,
      quotesSnapped: sanitized.quotesSnapped,
    };
  }
  return results;
}

/** Kod i zgłoszenie sędziego podpowiedzi (§6.4); powód sędziego trafia do `found`. */
function hintFinding(verdict: AgentHintVerdict): { code: string; issue: LessonRuleIssue } | undefined {
  if (verdict.verdict === "ok") return undefined;
  const [code, label] =
    verdict.verdict === "unsupported"
      ? (["hint_unsupported", "not supported by the material"] as const)
      : verdict.verdict === "language"
        ? (["hint_language", "not correct in the language of the instructions"] as const)
        : (["hint_reveals_paraphrase", "giving away the answer or a required element in other words"] as const);
  const reason = verdict.reason.trim() === "" ? "" : `: ${clip(verdict.reason, undefined, { quote: false })}`;
  return {
    code,
    issue: lessonIssue("check.hint_judge", {
      pl: "hint: sędzia podpowiedzi odrzucił podpowiedź",
      found: `the hint judge found the hint ${label}${reason}`,
    }),
  };
}

/**
 * Zgłoszenie kontroli otwartej: pierwsza nieprzyjęta odpowiedź. Błędy wygrywają z brakami:
 * odpowiedź z błędnymi stwierdzeniami albo `incorrect` to przypadek „błędy” (sprawdź model i
 * kryteria z materiałem), a „braki” (rozluźnij kryteria) tylko `partial` bez błędów — inaczej
 * odpowiedź sprzeczna z materiałem skłaniałaby agenta do luzowania kryteriów (§13). Lista błędów
 * jest zawsze, gdy niepusta, także obok braków.
 */
function openFinding(outcome: OpenCheckOutcome): { code: string; issue: LessonRuleIssue } | undefined {
  const failed = outcome.answers.find((graded) => graded.knowledge !== "correct");
  if (failed === undefined) return undefined;
  const list = (texts: readonly string[]) => (texts.length === 0 ? "nothing" : texts.map((text) => clip(text)).join(", "));
  const wrongFirst = failed.wrong.length > 0 || failed.knowledge === "incorrect";
  const parts = [
    wrongFirst
      ? "an answer based on the material was graded as containing errors."
      : "a correct answer that follows the question was not accepted: it lacks required elements.",
    `Answer: ${clip(failed.answer)}.`,
  ];
  if (failed.missing.length > 0 || !wrongFirst) parts.push(`Missing: ${list(failed.missing)}.`);
  if (failed.wrong.length > 0 || (wrongFirst && failed.missing.length === 0)) parts.push(`Errors: ${list(failed.wrong)}.`);
  return {
    code: "open_not_accepted",
    issue: lessonIssue("check.open_answer", {
      pl: "requiredElements: ocena nie przyjęła odpowiedzi niezależnego rozwiązującego",
      found: parts.join(" "),
    }),
  };
}

/** Wariant odrzucony przez checker: pozycja w `acceptedAnswers` szkicu i tekst. */
interface RemovedVariant {
  readonly index: number;
  readonly text: string;
}

function removedVariantsOf(draft: LessonExerciseDraft, variants: CandidateChecks["variants"]): RemovedVariant[] {
  if (variants.kind !== "done") return [];
  return draft.acceptedAnswers.flatMap((text, index) => (variants.value[index] === false ? [{ index, text }] : []));
}

function variantNote(removed: RemovedVariant, draft: LessonExerciseDraft): LessonRuleIssue {
  return lessonIssue("check.variants", {
    field: `acceptedAnswers[${removed.index}]`,
    pl: "acceptedAnswers: wariant nie był równoważny odpowiedzi i został usunięty",
    found: `variant ${clip(removed.text)} removed: not equivalent to the answer ${clip(draft.answer)}; do not add it again`,
  });
}

/**
 * Kroki checkera (spec katalogu reguł §5.3) na oczyszczonym szkicu (`draft`, bez wariantów
 * `removed`): `na` przechodzi, `unavailable` przechodzi z `unchecked`, `done` może odrzucić.
 * Ślepe rozwiązanie wygrywa z sędzią podpowiedzi i kontrolą otwartą; te dwie są oceniane razem
 * (jedno odrzucenie z kodem pierwszej — podpowiedzi — i wszystkimi zgłoszeniami, żeby agent
 * poprawił wszystko naraz). Odpowiedź pasująca tylko do usuniętego wariantu: w ślepym rozwiązaniu
 * rozjazd z wyjaśnieniem, w kontroli otwartej ocena bez podstaw (`unavailable`).
 */
function checkerSteps(
  draft: LessonExerciseDraft,
  removed: readonly RemovedVariant[],
  checks: CandidateChecks,
  ctx: AgentCheckContext,
): { ok: true; unchecked: boolean } | { ok: false; rejection: Rejection } {
  const { solve, hint } = checks;
  const normalizer = ctx.subject.normalizer;
  const onlyRemoved = (answer: string): RemovedVariant | undefined =>
    [draft.answer, ...draft.acceptedAnswers].some((key) => answersEquivalent(answer, key, normalizer))
      ? undefined
      : removed.find((variant) => answersEquivalent(answer, variant.text, normalizer));

  if (solve.kind === "done" && !blindMatches(draft, solve.value, normalizer)) {
    const viaRemoved = solve.value.length === 1 ? onlyRemoved(solve.value[0]!) : undefined;
    const detail = blindMismatchFound(draft, solve.value, normalizer);
    return reject("blind", "blind_mismatch", [
      lessonIssue("check.blind_solve", {
        pl: "answer: niezależny rozwiązujący odpowiedział inaczej niż klucz",
        found: viaRemoved === undefined
          ? detail
          : `${detail}; it matched only the removed variant ${clip(viaRemoved.text)}, which the variant check judged not ` +
            "equivalent: do not add it again; make the stimulus point to the key only",
      }),
    ]);
  }
  // Ocena przyjęta tylko dzięki usuniętemu wariantowi nie jest dowodem: kontrola bez wyniku.
  const open: CandidateChecks["open"] =
    checks.open.kind === "done" &&
    removed.length > 0 &&
    checks.open.value.answers.some((graded) => graded.knowledge === "correct" && onlyRemoved(graded.answer) !== undefined)
      ? { kind: "unavailable" }
      : checks.open;
  const findings = [hint.kind === "done" ? hintFinding(hint.value) : undefined, open.kind === "done" ? openFinding(open.value) : undefined];
  const present = findings.filter((finding) => finding !== undefined);
  if (present.length > 0) {
    return reject(findings[0] !== undefined ? "hint" : "open", present[0]!.code, present.map((finding) => finding.issue));
  }
  const unavailable = [solve, checks.variants, hint, open].some((result) => result.kind === "unavailable");
  return { ok: true, unchecked: unavailable };
}

/**
 * Przyjmuje kandydatów `pass` po kolei na bieżącym stanie, potem kroki checkera z `checks` (ten
 * sam indeks co `prechecked`). Kolejność jak w `precheckBatch`; wyniki w indeksach wejścia.
 *
 * Bez usuniętych wariantów kroki 1–4 idą przed checkerem (między `precheck` a `admit` inne
 * zagadnienie mogło dodać ćwiczenie). Z wariantami odrzuconymi przez checker (spec katalogu reguł
 * §5.3): oczyszczony szkic bez nich, ślepe rozwiązanie, sędzia i kontrola otwarta na oczyszczonym
 * szkicu, potem kroki 1–4 powtórzone na nim (odrzucenie z kodem kroku), a do puli trafia oczyszczony
 * szkic z notą `check.variants`.
 */
export function admitBatch(
  state: LessonAgentState,
  objectiveId: string,
  prechecked: readonly PrecheckEntry[],
  checks: readonly CandidateChecks[],
  ctx: AgentCheckContext,
): { state: LessonAgentState; results: AdmitEntry[] } {
  if (checks.length !== prechecked.length) {
    throw new Error(`checks length ${checks.length} differs from prechecked length ${prechecked.length}`);
  }
  const results: AdmitEntry[] = new Array(prechecked.length);
  const order = processingOrder(prechecked.map((entry) => entry.pass && isKeywords(entry.draft)));
  // Rodziny pytań otwartych odrzuconych tutaj; odrzucone w `precheckBatch` odrzuciły tam już swoje słowa kluczowe.
  const rejectedFamilies = new Set<string>();
  let current = state;
  let before = snapshotOf(state, ctx);
  for (const index of order) {
    const entry = prechecked[index]!;
    if (!entry.pass) {
      results[index] = { rejected: entry.rejection };
      continue;
    }
    const check = checks[index]!;
    const removed = removedVariantsOf(entry.draft, check.variants);
    const draft = removed.length === 0
      ? entry.draft
      : { ...entry.draft, acceptedAnswers: entry.draft.acceptedAnswers.filter((_variant, position) => !removed.some((item) => item.index === position)) };
    const rejectWith = (rejection: Rejection) => {
      const family = openFamilyOf(draft);
      if (family !== undefined) rejectedFamilies.add(family);
      results[index] = { rejected: rejection };
    };
    let outcome = removed.length === 0 ? deterministicSteps(current, objectiveId, draft, before, ctx, rejectedFamilies) : undefined;
    if (outcome !== undefined && !outcome.ok) {
      rejectWith(outcome.rejection);
      continue;
    }
    const checked = checkerSteps(draft, removed, check, ctx);
    if (!checked.ok) {
      rejectWith(checked.rejection);
      continue;
    }
    outcome ??= deterministicSteps(current, objectiveId, draft, before, ctx, rejectedFamilies);
    if (!outcome.ok) {
      rejectWith(outcome.rejection);
      continue;
    }
    current = outcome.state;
    before = outcome.snapshot;
    results[index] = {
      accepted: outcome.id,
      sanitized: entry.sanitized,
      unchecked: checked.unchecked,
      notes: [...entry.notes, ...removed.map((variant) => variantNote(variant, entry.draft))],
      removedVariants: removed.map((variant) => variant.text),
      quotesSnapped: entry.quotesSnapped,
    };
  }
  return { state: current, results };
}

/** Najwyżej tyle przykładów kart na zagadnienie. */
export const MAX_CARD_EXAMPLES = 3;

/**
 * Przykłady kart zagadnienia od modelu (§3.4): linie przycięte, niepuste,
 * najwyżej `MAX_TEXT_LENGTH` znaków (jak `executeLessonGeneration`), bez
 * powtórzeń (identyczna linia po przycięciu liczy się raz). Linia odpada, gdy ujawnia (twardo) rozwiązanie ćwiczenia lekcji — `fixed` albo
 * puli — dotąd nieujawnionego. Przyjęte (najwyżej 3) zastępują wcześniejsze
 * przykłady zagadnienia; gdy nie przeszła żadna, stan się nie zmienia.
 */
export function submitExamples(
  state: LessonAgentState,
  objectiveId: string,
  lines: unknown,
  ctx: AgentCheckContext,
): { state: LessonAgentState; accepted: number; errors: string[] } {
  if (!Array.isArray(lines)) return { state, accepted: 0, errors: ["examples must be an array of strings"] };
  objectiveOf(state, objectiveId);
  const errors: string[] = [];
  const kept: string[] = [];
  const entries = orderedEntries(state);
  const exercises = entries.map((entry) => entry.draft);
  const leakedBefore = lessonLeaks(state, entries, ctx);
  lines.forEach((line: unknown, index) => {
    const label = `example ${index + 1}`;
    if (typeof line !== "string") {
      errors.push(`${label}: must be a string`);
      return;
    }
    const text = line.trim();
    if (text.length === 0) {
      errors.push(`${label}: is empty`);
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      errors.push(`${label}: is longer than ${MAX_TEXT_LENGTH} characters`);
      return;
    }
    // Powtórzona linia nie zajmuje kolejnego z trzech miejsc.
    if (kept.includes(text)) {
      errors.push(`${label}: duplicates an earlier example; this line was ignored`);
      return;
    }
    // Ofiary samej linii: z jedynym przykładem źródłem twardym jest właśnie ona.
    const victims = findExposureLeaks({
      exercises,
      examples: { [objectiveId]: [text] },
      objectiveOrder: state.objectives.map((objective) => objective.id),
      subject: ctx.subject,
      mode: ADMISSION_LEAK_MODE,
    })
      .filter((leak) => leak.source.kind === "card_example" && !leakedBefore.has(entries[leak.index]!.draft))
      .map((leak) => entries[leak.index]!);
    if (victims.length > 0) {
      errors.push(...victims.map((victim) => `${label} ${quoted(text)}: ${formatRuleReason(leakSourceIssue(victim, ctx))}`));
      return;
    }
    if (kept.length >= MAX_CARD_EXAMPLES) {
      errors.push(`${label}: an objective has at most ${MAX_CARD_EXAMPLES} card examples; this line was ignored`);
      return;
    }
    kept.push(text);
  });
  if (kept.length === 0) return { state, accepted: 0, errors };
  return { state: withExamples(state, objectiveId, kept), accepted: kept.length, errors };
}

/**
 * Usuwa ćwiczenie z puli tego zagadnienia razem z osieroconymi słowami
 * kluczowymi jego rodziny. Nieznany identyfikator, wpis innego zagadnienia
 * albo ćwiczenie `fixed` → `removed: []` i stan bez zmian.
 */
export function removeExercise(
  state: LessonAgentState,
  objectiveId: string,
  id: string,
  ctx: AgentCheckContext,
): { state: LessonAgentState; removed: string[] } {
  void ctx;
  const pool = poolOf(state, objectiveId);
  if (!pool.some((entry) => entry.id === id)) return { state, removed: [] };
  const remaining = pool.filter((entry) => entry.id !== id);
  const kept = new Set(withoutOrphanKeywords(state.fixed, remaining.map((entry) => entry.draft)).kept);
  const survivors = remaining.filter((entry) => kept.has(entry.draft));
  const removed = pool.filter((entry) => !survivors.includes(entry)).map((entry) => entry.id);
  return { state: withPool(state, objectiveId, survivors), removed };
}
