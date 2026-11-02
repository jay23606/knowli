-- Wyjaśnienie błędu dla dziecka (gramatyka i rozdziały): nagranie „explanation_audio”
-- jako zasób rewizji ćwiczenia obok `prompt_audio` i `feedback_audio`.
ALTER TABLE "learning_app"."revision_assets" DROP CONSTRAINT "revision_assets_role_allowed";
--> statement-breakpoint
ALTER TABLE "learning_app"."revision_assets" ADD CONSTRAINT "revision_assets_role_allowed" CHECK ("learning_app"."revision_assets"."role" in ('target_audio', 'example_audio', 'illustration', 'prompt_audio', 'feedback_audio', 'explanation_audio'));
