import { exerciseExposureText } from "../exposure-key";
import { findExposureLeaks, type ExposureLeak } from "../exposure-leaks";
import { withoutOrphanKeywords } from "../keyword-families";
import { MAX_TEXT_LENGTH, validateLessonExercise, validatePool } from "../pool-validation";
import type { AgentObjective, LessonExerciseDraft, SubjectModule } from "../types";
import { blindMatches } from "./solver";
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
 * wraca do modelu z nazwanym kodem reguły. Czyste funkcje nad jawnym stanem.
 */

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

export interface Rejection {
  readonly kind: "shape" | "rule" | "lesson" | "leak" | "blind" | "variant" | "hint" | "open" | "limit";
  /** Stały kod reguły, bez treści (logi, trwały zapis). */
  readonly code: string;
  /** Tekst dla modelu (angielski), może zawierać treść. */
  readonly reasons: readonly string[];
}

export type PrecheckEntry =
  | { readonly pass: true; readonly draft: LessonExerciseDraft; readonly sanitized: readonly string[] }
  | { readonly pass: false; readonly rejection: Rejection };

export type AdmitEntry =
  | { readonly accepted: string; readonly sanitized: readonly string[]; readonly unchecked: boolean }
  | { readonly rejected: Rejection };

/** Odrzucenia reguł lekcji i ujawnienia — po referencji szkicu (wadliwe `fixed` nie blokuje kandydatów). */
export interface LessonSnapshot {
  readonly entries: readonly OrderedLessonEntry[];
  readonly poolRejected: ReadonlyMap<LessonExerciseDraft, readonly string[]>;
  readonly extraRejected: ReadonlyMap<LessonExerciseDraft, readonly string[]>;
  readonly leaked: ReadonlyMap<LessonExerciseDraft, ExposureLeak>;
}

type LessonRules = Omit<LessonSnapshot, "leaked">;

