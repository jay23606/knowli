import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { DeckDtoSchema, LessonDeckDtoSchema, messages } from "@learning/contracts";
import { lessonAgentRunSummary } from "./helpers/lesson-agent-run";
import { closeWorldDatabase, worldPool } from "./helpers/world-database";
import { loginParent } from "./helpers/parent-session";

/**
 * E2E zakładki „Źródła” na prawdziwej bazie, workerze i fałszywych providerach
 * (Etap 2, design 2026-10-30 §3.4, §8): rodzic zapisuje źródło (fikcyjny
 * rozdział), tworzy z niego lekcję rozdziału (formularz bez pola materiału,
 * polecenie z `sourceMaterialId`), czeka na generację workera (fake-agent puli:
 * plan zagadnień słów i ram z pokrycia materiału) i publikuje
 * lekcję, widzi w edytorze „Ze źródła”, po edycji tekstu źródła — notkę
 * o zmianie, a po jego usunięciu opublikowana lekcja zostaje z własną kopią
 * tekstu, bez odnośnika. Efekt sprawdzany w interfejsie, w API rodzica i w bazie
 * (`decks.source_material_id`, kontekst wersji zestawu).
 *
 * Etap 4 (design §6.2, §8 „Słówka ze źródła”): z tego samego rodzaju źródła
 * rodzic tworzy zestaw słówek („Utwórz zestaw słówek”, polecenie
 * z `sourceMaterialId` i zawężeniem), worker z fałszywym LLM słówek (domyślnie: słowa
 * z tekstu) wypełnia szkic, edytor pokazuje słówka z tekstu i „Ze źródła”,
 * zestaw jest na stronie źródła, a po edycji tekstu — notka o zmianie przy
 * niezmienionym zestawie.
 */

test.afterAll(closeWorldDatabase);

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Fikcyjny rozdział: słowa i dwie ramy zdaniowe (bez fragmentów podręcznika). */
const CHAPTER_BODY = [
  "Zagadnienie 1: Ubrania",
  "coat, boots, dress, skirt, t-shirt",
  "Zagadnienie 2: Pogoda",
  "It's raining. It's snowing. What's the weather like?",
  "Zagadnienie 3: Co mam na sobie",
  "I'm wearing a coat. I'm wearing boots.",
].join("\n");
const ADDED_LINE = "It's sunny today.";

interface StoredDeck {
  source_material_id: string | null;
  source_material_revision: number | null;
}

