// ── Right-angle snapping for hand-drawn roofs ─────────────────────────
// A corner traced by hand that lands within 20° of square (70°–110°) is
// almost always a real 90° corner, so it is corrected to exactly 90°.
import { fromLocalMeters, polygonAreaM2, toLocalMeters } from "./roof";
import type { LatLng } from "./types";

/** Half-width of the "that was meant to be square" window, in degrees. */
export const SQUARE_TOLERANCE_DEG = 20;
/** Abandon the correction if it would drag a corner further than this. */
const MAX_SHIFT_M = 3;
/** Abandon the correction if it would change the roof area by more than this. */
const MAX_AREA_DRIFT = 0.15;

export interface Pt {
  x: number;
  y: number;
}

/** Unsigned angle (0–180°) between the two edges meeting at `b`. */
export function cornerAngleDeg(a: Pt, b: Pt, c: Pt): number {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
  if (l1 === 0 || l2 === 0) return 180;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

export function isNearlySquare(deg: number): boolean {
  return Math.abs(deg - 90) <= SQUARE_TOLERANCE_DEG;
}

function isNearlyStraight(deg: number): boolean {
  return deg >= 180 - SQUARE_TOLERANCE_DEG;
}

/**
 * Move `c` so the corner at `b` is exactly 90°, keeping the segment length and
 * the side the user drew towards. Returns null when the corner is too far from
 * square to assume it was meant to be one.
 */
export function squareCorner(a: Pt, b: Pt, c: Pt): Pt | null {
  if (!isNearlySquare(cornerAngleDeg(a, b, c))) return null;
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const l1 = Math.hypot(v1x, v1y);
  if (l1 === 0) return null;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const len = Math.hypot(v2x, v2y);
  // unit normal to b→a, flipped to the side the user actually clicked
  let nx = -v1y / l1, ny = v1x / l1;
  if (nx * v2x + ny * v2y < 0) { nx = -nx; ny = -ny; }
  return { x: b.x + nx * len, y: b.y + ny * len };
}

/**
 * Live snap while drawing: given the points placed so far, correct the point
 * just clicked so the corner it closes is exactly square. No-op until there
 * are two prior points, or when the corner is not close enough to square.
 */
export function squareNextPoint(placed: LatLng[], next: LatLng): LatLng {
  if (placed.length < 2) return next;
  const { pts, origin } = toLocalMeters([...placed.slice(-2), next]);
  const snapped = squareCorner(pts[0], pts[1], pts[2]);
  return snapped ? fromLocalMeters(origin, snapped.x, snapped.y) : next;
}

/** Intersection of two lines given as point + direction. Null if parallel. */
function intersect(p1: Pt, a1: number, p2: Pt, a2: number): Pt | null {
  const d1x = Math.cos(a1), d1y = Math.sin(a1);
  const d2x = Math.cos(a2), d2y = Math.sin(a2);
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((p2.x - p1.x) * d2y - (p2.y - p1.y) * d2x) / den;
  return { x: p1.x + d1x * t, y: p1.y + d1y * t };
}

function norm(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Square up a finished outline. Edge directions within tolerance of the
 * longest edge's 90° grid are rotated onto it and the corners rebuilt by
 * intersecting the corrected edges — so the closing corners get squared too,
 * which a point-by-point snap can never do. Corners that were NOT meant to be
 * square (or straight) are protected by freezing both of their edges, and the
 * whole correction is abandoned if it drifts too far from what was drawn.
 */
export function snapRightAngles(poly: LatLng[]): LatLng[] {
  if (poly.length < 3) return poly;
  const { pts, origin } = toLocalMeters(poly);
  const n = pts.length;
  const nextI = (i: number) => (i + 1) % n;
  const prevI = (i: number) => (i - 1 + n) % n;

  // reference direction: the longest edge — the one most likely drawn true
  let refIdx = 0, refLen = -1;
  for (let i = 0; i < n; i++) {
    const len = Math.hypot(pts[nextI(i)].x - pts[i].x, pts[nextI(i)].y - pts[i].y);
    if (len > refLen) { refLen = len; refIdx = i; }
  }
  const ref = Math.atan2(pts[nextI(refIdx)].y - pts[refIdx].y, pts[nextI(refIdx)].x - pts[refIdx].x);

  const tol = (SQUARE_TOLERANCE_DEG * Math.PI) / 180;
  const HALF_PI = Math.PI / 2;
  const drawn: number[] = [];
  const target: number[] = [];
  const mid: Pt[] = [];
  const rotate: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const j = nextI(i);
    const theta = Math.atan2(pts[j].y - pts[i].y, pts[j].x - pts[i].x);
    const onGrid = ref + Math.round(norm(theta - ref) / HALF_PI) * HALF_PI;
    drawn.push(theta);
    target.push(onGrid);
    rotate.push(Math.abs(norm(theta - onGrid)) <= tol);
    mid.push({ x: (pts[i].x + pts[j].x) / 2, y: (pts[i].y + pts[j].y) / 2 });
  }

  // Protect deliberate non-square corners: rotating either of its edges would
  // move it, so freeze both. Freezing only ever removes rotations, so one pass
  // is enough — it can never create a new violation.
  for (let i = 0; i < n; i++) {
    const angle = cornerAngleDeg(pts[prevI(i)], pts[i], pts[nextI(i)]);
    if (isNearlySquare(angle) || isNearlyStraight(angle)) continue;
    rotate[prevI(i)] = false;
    rotate[i] = false;
  }

  const dir = target.map((t, i) => (rotate[i] ? t : drawn[i]));
  if (!rotate.some(Boolean)) return poly;

  // Each corrected edge keeps its original midpoint, so the outline pivots in
  // place rather than sliding; corners are where consecutive edges now meet.
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = prevI(i);
    out.push(intersect(mid[p], dir[p], mid[i], dir[i]) ?? pts[i]);
  }

  for (let i = 0; i < n; i++) {
    if (Math.hypot(out[i].x - pts[i].x, out[i].y - pts[i].y) > MAX_SHIFT_M) return poly;
  }
  const before = polygonAreaM2(pts), after = polygonAreaM2(out);
  if (before > 0 && Math.abs(after / before - 1) > MAX_AREA_DRIFT) return poly;

  return out.map((p) => fromLocalMeters(origin, p.x, p.y));
}
