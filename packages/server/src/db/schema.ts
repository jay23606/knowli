import { sql } from "drizzle-orm";
import type { AssignmentGoal, RecordingModeDto, TestGoal } from "@learning/contracts";
import type { LessonMockTestPlanSnapshot, MockTestPlanSnapshot } from "../domain/mock-test-types";
import type { StoredTrainingSessionPlan } from "../domain/training-session-plan";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Autorytatywne odwzorowanie docs/schema.sql (projekt 1.2) w Drizzle.
 * Triggery i funkcje zabezpieczeń nie są wyrażalne tutaj — żyją jako jawne
 * migracje SQL w packages/server/drizzle (plik guards). Od tej pory źródłem
 * prawdy jest ten plik i przeglądane migracje, nie schema.sql.
 */
export const app = pgSchema("learning_app");

const timestamps = (name: string) => timestamp(name, { withTimezone: true });

export const familySettings = app.table(
  "family_settings",
  {
    id: smallint("id").primaryKey().default(1),
    timezone: text("timezone").notNull().default("Europe/Warsaw"),
  },
  (t) => [check("family_settings_single_row", sql`${t.id} = 1`)],
);

export const parentCredentials = app.table(
  "parent_credentials",
  {
    id: smallint("id").primaryKey().default(1),
    passwordHash: text("password_hash").notNull(),
    updatedAt: timestamps("updated_at").notNull().defaultNow(),
  },
  (t) => [check("parent_credentials_single_row", sql`${t.id} = 1`)],
);

export const parentSessions = app.table(
  "parent_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    createdAt: timestamps("created_at").notNull().defaultNow(),
    expiresAt: timestamps("expires_at").notNull(),
  },
  (t) => [
    check("parent_sessions_expires_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    index("parent_sessions_expiry_idx").on(t.expiresAt),
  ],
);

export const integrationTokens = app.table(
  "integration_tokens",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamps("created_at").notNull().defaultNow(),
    revokedAt: timestamps("revoked_at"),
  },
  (t) => [
    check("integration_tokens_name_length", sql`length(${t.name}) between 1 and 120`),
    check("integration_tokens_scopes_allowed", sql`${t.scopes} <@ ARRAY['learning:read']::text[]`),
    uniqueIndex("integration_tokens_hash_idx").on(t.tokenHash),
    index("integration_tokens_revoked_idx").on(t.revokedAt),
  ],
);

