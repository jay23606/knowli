-- Nagranie lektora historyjki lekcji (design „Historyjka lekcji” §7): historyjka
-- żyje w `lesson_context.story` wersji, a nie w rewizji ćwiczenia, więc jej
-- nagranie wiąże się z wersją (jedno na wersję). Bez stanu decyzji — nagranie
-- nie jest decyzją rodzica i nie blokuje publikacji. Wiersz opublikowanej
-- wersji jest niezmienny, jak `lesson_card_assets`.
CREATE TABLE "learning_app"."lesson_story_assets" (
	"deck_version_id" uuid NOT NULL,
	"asset_id" uuid,
	"expected_fingerprint" text NOT NULL,
	CONSTRAINT "lesson_story_assets_pk" PRIMARY KEY("deck_version_id")
);
--> statement-breakpoint
ALTER TABLE "learning_app"."lesson_story_assets" ADD CONSTRAINT "lesson_story_assets_deck_version_id_deck_versions_id_fk" FOREIGN KEY ("deck_version_id") REFERENCES "learning_app"."deck_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_app"."lesson_story_assets" ADD CONSTRAINT "lesson_story_assets_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "learning_app"."media_assets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "lesson_story_assets_asset_idx" ON "learning_app"."lesson_story_assets" USING btree ("asset_id");
--> statement-breakpoint
CREATE FUNCTION learning_app.guard_lesson_story_asset_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_version uuid;
  new_version uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_version := OLD.deck_version_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_version := NEW.deck_version_id; END IF;
  -- Blokada wiersza wersji serializuje edycję i publikację (jak guard_revision_change).
  PERFORM 1 FROM learning_app.deck_versions WHERE id IN (old_version,new_version) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM learning_app.deck_versions WHERE id IN (old_version,new_version) AND state='published')
    THEN RAISE EXCEPTION 'Published lesson story asset is immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lesson_story_assets_immutable BEFORE INSERT OR UPDATE OR DELETE ON learning_app.lesson_story_assets
  FOR EACH ROW EXECUTE FUNCTION learning_app.guard_lesson_story_asset_change();
