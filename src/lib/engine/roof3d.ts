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
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

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
  };
}
