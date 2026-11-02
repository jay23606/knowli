import { createHash } from "node:crypto";
import { z } from "zod";
import type { GenerationDeps } from "../../../config";
import { lessonExerciseIdentity, lessonIdentityOptionsOf } from "../../../domain/lessons/exercise-identity";
import { exerciseExposureText } from "../../../domain/lessons/exposure-key";
import { findExposureLeaks, type ExposureLeak } from "../../../domain/lessons/exposure-leaks";
import { findingText, NOTE_ONLY_REVIEW_CATEGORIES, REVIEW_CATEGORIES, reviewRoleFor, type ReviewCategory } from "../../../domain/lessons/review-criteria";
import { exerciseSnippet, statusFromObjectives, type LessonReviewReport, type ReviewReason } from "../../../domain/lessons/review-report";
import { decideObjectiveReview, type ParsedVerdict } from "../../../domain/lessons/review-verdicts";
import type { LessonExerciseDraft, LessonTopic, SubjectModule } from "../../../domain/lessons/types";
import type { LessonReviewInput } from "../../../ports/ai";
import { GenerationProviderError } from "../../../ports/generation-error";
import { buildLessonPayload } from "./lesson-drafts";
import { LessonGenerationCancelledError, withLessonGenerationControl } from "./lesson-generation-control";
import { acceptFreshLessonPool } from "./lesson-pool-acceptance";

/**
 * Faza przeglądu świeżych ćwiczeń lekcji przez krytyka (spec etapu przeglądu §4–§5.1):
 * jedno wywołanie na zagadnienie, walidacja poprawek tymi samymi regułami co pula,
 * decyzje w domenie (`decideObjectiveReview`). Krytyk ocenia wyłącznie świeże ćwiczenia
 * przebiegu; istniejące ćwiczenia szkicu są kontekstem. Brak, awaria lub limit czasu
 * krytyka nigdy nie kończy przebiegu porażką — zagadnienie zostaje `unreviewed`.
 * Reguła twarda ujawnień działa później, u wywołującego (także bez krytyka).
 */

/** Wpis raportu dla ćwiczenia po przeglądzie (klucz w `ReviewPhaseResult.meta`). */
export interface ReviewMeta {
  readonly changed?: { category: ReviewCategory; reasonPl: string; beforePl: string; addedVariants: string[] };
  readonly note?: { category: ReviewCategory; reasonPl: string; fixRejected: boolean };
}

export interface ReviewPhaseResult {
  /** Świeże po werdyktach (przed regułą twardą), w kolejności wejścia. */
  readonly exercises: LessonExerciseDraft[];
  /** Klucz = obiekt ćwiczenia (tożsamość przeżywa kolejne filtry). */
  readonly meta: ReadonlyMap<LessonExerciseDraft, ReviewMeta>;
  readonly objectives: LessonReviewReport["objectives"];
  readonly dropped: LessonReviewReport["dropped"];
  readonly droppedCount: number;
}

export interface ReviewPhaseContext {
  readonly reviewer: GenerationDeps["reviewer"];
  readonly subject: SubjectModule;
  readonly topic: LessonTopic;
  /** Materiał przebiegu (walidacja poprawek; MATERIAL krytyka dla przedmiotów z materiału). */
  readonly material: string;
  readonly fresh: readonly LessonExerciseDraft[];
  readonly existing: readonly LessonExerciseDraft[];
  /** Końcowe przykłady kart (po filtrze nowych przykładów). */
  readonly examples: Readonly<Record<string, readonly string[]>>;
  readonly objectiveOrder: readonly string[];
  readonly objectiveContext: (objectiveId: string) => { title: string; kind?: "words" | "frame"; card: string };
  /** Zakres rodzin przebiegu (informacyjnie; walidacja poprawki nie nadaje go ponownie). */
  readonly familyScope: string | null;
  /** Wspólny licznik wywołań przebiegu (partia główna i runda pod etap). */
  readonly callsLeft: { value: number };
  /** Termin wywołań krytyka (= termin fazy − rezerwa finalizacji). */
  readonly reviewDeadlineAtMs: number;
  readonly cancelPollMs: number;
  readonly assertCurrent: () => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly runId: string;
}