test("rodzic tworzy źródło, lekcję rozdziału, publikuje ją, edytuje i usuwa źródło — lekcja zostaje z własną kopią", async ({ page }) => {
  const title = `Rozdział ${randomUUID().slice(0, 8)}: Ubrania i pogoda`;
  const pool = await worldPool();
  await loginParent(page);

  // 1. Nowe źródło: okno z tytułem i tekstem, po zapisie — strona źródła.
  await page.goto("/parent/sources");
  await expect(page.getByTestId("sources-panel")).toBeVisible();
  const createdSource = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/parent/sources"),
  );
  await page.getByTestId("new-source-open").click();
  await expect(page.getByTestId("new-source-dialog")).toBeVisible();
  await expect(page.getByTestId("source-create-submit")).toBeDisabled();
  await page.getByTestId("source-title").fill(title);
  await page.getByTestId("source-body").fill(CHAPTER_BODY);
  await page.getByTestId("source-create-submit").click();
  expect((await createdSource).status()).toBe(201);
  await expect(page).toHaveURL(new RegExp(`/parent/sources/${UUID}$`));
  const sourceId = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByTestId("source-heading")).toHaveText(title);
  await expect(page.getByTestId("source-preview")).toHaveValue(/coat, boots, dress, skirt, t-shirt/);
  await expect(page.getByTestId("source-no-decks")).toBeVisible();

  // Źródło jest na liście (z prawdziwej bazy) i wraca po przeładowaniu strony.
  await page.reload();
  await expect(page.getByTestId("source-heading")).toHaveText(title);
  await page.getByTestId("source-back").click();
  await expect(page).toHaveURL(/\/parent\/sources$/);
  const row = page.locator(`[data-source-id="${sourceId}"]`);
  await expect(row).toContainText(title);
  await expect(row).toContainText(messages.sources.deckCount.many!.replace("{n}", "0"));

  // 2. „Utwórz lekcję rozdziału”: formularz z podglądem źródła, bez pola materiału.
  await row.click();
  await page.getByTestId("source-create-chapter").click();
  await expect(page).toHaveURL(new RegExp(`/parent/lessons/new\\?source=${sourceId}&subject=english_chapter$`));
  await expect(page.getByTestId("new-lesson-form")).toBeVisible();
  await expect(page.getByTestId("lesson-subject")).toHaveValue("english_chapter");
  await expect(page.getByTestId("lesson-material")).toHaveCount(0);
  await expect(page.getByTestId("lesson-source")).toContainText(messages.sources.fromSource.replace("{title}", title));
  await expect(page.getByTestId("lesson-source-preview")).toHaveValue(/I'm wearing a coat\./);
  await expect(page.getByTestId("material-topic-name")).toHaveValue(title);
  await page.getByTestId("lesson-pool-size").fill("40");

  const lessonRequest = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/api/v1/parent/lessons/material"),
  );
  const lessonResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/parent/lessons/material"),
  );
  await page.getByTestId("lesson-create-submit").click();
  const command = (await lessonRequest).postDataJSON() as Record<string, unknown>;
  // Polecenie niesie odwołanie do źródła zamiast tekstu — serwer kopiuje jego bieżącą treść.
  expect(command).toMatchObject({ subjectId: "english_chapter", sourceMaterialId: sourceId });
  expect(command).not.toHaveProperty("material");
  const accepted = await lessonResponse;
  expect(accepted.status()).toBe(202);
  const { deckId } = (await accepted.json()) as { deckId: string };

  // 3. Edytor: generacja workera kończy się, a nagłówek wskazuje źródło.
  await expect(page).toHaveURL(new RegExp(`/parent/decks/${deckId}$`));
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  const note = page.getByTestId("lesson-source-note");
  await expect(note).toContainText(messages.sources.fromSource.replace("{title}", title));
  await expect(page.getByTestId("lesson-source-changed")).toHaveCount(0);
  await expect(page.getByTestId("generation-banner")).toBeHidden({ timeout: 120_000 });
  await expect(page.locator('[data-testid^="objective-group-"]').first()).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('[data-testid^="exercise-"]').first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("generation-failed")).toHaveCount(0);

  const afterCreate = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
  expect(afterCreate.source).toEqual({ id: sourceId, title, copiedRevision: 1, currentRevision: 1 });
  expect(afterCreate.draft?.exercises.length).toBeGreaterThan(0);
  // Pulę generuje fake-agent workera (etap 3 #237): planer dzieli pokrycie materiału na zagadnienia
  // z rodzajem (słowa albo rama; ten materiał bez sekcji „Zwroty:” daje same słowa), każde zagadnienie
  // kończy się z ćwiczeniami, a kierownik niczego nie odrzuca.
  const objectives = afterCreate.draft?.dynamicTopic?.objectives ?? [];
  expect(objectives.length).toBeGreaterThanOrEqual(2);
  expect(objectives.every((objective) => objective.kind === "words" || objective.kind === "frame")).toBe(true);
  for (const objective of objectives) {
    expect(afterCreate.draft!.exercises.some((exercise) => exercise.objectiveId === objective.id), objective.id).toBe(true);
  }
  const agentRun = await lessonAgentRunSummary(pool, deckId);
  expect(agentRun.kind).toBe("summary");
  expect(Object.keys(agentRun.objectives).sort()).toEqual(objectives.map((objective) => objective.id).sort());
  expect(Object.values(agentRun.objectives).every((objective) => objective.status === "complete" && objective.accepted > 0)).toBe(true);
  expect(agentRun.rejectionCodes).toEqual({});

  // Baza: odnośnik i rewizja źródła przy zestawie oraz kopia tekstu w kontekście wersji.
  const storedLesson = async () => {
    const { rows: decks } = await pool.query<StoredDeck>(
      "select source_material_id, source_material_revision from learning_app.decks where id = $1", [deckId],
    );
    const { rows: versions } = await pool.query<{ material: string }>(
      "select lesson_context->>'material' as material from learning_app.deck_versions where deck_id = $1", [deckId],
    );
    return { deck: decks[0], materials: versions.map((version) => version.material) };
  };
  const created = await storedLesson();
  expect(created.deck).toEqual({ source_material_id: sourceId, source_material_revision: 1 });
  expect(created.materials).toEqual([CHAPTER_BODY]);

  // 3a. Publikacja lekcji ze źródła (design §8: źródło → lekcja rozdziału → publikacja).
  await expect(page.getByTestId("publish-lesson")).toBeEnabled({ timeout: 120_000 });
  const published = page.waitForResponse((r) =>
    r.request().method() === "POST" && /\/api\/v1\/parent\/lesson-drafts\/.+\/publish$/.test(new URL(r.url()).pathname),
  );
  await page.getByTestId("publish-lesson").click();
  expect((await published).ok()).toBe(true);
  await expect(page.getByTestId("publish-status")).toBeVisible();
  const afterPublish = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
  expect(afterPublish.state).toBe("published");
  expect(afterPublish.published?.exercises.length).toBe(afterCreate.draft?.exercises.length);
  // publikacja nie zmienia pochodzenia: ta sama kopia i rewizja treści źródła
  expect(afterPublish.source).toEqual({ id: sourceId, title, copiedRevision: 1, currentRevision: 1 });
  expect((await storedLesson()).materials).toEqual([CHAPTER_BODY]);

  // 4. Strona źródła pokazuje opublikowany zestaw bez znacznika zmiany; edycja dopisuje linię do tekstu.
  await page.getByTestId("lesson-source-link").click();
  await expect(page).toHaveURL(new RegExp(`/parent/sources/${sourceId}$`));
  await expect(page.getByTestId("source-deck-0")).toHaveAttribute("data-deck-id", deckId);
  await expect(page.getByTestId("source-deck-0")).toContainText(messages.decks.states.published!);
  await expect(page.getByTestId("source-deck-stale-0")).toHaveCount(0);
  await page.getByTestId("source-edit").click();
  await page.getByTestId("source-body").fill(`${CHAPTER_BODY}\n${ADDED_LINE}`);
  const patched = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/v1/parent/sources/${sourceId}`),
  );
  await page.getByTestId("source-save").click();
  expect((await patched).status()).toBe(200);
  await expect(page.getByTestId("source-status")).toHaveText(messages.sources.saved);
  await expect(page.getByTestId("source-preview")).toHaveValue(`${CHAPTER_BODY}\n${ADDED_LINE}`);
  await expect(page.getByTestId("source-deck-stale-0")).toHaveText(messages.sources.sourceChanged);

  // 5. Lekcja ma własną kopię: edytor pokazuje notkę zmiany, a tekst lekcji się nie zmienia.
  await page.getByTestId("source-deck-0").click();
  await expect(page).toHaveURL(new RegExp(`/parent/decks/${deckId}$`));
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(page.getByTestId("lesson-source-note")).toContainText(messages.sources.fromSource.replace("{title}", title));
  await expect(page.getByTestId("lesson-source-changed")).toHaveText(messages.sources.sourceChanged);
  const afterEdit = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
  expect(afterEdit.source).toEqual({ id: sourceId, title, copiedRevision: 1, currentRevision: 2 });
  const edited = await storedLesson();
  expect(edited.deck).toEqual({ source_material_id: sourceId, source_material_revision: 1 });
  expect(edited.materials).toEqual([CHAPTER_BODY]);

  // 6. Usunięcie źródła z potwierdzeniem podającym liczbę zestawów.
  await page.getByTestId("lesson-source-link").click();
  await expect(page).toHaveURL(new RegExp(`/parent/sources/${sourceId}$`));
  await page.getByTestId("source-delete").click();
  await expect(page.getByTestId("source-delete-dialog")).toContainText(messages.sources.deleteConfirm.replace("{n}", "1"));
  const deleted = page.waitForResponse(
    (r) => r.request().method() === "DELETE" && r.url().endsWith(`/api/v1/parent/sources/${sourceId}`),
  );
  await page.getByTestId("source-delete-confirm").click();
  expect((await deleted).status()).toBe(204);
  await expect(page).toHaveURL(/\/parent\/sources$/);
  await expect(page.locator(`[data-source-id="${sourceId}"]`)).toHaveCount(0);
  expect((await page.request.get(`/api/v1/parent/sources/${sourceId}`)).status()).toBe(404);

  // 7. Lekcja zostaje z treścią i własną kopią tekstu, ale bez odnośnika do źródła.
  await page.goto(`/parent/decks/${deckId}`);
  await expect(page.getByTestId("lesson-editor")).toBeVisible();
  await expect(page.locator('[data-testid^="exercise-"]').first()).toBeVisible();
  await expect(page.getByTestId("lesson-source-note")).toHaveCount(0);
  await expect(page.getByTestId("lesson-source-link")).toHaveCount(0);
  const afterDelete = LessonDeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/lessons/${deckId}`)).json());
  expect(afterDelete.source).toBeUndefined();
  expect(afterDelete.state).toBe("published");
  expect(afterDelete.published?.exercises.length).toBe(afterPublish.published?.exercises.length);
  const removed = await storedLesson();
  expect(removed.deck?.source_material_id).toBeNull();
  expect(removed.materials).toEqual([CHAPTER_BODY]);
});

