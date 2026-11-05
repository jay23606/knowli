-- Agent puli lekcji, etap 2a (spec 2026-11-04 §8.1): punkt kontrolny runu puli
-- lekcji. W trakcie próby — postęp (`kind: "progress"`: zagadnienia, ćwiczenia,
-- przykłady, temat, wydatek budżetu i histogram kodów odrzuceń); po zapisie do
-- szkicu — podsumowanie bez treści (`kind: "summary"`). Wspólny materiał lekcji,
-- bez danych dziecka. NULL — run bez agenta, anulowany albo sprzed migracji.
-- Ręcznie pisany SQL: snapshoty drizzle po 0017 są znanym długiem.
ALTER TABLE "learning_app"."generation_runs" ADD COLUMN "agent_checkpoint" jsonb;