/** Kanoniczny JSON: klucze sortowane rekurencyjnie, pola `undefined` pomijane (jak w jsonb). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonical(item)));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/**
 * Odcisk payloadu ćwiczenia: sha256 kanonicznego JSON. Ten sam dla payloadu z
 * `buildLessonPayload` i dla payloadu odczytanego z bazy (jsonb zmienia kolejność kluczy).
 */
export function exerciseFingerprint(payload: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}

const REASON_PATTERN = /^[^\r\n]{1,120}$/u;

/** Surowy werdykt adaptera/fake'a; `exercise` tylko przy `fix` (null = poprawka nieczytelna). */
const RawVerdictSchema = z.object({
  n: z.number().int(),
  verdict: z.enum(["ok", "note", "fix", "drop"]),
  category: z.enum(REVIEW_CATEGORIES).nullish(),
  reasonPl: z.string().nullish(),
  exercise: z.record(z.string(), z.unknown()).nullish(),
});

type ReadVerdict =
  | { readonly n: number; readonly verdict: "ok" }
  | { readonly n: number; readonly verdict: "note" | "drop"; readonly category: ReviewCategory; readonly reasonPl: string }
  | { readonly n: number; readonly verdict: "fix"; readonly category: ReviewCategory; readonly reasonPl: string; readonly exercise: Record<string, unknown> | null };

/** Werdykt czytelny albo `undefined` (nieczytelny: zły kształt, kategoria, powód). */
function readVerdict(raw: unknown): ReadVerdict | undefined {
  const parsed = RawVerdictSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { n, verdict, category, reasonPl, exercise } = parsed.data;
  if (verdict === "ok") return { n, verdict };
  if (!category || typeof reasonPl !== "string" || !REASON_PATTERN.test(reasonPl) || reasonPl.trim() === "") return undefined;
  if (verdict === "fix") return { n, verdict, category, reasonPl, exercise: exercise ?? null };
  return { n, verdict, category, reasonPl };
}

/** Ćwiczenie w kształcie generatora dla krytyka: payload bez locale, zagadnienie pod aliasem. */
function reviewShape(draft: LessonExerciseDraft, subject: SubjectModule, aliasOf: (objectiveId: string) => string): Record<string, unknown> {
  const { answerLocale: _answerLocale, promptLocale: _promptLocale, ...shape } = buildLessonPayload(draft, subject);
  return { ...shape, objectiveId: aliasOf(draft.objectiveId) };
}

/**
 * Aliasy zagadnień dla krytyka: identyfikatory zagadnień z materiału zawierają identyfikator
 * zestawu (`<przedmiot>.d<deckId>.<slug>`), więc krytyk widzi tylko ostatni człon (unikalny
 * w lekcji, inaczej `objective-<n>`). Poprawka wraca z aliasem i jest mapowana z powrotem.
 */
function objectiveAliases(objectiveIds: readonly string[]): { aliasOf: (id: string) => string; idOf: (alias: unknown) => unknown } {
  const slugs = objectiveIds.map((id) => id.split(".").at(-1) ?? id);
  const unique = new Set(slugs).size === slugs.length && slugs.every((slug) => slug.length > 0);
  const aliases = new Map(objectiveIds.map((id, index) => [id, unique ? slugs[index]! : `objective-${index + 1}`] as const));
  const ids = new Map([...aliases].map(([id, alias]) => [alias, id] as const));
  return {
    aliasOf: (id) => aliases.get(id) ?? id,
    idOf: (alias) => (typeof alias === "string" ? (ids.get(alias) ?? alias) : alias),
  };
}

function fingerprintOf(draft: LessonExerciseDraft, subject: SubjectModule): string {
  return exerciseFingerprint(buildLessonPayload(draft, subject));
}

