-- Rodzinny asystent nauki: początkowy model PostgreSQL, projekt 1.2.
-- Podstawa: SPEC.md 1.1 i architecture.md 1.2. Nie jest wykonanym wdrożeniem.
-- UUID nadaje aplikacja. Czasy timestamptz; test_date jest datą strefy rodziny.
-- Graphile Worker tworzy i migruje swój schemat osobno.
-- JSONB zawsze podlega walidacji Zod przed zapisem.
BEGIN;
CREATE SCHEMA learning_app;
SET LOCAL search_path TO learning_app, public;

CREATE TABLE family_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  timezone text NOT NULL DEFAULT 'Europe/Warsaw'
);
INSERT INTO family_settings DEFAULT VALUES;

CREATE TABLE parent_credentials (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE parent_sessions (
  token_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX parent_sessions_expiry_idx ON parent_sessions(expires_at);

CREATE TABLE child_profiles (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  avatar_key text NOT NULL,
  birth_year smallint CHECK (birth_year BETWEEN 1900 AND 2200),
  can_read boolean NOT NULL DEFAULT true,
  recording_mode text NOT NULL DEFAULT 'hold' CHECK (recording_mode IN ('hold','toggle')),
  -- własna wersja polityki dziecka; NULL = bieżąca globalna (FK poniżej, po learning_policies)
  policy_id text,
  -- NULL oznacza legacy dane wymagające jawnej odbudowy; nowe profile są gotowe
  learning_projection_version text DEFAULT 'proj-3',
  -- ogólny dorobek punktowy (1 pkt / pełna zatwierdzona minuta) i reszta subminuty
  reward_points integer NOT NULL DEFAULT 0,
  reward_remainder_ms integer NOT NULL DEFAULT 0,
  -- zainteresowania dziecka: tematy zdań w lekcjach (do 5); format elementów pilnuje kontrakt
  interests text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT child_profiles_reward_nonnegative CHECK (reward_points >= 0 AND reward_remainder_ms >= 0 AND reward_remainder_ms < 60000),
  CONSTRAINT child_profiles_interests_valid CHECK (cardinality(interests) <= 5 AND array_position(interests, NULL) IS NULL)
);

CREATE TABLE learning_policies (
  id text PRIMARY KEY,
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE child_profiles ADD FOREIGN KEY (policy_id) REFERENCES learning_policies(id);
-- Wstawienie zweryfikowanej learning-v1 nastąpi w migracji/seed implementacji.

-- Źródła (materiał źródłowy rodzica, design 2026-10-30 §3): wklejony tekst rozdziału.
-- Zestaw kopiuje tekst przy tworzeniu; źródło nie jest czytane po utworzeniu zestawu.
CREATE TABLE source_materials (
  id uuid PRIMARY KEY,
  client_request_id uuid NOT NULL UNIQUE, -- idempotencja tworzenia
  request_hash text NOT NULL, -- sha256 z JSON {title, body} (po trim) z pierwszego żądania
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 16000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1), -- kontrola współbieżności: rośnie przy każdej zmianie
  body_revision integer NOT NULL DEFAULT 1 CHECK (body_revision >= 1), -- wersja treści: rośnie tylko przy zmianie body
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE decks (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'vocabulary',
  -- budżet zadań ocenianych sesji nauki zestawu (konfiguracja runtime, 1–100)
  session_task_budget integer NOT NULL DEFAULT 20 CHECK (session_task_budget BETWEEN 1 AND 100),
  -- pochodzenie zestawu: źródło i rewizja jego treści (body_revision) w chwili
  -- kopiowania tekstu; usunięcie źródła zeruje odnośnik (treść zestawu i rewizja zostają)
  source_material_id uuid REFERENCES source_materials(id) ON DELETE SET NULL,
  source_material_revision integer CHECK (source_material_revision IS NULL OR source_material_revision >= 1),
  published_version_id uuid,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- skopiowana rewizja jest obecna przy odnośniku (ON DELETE SET NULL zostawia ją bez odnośnika)
  CHECK (source_material_id IS NULL OR source_material_revision IS NOT NULL)
);
CREATE TABLE deck_versions (
  id uuid PRIMARY KEY,
  deck_id uuid NOT NULL REFERENCES decks(id),
  version_number integer NOT NULL CHECK (version_number > 0),
  edit_number integer NOT NULL DEFAULT 1 CHECK (edit_number > 0),
  -- review: szkic kompletny po generacji, oczekuje na przegląd; nadal edytowalny
  state text NOT NULL CHECK (state IN ('draft','review','published')),
  title text NOT NULL,
  source_locale text NOT NULL DEFAULT 'pl-PL',
  target_locale text NOT NULL DEFAULT 'en-GB',
  generation_prompt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (deck_id, version_number),
  UNIQUE (id, deck_id),
  CHECK ((state = 'published') = (published_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_editable_version_per_deck
  ON deck_versions(deck_id) WHERE state IN ('draft','review');
ALTER TABLE decks ADD CONSTRAINT published_version_belongs_to_deck
  FOREIGN KEY (published_version_id, id) REFERENCES deck_versions(id, deck_id);
-- Aplikacja ustawia published_version_id wyłącznie na state=published.
CREATE INDEX decks_source_material_idx ON decks(source_material_id) WHERE source_material_id IS NOT NULL;

CREATE TABLE learning_items (
  id uuid PRIMARY KEY,
  deck_id uuid NOT NULL REFERENCES decks(id),
  kind text NOT NULL DEFAULT 'vocabulary',
  retired_at timestamptz,
  UNIQUE (id, deck_id)
);
CREATE TABLE skill_versions (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES learning_items(id),
  skill text NOT NULL, -- listening, reading, recall, pronunciation, spelling
  revision_number integer NOT NULL CHECK (revision_number > 0),
  criteria jsonb NOT NULL CHECK (jsonb_typeof(criteria) = 'object'),
  criteria_hash text NOT NULL,
  predecessor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, skill, revision_number),
  UNIQUE (id, item_id, skill),
  FOREIGN KEY (predecessor_id, item_id, skill)
    REFERENCES skill_versions(id, item_id, skill)
);
CREATE TABLE item_revisions (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL,
  deck_id uuid NOT NULL,
  deck_version_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- payload: source, target, acceptedAnswers, example, visualType, visualData,
  -- sourceLocale, targetLocale. Reguły oceny są w skill_versions.criteria.
  target_key text NOT NULL,
  FOREIGN KEY (item_id, deck_id) REFERENCES learning_items(id, deck_id),
  FOREIGN KEY (deck_version_id, deck_id) REFERENCES deck_versions(id, deck_id),
  UNIQUE (deck_version_id, item_id),
  UNIQUE (deck_version_id, position),
  UNIQUE (id, item_id),
  UNIQUE (id, deck_version_id)
);
CREATE TABLE item_revision_skills (
  item_revision_id uuid NOT NULL,
  item_id uuid NOT NULL,
  skill text NOT NULL,
  skill_version_id uuid NOT NULL,
  PRIMARY KEY (item_revision_id, skill),
  UNIQUE (item_revision_id, skill, skill_version_id),
  FOREIGN KEY (item_revision_id, item_id) REFERENCES item_revisions(id, item_id),
  FOREIGN KEY (skill_version_id, item_id, skill) REFERENCES skill_versions(id, item_id, skill)
);

CREATE TABLE assignments (
  id uuid PRIMARY KEY,
  child_id uuid NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
  deck_id uuid NOT NULL REFERENCES decks(id),
  test_date date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (child_id, deck_id),
  UNIQUE (id, child_id, deck_id)
);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('tts','illustration')),
  fingerprint text NOT NULL,
  generation_number integer NOT NULL DEFAULT 1 CHECK (generation_number > 0),
  state text NOT NULL CHECK (state IN ('pending','ready','failed')),
  storage_key text, -- immutable content-addressed blob; może być współdzielony
  content_sha256 text,
  lease_token uuid,
  lease_until timestamptz,
  mime_type text,
  byte_count bigint CHECK (byte_count >= 0),
  provider text NOT NULL,
  model text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fingerprint, generation_number),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (state <> 'ready' OR
    (storage_key IS NOT NULL AND mime_type IS NOT NULL AND byte_count IS NOT NULL
     AND content_sha256 IS NOT NULL AND lease_token IS NULL))
);
CREATE TABLE revision_assets (
  item_revision_id uuid NOT NULL REFERENCES item_revisions(id),
  role text NOT NULL CHECK (role IN ('target_audio','example_audio','illustration','prompt_audio','feedback_audio','explanation_audio')),
  asset_id uuid REFERENCES media_assets(id),
  expected_fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','approved','omitted')),
  PRIMARY KEY (item_revision_id, role),
  CHECK (state <> 'approved' OR asset_id IS NOT NULL),
  CHECK (state <> 'omitted' OR role = 'illustration')
);
-- Przed publikacją: wymagane audio approved + media_assets.ready;
-- obraz approved albo jawne omitted. Nie ma tu surowego audio dziecka.

CREATE TABLE generation_runs (
  id uuid PRIMARY KEY,
  deck_version_id uuid REFERENCES deck_versions(id),
  expected_edit_number integer CHECK (expected_edit_number > 0),
  asset_id uuid REFERENCES media_assets(id),
  kind text NOT NULL CHECK (kind IN ('deck','tts','illustration')),
  dedupe_key text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','superseded')),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- słówka ze źródła (design 2026-10-30 §6.2, migracja 0031): elementy odrzucone przy
  -- walidacji per element, zapisywane przy sukcesie i przy porażce `no_source_items`;
  -- NULL — run bez takiej walidacji (zestaw z opisu, lekcja, media), niezakończony
  -- albo ponowiony ręcznie
  rejected_count integer CHECK (rejected_count IS NULL OR rejected_count >= 0),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK ((kind = 'deck' AND deck_version_id IS NOT NULL AND expected_edit_number IS NOT NULL AND asset_id IS NULL)
    OR (kind IN ('tts','illustration') AND asset_id IS NOT NULL AND deck_version_id IS NULL AND expected_edit_number IS NULL)),
  CHECK (kind = 'deck' OR lease_token IS NULL) -- media używają lease z media_assets
);
CREATE UNIQUE INDEX one_run_per_asset ON generation_runs(asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX generation_runs_state_idx ON generation_runs(state, created_at);

CREATE TABLE learning_sessions (
  id uuid PRIMARY KEY,
  child_id uuid NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL,
  deck_id uuid NOT NULL,
  deck_version_id uuid NOT NULL,
  policy_id text NOT NULL REFERENCES learning_policies(id),
  microphone_enabled boolean NOT NULL,
  -- completed: jawny koniec z podsumowaniem; ended: zamknięcie systemowe
  state text NOT NULL CHECK (state IN ('active','completed','ended')),
  -- kopia budżetu przypięta przy starcie sesji: trening/daily_round z
  -- decks.session_task_budget, mock_test z liczby slotów planu kartkówki
  task_budget integer NOT NULL DEFAULT 20 CHECK (task_budget > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  -- snapshot kontaktów z poprzednich sesji i ustawień terminu/strefy:
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (assignment_id, child_id, deck_id) REFERENCES assignments(id, child_id, deck_id),
  FOREIGN KEY (deck_version_id, deck_id) REFERENCES deck_versions(id, deck_id),
  UNIQUE (id, child_id),
  UNIQUE (id, deck_version_id),
  CHECK ((state = 'active') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX one_active_session_per_child
  ON learning_sessions(child_id) WHERE state = 'active';
CREATE INDEX learning_sessions_child_time_idx ON learning_sessions(child_id, started_at DESC);

CREATE TABLE session_tasks (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  child_id uuid NOT NULL,
  deck_version_id uuid NOT NULL,
  item_revision_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  exercise_type text NOT NULL,
  direction text,
  state text NOT NULL CHECK (state IN ('issued','answered','completed','skipped')),
  public_prompt jsonb NOT NULL CHECK (jsonb_typeof(public_prompt) = 'object'),
  answer_key jsonb NOT NULL CHECK (jsonb_typeof(answer_key) = 'object'),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, child_id) REFERENCES learning_sessions(id, child_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, deck_version_id) REFERENCES learning_sessions(id, deck_version_id),
  FOREIGN KEY (item_revision_id, deck_version_id) REFERENCES item_revisions(id, deck_version_id),
  UNIQUE (session_id, ordinal),
  UNIQUE (id, child_id),
  UNIQUE (id, item_revision_id),
  CHECK (state <> 'completed' OR exercise_type = 'exposure'),
  CHECK (state <> 'answered' OR exercise_type <> 'exposure')
);
CREATE UNIQUE INDEX one_issued_task_per_session
  ON session_tasks(session_id) WHERE state = 'issued';

CREATE TABLE attempts (
  id uuid PRIMARY KEY,
  child_id uuid NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  item_revision_id uuid NOT NULL,
  client_attempt_id uuid NOT NULL,
  request_hash text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  modality text NOT NULL CHECK (modality IN ('choice','text','audio','dont_remember','skip')),
  state text NOT NULL CHECK (state IN ('processing','completed')),
  answer jsonb, -- tylko tekst/opcja/transkrypcja; żadnych bytes/URL nagrania
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object'),
  feedback jsonb,
  policy_id text NOT NULL REFERENCES learning_policies(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (task_id, child_id) REFERENCES session_tasks(id, child_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, item_revision_id) REFERENCES session_tasks(id, item_revision_id),
  UNIQUE (child_id, client_attempt_id),
  UNIQUE (task_id, attempt_number),
  UNIQUE (id, item_revision_id),
  UNIQUE (id, child_id),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_processing_attempt_per_task ON attempts(task_id) WHERE state='processing';
CREATE INDEX attempts_stale_idx ON attempts(received_at) WHERE state='processing';

CREATE TABLE assessments (
  child_id uuid NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  item_revision_id uuid NOT NULL,
  skill text NOT NULL,
  skill_version_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('correct','incorrect','unassessed')),
  reason text,
  independent boolean NOT NULL,
  confirmation_eligible boolean NOT NULL,
  provider text,
  provider_model text,
  provider_policy_version text,
  score numeric,
  score_scale text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (attempt_id, skill),
  FOREIGN KEY (attempt_id, child_id) REFERENCES attempts(id, child_id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id, item_revision_id) REFERENCES attempts(id, item_revision_id) ON DELETE CASCADE,
  FOREIGN KEY (item_revision_id, skill, skill_version_id)
    REFERENCES item_revision_skills(item_revision_id, skill, skill_version_id),
  CHECK (outcome <> 'unassessed' OR (score IS NULL AND NOT confirmation_eligible)),
  CHECK (score IS NULL OR (provider IS NOT NULL AND score_scale IS NOT NULL))
);
CREATE INDEX assessments_skill_history_idx ON assessments(skill_version_id, attempt_id);
-- Pasma score są właściwe providerowi, bez uniwersalnego 0-100.
-- details może zawierać expectedItemId/answeredItemId dla wiarygodnej pomyłki,
-- wordMatch/lettersCorrect/capitalizationCorrect, powód wsparcia oraz
-- direction (en->pl / pl->en) dla ocen rozpoznawania tekstu.

CREATE TABLE learning_events (
  id uuid PRIMARY KEY,
  child_id uuid NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  item_id uuid NOT NULL REFERENCES learning_items(id),
  client_event_id uuid, -- opcjonalny dla obserwacji klienta; ujawnienie zapisuje serwer
  sealed boolean NOT NULL DEFAULT false,
  step_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('contact','prompt_issued','audio_issued','hint_issued','feedback_issued','display_confirmed','audio_played','presentation_completed')),
  occurred_at timestamptz NOT NULL DEFAULT now(), -- autorytatywny czas serwera
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (task_id, child_id) REFERENCES session_tasks(id, child_id) ON DELETE CASCADE,
  UNIQUE (child_id, client_event_id),
  UNIQUE (id, child_id)
);
CREATE INDEX learning_events_contact_idx ON learning_events(child_id, item_id, occurred_at DESC);
CREATE TABLE event_exposures (
  child_id uuid NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  FOREIGN KEY (event_id, child_id) REFERENCES learning_events(id, child_id) ON DELETE CASCADE,
  target_key text NOT NULL,
  PRIMARY KEY (event_id, target_key)
);
CREATE INDEX event_exposures_target_idx ON event_exposures(target_key, event_id);

CREATE TABLE child_skill_progress (
  child_id uuid NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id),
  status text NOT NULL CHECK (status IN ('unseen','practicing','needs_confirmation','needs_reconfirmation','mastered')),
  independent_success_streak integer NOT NULL DEFAULT 0 CHECK (independent_success_streak >= 0),
  last_reviewed_at timestamptz,
  next_review_at timestamptz,
  delayed_confirmation_at timestamptz,
  projection_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (child_id, skill_version_id)
);
CREATE INDEX child_skill_due_idx ON child_skill_progress(child_id, next_review_at);

-- Reguły niezmienności: historie kasujemy tylko przez usunięcie profilu;
-- wersji kryteriów, polityk i opublikowanych materiałów nie edytujemy.
CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable row in %', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER learning_policies_immutable BEFORE UPDATE OR DELETE ON learning_policies
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER skill_versions_immutable BEFORE UPDATE OR DELETE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION reject_change();

CREATE FUNCTION guard_published_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'published' THEN RAISE EXCEPTION 'Published version is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deck_versions_immutable BEFORE UPDATE OR DELETE ON deck_versions
  FOR EACH ROW EXECUTE FUNCTION guard_published_version();

CREATE FUNCTION guard_revision_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_version uuid; new_version uuid;
BEGIN
  IF TG_TABLE_NAME = 'item_revisions' THEN
    IF TG_OP <> 'INSERT' THEN old_version := OLD.deck_version_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_version := NEW.deck_version_id; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      SELECT deck_version_id INTO old_version FROM learning_app.item_revisions WHERE id=OLD.item_revision_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT deck_version_id INTO new_version FROM learning_app.item_revisions WHERE id=NEW.item_revision_id;
    END IF;
  END IF;
  -- Blokada wiersza wersji serializuje edycję i publikację.
  PERFORM 1 FROM learning_app.deck_versions WHERE id IN (old_version,new_version) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM learning_app.deck_versions WHERE id IN (old_version,new_version) AND state='published')
    THEN RAISE EXCEPTION 'Published revision is immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER item_revisions_immutable BEFORE INSERT OR UPDATE OR DELETE ON item_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_revision_change();
CREATE TRIGGER item_revision_skills_immutable BEFORE INSERT OR UPDATE OR DELETE ON item_revision_skills
  FOR EACH ROW EXECUTE FUNCTION guard_revision_change();
CREATE TRIGGER revision_assets_immutable BEFORE INSERT OR UPDATE OR DELETE ON revision_assets
  FOR EACH ROW EXECUTE FUNCTION guard_revision_change();

CREATE FUNCTION guard_completed_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='completed' THEN RAISE EXCEPTION 'Completed attempt is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','answer','feedback','completed_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','answer','feedback','completed_at']) THEN
    RAISE EXCEPTION 'Attempt identity and qualification context are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attempts_immutable_after_completion BEFORE UPDATE ON attempts
  FOR EACH ROW EXECUTE FUNCTION guard_completed_attempt();
-- Usunięcie profilu ma nadal działać przez CASCADE.
CREATE TRIGGER assessments_no_update BEFORE UPDATE ON assessments
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE FUNCTION guard_ready_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='ready' THEN RAISE EXCEPTION 'Ready media is immutable; create a new generation'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_ready_immutable BEFORE UPDATE OR DELETE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION guard_ready_asset();

CREATE FUNCTION guard_task_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
    RAISE EXCEPTION 'Issued task snapshot is immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND OLD.state <> 'issued' THEN
    RAISE EXCEPTION 'Terminal task cannot be reopened';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_tasks_snapshot BEFORE UPDATE ON session_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_task_snapshot();

CREATE FUNCTION guard_assessment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt_state text;
BEGIN
  SELECT state INTO attempt_state FROM learning_app.attempts WHERE id=NEW.attempt_id FOR UPDATE;
  IF attempt_state IS DISTINCT FROM 'processing' THEN
    RAISE EXCEPTION 'Assessments may only be inserted before attempt finalization';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessments_insert_guard BEFORE INSERT ON assessments
  FOR EACH ROW EXECUTE FUNCTION guard_assessment_insert();

-- Ujawnienie tworzymy wraz z pełną listą target_key, następnie seal w tej samej transakcji.
CREATE FUNCTION guard_event_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed OR NOT NEW.sealed OR
      (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed') THEN
    RAISE EXCEPTION 'Event permits only one sealing transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER learning_events_seal BEFORE UPDATE ON learning_events
  FOR EACH ROW EXECUTE FUNCTION guard_event_seal();
CREATE FUNCTION require_sealed_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM learning_app.learning_events WHERE id=NEW.id AND NOT sealed) THEN
    RAISE EXCEPTION 'Event must be sealed before commit';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER learning_events_sealed_at_commit AFTER INSERT OR UPDATE ON learning_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_sealed_event();
CREATE FUNCTION guard_exposure_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_sealed boolean;
BEGIN
  SELECT sealed INTO event_sealed FROM learning_app.learning_events WHERE id=NEW.event_id FOR UPDATE;
  IF event_sealed IS DISTINCT FROM false THEN RAISE EXCEPTION 'Cannot extend sealed disclosure'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_exposures_insert_guard BEFORE INSERT ON event_exposures
  FOR EACH ROW EXECUTE FUNCTION guard_exposure_insert();
CREATE TRIGGER event_exposures_no_update BEFORE UPDATE ON event_exposures
  FOR EACH ROW EXECUTE FUNCTION reject_change();

-- Kontrolowane usuwanie wyłącznie przez CASCADE po DELETE profilu.
-- Brak flagi sesji SQL pozwalającej aplikacji wyłączyć ochronę.
CREATE FUNCTION guard_history_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM learning_app.child_profiles WHERE id=OLD.child_id) THEN
    RAISE EXCEPTION 'Delete the child profile to erase learning history';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER sessions_delete_guard BEFORE DELETE ON learning_sessions FOR EACH ROW EXECUTE FUNCTION guard_history_delete();
