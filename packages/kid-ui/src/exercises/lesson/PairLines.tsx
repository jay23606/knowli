"use client";

import { useLayoutEffect, useRef, type ReactElement, type RefObject } from "react";
import { m, useReducedMotion } from "motion/react";
import { kidFadeAnimate, kidFadeInitial, kidFadeTransition } from "../../motion/kid-motion";
import type { PairSide, PairState } from "./assignment-state";

const DOT_RADIUS = 6;
const DOT_RADIUS_SELECTED = 8;

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Punkt zaczepienia kafelka na krawędzi zwróconej do pasa (lewy: prawa krawędź,
 * prawy: lewa) w pikselach wewnętrznych kontenera. `offset*` są wewnętrzne pod CSS
 * `zoom` (jak współrzędne SVG) i ignorują `whileTap` oraz transformacje wejścia;
 * łańcuch `offsetParent` kończy się na kontenerze albo na `null` (jsdom).
 */
function anchorOf(tile: HTMLElement, side: PairSide, container: HTMLElement): Point {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = tile;
  while (node !== null && node !== container) {
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return {
    x: side === "left" ? left + tile.offsetWidth : left,
    y: top + tile.offsetHeight / 2,
  };
}

/**
 * Kropki i linie „Połącz w pary”: dekoracyjna warstwa SVG nad kafelkami. Ma być
 * ostatnim dzieckiem kontenera (`position: relative`), więc refy kafelków są już
 * podpięte, gdy biegnie jej efekt. Współrzędne zapisuje wprost w atrybutach
 * (bez `setState`), żeby po zmianie par nie było klatki ze starymi liniami.
 */
export function PairLines({
  state,
  containerRef,
  tileOf,
}: {
  state: PairState;
  /** Kontener `kid-lesson-pair` (position: relative) — od niego liczone są pozycje. */
  containerRef: RefObject<HTMLElement | null>;
  /** Zarejestrowany kafelek (stabilne refy widoku). */
  tileOf: (side: PairSide, id: string) => HTMLElement | null;
}): ReactElement {
  const reduceMotion = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const layoutRef = useRef<() => void>(() => undefined);

  layoutRef.current = () => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (svg === null || container === null) return;
    const point = (side: PairSide, id: string): Point | null => {
      const tile = tileOf(side, id);
      return tile === null ? null : anchorOf(tile, side, container);
    };
    for (const dot of svg.querySelectorAll("circle[data-side]")) {
      const at = point(dot.getAttribute("data-side") as PairSide, dot.getAttribute("data-item-id") ?? "");
      if (at === null) continue;
      dot.setAttribute("cx", String(at.x));
      dot.setAttribute("cy", String(at.y));
    }
    for (const line of svg.querySelectorAll("line[data-left-id]")) {
      const from = point("left", line.getAttribute("data-left-id") ?? "");
      const to = point("right", line.getAttribute("data-right-id") ?? "");
      if (from === null || to === null) continue;
      line.setAttribute("x1", String(from.x));
      line.setAttribute("y1", String(from.y));
      line.setAttribute("x2", String(to.x));
      line.setAttribute("y2", String(to.y));
    }
  };

  // Jeden obserwator na czas życia warstwy: zmiana rozmiaru kontenera lub kafelków
  // (zawijanie tekstu, obrót, zoom) przelicza współrzędne; nigdy sam SVG (pętla).
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef(new WeakSet<Element>());
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => layoutRef.current());
    observerRef.current = observer;
    observedRef.current = new WeakSet();
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  // Po każdym renderze: pary i zaznaczenie zmieniają liczbę i klasy elementów SVG,
  // a kafelek mógł zostać podpięty lub ponownie zamontowany — dopisz go do obserwatora.
  useLayoutEffect(() => {
    const observer = observerRef.current;
    if (observer !== null) {
      const watch = (element: Element | null) => {
        if (element === null || observedRef.current.has(element)) return;
        observedRef.current.add(element);
        observer.observe(element);
      };
      watch(containerRef.current);
      for (const item of state.left) watch(tileOf("left", item.id));
      for (const item of state.right) watch(tileOf("right", item.id));
    }
    layoutRef.current();
  });

  const dots = [
    ...state.left.map((item) => ({ side: "left" as const, id: item.id })),
    ...state.right.map((item) => ({ side: "right" as const, id: item.id })),
  ];
  const pairedIds = {
    left: new Set(state.pairs.keys()),
    right: new Set(state.pairs.values()),
  };

  return (
    <svg
      ref={svgRef}
      className="kid-lesson-pair__lines"
      data-testid="kid-lesson-match-lines"
      aria-hidden="true"
    >
      {[...state.pairs].map(([leftId, rightId]) => {
        // Linia zaznaczonego kafelka w parze jest grubsza (spec §5.4): skrzyżowane linie
        // długich opisów da się wtedy prześledzić.
        const { selected } = state;
        const emphasised = selected !== null && selected.id === (selected.side === "left" ? leftId : rightId);
        return (
          <m.line
            key={`${leftId}:${rightId}`}
            data-testid="kid-lesson-match-line"
            data-left-id={leftId}
            data-right-id={rightId}
            className={`kid-lesson-pair__line${emphasised ? " kid-lesson-pair__line--selected" : ""}`}
            x1={0}
            y1={0}
            x2={0}
            y2={0}
            initial={reduceMotion ? false : kidFadeInitial}
            animate={kidFadeAnimate}
            transition={kidFadeTransition}
          />
        );
      })}
      {dots.map(({ side, id }) => {
        const selected = state.selected?.side === side && state.selected.id === id;
        const paired = pairedIds[side].has(id);
        const modifier = selected ? " kid-lesson-pair__dot--selected" : paired ? " kid-lesson-pair__dot--paired" : "";
        return (
          <circle
            key={`${side}:${id}`}
            data-testid="kid-lesson-match-dot"
            data-side={side}
            data-item-id={id}
            className={`kid-lesson-pair__dot${modifier}`}
            r={selected ? DOT_RADIUS_SELECTED : DOT_RADIUS}
            cx={0}
            cy={0}
          />
        );
      })}
    </svg>
  );
}
