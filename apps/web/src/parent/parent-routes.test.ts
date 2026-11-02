import { describe, expect, it } from "vitest";
import { routeFromPath, routePath, type ParentRoute } from "./parent-routes";

const DECK_ID = "3f2c1a9e-5b7d-4c8e-9a1b-2c3d4e5f6a7b";
const SOURCE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

describe("parent routes", () => {
  it("reads sections from their addresses", () => {
    expect(routeFromPath("/parent/decks")).toEqual({ section: "decks" });
    expect(routeFromPath("/parent/children/")).toEqual({ section: "children" });
    expect(routeFromPath("/parent/progress")).toEqual({ section: "progress" });
    expect(routeFromPath("/parent/work-card")).toEqual({ section: "work-card" });
    expect(routeFromPath("/parent/sources")).toEqual({ section: "sources" });
    expect(routeFromPath("/parent/costs")).toEqual({ section: "costs" });
  });

  it("builds the costs address", () => {
    expect(routePath({ section: "costs" })).toBe("/parent/costs");
  });

  it("reads an open deck and the new lesson form", () => {
    expect(routeFromPath(`/parent/decks/${DECK_ID}`)).toEqual({ section: "decks", deckId: DECK_ID });
    expect(routeFromPath(`/parent/decks/${DECK_ID.toUpperCase()}`)).toEqual({ section: "decks", deckId: DECK_ID });
    expect(routeFromPath("/parent/lessons/new")).toEqual({ section: "decks", newLesson: true });
  });

  it("reads an open source", () => {
    expect(routeFromPath(`/parent/sources/${SOURCE_ID}`)).toEqual({ section: "sources", sourceId: SOURCE_ID });
    expect(routeFromPath(`/parent/sources/${SOURCE_ID.toUpperCase()}/`)).toEqual({ section: "sources", sourceId: SOURCE_ID });
  });

  it("reads the new lesson form from a source with the chosen subject", () => {
    expect(routeFromPath(`/parent/lessons/new?source=${SOURCE_ID}&subject=english_chapter`))
      .toEqual({ section: "decks", newLesson: true, sourceId: SOURCE_ID, subjectId: "english_chapter" });
    expect(routeFromPath(`/parent/lessons/new?subject=school&source=${SOURCE_ID.toUpperCase()}`))
      .toEqual({ section: "decks", newLesson: true, sourceId: SOURCE_ID, subjectId: "school" });
    expect(routeFromPath(`/parent/lessons/new?source=${SOURCE_ID}`))
      .toEqual({ section: "decks", newLesson: true, sourceId: SOURCE_ID });
  });

  it("ignores invalid and unknown query parameters", () => {
    expect(routeFromPath("/parent/lessons/new?source=nie-uuid&subject=english_chapter"))
      .toEqual({ section: "decks", newLesson: true, subjectId: "english_chapter" });
    expect(routeFromPath(`/parent/lessons/new?source=${SOURCE_ID}&subject=Zły%20przedmiot`))
      .toEqual({ section: "decks", newLesson: true, sourceId: SOURCE_ID });
    expect(routeFromPath(`/parent/lessons/new?source=${SOURCE_ID}&subject=${"x".repeat(65)}`))
      .toEqual({ section: "decks", newLesson: true, sourceId: SOURCE_ID });
    expect(routeFromPath("/parent/lessons/new?utm=x")).toEqual({ section: "decks", newLesson: true });
    expect(routeFromPath("/parent/lessons/new?")).toEqual({ section: "decks", newLesson: true });
    // parametry innych widoków nie mają znaczenia
    expect(routeFromPath(`/parent/decks?source=${SOURCE_ID}`)).toEqual({ section: "decks" });
    expect(routeFromPath(`/parent/sources?source=${SOURCE_ID}`)).toEqual({ section: "sources" });
  });

  it("reads and writes the new vocabulary deck form from a source", () => {
    expect(routeFromPath(`/parent/vocabulary/new?source=${SOURCE_ID}`))
      .toEqual({ section: "decks", newVocabulary: true, sourceId: SOURCE_ID });
    expect(routeFromPath(`/parent/vocabulary/new?source=${SOURCE_ID.toUpperCase()}&utm=x`))
      .toEqual({ section: "decks", newVocabulary: true, sourceId: SOURCE_ID });
    expect(routePath({ section: "decks", newVocabulary: true, sourceId: SOURCE_ID }))
      .toBe(`/parent/vocabulary/new?source=${SOURCE_ID}`);
  });

  it("has no new vocabulary view without a valid source (the form needs one)", () => {
    expect(routeFromPath("/parent/vocabulary/new")).toBeNull();
    expect(routeFromPath("/parent/vocabulary/new?")).toBeNull();
    expect(routeFromPath("/parent/vocabulary/new?source=nie-uuid")).toBeNull();
    expect(routeFromPath(`/parent/vocabulary/new?source=${SOURCE_ID}x`)).toBeNull();
    expect(routeFromPath(`/parent/vocabulary/new?subject=english_chapter`)).toBeNull();
    expect(routeFromPath("/parent/vocabulary")).toBeNull();
    expect(routeFromPath(`/parent/vocabulary/new/${SOURCE_ID}`)).toBeNull();
    // bez źródła adres formularza nie istnieje, więc nie ma go z czego zapisać jako widoku
    expect(routeFromPath(routePath({ section: "decks", newVocabulary: true }))).toBeNull();
  });

  it("has no view for the panel root and unknown addresses", () => {
    expect(routeFromPath("/parent")).toBeNull();
    expect(routeFromPath("/parent/")).toBeNull();
    expect(routeFromPath("/parent/unknown")).toBeNull();
    expect(routeFromPath("/parent/decks/extra")).toBeNull();
    expect(routeFromPath(`/parent/children/${DECK_ID}`)).toBeNull();
    expect(routeFromPath(`/parent/decks/${DECK_ID}/edit`)).toBeNull();
    expect(routeFromPath("/parent/lessons")).toBeNull();
    expect(routeFromPath("/parent/sources/new")).toBeNull();
    expect(routeFromPath(`/parent/sources/${SOURCE_ID}/edit`)).toBeNull();
    expect(routeFromPath("/kids/x/learn")).toBeNull();
  });

  it("writes the new lesson form from a source with query parameters", () => {
    expect(routePath({ section: "decks", newLesson: true, sourceId: SOURCE_ID, subjectId: "english_chapter" }))
      .toBe(`/parent/lessons/new?source=${SOURCE_ID}&subject=english_chapter`);
    expect(routePath({ section: "sources", sourceId: SOURCE_ID })).toBe(`/parent/sources/${SOURCE_ID}`);
  });

  it("round-trips every view", () => {
    const routes: ParentRoute[] = [
      { section: "decks" },
      { section: "sources" },
      { section: "children" },
      { section: "progress" },
      { section: "work-card" },
      { section: "decks", deckId: DECK_ID },
      { section: "decks", newLesson: true },
      { section: "decks", newLesson: true, sourceId: SOURCE_ID },
      { section: "decks", newLesson: true, subjectId: "school" },
      { section: "decks", newLesson: true, sourceId: SOURCE_ID, subjectId: "english_chapter" },
      { section: "decks", newVocabulary: true, sourceId: SOURCE_ID },
      { section: "sources", sourceId: SOURCE_ID },
    ];
    for (const route of routes) {
      expect(routeFromPath(routePath(route))).toEqual(route);
    }
  });
});
