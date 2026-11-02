-- Dziennik płatnych wywołań usług AI (spec 2026-11-02-llm-cost-tracking §3.1):
-- jeden wiersz to jedno wywołanie HTTP łącznie z ponowieniami. Bez treści,
-- imion i wieku. Klucze obce zerują się przy usunięciu celu (SET NULL), więc
-- historia kosztów przeżywa profil, sesję, run i talię.
CREATE TABLE "learning_app"."provider_usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"feature" text NOT NULL,
	"operation" text,
	"provider" text NOT NULL,
	"model" text,
	"outcome" text NOT NULL,
	"http_status" smallint,
	"input_tokens" integer,
	"output_tokens" integer,
	"characters" integer,
	"audio_ms" integer,
	"images" integer,
	"cost_usd" numeric(12, 6),
	"cost_source" text NOT NULL,
	"price_ref" text,
	"scope_kind" text NOT NULL,
	"generation_run_id" uuid,
	"deck_id" uuid,
	"session_id" uuid,
	"child_id" uuid,
	CONSTRAINT "provider_usage_events_feature_allowed" CHECK ("learning_app"."provider_usage_events"."feature" in ('deck_generation', 'lesson_generation', 'tts', 'illustration', 'deck_cover', 'answer_grading', 'session_activity_review', 'lesson_stt', 'speech_stt', 'pronunciation')),
	CONSTRAINT "provider_usage_events_outcome_allowed" CHECK ("learning_app"."provider_usage_events"."outcome" in ('ok', 'failed')),
	CONSTRAINT "provider_usage_events_cost_source_allowed" CHECK ("learning_app"."provider_usage_events"."cost_source" in ('provider', 'price_table', 'not_billed', 'unknown')),
	CONSTRAINT "provider_usage_events_scope_kind_allowed" CHECK ("learning_app"."provider_usage_events"."scope_kind" in ('run', 'session', 'deck', 'none')),
	CONSTRAINT "provider_usage_events_units_nonnegative" CHECK (("learning_app"."provider_usage_events"."input_tokens" is null or "learning_app"."provider_usage_events"."input_tokens" >= 0) and ("learning_app"."provider_usage_events"."output_tokens" is null or "learning_app"."provider_usage_events"."output_tokens" >= 0) and ("learning_app"."provider_usage_events"."characters" is null or "learning_app"."provider_usage_events"."characters" >= 0) and ("learning_app"."provider_usage_events"."audio_ms" is null or "learning_app"."provider_usage_events"."audio_ms" >= 0) and ("learning_app"."provider_usage_events"."images" is null or "learning_app"."provider_usage_events"."images" >= 0)),
	CONSTRAINT "provider_usage_events_cost_nonnegative" CHECK ("learning_app"."provider_usage_events"."cost_usd" is null or "learning_app"."provider_usage_events"."cost_usd" >= 0),
	CONSTRAINT "provider_usage_events_cost_unknown_null" CHECK (("learning_app"."provider_usage_events"."cost_source" = 'unknown') = ("learning_app"."provider_usage_events"."cost_usd" is null)),
	CONSTRAINT "provider_usage_events_not_billed_zero" CHECK ("learning_app"."provider_usage_events"."cost_source" <> 'not_billed' or "learning_app"."provider_usage_events"."cost_usd" = 0),
	CONSTRAINT "provider_usage_events_price_ref_shape" CHECK (("learning_app"."provider_usage_events"."price_ref" is not null) = ("learning_app"."provider_usage_events"."cost_source" = 'price_table'))
);
--> statement-breakpoint
-- Pochodzenie runu mediów (spec §3.2): talia szkicu, którego uzgodnienie albo
-- ręczna regeneracja zleciły zasób. Tylko informacyjne; NULL dla starych runów.
ALTER TABLE "learning_app"."generation_runs" ADD COLUMN "origin_deck_id" uuid;
--> statement-breakpoint
ALTER TABLE "learning_app"."generation_runs" ADD CONSTRAINT "generation_runs_origin_deck_id_decks_id_fk" FOREIGN KEY ("origin_deck_id") REFERENCES "learning_app"."decks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_app"."provider_usage_events" ADD CONSTRAINT "provider_usage_events_generation_run_id_generation_runs_id_fk" FOREIGN KEY ("generation_run_id") REFERENCES "learning_app"."generation_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_app"."provider_usage_events" ADD CONSTRAINT "provider_usage_events_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "learning_app"."decks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_app"."provider_usage_events" ADD CONSTRAINT "provider_usage_events_session_id_learning_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "learning_app"."learning_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_app"."provider_usage_events" ADD CONSTRAINT "provider_usage_events_child_id_child_profiles_id_fk" FOREIGN KEY ("child_id") REFERENCES "learning_app"."child_profiles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "provider_usage_events_occurred_at_idx" ON "learning_app"."provider_usage_events" USING btree ("occurred_at");
--> statement-breakpoint
CREATE INDEX "provider_usage_events_deck_idx" ON "learning_app"."provider_usage_events" USING btree ("deck_id");
--> statement-breakpoint
CREATE INDEX "provider_usage_events_run_idx" ON "learning_app"."provider_usage_events" USING btree ("generation_run_id");
--> statement-breakpoint
CREATE INDEX "provider_usage_events_session_idx" ON "learning_app"."provider_usage_events" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "provider_usage_events_child_time_idx" ON "learning_app"."provider_usage_events" USING btree ("child_id","occurred_at");
