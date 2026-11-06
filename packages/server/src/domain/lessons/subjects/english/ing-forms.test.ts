import { describe, expect, it } from "vitest";
import {
  STATE_VERBS,
  baseOfIngForm,
  ingFormOf,
  ingRuleOf,
  ingVerbsByRule,
  isCollocationIngForm,
  isIngFormInTable,
  stateVerbIn,
} from "./ing-forms";

describe("tabela form -ing", () => {
  it("klasy reguł pisowni", () => {
    expect([ingFormOf("play"), ingRuleOf("play")]).toEqual(["playing", "plain"]);
    expect([ingFormOf("do"), ingRuleOf("do")]).toEqual(["doing", "plain"]);
    expect([ingFormOf("write"), ingRuleOf("write")]).toEqual(["writing", "drop_e"]);
    expect([ingFormOf("swim"), ingRuleOf("swim")]).toEqual(["swimming", "double"]);
    expect([ingFormOf("lie"), ingRuleOf("lie")]).toEqual(["lying", "ie_to_y"]);
    expect([ingFormOf("travel"), ingRuleOf("travel")]).toEqual(["travelling", "other"]);
    expect([ingFormOf("fix"), ingFormOf("jump")]).toEqual(["fixing", "jumping"]);
  });

  it("czasowniki pogody („Is it raining now?”)", () => {
    expect([ingFormOf("rain"), ingRuleOf("rain")]).toEqual(["raining", "plain"]);
    expect([ingFormOf("snow"), ingRuleOf("snow")]).toEqual(["snowing", "plain"]);
    expect([ingFormOf("shine"), ingRuleOf("shine")]).toEqual(["shining", "drop_e"]);
  });

  it("czasownik spoza tabeli i czasowniki stanu → undefined", () => {
    expect(ingFormOf("photosynthesise")).toBeUndefined();
    expect(ingRuleOf("photosynthesise")).toBeUndefined();
    expect(STATE_VERBS.has("be")).toBe(false);
    for (const verb of STATE_VERBS) expect(ingFormOf(verb), verb).toBeUndefined();
  });

  it("live i leave poza tabelą — w Present Continuous znaczą „tymczasowo” albo przyszłość", () => {
    for (const verb of ["live", "leave"]) expect(ingFormOf(verb), verb).toBeUndefined();
    for (const form of ["living", "leaving"]) expect(isIngFormInTable(form), form).toBe(false);
    expect(ingVerbsByRule(["drop_e"])).not.toContain("live");
  });

  it("odwrotność i rozpoznanie formy -ing", () => {
    expect(baseOfIngForm("running")).toBe("run");
    expect(baseOfIngForm("lying")).toBe("lie");
    expect(baseOfIngForm("having")).toBeUndefined();
    expect(isIngFormInTable("swimming")).toBe(true);
    for (const word of ["morning", "sing", "thing", "evening", "having"]) {
      expect(isIngFormInTable(word), word).toBe(false);
    }
  });

  it("liczności: tabela ≥ 70, plain/drop_e/double ≥ 5, ie_to_y ≥ 2", () => {
    const all = ingVerbsByRule(["plain", "drop_e", "double", "ie_to_y", "other"]);
    expect(all.length).toBeGreaterThanOrEqual(70);
    expect(new Set(all).size).toBe(all.length);
    for (const rule of ["plain", "drop_e", "double"] as const) {
      expect(ingVerbsByRule([rule]).length, rule).toBeGreaterThanOrEqual(5);
    }
    expect(ingVerbsByRule(["ie_to_y"])).toEqual(["lie", "tie"]);
    expect(ingVerbsByRule([])).toEqual([]);
  });

  it("spójność tabeli: forma zgodna z klasą, formy jednoznaczne", () => {
    const forms = new Set<string>();
    for (const verb of ingVerbsByRule(["plain", "drop_e", "double", "ie_to_y", "other"])) {
      const form = ingFormOf(verb)!;
      const rule = ingRuleOf(verb)!;
      expect(forms.has(form), form).toBe(false);
      forms.add(form);
      expect(baseOfIngForm(form), form).toBe(verb);
      if (rule === "plain") expect(form, verb).toBe(`${verb}ing`);
      if (rule === "drop_e") expect(form, verb).toBe(`${verb.slice(0, -1)}ing`);
      if (rule === "double") expect(form, verb).toBe(`${verb}${verb.at(-1)}ing`);
      if (rule === "ie_to_y") expect(form, verb).toBe(`${verb.slice(0, -2)}ying`);
    }
  });
});