/** Fikcyjny tekst o pogodzie i ubraniach (Etap 4: słówka ze źródła). */
const VOCABULARY_BODY = [
  "Weather and clothes",
  "It's cold and windy today. I'm wearing a coat, a scarf and boots.",
  "Look, it's snowing! My sister is wearing gloves.",
].join("\n");
/**
 * Fałszywy LLM w trybie materiału wypisuje kolejne różne słowa tekstu
 * (≥ 3 litery, bez słów funkcyjnych i skrótów z apostrofem) do `maxItems`;
 * tekst ma ich 12, formularz prosi o 8 — reszta nie trafia do zestawu.
 */
const VOCABULARY_MAX_ITEMS = 8;
const EXPECTED_TARGETS = ["weather", "clothes", "cold", "windy", "wearing", "coat", "scarf", "boots"];
const VOCABULARY_INSTRUCTION = "tylko ubrania i pogoda";

test("rodzic tworzy ze źródła zestaw słówek — słowa z tekstu, notka „Ze źródła”, zestaw na stronie źródła", async ({ page }) => {
  const title = `Rozdział ${randomUUID().slice(0, 8)}: Weather and clothes`;
  const pool = await worldPool();
  await loginParent(page);

  // Źródło przez API rodzica (zapis źródła w UI pokrywa test wyżej).
  const createdSource = await page.request.post("/api/v1/parent/sources", {
    data: { clientRequestId: randomUUID(), title, body: VOCABULARY_BODY },
  });
  expect(createdSource.status()).toBe(201);
  const { id: sourceId } = (await createdSource.json()) as { id: string };

  // 1. Strona źródła → „Utwórz zestaw słówek” → formularz z podglądem tekstu.
  await page.goto(`/parent/sources/${sourceId}`);
  await expect(page.getByTestId("source-heading")).toHaveText(title);
  await expect(page.getByTestId("source-no-decks")).toBeVisible();
  await expect(page.getByTestId("source-create-vocabulary")).toHaveText(messages.sources.createVocabulary);
  await page.getByTestId("source-create-vocabulary").click();
  await expect(page).toHaveURL(new RegExp(`/parent/vocabulary/new\\?source=${sourceId}$`));
  await expect(page.getByTestId("new-vocabulary-form")).toBeVisible();
  await expect(page.getByTestId("new-vocabulary-source")).toContainText(messages.sources.fromSource.replace("{title}", title));
  await expect(page.getByTestId("new-vocabulary-source-preview")).toHaveValue(VOCABULARY_BODY);
  await expect(page.getByTestId("new-vocabulary-title")).toHaveValue(title);
  await expect(page.getByTestId("new-vocabulary-format")).toHaveValue("standard");
  await page.getByTestId("new-vocabulary-max-items").fill(String(VOCABULARY_MAX_ITEMS));
  await page.getByTestId("new-vocabulary-instruction").fill(VOCABULARY_INSTRUCTION);

  const generateRequest = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/api/v1/parent/decks/generate"),
  );
  const generateResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/parent/decks/generate"),
  );
  await page.getByTestId("new-vocabulary-submit").click();
  const command = (await generateRequest).postDataJSON() as Record<string, unknown>;
  // Polecenie niesie odwołanie do źródła i rewizję podglądu, a nie tekst ani opis.
  expect(command).toMatchObject({
    sourceMaterialId: sourceId, expectedSourceRevision: 1, instruction: VOCABULARY_INSTRUCTION,
    maxItems: VOCABULARY_MAX_ITEMS, vocabularyFormat: "standard",
  });
  expect(command).not.toHaveProperty("prompt");
  expect(command).not.toHaveProperty("material");
  expect(command).not.toHaveProperty("locales");
  const accepted = await generateResponse;
  expect(accepted.status()).toBe(202);
  const { deckId, generationRunId } = (await accepted.json()) as { deckId: string; generationRunId: string };

  // 2. Edytor zestawu: worker kończy generację, słówka pochodzą z tekstu, notka wskazuje źródło.
  await expect(page).toHaveURL(new RegExp(`/parent/decks/${deckId}$`));
  await expect(page.getByTestId("editor-title")).toHaveValue(title);
  await expect(page.getByTestId("lesson-source-note")).toContainText(messages.sources.fromSource.replace("{title}", title));
  await expect(page.getByTestId("lesson-source-changed")).toHaveCount(0);
  await expect(page.getByTestId(`item-card-${VOCABULARY_MAX_ITEMS - 1}`)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId(`item-card-${VOCABULARY_MAX_ITEMS}`)).toHaveCount(0);
  await expect(page.getByTestId("generation-banner")).toBeHidden();
  await expect(page.getByTestId("generation-failed")).toHaveCount(0);
  // fałszywy LLM zwraca wyłącznie słowa z tekstu, więc nic nie pominięto
  await expect(page.getByTestId("vocabulary-rejected-count")).toHaveCount(0);
  for (const [index, target] of EXPECTED_TARGETS.entries()) {
    await expect(page.getByTestId(`item-target-${index}`)).toHaveValue(target);
  }
  await expect(page.getByTestId("item-example-5")).toHaveValue("I'm wearing a coat, a scarf and boots.");

  const deck = DeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/decks/${deckId}`)).json());
  expect(deck.source).toEqual({ id: sourceId, title, copiedRevision: 1, currentRevision: 1 });
  expect(deck.generation).toMatchObject({ id: generationRunId, state: "succeeded", rejectedCount: 0 });
  const textWords = new Set(VOCABULARY_BODY.toLowerCase().split(/[^\p{L}']+/u));
  const targets = deck.draft?.items.map((item) => item.target) ?? [];
  expect(targets).toEqual(EXPECTED_TARGETS);
  for (const target of targets) expect(textWords.has(target), target).toBe(true);

  // Baza: odnośnik i rewizja źródła przy zestawie; run niesie kopię tekstu i zawężenie, bez opisu.
  const storedVocabulary = async () => {
    const { rows: decks } = await pool.query<StoredDeck>(
      "select source_material_id, source_material_revision from learning_app.decks where id = $1", [deckId],
    );
    const { rows: runs } = await pool.query<{ input: Record<string, unknown>; rejected_count: number | null; state: string }>(
      "select input, rejected_count, state from learning_app.generation_runs where id = $1", [generationRunId],
    );
    return { deck: decks[0], run: runs[0] };
  };
  const created = await storedVocabulary();
  expect(created.deck).toEqual({ source_material_id: sourceId, source_material_revision: 1 });
  expect(created.run).toMatchObject({ state: "succeeded", rejected_count: 0 });
  expect(created.run?.input).toMatchObject({
    mode: "material", material: VOCABULARY_BODY, instruction: VOCABULARY_INSTRUCTION, deckId,
    maxItems: VOCABULARY_MAX_ITEMS, locales: { source: "pl-PL", target: "en-GB" },
  });
  expect(created.run?.input).not.toHaveProperty("prompt");

  // 3. Strona źródła wymienia zestaw słówek bez znacznika zmiany.
  await page.getByTestId("lesson-source-link").click();
  await expect(page).toHaveURL(new RegExp(`/parent/sources/${sourceId}$`));
  await expect(page.getByTestId("source-deck-0")).toHaveAttribute("data-deck-id", deckId);
  await expect(page.getByTestId("source-deck-0")).toContainText(title);
  await expect(page.getByTestId("source-deck-0")).toContainText(messages.lessons.kindLabel.vocabulary!);
  await expect(page.getByTestId("source-deck-stale-0")).toHaveCount(0);

  // 4. Edycja tekstu źródła: strona i edytor pokazują „źródło zmieniono”, zestaw zostaje bez zmian.
  await page.getByTestId("source-edit").click();
  await page.getByTestId("source-body").fill(`${VOCABULARY_BODY}\nIt's sunny now.`);
  const patched = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/v1/parent/sources/${sourceId}`),
  );
  await page.getByTestId("source-save").click();
  expect((await patched).status()).toBe(200);
  await expect(page.getByTestId("source-status")).toHaveText(messages.sources.saved);
  await expect(page.getByTestId("source-deck-stale-0")).toHaveText(messages.sources.sourceChanged);
  await page.getByTestId("source-deck-0").click();
  await expect(page).toHaveURL(new RegExp(`/parent/decks/${deckId}$`));
  await expect(page.getByTestId("lesson-source-changed")).toHaveText(messages.sources.sourceChanged);
  await expect(page.getByTestId("item-target-0")).toHaveValue(EXPECTED_TARGETS[0]!);
  const afterEdit = DeckDtoSchema.parse(await (await page.request.get(`/api/v1/parent/decks/${deckId}`)).json());
  expect(afterEdit.source).toEqual({ id: sourceId, title, copiedRevision: 1, currentRevision: 2 });
  expect(afterEdit.draft?.items.map((item) => item.target)).toEqual(EXPECTED_TARGETS);
  const edited = await storedVocabulary();
  expect(edited.deck).toEqual({ source_material_id: sourceId, source_material_revision: 1 });
  expect(edited.run?.input).toMatchObject({ material: VOCABULARY_BODY });
});
