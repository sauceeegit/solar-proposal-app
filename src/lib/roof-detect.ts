// ── Roof outline detection from Google's building mask ────────────────
// Far more accurate than asking a vision model to guess pixel coordinates:
// the mask is Google's own building segmentation at 0.5 m. We label connected
// blobs, trace the boundary of each, simplify it, and return ranked candidates
// for the user to confirm or switch between. The human still decides.
import { fromArrayBuffer } from "geotiff";
import { fromUTM, toUTM } from "@/lib/solar-api";
import type { LatLng } from "@/lib/engine/types";

export interface RoofCandidate {
  polygon: LatLng[];
  areaM2: number;
  /** metres from the queried point to this blob's centroid */
  distanceM: number;
  containsPoint: boolean;
}

export interface RoofDetectResult {
  available: boolean;
  reason?: string;
  candidates: RoofCandidate[];
  /** index into candidates of the best guess, or -1 */
  recommended: number;
  imageryQuality?: string;
  imageryDate?: string;
  /** how old the mask imagery is, in months — stale imagery misses new builds */
  imageryAgeMonths?: number;
  /** true when the imagery is old enough that the building may have changed */
  stale?: boolean;
}

/**
 * Imagery older than this may not reflect the building as it stands today.
 * Thai BASE coverage commonly runs 2–4 years behind the live satellite tiles,
 * so this fires often — which is correct: the user must check before quoting.
 */
export const STALE_AFTER_MONTHS = 24;

/** Blobs smaller than this are noise (sheds, awnings, mask speckle). */
const MIN_AREA_M2 = 40;
/** Simplification tolerance in pixels (0.5 m/px → ~1 m). */
const SIMPLIFY_PX = 2;

/** Moore-neighbour boundary tracing over a pixel set. */
function traceBoundary(set: Set<number>, w: number, h: number): [number, number][] {
  const N8: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  let start: [number, number] | null = null;
  for (let y = 0; y < h && !start; y++) {
    for (let x = 0; x < w; x++) if (set.has(y * w + x)) { start = [x, y]; break; }
  }
  if (!start) return [];
  const [sx, sy] = start;
  let cx = sx, cy = sy, bdir = 7;
  const out: [number, number][] = [[sx, sy]];
  for (let guard = 0; guard < w * h * 4; guard++) {
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const d = (bdir + k) % 8;
      const nx = cx + N8[d][0], ny = cy + N8[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (set.has(ny * w + nx)) {
        cx = nx; cy = ny; bdir = (d + 4) % 8;
        out.push([cx, cy]);
        moved = true;
        break;
      }
    }
    if (!moved) break;
    if (cx === sx && cy === sy) break;
  }
  return out;
}

function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / L;
}

/** Douglas–Peucker on an open sequence. */
function simplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    return simplify(pts.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(pts.slice(idx), eps));
  }
  return [pts[0], pts[pts.length - 1]];
}

/**
 * Detect candidate roof outlines around a point using Google's building mask.
 * Never throws — returns { available: false } so the caller can fall back to
 * the vision suggestion or manual drawing.
 */