function lessonRules(state: LessonAgentState, ctx: AgentCheckContext): LessonRules {
  const entries = orderedEntries(state);
  const lesson = entries.map((entry) => entry.draft);
  const pool = validatePool(lesson, ctx.subject, state.topic, { existingExercises: [] });
  const poolRejected = new Map(pool.rejected.map((item) => [item.exercise, item.errors] as const));
  const extraRejected = new Map<LessonExerciseDraft, readonly string[]>();
  for (const [index, errors] of ctx.subject.validatePoolExtra?.(lesson, { material: ctx.material }) ?? []) {
    const draft = lesson[index];
    if (draft !== undefined && errors.length > 0) extraRejected.set(draft, errors);
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
): { ok: true; draft: LessonExerciseDraft; sanitized: readonly string[] } | { ok: false; rejection: Rejection } {
  const sanitizedResult = ctx.subject.agentPolicy.sanitize?.(draft) ?? { draft, removed: [] };
  const refine = ctx.subject.refineGeneratedPool;
  if (refine === undefined) return { ok: true, draft: sanitizedResult.draft, sanitized: sanitizedResult.removed };
  const refined = refine([sanitizedResult.draft], { material: ctx.material });
  const kept = refined.kept[0];
  if (refined.rejected.length > 0 || kept === undefined) {
    const reasons = refined.rejected.map((item) => item.reason);
    return { ok: false, rejection: { kind: "rule", code: "refine", reasons: reasons.length > 0 ? reasons : ["the subject rules rejected this exercise"] } };
  }
  return { ok: true, draft: kept, sanitized: sanitizedResult.removed };
}

function entryLabel(entry: OrderedLessonEntry | undefined): string {
  return entry?.id ? `exercise ${entry.id}` : "an existing exercise";
}

function quoted(text: string): string {
  return `"${text}"`;
}

function leakVictimReason(leak: ExposureLeak, after: readonly OrderedLessonEntry[], ctx: AgentCheckContext): string {
  const template = ctx.subject.agentPolicy.rejectionTexts.leakVictim;
  if (leak.source.kind === "card_example") {
    return `${template} The child already sees this answer in the card example ${quoted(leak.source.text)}.`;
  }
  const source = after[leak.source.index];
  const text = source ? exerciseExposureText(ctx.subject, source.draft) : "";
  const where = leak.kind === "soft" ? "an earlier independent exercise" : entryLabel(source);
  return `${template} The child already sees this answer in ${where} ${quoted(text)}.`;
}

function leakSourceReason(victim: OrderedLessonEntry, ctx: AgentCheckContext): string {
  const template = ctx.subject.agentPolicy.rejectionTexts.leakSource;
  return `${template} It would reveal the answer of ${entryLabel(victim)} ${quoted(exerciseExposureText(ctx.subject, victim.draft))}.`;
}

function newlyRejected(
  after: ReadonlyMap<LessonExerciseDraft, readonly string[]>,
  before: ReadonlyMap<LessonExerciseDraft, readonly string[]>,
  candidate: LessonExerciseDraft,
): [LessonExerciseDraft, readonly string[]][] {
  return [...after].filter(([draft]) => draft !== candidate && !before.has(draft));
}

function victimReasons(
  victims: readonly [LessonExerciseDraft, readonly string[]][],
  entries: readonly OrderedLessonEntry[],
): string[] {
  return victims.map(([draft, errors]) => {
    const entry = entries.find((item) => item.draft === draft);
    return `adding this exercise would make the lesson reject ${entryLabel(entry)}: ${errors.join("; ")}`;
  });
}

type StepOutcome =
  | { readonly ok: true; readonly id: string; readonly state: LessonAgentState; readonly snapshot: LessonSnapshot }
  | { readonly ok: false; readonly rejection: Rejection };

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
): StepOutcome {
  if (draft.objectiveId !== objectiveId) throw new Error(`draft objective ${draft.objectiveId} differs from ${objectiveId}`);
  const objective = objectiveOf(state, objectiveId);
  const limits = limitsOf(ctx, objectiveId);
  const pool = poolOf(state, objectiveId);

  // 1. Limity.
  if (pool.length >= limits.maxExercises) {
    return reject("limit", "limit_full", [
      `this objective already has ${pool.length} exercises (limit ${limits.maxExercises}); remove an exercise before submitting another`,
    ]);
  }
  if (draft.exerciseType === "lesson_listen_choice") {
    const isOwnListen = (item: LessonExerciseDraft) => item.objectiveId === objectiveId && item.exerciseType === "lesson_listen_choice";
    const listenCount = pool.filter((entry) => isOwnListen(entry.draft)).length + state.fixed.filter(isOwnListen).length;
    if (listenCount >= limits.listenAllowance) {
      return reject("limit", "limit_listen", [
        `this objective already has ${listenCount} lesson_listen_choice exercises (allowance ${limits.listenAllowance}); submit other exercise types`,
      ]);
    }
  }

  // 2. Reguły ćwiczenia.
  const exerciseErrors = validateLessonExercise(draft, ctx.subject, state.topic);
  if (exerciseErrors.length > 0) return reject("rule", "rule_exercise", exerciseErrors);
  const findings = ctx.subject.agentPolicy.exerciseGate?.(draft, objective, { material: ctx.material }) ?? [];
  if (findings.length > 0) return reject("rule", findings[0]!.code, findings.map((finding) => finding.reason));

  // Kandydat jako własny obiekt (ochronnie): porównania zbiorów po referencji odróżniają go od
  // reszty lekcji, nawet gdy wołający przekaże ten sam obiekt drugi raz.
  const candidate: LessonExerciseDraft = { ...draft };
  const taken = takeIds(state, 1);
  const id = taken.ids[0]!;
  const entry: AgentPoolEntry = { id, draft: candidate };
  const next = withPool(taken.state, objectiveId, [...pool, entry]);

  // 3. Reguły lekcji: kandydat odrzucony albo nowe odrzucenie innego ćwiczenia.
  const rules = lessonRules(next, ctx);
  const ownPoolErrors = rules.poolRejected.get(candidate);
  if (ownPoolErrors !== undefined) return reject("lesson", "lesson_pool", ownPoolErrors);
  const ownExtraErrors = rules.extraRejected.get(candidate);
  if (ownExtraErrors !== undefined) return reject("lesson", "lesson_extra", ownExtraErrors);
  const extraVictims = newlyRejected(rules.extraRejected, before.extraRejected, candidate);
  if (extraVictims.length > 0) return reject("lesson", "lesson_extra", victimReasons(extraVictims, rules.entries));
  const poolVictims = newlyRejected(rules.poolRejected, before.poolRejected, candidate);
  if (poolVictims.length > 0) return reject("lesson", "lesson_pool", victimReasons(poolVictims, rules.entries));

  // 4. Ujawnienia (tryb generation): kandydat ofiarą albo nowa ofiara (także `fixed`).
  const leaked = lessonLeaks(next, rules.entries, ctx);
  const ownLeak = leaked.get(candidate);
  if (ownLeak !== undefined) return reject("leak", "leak_victim", [leakVictimReason(ownLeak, rules.entries, ctx)]);
  const leakVictims = rules.entries.filter((item) => leaked.has(item.draft) && !before.leaked.has(item.draft));
  if (leakVictims.length > 0) return reject("leak", "leak_source", leakVictims.map((victim) => leakSourceReason(victim, ctx)));

  return { ok: true, id, state: next, snapshot: { ...rules, leaked } };
}

