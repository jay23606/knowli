// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderKid } from "../../test/render-kid";
import { PairLines } from "./PairLines";
import { pairState, type PairSide, type PairState } from "./assignment-state";

const motionFlags = vi.hoisted(() => ({ reduce: false }));
vi.mock("motion/react", async (orig) => ({
  ...(await orig<typeof import("motion/react")>()),
  useReducedMotion: () => motionFlags.reduce,
}));

const item = (id: string) => ({ id, text: id });

function stateWith(pairs: Array<[string, string]>, selected: PairState["selected"] = null): PairState {
  const base = pairState([item("l1"), item("l2"), item("l3")], [item("r1"), item("r2"), item("r3"), item("r4")]);
  return { ...base, pairs: new Map(pairs), selected };
}

function renderLines(state: PairState) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const tiles = new Map<string, HTMLElement>();
  for (const side of ["left", "right"] as const) {
    for (const entry of side === "left" ? state.left : state.right) {
      const tile = document.createElement("div");
      container.appendChild(tile);
      tiles.set(`${side}:${entry.id}`, tile);
    }
  }
  const containerRef = createRef<HTMLElement>();
  (containerRef as { current: HTMLElement | null }).current = container;
  const tileOf = (side: PairSide, id: string) => tiles.get(`${side}:${id}`) ?? null;
  return renderKid(<PairLines state={state} containerRef={containerRef} tileOf={tileOf} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  motionFlags.reduce = false;
});

describe("PairLines", () => {
  it("rysuje kropkę dla każdego kafelka i linię dla każdej pary", () => {
    const { container } = renderLines(stateWith([["l1", "r2"], ["l3", "r1"]]));
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-testid")).toBe("kid-lesson-match-lines");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toBe("kid-lesson-pair__lines");
    expect(svg?.hasAttribute("viewBox")).toBe(false);
    expect(svg?.hasAttribute("preserveAspectRatio")).toBe(false);
    expect(container.querySelectorAll("[data-testid='kid-lesson-match-dot']")).toHaveLength(7);
    const lines = [...container.querySelectorAll("[data-testid='kid-lesson-match-line']")];
    expect(lines.map((line) => [line.getAttribute("data-left-id"), line.getAttribute("data-right-id")])).toEqual([
      ["l1", "r2"],
      ["l3", "r1"],
    ]);
  });

  it("kropki w parze i zaznaczona mają swoje klasy i promień", () => {
    const { container } = renderLines(stateWith([["l1", "r2"]], { side: "right", id: "r3" }));
    const dot = (side: string, id: string) =>
      container.querySelector(`[data-testid='kid-lesson-match-dot'][data-side='${side}'][data-item-id='${id}']`)!;
    expect(dot("right", "r3").getAttribute("class")).toContain("kid-lesson-pair__dot--selected");
    expect(dot("right", "r3").getAttribute("r")).toBe("8");
    for (const [side, id] of [["left", "l1"], ["right", "r2"]]) {
      expect(dot(side, id).getAttribute("class")).toContain("kid-lesson-pair__dot--paired");
      expect(dot(side, id).getAttribute("r")).toBe("6");
    }
    for (const [side, id] of [["left", "l2"], ["left", "l3"], ["right", "r1"], ["right", "r4"]]) {
      expect(dot(side, id).getAttribute("class")).toBe("kid-lesson-pair__dot");
      expect(dot(side, id).getAttribute("r")).toBe("6");
    }
  });

  it("działa bez ResizeObserver (jsdom) i przy zerowych offsetach", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { container } = renderLines(stateWith([["l1", "r2"]]));
    expect(container.querySelector("[data-testid='kid-lesson-match-dot']")?.getAttribute("cx")).toBe("0");
    expect(container.querySelector("[data-testid='kid-lesson-match-line']")?.getAttribute("x1")).toBe("0");
  });

  it("kotwiczy kropki i linię na krawędziach kafelków zwróconych do pasa", () => {
    const state = stateWith([["l1", "r2"]]);
    const container = document.createElement("div");
    const place = (offsetLeft: number, offsetTop: number, offsetWidth: number, offsetHeight: number) => {
      const tile = document.createElement("div");
      for (const [key, value] of Object.entries({ offsetLeft, offsetTop, offsetWidth, offsetHeight })) {
        Object.defineProperty(tile, key, { value, configurable: true });
      }
      return tile;
    };
    const tiles = new Map([
      ["left:l1", place(0, 10, 100, 40)],
      ["right:r2", place(160, 70, 200, 60)],
    ]);
    const containerRef = createRef<HTMLElement>();
    (containerRef as { current: HTMLElement | null }).current = container;
    const { container: view } = renderKid(
      <PairLines state={state} containerRef={containerRef} tileOf={(side, id) => tiles.get(`${side}:${id}`) ?? null} />,
    );
    const dot = (side: string, id: string) =>
      view.querySelector(`[data-testid='kid-lesson-match-dot'][data-side='${side}'][data-item-id='${id}']`)!;
    expect([dot("left", "l1").getAttribute("cx"), dot("left", "l1").getAttribute("cy")]).toEqual(["100", "30"]);
    expect([dot("right", "r2").getAttribute("cx"), dot("right", "r2").getAttribute("cy")]).toEqual(["160", "100"]);
    const line = view.querySelector("[data-testid='kid-lesson-match-line']")!;
    expect(["x1", "y1", "x2", "y2"].map((name) => line.getAttribute(name))).toEqual(["100", "30", "160", "100"]);
    // Kafelek bez zarejestrowanego elementu zostaje na domyślnych współrzędnych.
    expect(dot("left", "l2").getAttribute("cx")).toBe("0");
  });

  it("linia wchodzi przez przezroczystość, a przy ograniczeniu ruchu od razu", () => {
    motionFlags.reduce = false;
    const first = renderLines(stateWith([["l1", "r2"]]));
    expect(first.container.querySelector("[data-testid='kid-lesson-match-line']")?.getAttribute("style")).toContain(
      "opacity: 0",
    );
    first.unmount();
    cleanup();

    motionFlags.reduce = true;
    const second = renderLines(stateWith([["l1", "r2"]]));
    const style = second.container.querySelector("[data-testid='kid-lesson-match-line']")?.getAttribute("style") ?? "";
    expect(style).not.toContain("opacity: 0");
  });
});
