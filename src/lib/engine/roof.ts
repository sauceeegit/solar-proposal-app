// ── Roof geometry & panel packing (spec §5.1–5.2) ─────────────────────
import { PANEL, PACKING, DEFAULT_TILT_DEG, type RoofType } from "@/config/assumptions";
import type { LatLng, PanelRect, PackingResult } from "./types";

const EARTH_R = 6_371_000;

/**
 * Project lat/lng to local meters around the polygon centroid, or around
 * `about` when several shapes must share one frame (roof + obstructions).
 */
export function toLocalMeters(poly: LatLng[], about?: LatLng): { pts: { x: number; y: number }[]; origin: LatLng } {
  const origin = about ?? {
    lat: poly.reduce((s, p) => s + p.lat, 0) / poly.length,
    lng: poly.reduce((s, p) => s + p.lng, 0) / poly.length,
  };
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const pts = poly.map((p) => ({
    x: ((p.lng - origin.lng) * Math.PI / 180) * EARTH_R * cosLat,
    y: ((p.lat - origin.lat) * Math.PI / 180) * EARTH_R,
  }));
  return { pts, origin };
}

/** Inverse of toLocalMeters: local meters around `origin` back to lat/lng. */
export function fromLocalMeters(origin: LatLng, x: number, y: number): LatLng {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    lat: origin.lat + ((y / EARTH_R) * 180) / Math.PI,
    lng: origin.lng + ((x / (EARTH_R * cosLat)) * 180) / Math.PI,
  };
}

export function polygonAreaM2(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

/**
 * Approximate inward offset (vertices moved toward the centroid). Used only for
 * the reported usable-area figure — panel placement enforces the edge clearance
 * exactly via distance-to-boundary, see packPanels.
 */
export function insetPolygon(pts: { x: number; y: number }[], meters: number) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return pts.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const shrink = Math.min(meters, d * 0.5);
    return { x: p.x - (dx / d) * shrink, y: p.y - (dy / d) * shrink };
  });
}

/** Shortest distance from a point to a line segment. */
function distToSegment(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number
): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Shortest distance from a point to the polygon's boundary. */
function distToBoundary(px: number, py: number, poly: { x: number; y: number }[]): number {
  let min = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distToSegment(px, py, poly[j].x, poly[j].y, poly[i].x, poly[i].y);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Separation between two convex shapes: >0 = that many metres apart, ≤0 =
 * overlapping. Separating-axis test over both shapes' edge normals; in the
 * corner-to-corner case it under-reports slightly, which errs towards keeping
 * panels away from obstructions.
 */
function convexGap(a: { x: number; y: number }[], b: { x: number; y: number }[]): number {
  let best = -Infinity;
  for (const shape of [a, b]) {
    for (let i = 0; i < shape.length; i++) {
      const j = (i + 1) % shape.length;
      const ex = shape[j].x - shape[i].x, ey = shape[j].y - shape[i].y;
      const len = Math.hypot(ex, ey);
      if (len === 0) continue;
      const nx = -ey / len, ny = ex / len;
      const pa = a.map((p) => p.x * nx + p.y * ny);
      const pb = b.map((p) => p.x * nx + p.y * ny);
      const gap = Math.max(Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb));
      if (gap > best) best = gap;
    }
  }
  return best;
}

function pointInPolygon(px: number, py: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Orientation (deg from east, CCW) of the polygon's longest edge — rows follow it. */
function longestEdgeAngle(pts: { x: number; y: number }[]): number {
  let best = 0, bestLen = -1;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
    const len = Math.hypot(dx, dy);
    if (len > bestLen) {
      bestLen = len;
      best = Math.atan2(dy, dx);
    }
  }
  return best;
}

/**
 * Pack panels into the roof polygon on a uniform grid, per the layout spec:
 *   • 200 mm clearance from the building edge, all around the outline
 *   • 100 mm between panels within a row (short edge to short edge)
 *   • 400 mm between rows
 * Panel plan depth is length × cos(tilt), so pitched roofs pack slightly tighter.
 * `obstructions` are keep-out shapes inside the roof (stairwells, water tanks,
 * AC platforms); the same 200 mm clearance is held around them.
 * The returned layout IS the design: count = panels.length everywhere downstream.
 */
