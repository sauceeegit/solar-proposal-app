// ── Rectangular footprint assumption ──────────────────────────────────
// Most roofs we quote are a simple rectangle, so by default the outline the
// user draws (or Google detects) is replaced by the tightest rectangle that
// contains it. Roofs that genuinely are not rectangular opt out.
import { fromLocalMeters, polygonAreaM2, toLocalMeters } from "./roof";
import type { LatLng } from "./types";

interface Pt { x: number; y: number }

/** Convex hull, counter-clockwise (Andrew's monotone chain). */
function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (src: Pt[]) => {
    const out: Pt[] = [];
    for (const q of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...half(p), ...half([...p].reverse())];
}

/**
 * Smallest-area rectangle containing the outline. The optimal rectangle always
 * has a side flush with a hull edge, so testing every hull edge direction is
 * exact. Returns the four corners, or the input if it is not a polygon.
 */
export function fitRectangle(poly: LatLng[]): LatLng[] {
  if (poly.length < 3) return poly;
  const { pts, origin } = toLocalMeters(poly);
  const h = hull(pts);
  if (h.length < 3) return poly;

  let best: { area: number; corners: Pt[] } | null = null;
  for (let i = 0; i < h.length; i++) {
    const j = (i + 1) % h.length;
    const ang = Math.atan2(h[j].y - h[i].y, h[j].x - h[i].x);
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    const rot = h.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
    const x0 = Math.min(...rot.map((p) => p.x)), x1 = Math.max(...rot.map((p) => p.x));
    const y0 = Math.min(...rot.map((p) => p.y)), y1 = Math.max(...rot.map((p) => p.y));
    const area = (x1 - x0) * (y1 - y0);
    if (best && area >= best.area) continue;
    const back = Math.cos(ang), backSin = Math.sin(ang);
    best = {
      area,
      corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({
        x: x * back - y * backSin,
        y: x * backSin + y * back,
      })),
    };
  }
  if (!best) return poly;
  return best.corners.map((p) => fromLocalMeters(origin, p.x, p.y));
}

/**
 * How much bigger the fitted rectangle is than the outline drawn, as a
 * fraction. A big number means the building is not really a rectangle and the
 * assumption should be turned off.
 */
export function rectangleOvershoot(poly: LatLng[], rect: LatLng[]): number {
  const drawn = polygonAreaM2(toLocalMeters(poly).pts);
  if (drawn <= 0) return 0;
  return polygonAreaM2(toLocalMeters(rect).pts) / drawn - 1;
}
