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

  it("rejects degenerate outlines", () => {
    expect(roof3dFromPolygon(shape([[0, 0], [5, 0]]))).toBeNull();
    // a 30 m line has no north–south extent to build from
    expect(roof3dFromPolygon(shape([[0, 0], [30, 0], [15, 0.01]]))).toBeNull();
  });
});
