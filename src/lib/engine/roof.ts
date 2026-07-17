// ── Roof geometry & panel packing (spec §5.1–5.2) ─────────────────────
import { PANEL, PACKING, DEFAULT_TILT_DEG, type RoofType } from "@/config/assumptions";
import type { LatLng, PanelRect, PackingResult } from "./types";

const EARTH_R = 6_371_000;

/** Project lat/lng to local meters around the polygon centroid. */
export function toLocalMeters(poly: LatLng[]): { pts: { x: number; y: number }[]; origin: LatLng } {
  const origin = {
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

export function polygonAreaM2(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

/** Conservative inset: move each vertex toward the centroid (spec: 0.4 m edges). */
export function insetPolygon(pts: { x: number; y: number }[], meters: number) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return pts.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const shrink = Math.min(meters * 1.3, d * 0.5); // 1.3× for conservatism vs true edge offset
    return { x: p.x - (dx / d) * shrink, y: p.y - (dy / d) * shrink };
  });
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
 * Pack panels into the roof polygon.
 * Pitched roofs: plan depth of a panel = length × cos(tilt), packed contiguous rows.
 * Flat roofs: rows spaced for GCR, plus walkway factor.
 * The returned layout IS the design: count = panels.length everywhere downstream.
 */
export function packPanels(roofPolygon: LatLng[], roofType: RoofType, tiltDeg?: number): PackingResult {
  const tilt = tiltDeg ?? DEFAULT_TILT_DEG[roofType];
  const tiltRad = (tilt * Math.PI) / 180;
  const { pts } = toLocalMeters(roofPolygon);
  const footprintM2 = polygonAreaM2(pts);
  const inset = insetPolygon(pts, PACKING.edgeSetbackM);

  const panelW = PANEL.widthM; // across the row
  const planDepth = PANEL.lengthM * Math.cos(tiltRad); // up-slope footprint
  const colPitch = panelW; // panels sit edge-to-edge along a row

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
  const cosA = Math.cos(-ang), sinA = Math.sin(-ang);
  const rot = inset.map((p) => ({ x: p.x * cosA - p.y * sinA, y: p.x * sinA + p.y * cosA }));
  const minX = Math.min(...rot.map((p) => p.x)), maxX = Math.max(...rot.map((p) => p.x));
  const minY = Math.min(...rot.map((p) => p.y)), maxY = Math.max(...rot.map((p) => p.y));

  // Row positions: flat roofs use blocks of rows back-to-back (no spacing
  // within a block) separated by walkways; pitched roofs pack contiguously.
  const rowYs: number[] = [];
  let yCursor = minY + planDepth / 2;
  let rowsInBlock = 0;
  while (yCursor <= maxY - planDepth / 2 + 1e-9) {
    rowYs.push(yCursor);
    rowsInBlock++;
    if (roofType === "flat" && rowsInBlock >= PACKING.rowsPerBlock) {
      yCursor += planDepth + PACKING.walkwayM; // walkway between blocks
      rowsInBlock = 0;
    } else {
      yCursor += planDepth;
    }
  }

  const panels: PanelRect[] = [];
  const cosB = Math.cos(ang), sinB = Math.sin(ang);
  for (const y of rowYs) {
    for (let x = minX + colPitch / 2; x <= maxX - colPitch / 2 + 1e-9; x += colPitch) {
      // all 4 corners must be inside the inset polygon (in the rotated frame)
      const corners = [
        [x - panelW / 2, y - planDepth / 2],
        [x + panelW / 2, y - planDepth / 2],
        [x + panelW / 2, y + planDepth / 2],
        [x - panelW / 2, y + planDepth / 2],
      ];
      const ok = corners.every(([cx, cy]) => {
        const wx = cx * cosB - cy * sinB;
        const wy = cx * sinB + cy * cosB;
        return pointInPolygon(wx, wy, inset);
      });
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
    usableM2: polygonAreaM2(inset),
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