function reject(kind: Rejection["kind"], code: string, reasons: readonly string[]): { ok: false; rejection: Rejection } {
  return { ok: false, rejection: { kind, code, reasons } };
}

/**
 * Sanityzacja i kroki 1–4 dla paczki (§3.3) na roboczej kopii stanu: kolejni
 * kandydaci są do niej dokładani, więc duplikat w paczce odpada już tutaj.
 * Słowa kluczowe idą na końcu paczki; wyniki w indeksach wejścia. Stan
 * wejściowy się nie zmienia.
 */
export function precheckBatch(
  state: LessonAgentState,
  objectiveId: string,
  drafts: readonly LessonExerciseDraft[],
  ctx: AgentCheckContext,
): PrecheckEntry[] {
  const results: PrecheckEntry[] = new Array(drafts.length);
  let working = state;
  let before = snapshotOf(state, ctx);
  for (const index of processingOrder(drafts.map(isKeywords))) {
    const sanitized = sanitizeCandidate(drafts[index]!, ctx);
    if (!sanitized.ok) {
      results[index] = { pass: false, rejection: sanitized.rejection };
      continue;
    }
    const outcome = deterministicSteps(working, objectiveId, sanitized.draft, before, ctx);
    if (!outcome.ok) {
      results[index] = { pass: false, rejection: outcome.rejection };
      continue;
    }
    working = outcome.state;
    before = outcome.snapshot;
    results[index] = { pass: true, draft: sanitized.draft, sanitized: sanitized.sanitized };
  }
  return results;
}

function quotedList(texts: readonly string[]): string {
  return texts.length === 0 ? "nothing" : texts.map(quoted).join(", ");
}

/** Kod i powód odrzucenia przez sędziego podpowiedzi (§6.4); brak szablonu przedmiotu daje sam powód. */
function hintFinding(verdict: AgentHintVerdict, ctx: AgentCheckContext): { code: string; reason: string } | undefined {
  if (verdict.verdict === "ok") return undefined;
  const texts = ctx.subject.agentPolicy.rejectionTexts;
  const [code, template] =
    verdict.verdict === "unsupported"
      ? (["hint_unsupported", texts.hintUnsupported] as const)
      : verdict.verdict === "language"
        ? (["hint_language", texts.hintLanguage] as const)
        : (["hint_reveals_paraphrase", texts.hintReveals] as const);
  return { code, reason: [template, verdict.reason].filter((part) => part !== undefined && part !== "").join(" ") };
}

/**
 * Powód odrzucenia kontroli otwartej: pierwsza nieprzyjęta odpowiedź. Błędy wygrywają z brakami:
 * odpowiedź z błędnymi stwierdzeniami albo `incorrect` dostaje `openWrong` (sprawdź model i kryteria
 * z materiałem), a `openMissing` (rozluźnij kryteria) tylko `partial` bez błędów — inaczej odpowiedź
 * sprzeczna z materiałem skłaniałaby agenta do luzowania kryteriów (§13). Lista błędów jest zawsze,
 * gdy niepusta, także obok braków.
 */