CREATE TRIGGER tasks_delete_guard BEFORE DELETE ON session_tasks FOR EACH ROW EXECUTE FUNCTION guard_history_delete();
CREATE TRIGGER attempts_delete_guard BEFORE DELETE ON attempts FOR EACH ROW EXECUTE FUNCTION guard_history_delete();
CREATE TRIGGER assessments_delete_guard BEFORE DELETE ON assessments FOR EACH ROW EXECUTE FUNCTION guard_history_delete();
CREATE TRIGGER events_delete_guard BEFORE DELETE ON learning_events FOR EACH ROW EXECUTE FUNCTION guard_history_delete();
CREATE TRIGGER exposures_delete_guard BEFORE DELETE ON event_exposures FOR EACH ROW EXECUTE FUNCTION guard_history_delete();

-- Wymagane dodatkowe reguły przypadków użycia (nieudawane CHECK-ami SQL):
-- 1. Publikacja: kryteria wszystkich pięciu umiejętności i gotowe media.
-- 2. Tylko stan published do startu sesji, aktywne przypisanie, brak archive.
-- 3. context i answer_key nigdy nie są automatycznie serializowane do Kid API.
-- 4. Media job dotyczy tylko asset_id; role/fingerprint/kind sprawdzane przy reconcile szkicu.
-- 5. next/submit/disclosures/complete-presentation blokują sesję; ujawnienia zapisują przed odpowiedzią HTTP.
-- 6. Oceny i aktualizacja projekcji w transakcji finalizacji attempt.
-- 7. Edycja opublikowanej treści tworzy nowe item_revisions i mapę skill_versions.
-- 8. Rekonstrukcja postępu nie przepisuje assessments; wersjonuje projekcję.
-- 9. Lease assetu sprawdzany przez CAS przed finalizacją; storage.putImmutable nigdy nie nadpisuje blobu.
-- 10. Brak surowego audio i binarnych danych w JSON; walidacja whitelist pól.
COMMIT;