/** MATERIAL krytyka: materiał rodzica (przedmiot z materiału) albo opis tematu z katalogu. */
function reviewMaterial(ctx: ReviewPhaseContext): string {
  if (ctx.subject.buildDynamicTopic !== undefined) return ctx.material;
  const descriptions = ctx.objectiveOrder.flatMap((objectiveId) => {
    const objective = ctx.topic.objectives.find((candidate) => candidate.id === objectiveId);
    return objective === undefined ? [] : [objective.descriptionEn];
  });
  return [ctx.topic.titlePl, ...descriptions].join("\n");
}

/** Zagadnienia lekcji (kolejność lekcji, potem spoza niej) — klucze bloku przykładów i aliasów. */
function lessonObjectiveIds(ctx: ReviewPhaseContext): string[] {
  const extra = [...Object.keys(ctx.examples), ...ctx.fresh.map((exercise) => exercise.objectiveId), ...ctx.existing.map((exercise) => exercise.objectiveId)];
  return [...new Set([...ctx.objectiveOrder, ...extra])];
}

/** Przykłady wszystkich kart w kolejności zagadnień lekcji — jeden obiekt na lekcję (stały prefiks cache). */
function lessonCardExamples(ctx: ReviewPhaseContext, aliasOf: (id: string) => string): Record<string, string[]> {
  const ids = [...ctx.objectiveOrder, ...Object.keys(ctx.examples).filter((id) => !ctx.objectiveOrder.includes(id))];
  return Object.fromEntries(ids.map((id) => [aliasOf(id), [...(ctx.examples[id] ?? [])]]));
}

/** Zagadnienia ze świeżymi ćwiczeniami: najpierw kolejność lekcji, potem pozostałe. */
function freshObjectiveIds(ctx: ReviewPhaseContext): string[] {
  const present = new Set(ctx.fresh.map((exercise) => exercise.objectiveId));
  const ordered = ctx.objectiveOrder.filter((id) => present.has(id));
  return [...ordered, ...[...present].filter((id) => !ordered.includes(id))];
}

function hardVictims(leaks: readonly ExposureLeak[]): Set<number> {
  return new Set(leaks.filter((leak) => leak.kind === "hard").map((leak) => leak.index));
}

interface ObjectiveBatch {
  readonly objectiveId: string;
  /** Indeksy świeżych ćwiczeń zagadnienia w `ctx.fresh` (kolejność = n − 1). */
  readonly freshIndexes: readonly number[];
  readonly drafts: readonly LessonExerciseDraft[];
}

type ObjectiveOutcome =
  | { readonly kind: "unreviewed"; readonly reason: ReviewReason; readonly durationMs?: number }
  | { readonly kind: "reviewed"; readonly verdicts: readonly unknown[]; readonly durationMs?: number };

/**
 * Walidacja poprawki (spec §5.1): ten sam typ, zagadnienie i rodzina; cała partia zagadnienia
 * (`drafts` — bieżący stan, z poprawkami przyjętymi wcześniej) z poprawką w miejscu oryginału
 * przechodzi `acceptFreshLessonPool`, poprawka jest przyjęta, a żadne inne ćwiczenie partii nie
 * odpada z jej powodu (porównanie z partią bez tej poprawki); poprawka nie jest ofiarą ani
 * źródłem twardego ujawnienia i nie tworzy nowej ofiary twardej wśród ćwiczeń szkicu,
 * świeżych innych zagadnień (`others`, po ich przeglądzie) i partii. Zwraca ćwiczenie po
 * sanityzacji puli albo `undefined`.
 */