export function packPanels(
  roofPolygon: LatLng[],
  roofType: RoofType,
  tiltDeg?: number,
  obstructions?: LatLng[][]
): PackingResult {
  const tilt = tiltDeg ?? DEFAULT_TILT_DEG[roofType];
  const tiltRad = (tilt * Math.PI) / 180;
  const { pts, origin } = toLocalMeters(roofPolygon);
  const footprintM2 = polygonAreaM2(pts);
  const inset = insetPolygon(pts, PACKING.edgeClearanceM);
  // keep-outs share the roof's local frame so the two can be compared directly
  const obs = (obstructions ?? [])
    .filter((o) => o.length >= 3)
    .map((o) => toLocalMeters(o, origin).pts);
  const obstructedM2 = Math.min(footprintM2, obs.reduce((s, o) => s + polygonAreaM2(o), 0));

  const panelW = PANEL.widthM; // short edge — runs across the row
  const planDepth = PANEL.lengthM * Math.cos(tiltRad); // up-slope footprint
  const colPitch = panelW + PACKING.withinRowGapM;
  const rowPitch = planDepth + PACKING.betweenRowsGapM;

  // Row axis: the roof's two edge directions are candidates (longest edge and
  // its perpendicular). Panels face perpendicular to the rows — pick the
  // candidate whose facing is closest to the optimal direction (south, 180°).
  const facingOf = (a: number) => {
    const rowAxis = ((90 - (a * 180) / Math.PI) % 360 + 360) % 360;
    const f1 = (rowAxis + 90) % 360;
    const f2 = (rowAxis + 270) % 360;
    return Math.abs(f1 - 180) <= Math.abs(f2 - 180) ? f1 : f2;
  };
  const base = longestEdgeAngle(pts);
  const candidates = [base, base + Math.PI / 2];
  const ang = candidates.reduce((best, c) =>
    Math.abs(facingOf(c) - 180) < Math.abs(facingOf(best) - 180) ? c : best
  );
  const azimuthDeg = Math.round(facingOf(ang));
  // Work in the row-aligned frame: rotation preserves distances, so the edge
  // clearance can be enforced exactly against the real (un-inset) outline.
  const cosA = Math.cos(-ang), sinA = Math.sin(-ang);
  const toFrame = (p: { x: number; y: number }) => ({ x: p.x * cosA - p.y * sinA, y: p.x * sinA + p.y * cosA });
  const rot = pts.map(toFrame);
  const obsRot = obs.map((o) => o.map(toFrame));
  const minX = Math.min(...rot.map((p) => p.x)), maxX = Math.max(...rot.map((p) => p.x));
  const minY = Math.min(...rot.map((p) => p.y)), maxY = Math.max(...rot.map((p) => p.y));
  const clear = PACKING.edgeClearanceM;

  const panels: PanelRect[] = [];
  const cosB = Math.cos(ang), sinB = Math.sin(ang);
  // Start where the clearance could first be met — the bounding-box edge itself
  // can never pass, so beginning there would waste a whole pitch.
  for (let y = minY + clear + planDepth / 2; y <= maxY - clear - planDepth / 2 + 1e-9; y += rowPitch) {
    for (let x = minX + clear + panelW / 2; x <= maxX - clear - panelW / 2 + 1e-9; x += colPitch) {
      const x0 = x - panelW / 2, x1 = x + panelW / 2;
      const y0 = y - planDepth / 2, y1 = y + planDepth / 2;
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      // every corner inside the roof AND at least `clear` from any edge
      let ok = corners.every(
        ([cx, cy]) => pointInPolygon(cx, cy, rot) && distToBoundary(cx, cy, rot) >= clear
      );
      // guard the concave case: a roof vertex poking into the panel between corners
      if (ok) ok = !rot.some((v) => v.x > x0 && v.x < x1 && v.y > y0 && v.y < y1);
      // and hold the same clearance around every keep-out shape
      if (ok && obsRot.length > 0) {
        const rect = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
        ok = obsRot.every((o) => convexGap(rect, o) >= clear);
      }
      if (ok) {
        panels.push({
          x: x * cosB - y * sinB,
          y: x * sinB + y * cosB,
          w: panelW,
          h: planDepth,
          // rect is axis-aligned in the row frame → rotated by +ang in world
          rotDeg: (ang * 180) / Math.PI,
        });
      }
    }
  }

  return {
    panels,
    count: panels.length,
    footprintM2,
    obstructedM2,
    usableM2: Math.max(0, polygonAreaM2(inset) - obstructedM2),
    maxKw: (panels.length * PANEL.watt) / 1000,
    rowAxisDeg: ((90 - (ang * 180) / Math.PI) % 360 + 360) % 360,
    azimuthDeg,
  };
}

/**
 * Mountable-surface multiplier for pitched roofs (spec §5.1):
 * true surface = footprint / cos(tilt). Used for reporting, packing already
 * works in plan view so the panel plan-footprint shrink handles it.
 */
export function surfaceMultiplier(roofType: RoofType, tiltDeg?: number): number {
  if (roofType === "flat") return 1;
  const t = ((tiltDeg ?? DEFAULT_TILT_DEG[roofType]) * Math.PI) / 180;
  return 1 / Math.cos(t);
}
