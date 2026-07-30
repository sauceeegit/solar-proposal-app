import { describe, expect, it } from "vitest";
import { fromLocalMeters } from "./roof";
import { roof3dFromPolygon } from "./roof3d";
import type { LatLng } from "./types";

const ORIGIN = { lat: 7.8376, lng: 98.2997 }; // Phuket
const ll = (x: number, y: number): LatLng => fromLocalMeters(ORIGIN, x, y);
const shape = (pts: [number, number][]) => pts.map(([x, y]) => ll(x, y));

describe("roof outline → 3D model payload", () => {
  it("reports the east–west and north–south extents in metres", () => {
    const roof = shape([[0, 0], [30, 0], [30, 20], [0, 20]]);
    const out = roof3dFromPolygon(roof)!;
    expect(out.widthM).toBeCloseTo(30, 1);
    expect(out.lengthM).toBeCloseTo(20, 1);
  });

  it("normalises to 0..1 with v pointing north", () => {
    const roof = shape([[0, 0], [30, 0], [30, 20], [0, 20]]);
    const { outline } = roof3dFromPolygon(roof)!;
    expect(outline).toHaveLength(4);
    for (const [u, v] of outline) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // the two northern corners are the ones at y = 20, and north is v = 1
    const north = outline.filter(([, v]) => v > 0.5);
    expect(north).toHaveLength(2);
    // south-west corner sits at the origin of the plan frame
    expect(outline[0][0]).toBeCloseTo(0, 3);
    expect(outline[0][1]).toBeCloseTo(0, 3);
  });

  it("keeps an L-shape's notch rather than squaring it off", () => {
    const lShape = shape([[0, 0], [30, 0], [30, 10], [12, 10], [12, 24], [0, 24]]);
    const out = roof3dFromPolygon(lShape)!;
    expect(out.outline).toHaveLength(6);
    expect(out.widthM).toBeCloseTo(30, 1);
    expect(out.lengthM).toBeCloseTo(24, 1);
    // the notch corner is at 12/30 east, 10/24 north
    expect(out.outline[3][0]).toBeCloseTo(12 / 30, 2);
    expect(out.outline[3][1]).toBeCloseTo(10 / 24, 2);
  });

  it("preserves the roof's real aspect ratio, so 3D matches the drawing", () => {
    const wide = roof3dFromPolygon(shape([[0, 0], [40, 0], [40, 8], [0, 8]]))!;
    expect(wide.widthM / wide.lengthM).toBeCloseTo(5, 1);
  });

  it("reports a north-aligned roof as on-axis", () => {
    expect(roof3dFromPolygon(shape([[0, 0], [30, 0], [30, 20], [0, 20]]))!.offAxisDeg).toBeCloseTo(0, 1);
  });

  it("measures how far an angled roof is off the compass axes", () => {
    for (const deg of [12, 35, 58, 104]) {
      const a = (deg * Math.PI) / 180;
      const src: [number, number][] = [[0, 0], [30, 0], [30, 12], [0, 12]];
      const rotated = shape(src.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]));
      // the grid is square and edges are undirected, so the answer folds into 0..45°
      const folded = Math.min(deg % 90, 90 - (deg % 90));
      expect(roof3dFromPolygon(rotated)!.offAxisDeg).toBeCloseTo(folded, 0);
    }
  });

  it("normalises obstructions against the roof's box, not their own", () => {
    const roof = shape([[0, 0], [40, 0], [40, 20], [0, 20]]);
    // a 4 x 4 m box whose centre sits at 10 m east, 5 m north
    const tank = shape([[8, 3], [12, 3], [12, 7], [8, 7]]);
    const out = roof3dFromPolygon(roof, [tank])!;
    expect(out.obstructions).toHaveLength(1);
    const uv = out.obstructions[0];
    const cu = uv.reduce((s, [u]) => s + u, 0) / 4;
    const cv = uv.reduce((s, [, v]) => s + v, 0) / 4;
    expect(cu).toBeCloseTo(10 / 40, 2); // NOT 0.5 — that would be its own box
    expect(cv).toBeCloseTo(5 / 20, 2);
    // and it keeps its real 4 x 4 m shape: 0.1 of a 40 m width, 0.2 of a 20 m length
    expect(Math.max(...uv.map(([u]) => u)) - Math.min(...uv.map(([u]) => u))).toBeCloseTo(0.1, 2);
    expect(Math.max(...uv.map(([, v]) => v)) - Math.min(...uv.map(([, v]) => v))).toBeCloseTo(0.2, 2);
  });

  it("drops obstructions that fall outside the roof", () => {
    const roof = shape([[0, 0], [20, 0], [20, 20], [0, 20]]);
    const inside = shape([[8, 8], [12, 8], [12, 12], [8, 12]]);
    const milesAway = shape([[200, 200], [204, 200], [204, 204], [200, 204]]);
    expect(roof3dFromPolygon(roof, [inside, milesAway])!.obstructions).toHaveLength(1);
  });

  it("has no obstructions when none were drawn", () => {
    const roof = shape([[0, 0], [20, 0], [20, 20], [0, 20]]);
    expect(roof3dFromPolygon(roof)!.obstructions).toEqual([]);
    expect(roof3dFromPolygon(roof, [])!.obstructions).toEqual([]);
  });

  it("rejects degenerate outlines", () => {
    expect(roof3dFromPolygon(shape([[0, 0], [5, 0]]))).toBeNull();
    // a 30 m line has no north–south extent to build from
    expect(roof3dFromPolygon(shape([[0, 0], [30, 0], [15, 0.01]]))).toBeNull();
  });
});
