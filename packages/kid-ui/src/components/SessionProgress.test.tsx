// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderKid, screen } from "../test/render-kid";
import { PEBBLE_LIMIT, SessionProgress } from "./SessionProgress";

afterEach(cleanup);

describe("SessionProgress", () => {
  it("renders one hidden pebble per assessed task with done and current states", () => {
    renderKid(<SessionProgress remaining={null} total={5} done={2} />);
    const row = screen.getByTestId("kid-progress-pebbles");
    expect(row.getAttribute("aria-hidden")).toBe("true");
    const pebbles = [...row.querySelectorAll("[data-testid='kid-progress-pebble']")];
    expect(pebbles.map((pebble) => pebble.getAttribute("data-state")))
      .toEqual(["done", "done", "current", "upcoming", "upcoming"]);
    expect(screen.queryByTestId("kid-remaining")).toBeNull();
    expect(screen.queryByTestId("kid-progress-fill")).toBeNull();
  });

  it("falls back to a continuous bar above the pebble limit", () => {
    expect(PEBBLE_LIMIT).toBe(20);
    renderKid(<SessionProgress remaining={null} total={21} done={5} />);
    expect(screen.queryByTestId("kid-progress-pebble")).toBeNull();
    expect(screen.getByTestId("kid-progress-fill")).toBeTruthy();
  });

  it("keeps the remaining label as the accessible text next to the pebbles", () => {
    renderKid(<SessionProgress remaining={2} total={20} done={18} />);
    const label = screen.getByTestId("kid-remaining");
    expect(label.textContent).toContain("2");
    expect(label.getAttribute("aria-hidden")).toBeNull();
    expect(screen.getAllByTestId("kid-progress-pebble")).toHaveLength(20);
    expect(screen.getByTestId("kid-progress-pebbles").contains(label)).toBe(false);
    expect(screen.queryByTestId("kid-streak-star")).toBeNull();
  });

  it("closing story label says Jeszcze N i historyjka!", () => {
    renderKid(<SessionProgress remaining={2} total={6} done={4} closingStory />);
    expect(screen.getByTestId("kid-remaining").textContent).toBe("Jeszcze 2 i historyjka!");
  });

  it("default label stays Jeszcze N i koniec!", () => {
    const { rerender } = renderKid(<SessionProgress remaining={3} total={6} done={3} />);
    expect(screen.getByTestId("kid-remaining").textContent).toBe("Jeszcze 3 i koniec!");
    rerender(<SessionProgress remaining={3} total={6} done={3} closingStory={false} />);
    expect(screen.getByTestId("kid-remaining").textContent).toBe("Jeszcze 3 i koniec!");
  });

  it("drops a hidden star when a streak milestone is reached", () => {
    renderKid(<SessionProgress remaining={null} total={5} done={3} milestone={1} />);
    const star = screen.getByTestId("kid-streak-star");
    expect(star.getAttribute("aria-hidden")).toBe("true");
    const pebbles = screen.getAllByTestId("kid-progress-pebble");
    expect(pebbles[2]!.contains(star)).toBe(true);
  });

  it("plays the star entrance when a milestone moves it to a new pebble", () => {
    const { rerender } = renderKid(<SessionProgress remaining={null} total={6} done={0} />);
    rerender(<SessionProgress remaining={null} total={6} done={3} milestone={1} />);
    const star = screen.getByTestId("kid-streak-star");
    expect(screen.getAllByTestId("kid-progress-pebble")[2]!.contains(star)).toBe(true);
    // Skipping the entrance would start the star on its last, invisible keyframe.
    expect(star.style.transform).not.toContain("-26px");
    expect(star.style.transform).toContain("scale(0.3)");
  });

  it("does not replay a star that was already shown when the progress mounts", () => {
    renderKid(<SessionProgress remaining={null} total={6} done={3} milestone={1} />);
    expect(screen.getByTestId("kid-streak-star").style.transform).not.toContain("scale(0.3)");
  });

  it("shows no current pebble when the session is done", () => {
    renderKid(<SessionProgress remaining={null} total={4} done={4} />);
    const states = screen.getAllByTestId("kid-progress-pebble").map((pebble) => pebble.getAttribute("data-state"));
    expect(states).toEqual(["done", "done", "done", "done"]);
  });

  it("shows an empty bar before the session size is known", () => {
    renderKid(<SessionProgress remaining={null} />);
    expect(screen.queryByTestId("kid-progress-pebble")).toBeNull();
    expect(screen.getByTestId("kid-progress-fill")).toBeTruthy();
  });
});
