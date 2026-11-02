// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderKid } from "../../test/render-kid";
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

/** Kontenery dołączone do `document.body` przez `renderLines` — usuwane po każdym teście. */
const attached: HTMLElement[] = [];

function renderLines(state: PairState) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  attached.push(container);
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
  for (const node of attached.splice(0)) node.remove();
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

  it("linia zaznaczonego kafelka w parze jest wyróżniona — zaznaczenie po lewej i po prawej", () => {
    const lineClasses = (state: PairState) => {
      const { container, unmount } = renderLines(state);
      const classes = [...container.querySelectorAll("[data-testid='kid-lesson-match-line']")]
        .map((line) => [line.getAttribute("data-left-id"), line.getAttribute("class")]);
      unmount();
      return classes;
    };
    const pairs: Array<[string, string]> = [["l1", "r2"], ["l3", "r1"]];
    expect(lineClasses(stateWith(pairs))).toEqual([["l1", "kid-lesson-pair__line"], ["l3", "kid-lesson-pair__line"]]);
    expect(lineClasses(stateWith(pairs, { side: "left", id: "l1" }))).toEqual([
      ["l1", "kid-lesson-pair__line kid-lesson-pair__line--selected"], ["l3", "kid-lesson-pair__line"],
    ]);
    expect(lineClasses(stateWith(pairs, { side: "right", id: "r1" }))).toEqual([
      ["l1", "kid-lesson-pair__line"], ["l3", "kid-lesson-pair__line kid-lesson-pair__line--selected"],
    ]);
    // Wolny zaznaczony kafelek nie wyróżnia żadnej linii, także gdy jego id pokrywa się z drugą stroną pary.
    expect(lineClasses(stateWith(pairs, { side: "right", id: "r4" }))).toEqual([
      ["l1", "kid-lesson-pair__line"], ["l3", "kid-lesson-pair__line"],
    ]);
    expect(lineClasses(stateWith(pairs, { side: "left", id: "l2" }))).toEqual([
      ["l1", "kid-lesson-pair__line"], ["l3", "kid-lesson-pair__line"],
    ]);
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

  it("obserwuje kontener i każdy kafelek (także podpięty później), nigdy SVG; przelicza po zmianie rozmiaru", () => {
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      readonly observed: Element[] = [];
      disconnected = false;
      constructor(readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this);
      }
      observe(target: Element) {
        this.observed.push(target);
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const state = stateWith([["l1", "r2"]]);
    const container = document.createElement("div");
    const place = (offsetTop: number) => {
      const tile = document.createElement("div");
      for (const [key, value] of Object.entries({ offsetLeft: 0, offsetTop, offsetWidth: 100, offsetHeight: 40 })) {
        Object.defineProperty(tile, key, { value, configurable: true });
      }
      return tile;
    };
    const tiles = new Map<string, HTMLElement>([
      ["left:l1", place(10)],
      ["right:r2", place(70)],
    ]);
    const containerRef = createRef<HTMLElement>();
    (containerRef as { current: HTMLElement | null }).current = container;
    const tileOf = (side: PairSide, id: string) => tiles.get(`${side}:${id}`) ?? null;
    const view = renderKid(<PairLines state={state} containerRef={containerRef} tileOf={tileOf} />);

    expect(FakeResizeObserver.instances).toHaveLength(1);
    const observer = FakeResizeObserver.instances[0]!;
    expect(observer.observed).toEqual([container, tiles.get("left:l1"), tiles.get("right:r2")]);

    // Kafelek zarejestrowany po pierwszym renderze (np. ponownie zamontowany) też jest obserwowany, bez duplikatów.
    tiles.set("left:l2", place(130));
    view.rerender(<PairLines state={state} containerRef={containerRef} tileOf={tileOf} />);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(observer.observed).toEqual([container, tiles.get("left:l1"), tiles.get("right:r2"), tiles.get("left:l2")]);
    expect(observer.observed.some((target) => target instanceof SVGElement)).toBe(false);

    const line = view.container.querySelector("[data-testid='kid-lesson-match-line']")!;
    expect(line.getAttribute("y1")).toBe("30");
    Object.defineProperty(tiles.get("left:l1")!, "offsetTop", { value: 50, configurable: true });
    act(() => observer.callback([], observer as unknown as ResizeObserver));
    expect(line.getAttribute("y1")).toBe("70");

    view.unmount();
    expect(observer.disconnected).toBe(true);
  });
});
