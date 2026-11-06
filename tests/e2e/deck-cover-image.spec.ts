import { expect, test } from "@playwright/test";
import { installKidUiFixture } from "./helpers/kid-ui-fixture";
import { pictureVocabularyFixture } from "./helpers/picture-fixtures";
import { randomUUID } from "node:crypto";
import { openNewMaterial } from "./helpers/parent-new-material";
import { fillParentAuth } from "./helpers/parent-session";

test("rodzic podgląda propozycję, może ją odrzucić i dopiero po akceptacji zapisuje okładkę", async ({ page }) => {
  test.slow();
  await page.goto("/parent");
  await fillParentAuth(page);
  await page.getByTestId("auth-submit").click();
  await page.getByTestId("tab-decks").click();
  await openNewMaterial(page, "generate");
  const title = `Okładka ${randomUUID().slice(0, 8)}`;
  await page.getByTestId("deck-prompt").fill("angielskie dni tygodnia dla początkującego dziecka");
  await page.getByTestId("deck-title").fill(title);
  await page.getByTestId("generate-submit").click();
  await expect(page.getByTestId("editor-title")).toHaveValue(title, { timeout: 120_000 });
  await expect(page.getByTestId("item-source-0")).toBeVisible({ timeout: 120_000 });

  await page.getByTestId("deck-cover-generate").click();
  await expect(page.getByTestId("generated-cover-preview")).toBeVisible();
  await expect(page.getByTestId("deck-cover-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Odrzuć" }).click();
  await expect(page.getByTestId("generated-cover-preview")).toHaveCount(0);
  await expect(page.getByTestId("deck-cover-empty")).toBeVisible();

  await page.getByTestId("deck-cover-generate").click();
  await expect(page.getByTestId("generated-cover-preview")).toBeVisible();
  await page.getByRole("button", { name: "Ustaw jako okładkę" }).click();
  await expect(page.getByTestId("deck-cover-preview")).toHaveAttribute("src", /\/api\/v1\/media\//);
});

test("dedykowana okładka wygrywa z wizualizacją słowa bez utraty informacji karty", async ({ page }) => {
  const fixture = pictureVocabularyFixture();
  fixture.decks = [
    { ...fixture.decks[0]!, coverAssetId: "10000000-0000-4000-8000-000000000099" },
    fixture.decks[1]!,
  ];
  await installKidUiFixture(page, fixture);
  await page.goto("/");
  await page.getByTestId("kid-profile").click();

  const covered = page.getByTestId("kid-deck-card").first();
  await expect(covered.getByTestId("kid-deck-cover")).toHaveAttribute("src", "/api/v1/media/10000000-0000-4000-8000-000000000099");
  await expect(covered.locator(".kid-visual")).toHaveCount(0);
  await expect(covered.getByTestId("kid-deck-title")).toContainText("Kolory");
  await expect(covered.getByTestId("kid-deck-stars")).toBeVisible();
  await expect(covered.getByTestId("kid-deck")).toBeVisible();

  const fallback = page.getByTestId("kid-deck-card").nth(1);
  await expect(fallback.locator(".kid-visual")).toBeVisible();
});