function validatedFix(
  ctx: ReviewPhaseContext,
  drafts: readonly LessonExerciseDraft[],
  others: readonly LessonExerciseDraft[],
  index: number,
  rawFix: Record<string, unknown>,
  poolCheck: (raw: readonly unknown[]) => LessonExerciseDraft[],
): LessonExerciseDraft | undefined {
  const { subject } = ctx;
  const original = drafts[index]!;
  const sameIdentity = (candidate: { exerciseType?: unknown; objectiveId?: unknown; familyId?: unknown }) =>
    candidate.exerciseType === original.exerciseType &&
    candidate.objectiveId === original.objectiveId &&
    (candidate.familyId ?? undefined) === (original.familyId ?? undefined);
  if (!sameIdentity(rawFix)) return undefined;

  // Inne ćwiczenia partii przyjęte bez poprawki muszą zostać przyjęte także z nią.
  const kept = poolCheck(drafts).map((draft) => fingerprintOf(draft, subject));
  const originalAt = kept.indexOf(fingerprintOf(original, subject));
  if (originalAt !== -1) kept.splice(originalAt, 1);
  const remaining = poolCheck(drafts.map((draft, position) => (position === index ? rawFix : draft)));
  for (const fingerprint of kept) {
    const at = remaining.findIndex((draft) => fingerprintOf(draft, subject) === fingerprint);
    if (at === -1) return undefined;
    remaining.splice(at, 1);
  }
  if (remaining.length !== 1 || !sameIdentity(remaining[0]!)) return undefined;
  const candidate = remaining[0]!;

  // Ujawnienia: poprawka nie może być ofiarą ani tworzyć nowej ofiary twardej.
  const leakInput = (batch: readonly LessonExerciseDraft[]) => ({
    exercises: [...ctx.existing, ...others, ...batch],
    examples: ctx.examples,
    objectiveOrder: ctx.objectiveOrder,
    subject,
    mode: "generation" as const,
  });
  const fixIndex = ctx.existing.length + others.length + index;
  const leaksWith = findExposureLeaks(leakInput(drafts.map((draft, position) => (position === index ? candidate : draft))));
  const before = hardVictims(findExposureLeaks(leakInput(drafts)));
  for (const leak of leaksWith) {
    if (leak.kind !== "hard") continue;
    if (leak.index === fixIndex) return undefined;
    if (leak.source.kind === "exercise" && leak.source.index === fixIndex) return undefined;
    if (!before.has(leak.index)) return undefined;
  }
  return candidate;
}

interface BatchReview {
  readonly replacements: ReadonlyMap<number, LessonExerciseDraft>;
  readonly dropIndexes: ReadonlySet<number>;
  readonly meta: ReadonlyMap<LessonExerciseDraft, ReviewMeta>;
  readonly dropped: LessonReviewReport["dropped"];
  readonly status: "reviewed" | "suspicious";
  readonly counts: { ok: number; note: number; fix: number; drop: number };
  readonly invalid: number;
  readonly leaks: number;
}

/**
 * Werdykty jednego zagadnienia → zmiany (bez zapisu do stanu fazy; stosuje je wywołujący).
 * Poprawki walidowane po kolei: każda widzi wcześniej przyjęte poprawki swojej partii,
 * a jako tło — ćwiczenia szkicu i bieżący stan świeżych innych zagadnień (`current`).
 */
