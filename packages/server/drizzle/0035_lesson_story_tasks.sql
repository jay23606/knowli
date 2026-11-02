-- Historyjka na koniec sesji lekcji (design „Historyjka lekcji” §8): zadanie
-- `lesson_story` jest prezentacją kończoną `complete-presentation` jak karta
-- (stan `completed`), a `lesson_story_question` kończy się stanem `answered`
-- jak zamknięte zadania lekcji. Dlatego CHECK dopuszcza `completed` tylko dla
-- ekspozycji, karty i historyjki — pytanie historyjki zostaje poza listą.
ALTER TABLE "learning_app"."session_tasks" DROP CONSTRAINT "session_tasks_completed_only_exposure";--> statement-breakpoint
ALTER TABLE "learning_app"."session_tasks" ADD CONSTRAINT "session_tasks_completed_only_exposure" CHECK ("learning_app"."session_tasks"."state" <> 'completed' or "learning_app"."session_tasks"."exercise_type" in ('exposure', 'lesson_card', 'lesson_story'));