describe("stateVerbIn", () => {
  it("formy i wyjątki", () => {
    expect(stateVerbIn("She likes apples every day.", "any_form")).toBe("like");
    expect(stateVerbIn("I am liking it.", "ing_form")).toBe("like");
    expect(stateVerbIn("She is reading now.", "any_form")).toBeUndefined();
    expect(stateVerbIn("She is having lunch now.", "any_form")).toBeUndefined();
    expect(stateVerbIn("She has breakfast every day.", "any_form")).toBeUndefined();
    expect(stateVerbIn("He is looking at the stars.", "any_form")).toBeUndefined();
    expect(stateVerbIn("Look! Tom is running.", "any_form")).toBeUndefined();
    expect(stateVerbIn("She has a dog.", "any_form")).toBe("have");
    expect(stateVerbIn("I know it now.", "any_form")).toBe("know");
    expect(stateVerbIn("He is being silly.", "ing_form")).toBe("be");
  });

  it("tryb ing_form nie widzi form niebędących -ing", () => {
    expect(stateVerbIn("She likes apples.", "ing_form")).toBeUndefined();
    expect(stateVerbIn("She has a dog.", "ing_form")).toBeUndefined();
    expect(stateVerbIn("She is having a dog.", "ing_form")).toBe("have");
    expect(stateVerbIn("He is being silly.", "any_form")).toBe("be");
  });

  it("kolokacje z have i look, także z przecinkiem po Look", () => {
    expect(stateVerbIn("They have a party now.", "any_form")).toBeUndefined();
    expect(stateVerbIn("He is having a shower.", "any_form")).toBeUndefined();
    expect(stateVerbIn("She is having fun.", "any_form")).toBeUndefined();
    expect(stateVerbIn("He is looking for his cap.", "any_form")).toBeUndefined();
    expect(stateVerbIn("Look, Tom is running.", "any_form")).toBeUndefined();
    expect(stateVerbIn("Tom is running. Look! Ann is jumping.", "any_form")).toBeUndefined();
    expect(stateVerbIn("They look happy.", "any_form")).toBe("look");
    expect(stateVerbIn("They look every day.", "any_form")).toBe("look");
  });

  it("zwraca pierwszy czasownik stanu w kolejności tekstu", () => {
    expect(stateVerbIn("She wants a dog and loves cats.", "any_form")).toBe("want");
    expect(stateVerbIn("She recognises him.", "any_form")).toBe("recognise");
    expect(stateVerbIn("I am forgetting it.", "ing_form")).toBe("forget");
  });

  it("nie łapie zwykłych słów", () => {
    expect(stateVerbIn("The seeds are in the morning sun.", "any_form")).toBeUndefined();
    expect(stateVerbIn("", "any_form")).toBeUndefined();
  });
});

describe("isCollocationIngForm", () => {
  it("having i looking w kolokacjach", () => {
    expect(isCollocationIngForm(["she", "is", "having", "lunch"], 2)).toBe(true);
    expect(isCollocationIngForm(["he", "is", "looking", "for", "it"], 2)).toBe(true);
    expect(isCollocationIngForm(["she", "is", "having", "a", "dog"], 2)).toBe(false);
    expect(isCollocationIngForm(["she", "is", "having", "a", "bath"], 2)).toBe(true);
    expect(isCollocationIngForm(["he", "is", "looking", "happy"], 2)).toBe(false);
    expect(isCollocationIngForm(["she", "is", "liking", "fun"], 2)).toBe(false);
    expect(isCollocationIngForm(["she", "is", "having"], 2)).toBe(false);
  });
});