export const childProfiles = app.table(
  "child_profiles",
  {
    id: uuid("id").primaryKey(),
    displayName: text("display_name").notNull(),
    avatarKey: text("avatar_key").notNull(),
    birthYear: smallint("birth_year"),
    canRead: boolean("can_read").notNull().default(true),
    recordingMode: text("recording_mode").$type<RecordingModeDto>().notNull().default("hold"),
    // Zainteresowania dziecka (tematy zdań w lekcjach, do 5); format elementów pilnuje kontrakt.
    interests: text("interests").array().notNull().default(sql`ARRAY[]::text[]`),
    // własna wersja polityki dziecka (design 2026-10-09); null = bieżąca globalna
    policyId: text("policy_id").references((): AnyPgColumn => learningPolicies.id),
    // NULL oznacza legacy dane wymagające jawnej odbudowy; nowe profile są gotowe.
    learningProjectionVersion: text("learning_projection_version").default("proj-3"),
    // Ogólny dorobek punktowy dziecka (1 pkt / pełna zatwierdzona minuta) i
    // niewykorzystana reszta subminuty przenoszona między sesjami.
    rewardPoints: integer("reward_points").notNull().default(0),
    rewardRemainderMs: integer("reward_remainder_ms").notNull().default(0),
    createdAt: timestamps("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("child_profiles_display_name_length", sql`length(${t.displayName}) between 1 and 80`),
    check("child_profiles_birth_year_range", sql`${t.birthYear} is null or ${t.birthYear} between 1900 and 2200`),
    check("child_profiles_recording_mode", sql`${t.recordingMode} in ('hold', 'toggle')`),
    check("child_profiles_interests_valid", sql`cardinality(${t.interests}) <= 5 and array_position(${t.interests}, null) is null`),
    check("child_profiles_reward_nonnegative", sql`${t.rewardPoints} >= 0 and ${t.rewardRemainderMs} >= 0 and ${t.rewardRemainderMs} < 60000`),
  ],
);

export const learningPolicies = app.table(
  "learning_policies",
  {
    id: text("id").primaryKey(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamps("created_at").notNull().defaultNow(),
  },
  (t) => [check("learning_policies_config_object", sql`jsonb_typeof(${t.config}) = 'object'`)],
);

export const deckVersions = app.table(
  "deck_versions",
  {
    id: uuid("id").primaryKey(),
    deckId: uuid("deck_id")
      .notNull()
      .references((): AnyPgColumn => decks.id),
    versionNumber: integer("version_number").notNull(),
    editNumber: integer("edit_number").notNull().default(1),
    // review: szkic kompletny po generacji, oczekuje na przegląd; nadal edytowalny
    state: text("state").$type<"draft" | "review" | "published">().notNull(),
    title: text("title").notNull(),
    sourceLocale: text("source_locale").notNull().default("pl-PL"),
    targetLocale: text("target_locale").notNull().default("en-GB"),
    vocabularyFormat: text("vocabulary_format").$type<"standard" | "picture">().notNull().default("standard"),
    generationPrompt: text("generation_prompt"),
    // Kontekst lekcji (design grammar-module „Data Models”): wymagany dla
    // zestawów lesson, zabroniony dla vocabulary, niezmienny po publikacji —
    // egzekwuje trigger w 0007_lessons.sql.
    lessonContext: jsonb("lesson_context").$type<Record<string, unknown>>(),
    createdAt: timestamps("created_at").notNull().defaultNow(),
    publishedAt: timestamps("published_at"),
  },
  (t) => [
    check("deck_versions_version_positive", sql`${t.versionNumber} > 0`),
    check("deck_versions_edit_number_positive", sql`${t.editNumber} > 0`),
    check("deck_versions_vocabulary_format_allowed", sql`${t.vocabularyFormat} in ('standard', 'picture')`),
    check("deck_versions_state_allowed", sql`${t.state} in ('draft', 'review', 'published')`),
    check(
      "deck_versions_published_iff_published_at",
      sql`(${t.state} = 'published') = (${t.publishedAt} is not null)`,
    ),
    unique("deck_versions_version_number_unique").on(t.deckId, t.versionNumber),
    unique("deck_versions_id_deck_unique").on(t.id, t.deckId),
    uniqueIndex("one_editable_version_per_deck")
      .on(t.deckId)
      .where(sql`${t.state} in ('draft', 'review')`),
  ],
);

/**
 * Źródło (materiał źródłowy rodzica, design 2026-10-30 §3): wklejony tekst
 * rozdziału, z którego rodzic tworzy lekcje i zestawy. Zestaw KOPIUJE tekst
 * przy tworzeniu i pamięta tylko odnośnik (`decks.source_material_id`) —
 * źródło nie jest czytane po utworzeniu zestawu. Dwie rewizje: `revision` rośnie
 * przy każdej zmianie (kontrola współbieżności edycji), `body_revision` — tylko
 * przy zmianie treści (wersja kopiowanego tekstu, zapisywana w
 * `decks.source_material_revision`). `request_hash` to skrót tytułu i treści
 * z pierwszego żądania tworzenia (idempotencja po `client_request_id`).
 */
export const sourceMaterials = app.table(
  "source_materials",
  {
    id: uuid("id").primaryKey(),
    clientRequestId: uuid("client_request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    revision: integer("revision").notNull().default(1),
    bodyRevision: integer("body_revision").notNull().default(1),
    createdAt: timestamps("created_at").notNull().defaultNow(),
    updatedAt: timestamps("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("source_materials_client_request_id_unique").on(t.clientRequestId),
    check("source_materials_title_length", sql`length(${t.title}) between 1 and 120`),
    check("source_materials_body_length", sql`length(${t.body}) between 1 and 16000`),
    check("source_materials_revision_positive", sql`${t.revision} >= 1`),
    check("source_materials_body_revision_positive", sql`${t.bodyRevision} >= 1`),
  ],
);

export const decks = app.table(
  "decks",
  {
    id: uuid("id").primaryKey(),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("vocabulary"),
    coverAssetId: uuid("cover_asset_id").references((): AnyPgColumn => mediaAssets.id),
    // Budżet zadań ocenianych sesji nauki tego zestawu (konfiguracja runtime,
    // nie treść — mutacja bez nowego szkicu wersji). Obowiązuje słówka i lekcje.
    sessionTaskBudget: integer("session_task_budget").notNull().default(20),
    // Pochodzenie zestawu (design 2026-10-30 §3.1): źródło, z którego skopiowano
    // tekst, i rewizja jego treści (`source_materials.body_revision`) w chwili
    // kopiowania. Sam odnośnik jest informacją — usunięcie źródła zeruje
    // `source_material_id`, a treść zestawu i skopiowana rewizja zostają.
    sourceMaterialId: uuid("source_material_id").references((): AnyPgColumn => sourceMaterials.id, { onDelete: "set null" }),
    sourceMaterialRevision: integer("source_material_revision"),
    publishedVersionId: uuid("published_version_id"),
    archivedAt: timestamps("archived_at"),
    createdAt: timestamps("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("decks_kind_allowed", sql`${t.kind} in ('vocabulary', 'lesson')`),
    check("decks_session_task_budget", sql`${t.sessionTaskBudget} between 1 and 100`),
    // Skopiowana rewizja treści jest dodatnia i obecna przy odnośniku; ON DELETE SET NULL
    // zeruje tylko odnośnik, więc wiersz po usunięciu źródła przechodzi oba warunki.
    check("decks_source_material_revision_positive", sql`${t.sourceMaterialRevision} is null or ${t.sourceMaterialRevision} >= 1`),
    check("decks_source_material_revision_required", sql`${t.sourceMaterialId} is null or ${t.sourceMaterialRevision} is not null`),
    index("decks_source_material_idx").on(t.sourceMaterialId).where(sql`${t.sourceMaterialId} is not null`),
    // Aplikacja ustawia published_version_id wyłącznie na state=published.
    foreignKey({
      name: "published_version_belongs_to_deck",
      columns: [t.publishedVersionId, t.id],
      foreignColumns: [deckVersions.id, deckVersions.deckId],
    }),
  ],
);

export const learningItems = app.table(
  "learning_items",
  {
    id: uuid("id").primaryKey(),
    deckId: uuid("deck_id")
      .notNull()
      .references((): AnyPgColumn => decks.id),
    kind: text("kind").notNull().default("vocabulary"),
    retiredAt: timestamps("retired_at"),
  },
  (t) => [
    check("learning_items_kind_allowed", sql`${t.kind} in ('vocabulary', 'lesson_exercise')`),
    unique("learning_items_id_deck_unique").on(t.id, t.deckId),
  ],
);

export const skillVersions = app.table(
  "skill_versions",
  {
    id: uuid("id").primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references((): AnyPgColumn => learningItems.id),
    // listening, reading, recall, pronunciation, spelling
    skill: text("skill").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    criteria: jsonb("criteria").$type<Record<string, unknown>>().notNull(),
    criteriaHash: text("criteria_hash").notNull(),
    predecessorId: uuid("predecessor_id"),
    createdAt: timestamps("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("skill_versions_revision_positive", sql`${t.revisionNumber} > 0`),
    check("skill_versions_criteria_object", sql`jsonb_typeof(${t.criteria}) = 'object'`),
    unique("skill_versions_item_skill_revision_unique").on(t.itemId, t.skill, t.revisionNumber),
    unique("skill_versions_id_item_skill_unique").on(t.id, t.itemId, t.skill),
    // Kompozytowy self-FK (predecessor_id, item_id, skill) -> (id, item_id, skill)
    // wyrazony w jawnej migracji SQL: cykl self-referencji jest nieinferowalny
    // w definicji tabeli (TS7022). Zobacz drizzle/0001_guards_and_seed.sql.
  ],
);

export const itemRevisions = app.table(
  "item_revisions",
  {
    id: uuid("id").primaryKey(),
    itemId: uuid("item_id").notNull(),
    deckId: uuid("deck_id").notNull(),
    deckVersionId: uuid("deck_version_id").notNull(),
    position: integer("position").notNull(),
    payloadVersion: integer("payload_version").notNull().default(1),
    // payload: source, target, acceptedAnswers, example, visualType, visualData,
    // sourceLocale, targetLocale. Reguły oceny są w skill_versions.criteria.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    targetKey: text("target_key").notNull(),
  },
  (t) => [
    check("item_revisions_position_nonnegative", sql`${t.position} >= 0`),
    check("item_revisions_payload_version_positive", sql`${t.payloadVersion} > 0`),
    check("item_revisions_payload_object", sql`jsonb_typeof(${t.payload}) = 'object'`),
    foreignKey({
      name: "item_revisions_item_fk",
      columns: [t.itemId, t.deckId],
      foreignColumns: [learningItems.id, learningItems.deckId],
    }),
    foreignKey({
      name: "item_revisions_deck_version_fk",
      columns: [t.deckVersionId, t.deckId],
      foreignColumns: [deckVersions.id, deckVersions.deckId],
    }),
    unique("item_revisions_version_item_unique").on(t.deckVersionId, t.itemId),
    unique("item_revisions_version_position_unique").on(t.deckVersionId, t.position),
    unique("item_revisions_id_item_unique").on(t.id, t.itemId),
    unique("item_revisions_id_version_unique").on(t.id, t.deckVersionId),
  ],
);

export const itemRevisionSkills = app.table(
  "item_revision_skills",
  {
    itemRevisionId: uuid("item_revision_id").notNull(),
    itemId: uuid("item_id").notNull(),
    skill: text("skill").notNull(),
    skillVersionId: uuid("skill_version_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "item_revision_skills_pk", columns: [t.itemRevisionId, t.skill] }),
    unique("item_revision_skills_revision_skill_version_unique").on(
      t.itemRevisionId,
      t.skill,
      t.skillVersionId,
    ),
    foreignKey({
      name: "item_revision_skills_revision_fk",
      columns: [t.itemRevisionId, t.itemId],
      foreignColumns: [itemRevisions.id, itemRevisions.itemId],
    }),
    foreignKey({
      name: "item_revision_skills_skill_version_fk",
      columns: [t.skillVersionId, t.itemId, t.skill],
      foreignColumns: [skillVersions.id, skillVersions.itemId, skillVersions.skill],
    }),
  ],
);

export const assignments = app.table(
  "assignments",
  {
    id: uuid("id").primaryKey(),
    childId: uuid("child_id")
      .notNull()
      .references((): AnyPgColumn => childProfiles.id, { onDelete: "cascade" }),
    deckId: uuid("deck_id")
      .notNull()
      .references((): AnyPgColumn => decks.id),
    testDate: date("test_date"),
    testGoals: text("test_goals").array().$type<AssignmentGoal[]>(),
    mockTestTaskCount: integer("mock_test_task_count").notNull().default(10),
    active: boolean("active").notNull().default(true),
    createdAt: timestamps("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("assignments_child_deck_unique").on(t.childId, t.deckId),
    check("assignments_mock_test_count", sql`${t.mockTestTaskCount} between 1 and 100`),
    check("assignments_test_goals", sql`${t.testGoals} is null or (cardinality(${t.testGoals}) between 1 and 3 and ${t.testGoals} <@ array['recall','spelling','listening','lesson']::text[] and cardinality(array_positions(${t.testGoals}, 'recall')) <= 1 and cardinality(array_positions(${t.testGoals}, 'spelling')) <= 1 and cardinality(array_positions(${t.testGoals}, 'listening')) <= 1 and cardinality(array_positions(${t.testGoals}, 'lesson')) <= 1 and array_position(${t.testGoals}, null) is null and (array_position(${t.testGoals}, 'lesson') is null or ${t.testGoals} = array['lesson']::text[]))`),
    unique("assignments_id_child_deck_unique").on(t.id, t.childId, t.deckId),
  ],
);

export const mediaAssets = app.table(
  "media_assets",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    fingerprint: text("fingerprint").notNull(),
    generationNumber: integer("generation_number").notNull().default(1),
    state: text("state").notNull(),
    // immutable content-addressed blob; może być współdzielony
    storageKey: text("storage_key"),
    contentSha256: text("content_sha256"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamps("lease_until"),
    mimeType: text("mime_type"),
    byteCount: bigint("byte_count", { mode: "number" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamps("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("media_assets_kind_allowed", sql`${t.kind} in ('tts', 'illustration', 'deck_cover')`),
    check("media_assets_generation_positive", sql`${t.generationNumber} > 0`),
    check("media_assets_state_allowed", sql`${t.state} in ('pending', 'ready', 'failed')`),
    check("media_assets_byte_count_nonnegative", sql`${t.byteCount} is null or ${t.byteCount} >= 0`),
    check(
      "media_assets_lease_pairing",
      sql`(${t.leaseToken} is null) = (${t.leaseUntil} is null)`,
    ),
    check(
      "media_assets_ready_complete",
      sql`${t.state} <> 'ready' or (${t.storageKey} is not null and ${t.mimeType} is not null and ${t.byteCount} is not null and ${t.contentSha256} is not null and ${t.leaseToken} is null)`,
    ),
    unique("media_assets_fingerprint_generation_unique").on(t.fingerprint, t.generationNumber),
  ],
);

export const revisionAssets = app.table(
  "revision_assets",
  {
    itemRevisionId: uuid("item_revision_id")
      .notNull()
      .references((): AnyPgColumn => itemRevisions.id),
    role: text("role").$type<"target_audio" | "example_audio" | "illustration" | "prompt_audio" | "feedback_audio" | "explanation_audio">().notNull(),
    assetId: uuid("asset_id").references((): AnyPgColumn => mediaAssets.id),
    expectedFingerprint: text("expected_fingerprint").notNull(),
    state: text("state").$type<"pending" | "approved" | "omitted">().notNull(),
  },
  (t) => [
    check("revision_assets_role_allowed", sql`${t.role} in ('target_audio', 'example_audio', 'illustration', 'prompt_audio', 'feedback_audio', 'explanation_audio')`),
    check("revision_assets_state_allowed", sql`${t.state} in ('pending', 'approved', 'omitted')`),
    check("revision_assets_approved_has_asset", sql`${t.state} <> 'approved' or ${t.assetId} is not null`),
    check("revision_assets_only_illustration_omitted", sql`${t.state} <> 'omitted' or ${t.role} = 'illustration'`),
    primaryKey({ name: "revision_assets_pk", columns: [t.itemRevisionId, t.role] }),
  ],
);

/**
 * Nagranie „Posłuchaj karty” (design szkoły §12.2): karta nauki należy do
 * `lesson_context.dynamicTopic` wersji, nie do rewizji ćwiczenia. Bez stanu
 * decyzji; wiersze opublikowanej wersji niezmienne (trigger w migracji 0028).
 */
export const lessonCardAssets = app.table(
  "lesson_card_assets",
  {
    deckVersionId: uuid("deck_version_id")
      .notNull()
      .references((): AnyPgColumn => deckVersions.id),
    objectiveId: text("objective_id").notNull(),
    cardIndex: integer("card_index").notNull(),
    assetId: uuid("asset_id").references((): AnyPgColumn => mediaAssets.id),
    expectedFingerprint: text("expected_fingerprint").notNull(),
  },
  (t) => [
    check("lesson_card_assets_card_index_nonnegative", sql`${t.cardIndex} >= 0`),
    primaryKey({ name: "lesson_card_assets_pk", columns: [t.deckVersionId, t.objectiveId, t.cardIndex] }),
    index("lesson_card_assets_asset_idx").on(t.assetId),
  ],
);

export const generationRuns = app.table(
  "generation_runs",
  {
    id: uuid("id").primaryKey(),
    deckVersionId: uuid("deck_version_id").references((): AnyPgColumn => deckVersions.id),
    expectedEditNumber: integer("expected_edit_number"),
    assetId: uuid("asset_id").references((): AnyPgColumn => mediaAssets.id),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    state: text("state").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamps("lease_until"),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    nextAttemptAt: timestamps("next_attempt_at"),
    createdAt: timestamps("created_at").notNull().defaultNow(),
    finishedAt: timestamps("finished_at"),
    // Słówka ze źródła (design 2026-10-30 §6.2): elementy odrzucone przy walidacji
    // per element (spoza tekstu, niepoprawne, duplikaty), zapisywane przy sukcesie
    // (`markRunSucceeded`) i przy porażce `no_source_items`, gdy nic nie przeszło
    // (`markRunWithoutSourceItems`). NULL — run bez walidacji per element (opis,
    // lekcje, media) albo niezakończony. Lekcje liczą odrzucenia w `lesson_context`.
    rejectedCount: integer("rejected_count"),
  },
  (t) => [
    check("generation_runs_kind_allowed", sql`${t.kind} in ('deck', 'lesson', 'tts', 'illustration')`),
    check("generation_runs_rejected_count_nonnegative", sql`${t.rejectedCount} is null or ${t.rejectedCount} >= 0`),
    check(
      "generation_runs_state_allowed",
      sql`${t.state} in ('queued', 'running', 'succeeded', 'failed', 'superseded')`,
    ),
    check("generation_runs_attempts_nonnegative", sql`${t.attempts} >= 0`),
    check("generation_runs_expected_edit_positive", sql`${t.expectedEditNumber} is null or ${t.expectedEditNumber} > 0`),
    check("generation_runs_lease_pairing", sql`(${t.leaseToken} is null) = (${t.leaseUntil} is null)`),
    check(
      "generation_runs_kind_shape",
      sql`(${t.kind} in ('deck', 'lesson') and ${t.deckVersionId} is not null and ${t.expectedEditNumber} is not null and ${t.assetId} is null) or (${t.kind} in ('tts', 'illustration') and ${t.assetId} is not null and ${t.deckVersionId} is null and ${t.expectedEditNumber} is null)`,
    ),
    // media używają lease z media_assets
    check("generation_runs_deck_without_lease", sql`${t.kind} not in ('deck', 'lesson') or ${t.leaseToken} is null`),
    unique("generation_runs_dedupe_key_unique").on(t.dedupeKey),
    uniqueIndex("one_run_per_asset").on(t.assetId).where(sql`${t.assetId} is not null`),
    index("generation_runs_state_idx").on(t.state, t.createdAt),
  ],
);

export const learningSessions = app.table(
  "learning_sessions",
  {
    id: uuid("id").primaryKey(),
    childId: uuid("child_id")
      .notNull()
      .references((): AnyPgColumn => childProfiles.id, { onDelete: "cascade" }),
    assignmentId: uuid("assignment_id").notNull(),
    deckId: uuid("deck_id").notNull(),
    deckVersionId: uuid("deck_version_id").notNull(),
    policyId: text("policy_id")
      .notNull()
      .references((): AnyPgColumn => learningPolicies.id),
    microphoneEnabled: boolean("microphone_enabled").notNull(),
    mode: text("mode").$type<"training" | "mock_test" | "daily_round">().notNull().default("training"),
    dailyRoundDate: text("daily_round_date"),
    mockTestPlan: jsonb("mock_test_plan").$type<MockTestPlanSnapshot | LessonMockTestPlanSnapshot>(),
    trainingPlan: jsonb("training_plan").$type<StoredTrainingSessionPlan>(),
    // completed: jawny koniec z podsumowaniem; ended: zamknięcie systemowe
    state: text("state").notNull(),
    // kopia budżetu przypięta przy starcie sesji: trening/daily_round z
    // decks.session_task_budget, mock_test z liczby slotów planu kartkówki
    taskBudget: integer("task_budget").notNull().default(20),
    startedAt: timestamps("started_at").notNull().defaultNow(),
    endedAt: timestamps("ended_at"),
    // snapshot kontaktów z poprzednich sesji i ustawień terminu/strefy
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    // Raport aktywności FE + dołączone przez serwer zadania/odpowiedzi +
    // wykluczenia modelu albo kod błędu; znika po 7 dniach (retencja).
    activityReport: jsonb("activity_report").$type<Record<string, unknown>>(),
    activityReportExpiresAt: timestamps("activity_report_expires_at"),
    // Jednorazowe prawo wywołania oceny; chroni przed równoległym rozliczeniem.
    activityReviewStartedAt: timestamps("activity_review_started_at"),
    // Fingerprint pierwszego przyjętego raportu; zostaje po retencji.
    activityReportHash: text("activity_report_hash"),
    // Mały trwały wynik: czasy, punkty, uzasadnienie, ewentualny kod błędu.
    activityReview: jsonb("activity_review").$type<Record<string, unknown>>(),
  },
  (t) => [
    check("learning_sessions_state_allowed", sql`${t.state} in ('active', 'completed', 'ended')`),
    check("learning_sessions_mode_plan", sql`(${t.mode} in ('training', 'daily_round') and ${t.mockTestPlan} is null) or (${t.mode} = 'mock_test' and ${t.mockTestPlan} is not null)`),
    check("learning_sessions_training_plan_mode", sql`${t.trainingPlan} is null or (${t.mode} = 'training' and ${t.mockTestPlan} is null)`),
    check("learning_sessions_daily_round_date", sql`(${t.mode} = 'daily_round') = (${t.dailyRoundDate} is not null)`),
    check("learning_sessions_no_active_daily_round", sql`${t.mode} <> 'daily_round' or ${t.state} <> 'active'`),
    check("learning_sessions_budget_positive", sql`${t.taskBudget} > 0`),
    check("learning_sessions_active_iff_not_ended", sql`(${t.state} = 'active') = (${t.endedAt} is null)`),
    foreignKey({
      name: "learning_sessions_assignment_fk",
      columns: [t.assignmentId, t.childId, t.deckId],
      foreignColumns: [assignments.id, assignments.childId, assignments.deckId],
    }),
    foreignKey({
      name: "learning_sessions_deck_version_fk",
      columns: [t.deckVersionId, t.deckId],
      foreignColumns: [deckVersions.id, deckVersions.deckId],
    }),
    unique("learning_sessions_id_child_unique").on(t.id, t.childId),
    unique("learning_sessions_id_version_unique").on(t.id, t.deckVersionId),
    uniqueIndex("one_active_session_per_child").on(t.childId).where(sql`${t.state} = 'active'`),
    uniqueIndex("one_daily_round_per_child_day").on(t.childId, t.dailyRoundDate).where(sql`${t.mode} = 'daily_round'`),
    index("learning_sessions_child_time_idx").on(t.childId, t.startedAt.desc()),
    // Worker czyści przeterminowane raporty w ograniczonych partiach po terminie.
    index("learning_sessions_activity_expiry_idx").on(t.activityReportExpiresAt)
      .where(sql`${t.activityReportExpiresAt} is not null`),
  ],
);

export const sessionTasks = app.table(
  "session_tasks",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id").notNull(),
    childId: uuid("child_id").notNull(),
    deckVersionId: uuid("deck_version_id").notNull(),
    itemRevisionId: uuid("item_revision_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    exerciseType: text("exercise_type").notNull(),
    direction: text("direction"),
    state: text("state").notNull(),
    publicPrompt: jsonb("public_prompt").$type<Record<string, unknown>>().notNull(),
    answerKey: jsonb("answer_key").$type<Record<string, unknown>>().notNull(),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    issuedAt: timestamps("issued_at").notNull().defaultNow(),
  },
  (t) => [
    check("session_tasks_ordinal_nonnegative", sql`${t.ordinal} >= 0`),
    check("session_tasks_state_allowed", sql`${t.state} in ('issued', 'answered', 'completed', 'skipped')`),
    check("session_tasks_completed_only_exposure", sql`${t.state} <> 'completed' or ${t.exerciseType} in ('exposure', 'lesson_card')`),
    check("session_tasks_answered_never_exposure", sql`${t.state} <> 'answered' or ${t.exerciseType} <> 'exposure'`),
    foreignKey({
      name: "session_tasks_session_child_fk",
      columns: [t.sessionId, t.childId],
      foreignColumns: [learningSessions.id, learningSessions.childId],
    }).onDelete("cascade"),
    foreignKey({
      name: "session_tasks_session_version_fk",
      columns: [t.sessionId, t.deckVersionId],
      foreignColumns: [learningSessions.id, learningSessions.deckVersionId],
    }),
    foreignKey({
      name: "session_tasks_revision_fk",
      columns: [t.itemRevisionId, t.deckVersionId],
      foreignColumns: [itemRevisions.id, itemRevisions.deckVersionId],
    }),
    unique("session_tasks_session_ordinal_unique").on(t.sessionId, t.ordinal),
    unique("session_tasks_id_child_unique").on(t.id, t.childId),
    unique("session_tasks_id_revision_unique").on(t.id, t.itemRevisionId),
    uniqueIndex("one_issued_task_per_session").on(t.sessionId).where(sql`${t.state} = 'issued'`),
    index("session_tasks_child_issued_idx").on(t.childId, t.issuedAt),
    index("session_tasks_revision_issued_idx").on(t.itemRevisionId, t.issuedAt),
  ],
);

export const attempts = app.table(
  "attempts",
  {
    id: uuid("id").primaryKey(),
    childId: uuid("child_id")
      .notNull()
      .references((): AnyPgColumn => childProfiles.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    itemRevisionId: uuid("item_revision_id").notNull(),
    clientAttemptId: uuid("client_attempt_id").notNull(),
    requestHash: text("request_hash").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    modality: text("modality").notNull(),
    state: text("state").notNull(),
    // tylko tekst/opcja/transkrypcja; żadnych bytes/URL nagrania
    answer: jsonb("answer").$type<Record<string, unknown>>(),
    context: jsonb("context").$type<Record<string, unknown>>().notNull(),
    feedback: jsonb("feedback").$type<Record<string, unknown>>(),
    policyId: text("policy_id")
      .notNull()
      .references((): AnyPgColumn => learningPolicies.id),
    receivedAt: timestamps("received_at").notNull().defaultNow(),
    completedAt: timestamps("completed_at"),
  },
  (t) => [
    check("attempts_modality_allowed", sql`${t.modality} in ('choice', 'text', 'audio', 'dont_remember', 'skip', 'sequence', 'selection', 'assignment')`),
    check("attempts_state_allowed", sql`${t.state} in ('processing', 'completed')`),
    check("attempts_number_positive", sql`${t.attemptNumber} > 0`),
    check("attempts_completed_iff_completed_at", sql`(${t.state} = 'completed') = (${t.completedAt} is not null)`),
    foreignKey({
      name: "attempts_task_child_fk",
      columns: [t.taskId, t.childId],
      foreignColumns: [sessionTasks.id, sessionTasks.childId],
    }).onDelete("cascade"),
    foreignKey({
      name: "attempts_task_revision_fk",
      columns: [t.taskId, t.itemRevisionId],
      foreignColumns: [sessionTasks.id, sessionTasks.itemRevisionId],
    }),
    unique("attempts_child_client_id_unique").on(t.childId, t.clientAttemptId),
    unique("attempts_task_number_unique").on(t.taskId, t.attemptNumber),
    unique("attempts_id_revision_unique").on(t.id, t.itemRevisionId),
    unique("attempts_id_child_unique").on(t.id, t.childId),
    uniqueIndex("one_processing_attempt_per_task").on(t.taskId).where(sql`${t.state} = 'processing'`),
    index("attempts_stale_idx").on(t.receivedAt).where(sql`${t.state} = 'processing'`),
    index("attempts_child_received_idx").on(t.childId, t.receivedAt.desc()),
    index("attempts_item_revision_idx").on(t.itemRevisionId),
  ],
);

export const assessments = app.table(
  "assessments",
  {
    childId: uuid("child_id")
      .notNull()
      .references((): AnyPgColumn => childProfiles.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id").notNull(),
    itemRevisionId: uuid("item_revision_id").notNull(),
    skill: text("skill").notNull(),
    skillVersionId: uuid("skill_version_id").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    independent: boolean("independent").notNull(),
    confirmationEligible: boolean("confirmation_eligible").notNull(),
    provider: text("provider"),
    providerModel: text("provider_model"),
    providerPolicyVersion: text("provider_policy_version"),
    score: numeric("score"),
    scoreScale: text("score_scale"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    check("assessments_outcome_allowed", sql`${t.outcome} in ('correct', 'incorrect', 'unassessed')`),
    check(
      "assessments_unassessed_no_score",
      sql`${t.outcome} <> 'unassessed' or (${t.score} is null and not ${t.confirmationEligible})`,
    ),
    check(
      "assessments_score_needs_provider",
      sql`${t.score} is null or (${t.provider} is not null and ${t.scoreScale} is not null)`,
    ),
    primaryKey({ name: "assessments_pk", columns: [t.attemptId, t.skill] }),
    foreignKey({
      name: "assessments_attempt_child_fk",
      columns: [t.attemptId, t.childId],
      foreignColumns: [attempts.id, attempts.childId],
    }).onDelete("cascade"),
    foreignKey({
      name: "assessments_attempt_revision_fk",
      columns: [t.attemptId, t.itemRevisionId],
      foreignColumns: [attempts.id, attempts.itemRevisionId],
    }).onDelete("cascade"),
    foreignKey({
      name: "assessments_revision_skill_fk",
      columns: [t.itemRevisionId, t.skill, t.skillVersionId],
      foreignColumns: [itemRevisionSkills.itemRevisionId, itemRevisionSkills.skill, itemRevisionSkills.skillVersionId],
    }),
    index("assessments_skill_history_idx").on(t.skillVersionId, t.attemptId),
    index("assessments_child_skill_idx").on(t.childId, t.skillVersionId, t.skill),
  ],
);

export const learningEvents = app.table(
  "learning_events",
  {
    id: uuid("id").primaryKey(),
    childId: uuid("child_id")
      .notNull()
      .references((): AnyPgColumn => childProfiles.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references((): AnyPgColumn => learningItems.id),
    // opcjonalny dla obserwacji klienta; ujawnienie zapisuje serwer
    clientEventId: uuid("client_event_id"),
    sealed: boolean("sealed").notNull().default(false),
    stepId: text("step_id").notNull(),
    kind: text("kind").notNull(),
    occurredAt: timestamps("occurred_at").notNull().defaultNow(),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    check(
      "learning_events_kind_allowed",
      sql`${t.kind} in ('contact', 'prompt_issued', 'audio_issued', 'hint_issued', 'feedback_issued', 'display_confirmed', 'audio_played', 'presentation_completed')`,
    ),
    foreignKey({
      name: "learning_events_task_child_fk",
      columns: [t.taskId, t.childId],
      foreignColumns: [sessionTasks.id, sessionTasks.childId],
    }).onDelete("cascade"),
    unique("learning_events_child_client_id_unique").on(t.childId, t.clientEventId),
    unique("learning_events_id_child_unique").on(t.id, t.childId),
    index("learning_events_contact_idx").on(t.childId, t.itemId, t.occurredAt.desc()),
    index("learning_events_child_occurred_idx").on(t.childId, t.occurredAt.desc()),
    index("learning_events_audio_task_occurred_idx")
      .on(t.taskId, t.occurredAt)
      .where(sql`${t.kind} = 'audio_issued' and ${t.sealed} = true`),
  ],
);

export const eventExposures = app.table(
  "event_exposures",
  {
    childId: uuid("child_id")
      .notNull()
      .references((): AnyPgColumn => childProfiles.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    targetKey: text("target_key").notNull(),
  },
  (t) => [
    primaryKey({ name: "event_exposures_pk", columns: [t.eventId, t.targetKey] }),
    foreignKey({
      name: "event_exposures_event_fk",
      columns: [t.eventId, t.childId],
      foreignColumns: [learningEvents.id, learningEvents.childId],
    }).onDelete("cascade"),
    index("event_exposures_target_idx").on(t.targetKey, t.eventId),
    index("event_exposures_child_target_idx").on(t.childId, t.targetKey),
  ],
);

/** Zachowany do odczytu/migracji projekcji sprzed zakresu polityki. */
export const childSkillProgressLegacy = app.table(
  "child_skill_progress_legacy",
  {
    childId: uuid("child_id")
      .notNull()
      .references((): AnyPgColumn => childProfiles.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references((): AnyPgColumn => skillVersions.id),
    status: text("status").notNull(),
    independentSuccessStreak: integer("independent_success_streak").notNull().default(0),
    lastReviewedAt: timestamps("last_reviewed_at"),
    nextReviewAt: timestamps("next_review_at"),
    delayedConfirmationAt: timestamps("delayed_confirmation_at"),
    projectionVersion: text("projection_version").notNull(),
    updatedAt: timestamps("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "child_skill_progress_legacy_status_allowed",
      sql`${t.status} in ('unseen', 'practicing', 'needs_confirmation', 'needs_reconfirmation', 'mastered')`,
    ),
    check("child_skill_progress_legacy_streak_nonnegative", sql`${t.independentSuccessStreak} >= 0`),
    primaryKey({ name: "child_skill_progress_legacy_pk", columns: [t.childId, t.skillVersionId] }),
    index("child_skill_due_legacy_idx").on(t.childId, t.nextReviewAt),
  ],
);

export const childSkillProgress = app.table(
  "child_skill_progress",
  {
    childId: uuid("child_id")
      .notNull()
      .references((): AnyPgColumn => childProfiles.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references((): AnyPgColumn => skillVersions.id),
    policyId: text("policy_id")
      .notNull()
      .references((): AnyPgColumn => learningPolicies.id),
    status: text("status").notNull(),
    independentSuccessStreak: integer("independent_success_streak").notNull().default(0),
    lastReviewedAt: timestamps("last_reviewed_at"),
    nextReviewAt: timestamps("next_review_at"),
    delayedConfirmationAt: timestamps("delayed_confirmation_at"),
    firstIssuedAt: timestamps("first_issued_at"),
    hasQualifyingAssessment: boolean("has_qualifying_assessment").notNull().default(false),
    projectionVersion: text("projection_version").notNull(),
    updatedAt: timestamps("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "child_skill_progress_status_allowed",
      sql`${t.status} in ('unseen', 'practicing', 'needs_confirmation', 'needs_reconfirmation', 'mastered')`,
    ),
    check("child_skill_progress_streak_nonnegative", sql`${t.independentSuccessStreak} >= 0`),
    primaryKey({ name: "child_skill_progress_pk", columns: [t.childId, t.skillVersionId, t.policyId] }),
    index("child_skill_due_idx").on(t.childId, t.nextReviewAt),
    index("child_skill_policy_idx").on(t.childId, t.policyId, t.skillVersionId),
  ],
);

export const childTargetExposures = app.table(
  "child_target_exposures",
  {
    childId: uuid("child_id")
      .notNull()
      .references((): AnyPgColumn => childProfiles.id, { onDelete: "cascade" }),
    targetKey: text("target_key").notNull(),
    firstExposureAt: timestamps("first_exposure_at").notNull(),
    lastExposureAt: timestamps("last_exposure_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "child_target_exposures_pk", columns: [t.childId, t.targetKey] }),
    index("child_target_exposures_target_idx").on(t.targetKey, t.childId),
  ],
);

/**
 * Cache werdyktów modelu oceniającego dla ćwiczeń lekcji (design grammar-module
 * „Data Models”). Celowo bez kolumn dziecka — werdykt należy do wspólnego
 * materiału (item_revision + znormalizowana odpowiedź + wersja promptu) i
 * przeżywa usunięcie profilu. parent_decision pozwala rodzicowi nadpisać werdykt
 * bez przeliczania historii.
 */
export const lessonVerdicts = app.table(
  "lesson_verdicts",
  {
    id: uuid("id").primaryKey(),
    itemRevisionId: uuid("item_revision_id")
      .notNull()
      .references((): AnyPgColumn => itemRevisions.id),
    normalizedAnswer: text("normalized_answer").notNull(),
    promptVersion: text("prompt_version").notNull(),
    graderModel: text("grader_model").notNull(),
    verdict: text("verdict").notNull(),
    errorCategory: text("error_category"),
    fragments: jsonb("fragments").$type<string[]>().notNull().default([]),
    precision: text("precision"),
    matchedElements: jsonb("matched_elements").$type<string[]>().notNull().default([]),
    missingElements: jsonb("missing_elements").$type<string[]>().notNull().default([]),
    incorrectStatements: jsonb("incorrect_statements").$type<string[]>().notNull().default([]),
    redundantFragments: jsonb("redundant_fragments").$type<string[]>().notNull().default([]),
    // werdykt school-grader-v3 (migracja 0025)
    offTopicFragments: jsonb("off_topic_fragments").$type<string[]>().notNull().default([]),
    confusedConcepts: jsonb("confused_concepts").$type<{ said: string; meant: string }[]>().notNull().default([]),
    note: text("note"),
    parentDecision: text("parent_decision"),
    parentDecidedAt: timestamps("parent_decided_at"),
    createdAt: timestamps("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("lesson_verdicts_verdict_allowed", sql`${t.verdict} in ('correct', 'almost', 'incorrect')`),
    check(
      "lesson_verdicts_precision_allowed",
      sql`${t.precision} is null or ${t.precision} in ('concise', 'verbose', 'unfocused')`,
    ),
    check(
      "lesson_verdicts_parent_decision_allowed",
      sql`${t.parentDecision} is null or ${t.parentDecision} in ('confirmed', 'overridden_correct', 'overridden_incorrect')`,
    ),
    check(
      "lesson_verdicts_parent_decision_pairing",
      sql`(${t.parentDecision} is null) = (${t.parentDecidedAt} is null)`,
    ),
    unique("lesson_verdicts_cache_key_unique").on(t.itemRevisionId, t.normalizedAnswer, t.promptVersion),
    index("lesson_verdicts_revision_idx").on(t.itemRevisionId),
  ],
);

/**
 * Projekcja postępu per cel nauki (design grammar-module „Data Models”).
 * Klucz (child_id, subject_id, objective_id); kasowana kaskadą po usunięciu
 * profilu. Odbudowywana przez progress-rebuild z assessments (skill='objective')
 * — to zadanie 10, poza zakresem 0007.
 */
export const childObjectiveProgress = app.table(
  "child_objective_progress",
  {
    childId: uuid("child_id")
      .notNull()
      .references((): AnyPgColumn => childProfiles.id, { onDelete: "cascade" }),
    subjectId: text("subject_id").notNull(),
    objectiveId: text("objective_id").notNull(),
    topicId: text("topic_id").notNull(),
    status: text("status").notNull(),
    streak: integer("streak").notNull().default(0),
    nextReviewAt: timestamps("next_review_at"),
    lastIndependentAt: timestamps("last_independent_at"),
    projectionVersion: text("projection_version").notNull(),
    updatedAt: timestamps("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "child_objective_progress_status_allowed",
      sql`${t.status} in ('unseen', 'practicing', 'needs_confirmation', 'needs_reconfirmation', 'mastered')`,
    ),
    check("child_objective_progress_streak_nonnegative", sql`${t.streak} >= 0`),
    primaryKey({
      name: "child_objective_progress_pk",
      columns: [t.childId, t.subjectId, t.objectiveId],
    }),
    index("child_objective_progress_due_idx").on(t.childId, t.nextReviewAt),
  ],
);
