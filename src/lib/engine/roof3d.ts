// ── Feed the 2D roof outline into the Solvio 3D rooftop model ─────────
// The model's plan frame is north-up by definition: u runs west→east and
// v runs south→north, normalised 0..1 inside a widthM × lengthM box. Our
// polygon is lat/lng, so projecting it to local metres gives exactly that
// frame — which is why no separate "where is north" angle is needed. North
// is baked into the outline, and the model draws its own north arrow.
import { toLocalMeters } from "./roof";
import type { LatLng } from "./types";

export interface Roof3D {
  /** roof outline in order, [u, v] each 0..1 */
  outline: [number, number][];
  /** east–west extent of the outline, metres */
  widthM: number;
  /** north–south extent of the outline, metres */
  lengthM: number;
  /**
   * How far the roof's longest edge sits off the nearest compass axis, 0–45°.
   * Above a couple of degrees the model needs its angled layout, or it tiles
   * panels north-up and they run diagonally across the roof.
   */
  offAxisDeg: number;
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Deviation of the polygon's longest edge from the nearest compass axis, 0–45°. */
function longestEdgeOffAxisDeg(pts: { x: number; y: number }[]): number {
  let bestLen = -1, deg = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
    const len = Math.hypot(dx, dy);
    if (len <= bestLen) continue;
    bestLen = len;
    // edges are undirected and the grid is square, so fold into 0..45°
    const a = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 90;
    deg = Math.min(a, 90 - a);
  }
  return Math.round(deg * 10) / 10;
}

/**
 * Convert a confirmed roof polygon into the payload `solvioSetRoof` expects.
 * Returns null for a degenerate outline (nothing sensible to show in 3D).
 */
export function roof3dFromPolygon(poly: LatLng[]): Roof3D | null {
  if (poly.length < 3) return null;
  const { pts } = toLocalMeters(poly); // x = metres east, y = metres north
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const widthM = maxX - minX, lengthM = maxY - minY;
  if (!(widthM > 0.5) || !(lengthM > 0.5)) return null;
  return {
    outline: pts.map((p) => [r4((p.x - minX) / widthM), r4((p.y - minY) / lengthM)] as [number, number]),
    widthM: Math.round(widthM * 100) / 100,
    lengthM: Math.round(lengthM * 100) / 100,
    offAxisDeg: longestEdgeOffAxisDeg(pts),
  };
}
