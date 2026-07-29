import { describe, expect, it } from "vitest";
import { fitRectangle, rectangleOvershoot } from "./rect";
import { fromLocalMeters, packPanels, polygonAreaM2, toLocalMeters } from "./roof";
import { cornerAngleDeg } from "./snap";
import { PACKING } from "@/config/assumptions";
import type { LatLng } from "./types";

const ORIGIN = { lat: 7.8376, lng: 98.2997 }; // Phuket
const ll = (x: number, y: number): LatLng => fromLocalMeters(ORIGIN, x, y);
const shape = (pts: [number, number][]) => pts.map(([x, y]) => ll(x, y));
const areaOf = (poly: LatLng[]) => polygonAreaM2(toLocalMeters(poly).pts);

describe("rectangular footprint assumption", () => {
  it("turns a wonky quad into a true rectangle that contains it", () => {
    const wonky = shape([[0, 0], [30, 1.2], [28.6, 20.4], [-1.1, 19.1]]);
    const rect = fitRectangle(wonky);
    expect(rect).toHaveLength(4);
    const { pts } = toLocalMeters(rect);
    for (let i = 0; i < 4; i++) {
      expect(cornerAngleDeg(pts[(i + 3) % 4], pts[i], pts[(i + 1) % 4])).toBeCloseTo(90, 3);
    }
    // it encloses, so it is never smaller than what was drawn
    expect(areaOf(rect)).toBeGreaterThanOrEqual(areaOf(wonky) - 0.5);
    expect(rectangleOvershoot(wonky, rect)).toBeLessThan(0.1);
  });

  it("leaves an already-rectangular outline essentially unchanged", () => {
    const rect = shape([[0, 0], [30, 0], [30, 20], [0, 20]]);
    expect(rectangleOvershoot(rect, fitRectangle(rect))).toBeLessThan(0.001);
  });

  it("follows the building's own orientation, not north", () => {
    // 30 × 10 rectangle rotated 35°
    const a = (35 * Math.PI) / 180;
    const src: [number, number][] = [[0, 0], [30, 0], [30, 10], [0, 10]];
    const rotated = shape(src.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]));
    // a north-aligned box round this would be ~2× the area
    expect(rectangleOvershoot(rotated, fitRectangle(rotated))).toBeLessThan(0.01);
  });

  it("flags an L-shape as a bad fit for the assumption", () => {
    const lShape = shape([[0, 0], [30, 0], [30, 10], [12, 10], [12, 24], [0, 24]]);
    expect(rectangleOvershoot(lShape, fitRectangle(lShape))).toBeGreaterThan(0.2);
  });

  it("leaves fewer than 3 points untouched", () => {
    const line = shape([[0, 0], [5, 0]]);
    expect(fitRectangle(line)).toBe(line);
  });
});

describe("rooftop obstructions", () => {
  const roof = shape([[0, 0], [30, 0], [30, 20], [0, 20]]);
  // 6 × 5 m water tank in the middle
  const tank = shape([[12, 7], [18, 7], [18, 12], [12, 12]]);

  it("removes panels and reports the blocked area", () => {
    const clear = packPanels(roof, "flat");
    const blocked = packPanels(roof, "flat", undefined, [tank]);
    expect(blocked.count).toBeLessThan(clear.count);
    expect(blocked.obstructedM2).toBeCloseTo(30, 0);
    expect(blocked.footprintM2).toBeCloseTo(clear.footprintM2, 3); // roof itself unchanged
    expect(blocked.usableM2).toBeCloseTo(clear.usableM2 - 30, 0);
  });

  it("holds the 200 mm clearance around the obstruction", () => {
    const { panels } = packPanels(roof, "flat", undefined, [tank]);
    const { origin } = toLocalMeters(roof);
    const t = toLocalMeters(tank, origin).pts;
    const [tx0, tx1] = [Math.min(...t.map((p) => p.x)), Math.max(...t.map((p) => p.x))];
    const [ty0, ty1] = [Math.min(...t.map((p) => p.y)), Math.max(...t.map((p) => p.y))];
    for (const p of panels) {
      const rot = (p.rotDeg * Math.PI) / 180;
      const cos = Math.cos(rot), sin = Math.sin(rot);
      const corners = [[-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [p.w / 2, p.h / 2], [-p.w / 2, p.h / 2]]
        .map(([dx, dy]) => ({ x: p.x + dx * cos - dy * sin, y: p.y + dx * sin + dy * cos }));
      const gap = Math.max(
        tx0 - Math.max(...corners.map((c) => c.x)),
        Math.min(...corners.map((c) => c.x)) - tx1,
        ty0 - Math.max(...corners.map((c) => c.y)),
        Math.min(...corners.map((c) => c.y)) - ty1
      );
      expect(gap).toBeGreaterThanOrEqual(PACKING.edgeClearanceM - 1e-9);
    }
  });

  it("an obstruction covering the roof leaves no panels", () => {
    expect(packPanels(roof, "flat", undefined, [roof]).count).toBe(0);
  });

  it("ignores empty obstruction lists", () => {
    expect(packPanels(roof, "flat", undefined, []).count).toBe(packPanels(roof, "flat").count);
    expect(packPanels(roof, "flat").obstructedM2).toBe(0);
  });
});