export async function detectRoofs(lat: number, lng: number): Promise<RoofDetectResult> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return { available: false, reason: "no Google key", candidates: [], recommended: -1 };

  try {
    const dl = await fetch(
      `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${lat}&location.longitude=${lng}` +
        `&radiusMeters=80&view=IMAGERY_AND_ANNUAL_FLUX_LAYERS&requiredQuality=BASE&pixelSizeMeters=0.5&key=${key}`
    );
    if (!dl.ok) return { available: false, reason: `no Solar API coverage (HTTP ${dl.status})`, candidates: [], recommended: -1 };
    const layers = (await dl.json()) as {
      maskUrl?: string; imageryQuality?: string; imageryDate?: { year: number; month: number; day: number };
    };
    if (!layers.maskUrl) return { available: false, reason: "no building mask here", candidates: [], recommended: -1 };

    const res = await fetch(`${layers.maskUrl}&key=${key}`);
    if (!res.ok) throw new Error(`mask HTTP ${res.status}`);
    const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage();
    const [raw] = await img.readRasters();
    const data = raw as unknown as ArrayLike<number>;
    const w = img.getWidth(), h = img.getHeight();
    const bb = img.getBoundingBox() as [number, number, number, number];
    const pxS = (bb[2] - bb[0]) / w, pyS = (bb[3] - bb[1]) / h;
    const pxArea = pxS * pyS;

    const q = toUTM(lat, lng);
    const pinPx = Math.round((q.x - bb[0]) / pxS - 0.5);
    const pinPy = Math.round((bb[3] - q.y) / pyS - 0.5);

    // ── connected components (4-neighbour flood fill) ──
    const seen = new Uint8Array(w * h);
    const blobs: number[][] = [];
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || !(data[i] > 0.5)) continue;
      const stack = [i];
      seen[i] = 1;
      const px: number[] = [];
      while (stack.length) {
        const c = stack.pop()!;
        px.push(c);
        const cx = c % w, cy = (c - cx) / w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (!seen[n] && data[n] > 0.5) { seen[n] = 1; stack.push(n); }
        }
      }
      if (px.length * pxArea >= MIN_AREA_M2) blobs.push(px);
    }
    if (blobs.length === 0) return { available: false, reason: "no buildings detected nearby", candidates: [], recommended: -1 };

    const zone = q.zone;
    const candidates: RoofCandidate[] = [];
    for (const px of blobs) {
      const set = new Set(px);
      const ring = traceBoundary(set, w, h);
      if (ring.length < 8) continue;
      // simplify the closed ring in two halves so endpoints aren't pinned
      const half = Math.floor(ring.length / 2);
      const simp = simplify(ring.slice(0, half + 1), SIMPLIFY_PX).slice(0, -1)
        .concat(simplify(ring.slice(half), SIMPLIFY_PX));
      if (simp.length < 3) continue;

      const utm = simp.map(([x, y]) => ({ x: bb[0] + (x + 0.5) * pxS, y: bb[3] - (y + 0.5) * pyS }));
      const polygon = utm.map((p) => fromUTM(p.x, p.y, zone));
      const cX = utm.reduce((s, p) => s + p.x, 0) / utm.length;
      const cY = utm.reduce((s, p) => s + p.y, 0) / utm.length;
      candidates.push({
        polygon,
        // pixel count is the true mask area; the traced ring can differ slightly
        areaM2: Math.round(px.length * pxArea),
        distanceM: Math.round(Math.hypot(cX - q.x, cY - q.y)),
        containsPoint: set.has(pinPy * w + pinPx),
      });
    }
    if (candidates.length === 0) return { available: false, reason: "no traceable building outline", candidates: [], recommended: -1 };

    // Rank: a blob containing the queried point wins; otherwise the nearest.
    // Ties on distance are broken by larger area.
    candidates.sort((a, b) => {
      if (a.containsPoint !== b.containsPoint) return a.containsPoint ? -1 : 1;
      if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
      return b.areaM2 - a.areaM2;
    });

    let ageMonths: number | undefined;
    if (layers.imageryDate) {
      const d = layers.imageryDate;
      const then = new Date(d.year, (d.month ?? 1) - 1, d.day ?? 1).getTime();
      ageMonths = Math.max(0, Math.round((Date.now() - then) / (1000 * 60 * 60 * 24 * 30.44)));
    }

    return {
      available: true,
      candidates: candidates.slice(0, 6),
      recommended: 0,
      imageryQuality: layers.imageryQuality,
      imageryDate: layers.imageryDate
        ? `${layers.imageryDate.year}-${String(layers.imageryDate.month).padStart(2, "0")}`
        : undefined,
      imageryAgeMonths: ageMonths,
      stale: ageMonths != null && ageMonths > STALE_AFTER_MONTHS,
    };
  } catch (e) {
    return { available: false, reason: String(e), candidates: [], recommended: -1 };
  }
}