function reviewBatch(
  ctx: ReviewPhaseContext,
  batch: ObjectiveBatch,
  rawVerdicts: readonly unknown[],
  current: readonly (LessonExerciseDraft | undefined)[],
  hardLeakOf: ReadonlyMap<number, ExposureLeak>,
  idOf: (alias: unknown) => unknown,
): BatchReview {
  const { subject } = ctx;
  const identityOptions = lessonIdentityOptionsOf(subject);
  const own = new Set(batch.freshIndexes);
  const others = current.flatMap((exercise, index) => (exercise === undefined || own.has(index) ? [] : [exercise]));
  const background = [...ctx.existing, ...others];
  const listen = batch.drafts.filter((exercise) => exercise.exerciseType === "lesson_listen_choice").length;
  const poolCheck = (rawExercises: readonly unknown[]) =>
    acceptFreshLessonPool({
      rawExercises,
      subject,
      topic: ctx.topic,
      material: ctx.material,
      familyScope: null,
      existingDrafts: ctx.existing,
      existingAnswers: new Set(background.map((exercise) => exercise.answer)),
      existingExerciseIdentities: new Set(background.map((exercise) => lessonExerciseIdentity(exercise, identityOptions))),
      objectiveLimits: new Map([[batch.objectiveId, { count: batch.drafts.length - listen, listen }]]),
    }).accepted;

  const drafts = [...batch.drafts];
  let invalid = 0;
  const parsed: ParsedVerdict[] = [];
  const candidates = new Map<number, LessonExerciseDraft>();
  const seen = new Set<number>();
  for (const raw of rawVerdicts) {
    const verdict = readVerdict(raw);
    if (verdict === undefined) {
      invalid += 1;
      continue;
    }
    const inRange = verdict.n >= 1 && verdict.n <= drafts.length;
    // Tylko pierwszy werdykt danego n się liczy (duplikat zliczy domena jako nieczytelny).
    const firstForN = inRange && !seen.has(verdict.n);
    if (inRange) seen.add(verdict.n);
    if (verdict.verdict !== "fix") {
      parsed.push(verdict);
      continue;
    }
    const { exercise, ...rest } = verdict;
    const index = verdict.n - 1;
    // Poprawka, która i tak będzie tylko uwagą (obliczenia, `too_hard`), nie wchodzi do partii.
    const replaceable = firstForN && exercise !== null &&
      drafts[index]!.exerciseType !== "lesson_calculation" && !NOTE_ONLY_REVIEW_CATEGORIES.has(verdict.category);
    const candidate = replaceable
      ? validatedFix(ctx, drafts, others, index, { ...exercise, objectiveId: idOf(exercise.objectiveId) }, poolCheck)
      : undefined;
    if (candidate !== undefined) {
      candidates.set(index, candidate);
      drafts[index] = candidate;
    }
    parsed.push({ ...rest, fixValid: candidate !== undefined });
  }

  const hardLeakIndexes = new Set(batch.freshIndexes.flatMap((freshIndex, position) => (hardLeakOf.has(freshIndex) ? [position] : [])));
  const decision = decideObjectiveReview({
    freshCount: batch.drafts.length,
    objectiveTotal: ctx.existing.filter((exercise) => exercise.objectiveId === batch.objectiveId).length + batch.drafts.length,
    verdicts: parsed,
    calculationIndexes: new Set(batch.drafts.flatMap((exercise, position) => (exercise.exerciseType === "lesson_calculation" ? [position] : []))),
    hardLeakIndexes,
  });

  const replacements = new Map<number, LessonExerciseDraft>();
  const dropIndexes = new Set<number>();
  const meta = new Map<LessonExerciseDraft, ReviewMeta>();
  const dropped: LessonReviewReport["dropped"] = [];
  const counts = { ok: 0, note: 0, fix: 0, drop: 0 };
  decision.outcomes.forEach((decided, position) => {
    const original = batch.drafts[position]!;
    const freshIndex = batch.freshIndexes[position]!;
    if (decided.kind === "keep") {
      counts.ok += 1;
    } else if (decided.kind === "keep_with_note") {
      counts.note += 1;
      meta.set(original, { note: { category: decided.category, reasonPl: decided.reasonPl, fixRejected: decided.fixRejected } });
    } else if (decided.kind === "replace") {
      counts.fix += 1;
      const replacement = candidates.get(position)!;
      const addedVariants = replacement.acceptedAnswers.filter((variant) => !original.acceptedAnswers.includes(variant));
      replacements.set(freshIndex, replacement);
      meta.set(replacement, { changed: { category: decided.category, reasonPl: decided.reasonPl, beforePl: exerciseSnippet(original), addedVariants } });
    } else {
      counts.drop += 1;
      dropIndexes.add(freshIndex);
      dropped.push({ objectiveId: batch.objectiveId, category: decided.category, reasonPl: decided.reasonPl, snippet: exerciseSnippet(original) });
    }
  });
  return {
    replacements, dropIndexes, meta, dropped, status: decision.status, counts,
    invalid: invalid + decision.invalidVerdicts, leaks: hardLeakIndexes.size,
  };
}

