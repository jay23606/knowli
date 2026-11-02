import { describe, expect, it } from "vitest";
import {
  addToGroup, clearPairSelection, groupAssignments, groupComplete, groupPool, groupState, itemsIn, matchAssignments,
  matchComplete, matchPool, matchState, pairAssignments, pairComplete, pairOf, pairState, placeRight, removeFromGroup,
  rightOf, selectGroup, selectSlot, tapPairItem, type PairSide, type PairState,
} from "./assignment-state";

const item = (id: string) => ({ id, text: id.toUpperCase() });

describe("stan „Połącz w pary”", () => {
  const start = matchState([item("l1"), item("l2"), item("l3")], [item("r1"), item("r2"), item("r3"), item("rx")]);

  it("pierwsze miejsce aktywne; wstawienie przesuwa aktywne do następnego pustego", () => {
    expect(start.active).toBe("l1");
    const next = placeRight(start, "r2");
    expect(rightOf(next, "l1")?.id).toBe("r2");
    expect(next.active).toBe("l2");
    expect(matchPool(next).map((entry) => entry.id)).toEqual(["r1", "r3", "rx"]);
  });

  it("dotknięcie zajętego miejsca oddaje element i czyni miejsce aktywnym; po końcu wraca do pierwszego pustego", () => {
    let state = placeRight(placeRight(placeRight(start, "r1"), "r2"), "r3");
    expect(matchComplete(state)).toBe(true);
    expect(state.active).toBeNull();
    state = selectSlot(state, "l2");
    expect(state.active).toBe("l2");
    expect(rightOf(state, "l2")).toBeNull();
    expect(matchComplete(state)).toBe(false);
    state = placeRight(state, "rx");
    expect(matchAssignments(state)).toEqual([
      { itemId: "l1", targetId: "r1" }, { itemId: "l2", targetId: "rx" }, { itemId: "l3", targetId: "r3" },
    ]);
  });

  it("ignoruje element spoza puli i brak aktywnego miejsca", () => {
    const placed = placeRight(start, "r1");
    expect(placeRight(placed, "r1")).toBe(placed);
    const full = placeRight(placeRight(placed, "r2"), "r3");
    expect(placeRight(full, "rx")).toBe(full);
  });
});

describe("stan „Pogrupuj”", () => {
  const start = groupState([item("g1"), item("g2")], [item("a"), item("b"), item("c"), item("d")]);

  it("dodaje do aktywnej grupy, przełącza grupę i oddaje element do puli", () => {
    let state = addToGroup(start, "a");
    state = addToGroup(selectGroup(state, "g2"), "c");
    expect(itemsIn(state, "g1").map((entry) => entry.id)).toEqual(["a"]);
    expect(itemsIn(state, "g2").map((entry) => entry.id)).toEqual(["c"]);
    state = removeFromGroup(state, "a");
    expect(groupPool(state).map((entry) => entry.id)).toEqual(["a", "b", "d"]);
  });

  it("komplet przypisań w kolejności elementów zadania", () => {
    let state = addToGroup(addToGroup(start, "b"), "a");
    state = addToGroup(addToGroup(selectGroup(state, "g2"), "d"), "c");
    expect(groupComplete(state)).toBe(true);
    expect(groupAssignments(state)).toEqual([
      { itemId: "a", targetId: "g1" }, { itemId: "b", targetId: "g1" }, { itemId: "c", targetId: "g2" }, { itemId: "d", targetId: "g2" },
    ]);
  });
});

describe("stan „Połącz linią”", () => {
  const start = pairState([item("l1"), item("l2"), item("l3")], [item("r1"), item("r2"), item("r3"), item("rx")]);
  const taps = (state: PairState, ...steps: Array<[PairSide, string]>) =>
    steps.reduce((acc, [side, id]) => tapPairItem(acc, side, id), state);

  it("zaznacza dowolny kafelek bez zmiany par", () => {
    const selected = tapPairItem(start, "right", "r2");
    expect(selected.selected).toEqual({ side: "right", id: "r2" });
    expect(selected.pairs.size).toBe(0);
    const paired = taps(start, ["left", "l1"], ["right", "r1"]);
    const again = tapPairItem(paired, "left", "l1");
    expect(again.selected).toEqual({ side: "left", id: "l1" });
    expect(pairOf(again, "left", "l1")?.id).toBe("r1");
  });

  it("ponowne stuknięcie zaznaczonego zdejmuje zaznaczenie", () => {
    const state = taps(start, ["left", "l2"], ["left", "l2"]);
    expect(state.selected).toBeNull();
    expect(state.pairs.size).toBe(0);
  });

  it("stuknięcie w tej samej kolumnie przenosi zaznaczenie, pary bez zmian", () => {
    const paired = taps(start, ["left", "l1"], ["right", "r1"]);
    const state = taps(paired, ["left", "l2"], ["left", "l1"]);
    expect(state.selected).toEqual({ side: "left", id: "l1" });
    expect(pairOf(state, "left", "l1")?.id).toBe("r1");
    expect(state.pairs.size).toBe(1);
  });

  it("stuknięcie w drugiej kolumnie łączy w obu kierunkach", () => {
    const state = taps(start, ["left", "l1"], ["right", "r2"], ["right", "r3"], ["left", "l2"]);
    expect([...state.pairs]).toEqual([["l1", "r2"], ["l2", "r3"]]);
    expect(state.selected).toBeNull();
  });

  it("replaces pairs of both tiles", () => {
    const paired = taps(start, ["left", "l1"], ["right", "r1"], ["left", "l2"], ["right", "r2"]);
    const state = taps(paired, ["left", "l1"], ["right", "r2"]);
    expect([...state.pairs]).toEqual([["l1", "r2"]]);
    expect(pairOf(state, "right", "r1")).toBeNull();
    expect(pairOf(state, "left", "l2")).toBeNull();
    expect(pairOf(state, "right", "r2")?.id).toBe("l1");
    expect(state.selected).toBeNull();
  });

  it("nieznane id i strona bez elementu nie zmieniają stanu", () => {
    expect(tapPairItem(start, "left", "r1")).toBe(start);
    expect(tapPairItem(start, "right", "nope")).toBe(start);
  });

  it("clearPairSelection zdejmuje tylko zaznaczenie", () => {
    const paired = taps(start, ["left", "l1"], ["right", "r1"], ["left", "l2"]);
    const cleared = clearPairSelection(paired);
    expect(cleared.selected).toBeNull();
    expect(cleared.pairs).toEqual(paired.pairs);
    expect(clearPairSelection(cleared)).toBe(cleared);
  });

  it("komplet przy wolnym dystraktorze; przypisania w kolejności lewej kolumny", () => {
    const two = taps(start, ["left", "l3"], ["right", "r3"], ["left", "l1"], ["right", "r1"]);
    expect(pairComplete(two)).toBe(false);
    const all = taps(two, ["left", "l2"], ["right", "rx"]);
    expect(pairComplete(all)).toBe(true);
    expect(pairAssignments(all)).toEqual([
      { itemId: "l1", targetId: "r1" }, { itemId: "l2", targetId: "rx" }, { itemId: "l3", targetId: "r3" },
    ]);
  });
});
