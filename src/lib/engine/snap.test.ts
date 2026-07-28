import { describe, expect, it } from "vitest";
import { fromLocalMeters, toLocalMeters } from "./roof";
import { cornerAngleDeg, snapRightAngles, squareNextPoint } from "./snap";
import type { LatLng } from "./types";

const ORIGIN = { lat: 13.75, lng: 100.5 }; // Bangkok
const ll = (x: number, y: number): LatLng => fromLocalMeters(ORIGIN, x, y);
const shape = (pts: [number, number][]) => pts.map(([x, y]) => ll(x, y));

/** Interior corner angles (deg) of a polygon, in vertex order. */
function angles(poly: LatLng[]): number[] {
  const { pts } = toLocalMeters(poly);
  const n = pts.length;
  return pts.map((_, i) => cornerAngleDeg(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]));
}

describe("live snap while drawing", () => {
  it("squares an 81° corner and keeps the drawn segment length", () => {
    const placed = [ll(0, 10), ll(0, 0)];
    const out = squareNextPoint(placed, ll(10, 1.5));
    const { pts } = toLocalMeters([...placed, out]);
    expect(cornerAngleDeg(pts[0], pts[1], pts[2])).toBeCloseTo(90, 3);
    // segment length preserved (10, 1.5) → 10.11 m
    expect(Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y)).toBeCloseTo(Math.hypot(10, 1.5), 2);
  });

  it("keeps the side the user clicked towards", () => {
    const placed = [ll(0, 10), ll(0, 0)];
    const right = toLocalMeters([...placed, squareNextPoint(placed, ll(10, 1.5))]);
    const left = toLocalMeters([...placed, squareNextPoint(placed, ll(-10, 1.5))]);
    expect(right.pts[2].x - right.pts[1].x).toBeGreaterThan(0);
    expect(left.pts[2].x - left.pts[1].x).toBeLessThan(0);
  });

  it("leaves a deliberate 45° corner alone", () => {
    const placed = [ll(0, 10), ll(0, 0)];
    const target = ll(10, 10);
    expect(squareNextPoint(placed, target)).toBe(target);
  });

  it("is a no-op for the first two points", () => {
    const target = ll(5, 5);
    expect(squareNextPoint([], target)).toBe(target);
    expect(squareNextPoint([ll(0, 0)], target)).toBe(target);
  });
});

describe("squaring a finished outline", () => {
  it("turns a hand-drawn quad into exact right angles, including the closing corner", () => {
    const wonky = shape([[0, 0], [12, 0.9], [11.0, 8.9], [-0.6, 8.2]]);
    expect(angles(wonky).every((a) => Math.abs(a - 90) > 0.1)).toBe(true);
    for (const a of angles(snapRightAngles(wonky))) expect(a).toBeCloseTo(90, 2);
  });

  it("preserves a deliberate 45° cut corner", () => {
    const cut = shape([[0, 0], [10, 0], [10, 6], [6, 10], [0, 10]]);
    const out = snapRightAngles(cut);
    const before = toLocalMeters(cut).pts;
    const after = toLocalMeters(out).pts;
    after.forEach((p, i) => {
      expect(p.x).toBeCloseTo(before[i].x, 6);
      expect(p.y).toBeCloseTo(before[i].y, 6);
    });
  });

  it("does not touch a shape with no square-ish corner", () => {
    const tri = shape([[0, 0], [10, 0], [5, 8.66]]); // equilateral, 60° corners
    expect(snapRightAngles(tri)).toBe(tri);
  });

  it("abandons the correction when it would drag a corner metres away", () => {
    // 40 m long roof with one end wall 15° out — inside the corner tolerance,
    // but the long lever arm would move the corner 5.5 m
    const skewed = shape([[0, 0], [40, 0], [40, 17], [0, 6]]);
    expect(snapRightAngles(skewed)).toBe(skewed);
  });

  it("leaves fewer than 3 points untouched", () => {
    const line = shape([[0, 0], [5, 0]]);
    expect(snapRightAngles(line)).toBe(line);
  });
});