/** Wykonuje fazę przeglądu dla świeżych ćwiczeń przebiegu (opis w nagłówku modułu). */
export async function reviewFreshExercises(ctx: ReviewPhaseContext): Promise<ReviewPhaseResult> {
  const { reviewer, subject } = ctx;
  const objectiveIds = freshObjectiveIds(ctx);
  const provider = reviewer?.state === "ready" ? reviewer.provider : undefined;
  if (reviewer === undefined || reviewer.state !== "ready" || provider === undefined) {
    const reason: ReviewReason = reviewer?.state === "disabled" || reviewer === undefined ? "disabled" : "not_configured";
    return {
      exercises: [...ctx.fresh],
      meta: new Map(),
      objectives: objectiveIds.map((objectiveId) => ({ objectiveId, status: "unreviewed", reason })),
      dropped: [],
      droppedCount: 0,
    };
  }
  const { policy } = reviewer;

  // Ustalenia deterministyczne (twarde ujawnienia świeżych ofiar) — raz na fazę.
  const all = [...ctx.existing, ...ctx.fresh];
  const leaks = findExposureLeaks({ exercises: all, examples: ctx.examples, objectiveOrder: ctx.objectiveOrder, subject, mode: "generation" });
  const hardLeakOf = new Map<number, ExposureLeak>();
  for (const leak of leaks) {
    if (leak.kind === "hard" && leak.index >= ctx.existing.length) hardLeakOf.set(leak.index - ctx.existing.length, leak);
  }

  const batches: ObjectiveBatch[] = objectiveIds.map((objectiveId) => {
    const freshIndexes = ctx.fresh.flatMap((exercise, index) => (exercise.objectiveId === objectiveId ? [index] : []));
    return { objectiveId, freshIndexes, drafts: freshIndexes.map((index) => ctx.fresh[index]!) };
  });

  const { aliasOf, idOf } = objectiveAliases(lessonObjectiveIds(ctx));
  const material = reviewMaterial(ctx);
  const cardExamples = lessonCardExamples(ctx, aliasOf);
  const reviewRole = reviewRoleFor(subject);
  const inputOf = (batch: ObjectiveBatch): LessonReviewInput => {
    const findings = batch.freshIndexes.flatMap((freshIndex, position) => {
      const leak = hardLeakOf.get(freshIndex);
      if (leak === undefined) return [];
      if (leak.source.kind === "card_example") return [findingText(position + 1, { kind: "card_example", text: leak.source.text })];
      const sourceIndex = leak.source.index;
      const sourcePosition = batch.freshIndexes.indexOf(sourceIndex - ctx.existing.length);
      const text = exerciseExposureText(subject, all[sourceIndex]!);
      return [findingText(position + 1, sourcePosition === -1 ? { kind: "exercise", text } : { kind: "exercise", n: sourcePosition + 1, text })];
    });
    const context = ctx.objectiveContext(batch.objectiveId);
    return {
      subjectTitle: subject.titlePl,
      answerLocale: subject.answerLocale,
      promptLocale: subject.promptLocale,
      reviewRole,
      material,
      cardExamples,
      objective: { id: aliasOf(batch.objectiveId), title: context.title, ...(context.kind === undefined ? {} : { kind: context.kind }), card: context.card },
      existingExercises: ctx.existing.filter((exercise) => exercise.objectiveId === batch.objectiveId).map((exercise) => reviewShape(exercise, subject, aliasOf)),
      exercises: batch.drafts.map((exercise, position) => ({ n: position + 1, exercise: reviewShape(exercise, subject, aliasOf) })),
      findings,
    };
  };

  let cancelled: LessonGenerationCancelledError | undefined;
  const runOne = async (batch: ObjectiveBatch): Promise<ObjectiveOutcome> => {
    if (cancelled !== undefined) return { kind: "unreviewed", reason: "failed" };
    if (ctx.callsLeft.value <= 0) return { kind: "unreviewed", reason: "limit" };
    const remaining = ctx.reviewDeadlineAtMs - Date.now();
    if (remaining <= 0) return { kind: "unreviewed", reason: "timeout" };
    ctx.callsLeft.value -= 1;
    const startedAt = Date.now();
    const input = inputOf(batch);
    try {
      const result = await withLessonGenerationControl(
        { requestTimeoutMs: policy.timeoutMs, runTimeoutMs: remaining, cancelPollMs: ctx.cancelPollMs, assertCurrent: ctx.assertCurrent, signal: ctx.signal },
        (control) => control.callSoft((signal) => provider.reviewLessonObjective(input, signal)),
      );
      return { kind: "reviewed", verdicts: Array.isArray(result?.verdicts) ? result.verdicts : [], durationMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof LessonGenerationCancelledError) {
        cancelled ??= error;
        throw error;
      }
      const reason: ReviewReason = error instanceof GenerationProviderError && error.kind === "timeout" ? "timeout" : "failed";
      return { kind: "unreviewed", reason, durationMs: Date.now() - startedAt };
    }
  };

  // Pierwsze wywołanie samo (zapisuje cache prefiksu), kolejne równolegle do `concurrency`.
  const settled = new Map<string, PromiseSettledResult<ObjectiveOutcome>>();
  const queue = [...batches];
  const settle = async (batch: ObjectiveBatch) => {
    const [result] = await Promise.allSettled([runOne(batch)]);
    settled.set(batch.objectiveId, result!);
  };
  const first = queue.shift();
  if (first !== undefined) await settle(first);
  await Promise.all(
    Array.from({ length: Math.max(0, Math.min(policy.concurrency, queue.length)) }, async () => {
      for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) await settle(batch);
    }),
  );
  if (cancelled !== undefined) throw cancelled;

  const replacements = new Map<number, LessonExerciseDraft>();
  const dropIndexes = new Set<number>();
  const meta = new Map<LessonExerciseDraft, ReviewMeta>();
  const objectives: LessonReviewReport["objectives"] = [];
  const dropped: LessonReviewReport["dropped"] = [];
  // Bieżący stan świeżych ćwiczeń: poprawki i usunięcia zagadnień przetworzonych wcześniej
  // są tłem walidacji kolejnych (dwie poprawki nie mogą zbiec się w ten sam bodziec).
  const current: (LessonExerciseDraft | undefined)[] = [...ctx.fresh];

  for (const batch of batches) {
    const result = settled.get(batch.objectiveId);
    const outcome: ObjectiveOutcome = result?.status === "fulfilled" ? result.value : { kind: "unreviewed", reason: "failed" };
    const slug = batch.objectiveId.split(".").at(-1);
    let reviewed: BatchReview | undefined;
    let failure: ReviewReason | undefined = outcome.kind === "unreviewed" ? outcome.reason : undefined;
    if (outcome.kind === "reviewed") {
      try {
        reviewed = reviewBatch(ctx, batch, outcome.verdicts, current, hardLeakOf, idOf);
      } catch {
        // Nieprzewidziany błąd walidacji poprawek: zagadnienie bez zmian, przebieg trwa.
        failure = "failed";
      }
    }
    if (reviewed === undefined) {
      objectives.push({ objectiveId: batch.objectiveId, status: "unreviewed", reason: failure ?? "failed" });
      console.log(`[lesson-review] run=${ctx.runId} zagadnienie=${slug} status=unreviewed reason=${failure ?? "failed"} durationMs=${outcome.durationMs ?? 0}`);
      continue;
    }
    for (const [freshIndex, replacement] of reviewed.replacements) {
      replacements.set(freshIndex, replacement);
      current[freshIndex] = replacement;
    }
    for (const freshIndex of reviewed.dropIndexes) {
      dropIndexes.add(freshIndex);
      current[freshIndex] = undefined;
    }
    for (const [exercise, entry] of reviewed.meta) meta.set(exercise, entry);
    dropped.push(...reviewed.dropped);
    objectives.push({ objectiveId: batch.objectiveId, status: reviewed.status });
    const { counts } = reviewed;
    console.log(
      `[lesson-review] run=${ctx.runId} zagadnienie=${slug} ok=${counts.ok} note=${counts.note} fix=${counts.fix} drop=${counts.drop} invalid=${reviewed.invalid} leaks=${reviewed.leaks} status=${reviewed.status} durationMs=${outcome.durationMs ?? 0}`,
    );
  }

  const exercises = ctx.fresh.flatMap((exercise, index) => (dropIndexes.has(index) ? [] : [replacements.get(index) ?? exercise]));
  return { exercises, meta, objectives, dropped, droppedCount: dropIndexes.size };
}

