-- #318: normalizeTokens usuwał minus, więc „-5” i „5” dawały w cache werdyktów
-- lekcji ten sam klucz `normalized_answer`. Wiersz „5” mógł nieść werdykt (albo
-- ręczną decyzję rodzica) wydany dla „-5”. Po poprawce normalizatora usuwamy
-- wpisy cache przedmiotu szkolnego z cyfrą w odpowiedzi — zostaną ocenione
-- ponownie; ręczne decyzje rodzica w tych wierszach przepadają (decyzja
-- właściciela 2026-11-06). Inne przedmioty zostają bez zmian.
-- Ręcznie pisany SQL: snapshoty drizzle po 0017 są znanym długiem.
DELETE FROM "learning_app"."lesson_verdicts" AS v
USING "learning_app"."item_revisions" AS r, "learning_app"."deck_versions" AS dv
WHERE v."item_revision_id" = r."id"
  AND r."deck_version_id" = dv."id"
  AND dv."lesson_context"->>'subjectId' = 'school'
  AND v."normalized_answer" ~ '[0-9]';