function openFinding(outcome: OpenCheckOutcome, ctx: AgentCheckContext): { code: string; reason: string } | undefined {
  const failed = outcome.answers.find((graded) => graded.knowledge !== "correct");
  if (failed === undefined) return undefined;
  const texts = ctx.subject.agentPolicy.rejectionTexts;
  const wrongFirst = failed.wrong.length > 0 || failed.knowledge === "incorrect";
  const parts = [wrongFirst ? (texts.openWrong ?? "") : (texts.openMissing ?? ""), `Answer: ${quoted(failed.answer)}.`];
  if (failed.missing.length > 0 || !wrongFirst) parts.push(`Missing: ${quotedList(failed.missing)}`);
  if (failed.wrong.length > 0 || (wrongFirst && failed.missing.length === 0)) parts.push(`Errors: ${quotedList(failed.wrong)}`);
  return { code: "open_not_accepted", reason: parts.join(" ").trim() };
}

/**
 * Kroki 5–7 (wyniki checkera dla oczyszczonego szkicu): `na` przechodzi,
 * `unavailable` przechodzi z `unchecked`, `done` może odrzucić. Ślepe
 * rozwiązanie wygrywa z wariantami, a oba z sędzią podpowiedzi i kontrolą
 * otwartą; te dwie są oceniane razem (jedno odrzucenie z kodem pierwszej
 * — podpowiedzi — i wszystkimi powodami, żeby agent poprawił wszystko naraz).
 */
function checkerSteps(
  draft: LessonExerciseDraft,
  checks: CandidateChecks,
  ctx: AgentCheckContext,
): { ok: true; unchecked: boolean } | { ok: false; rejection: Rejection } {
  const { solve, variants, hint, open } = checks;
  if (solve.kind === "done" && !blindMatches(draft, solve.value, ctx.subject.normalizer)) {
    return reject("blind", "blind_mismatch", [
      `an independent solver who saw only the child's view answered ${quotedList(solve.value)}, which does not match the answer key; make the exercise unambiguous or fix the key`,
    ]);
  }
  if (variants.kind === "done") {
    const rejectedVariants = draft.acceptedAnswers.filter((_variant, index) => variants.value[index] === false);
    if (rejectedVariants.length > 0) {
      return reject(
        "variant",
        "variant_rejected",
        rejectedVariants.map((variant) => `the accepted variant ${quoted(variant)} is not equivalent to the answer ${quoted(draft.answer)}; remove or fix it`),
      );
    }
  }
  const hintIssue = hint.kind === "done" ? hintFinding(hint.value, ctx) : undefined;
  const openIssue = open.kind === "done" ? openFinding(open.value, ctx) : undefined;
  const issues = [hintIssue, openIssue].filter((issue) => issue !== undefined);
  if (issues.length > 0) {
    return reject(hintIssue !== undefined ? "hint" : "open", issues[0]!.code, issues.map((issue) => issue.reason));
  }
  const unavailable = [solve, variants, hint, open].some((result) => result.kind === "unavailable");
  return { ok: true, unchecked: unavailable };
}

/**
 * Przyjmuje kandydatów `pass` po kolei na bieżącym stanie, powtarzając kroki
 * 1–4 (między `precheck` a `admit` inne zagadnienie mogło dodać ćwiczenie),
 * potem kroki 5–6 z `checks` (ten sam indeks co `prechecked`). Kolejność jak
 * w `precheckBatch`; wyniki w indeksach wejścia.
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
  let current = state;
  let before = snapshotOf(state, ctx);
  for (const index of order) {
    const entry = prechecked[index]!;
    if (!entry.pass) {
      results[index] = { rejected: entry.rejection };
      continue;
    }
    const outcome = deterministicSteps(current, objectiveId, entry.draft, before, ctx);
    if (!outcome.ok) {
      results[index] = { rejected: outcome.rejection };
      continue;
    }
    const checked = checkerSteps(entry.draft, checks[index]!, ctx);
    if (!checked.ok) {
      results[index] = { rejected: checked.rejection };
      continue;
    }
    current = outcome.state;
    before = outcome.snapshot;
    results[index] = { accepted: outcome.id, sanitized: entry.sanitized, unchecked: checked.unchecked };
  }
  return { state: current, results };
}

/** Najwyżej tyle przykładów kart na zagadnienie. */
const MAX_EXAMPLES = 3;

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
      errors.push(...victims.map((victim) => `${label} ${quoted(text)}: ${leakSourceReason(victim, ctx)}`));
      return;
    }
    if (kept.length >= MAX_EXAMPLES) {
      errors.push(`${label}: an objective has at most ${MAX_EXAMPLES} card examples; this line was ignored`);
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