/** Najgorszy stan zagadnienia z kilku faz przebiegu (partia główna i runda pod etap). */
const STATUS_RANK: Record<LessonReviewReport["objectives"][number]["status"], number> = { reviewed: 0, suspicious: 1, unreviewed: 2 };

/**
 * Raport jednego przebiegu (do scalenia z `mergeReviewReport`): zagadnienia z faz (stan
 * najgorszy z faz), wpisy `changed`/`notes` z meta zapisanych ćwiczeń (po tożsamości obiektu;
 * ćwiczenia usunięte później przez filtry nie mają wpisu), `machine` dla każdego zapisanego
 * ćwiczenia (`reviewed` = zagadnienie przejrzane w fazie, która je oceniła) i usunięcia krytyka.
 */
export function reviewRunReport(input: {
  readonly phases: readonly ReviewPhaseResult[];
  readonly saved: readonly { readonly draft: LessonExerciseDraft; readonly exerciseId: string }[];
  readonly subject: SubjectModule;
  readonly toppedUp: LessonReviewReport["toppedUp"];
  readonly model?: string;
}): LessonReviewReport {
  const objectives = new Map<string, LessonReviewReport["objectives"][number]>();
  const meta = new Map<LessonExerciseDraft, ReviewMeta>();
  const reviewed = new Map<LessonExerciseDraft, boolean>();
  for (const phase of input.phases) {
    const statusOf = new Map(phase.objectives.map((objective) => [objective.objectiveId, objective.status] as const));
    for (const objective of phase.objectives) {
      const previous = objectives.get(objective.objectiveId);
      if (previous === undefined || STATUS_RANK[objective.status] > STATUS_RANK[previous.status]) objectives.set(objective.objectiveId, objective);
    }
    for (const exercise of phase.exercises) reviewed.set(exercise, statusOf.get(exercise.objectiveId) === "reviewed");
    for (const [exercise, entry] of phase.meta) meta.set(exercise, entry);
  }
  const report: LessonReviewReport = {
    status: "unreviewed",
    ...(input.model === undefined ? {} : { model: input.model }),
    objectives: [...objectives.values()],
    changed: [],
    dropped: input.phases.flatMap((phase) => phase.dropped),
    notes: [],
    toppedUp: [...input.toppedUp],
    machine: [],
  };
  for (const { draft, exerciseId } of input.saved) {
    const fingerprint = fingerprintOf(draft, input.subject);
    report.machine.push({ exerciseId, fingerprint, reviewed: reviewed.get(draft) ?? false });
    const entry = meta.get(draft);
    if (entry?.changed) report.changed.push({ exerciseId, fingerprint, ...entry.changed });
    if (entry?.note) report.notes.push({ exerciseId, fingerprint, ...entry.note });
  }
  return { ...report, status: statusFromObjectives(report.objectives) };
}
