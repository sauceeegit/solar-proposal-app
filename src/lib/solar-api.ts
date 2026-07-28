// ── Google Solar API: shading measurement + roof cross-check ──────────
// Used ONLY to enrich and validate. It never changes roof area, panel count
// or price — Thai coverage is BASE quality and its building detection is
// unreliable (it can return a neighbouring structure). The rasters, however,
// are spatial and independent of that, so they are trustworthy.
import { fromArrayBuffer } from "geotiff";
import type { LatLng, PanelRect } from "@/lib/engine/types";

/** WGS84 → UTM. Solar API GeoTIFFs are projected (Thailand = zone 47N). */
export function toUTM(lat: number, lng: number): { x: number; y: number; zone: number } {
  const zone = Math.floor((lng + 180) / 6) + 1;
  const a = 6378137.0, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const lam0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180, lam = (lng * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = (lam - lam0) * Math.cos(phi);
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const x =
    k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  const y =
    k0 *
    (M +
      N * Math.tan(phi) * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
        ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return { x, y, zone };
}

/** UTM → WGS84 (inverse of toUTM). */
export function fromUTM(x: number, y: number, zone: number): LatLng {
  const A = 6378137.0, F = 1 / 298.257223563, K0 = 0.9996;
  const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const xx = x - 500000, M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const p1 =
    mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const C1 = EP2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2;
  const N1 = A / Math.sqrt(1 - E2 * Math.sin(p1) ** 2);
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * Math.sin(p1) ** 2, 1.5);
  const D = xx / (N1 * K0);
  const lat =
    p1 - ((N1 * Math.tan(p1)) / R1) * ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24 +
      ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lng =
    (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(p1);
  return { lat: (lat * 180) / Math.PI, lng: (zone - 1) * 6 - 180 + 3 + (lng * 180) / Math.PI };
}

export interface RoofCheck {
  available: boolean;
  reason?: string;
  imageryQuality?: string;
  imageryDate?: string;
  /** 0..1 — fraction of the drawn polygon Google classifies as building roof */
  maskCoverage?: number;
  /** 0..1 — measured shading derate to apply to the PVWatts yield */
  shadingFactor?: number;
  /** kWh/kW/yr sampled inside the roof (Google's own scale — relative use only) */
  fluxMean?: number;
  fluxP95?: number;
  samplePixels?: number;
  /** pitch/azimuth from buildingInsights, only when its building agrees with ours */
  detectedPitchDeg?: number;
  detectedAzimuthDeg?: number;
  detectedAreaM2?: number;
  warnings: string[];
}

function pointInPoly(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function loadRaster(url: string, key: string) {
  const res = await fetch(`${url}&key=${key}`);
  if (!res.ok) throw new Error(`raster HTTP ${res.status}`);
  const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage();
  const [data] = await img.readRasters();
  return {
    data: data as unknown as ArrayLike<number>,
    w: img.getWidth(),
    h: img.getHeight(),
    bbox: img.getBoundingBox() as [number, number, number, number],
  };
}

/**
 * Measure real shading over the user's confirmed roof polygon and sanity-check
 * that the polygon actually sits on a building. Never throws — returns
 * { available: false } so the proposal continues untouched.
 */
export async function checkRoof(roofPolygon: LatLng[], panels?: PanelRect[]): Promise<RoofCheck> {
  const warnings: string[] = [];
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return { available: false, reason: "no Google key", warnings };
  if (roofPolygon.length < 3) return { available: false, reason: "no polygon", warnings };

  const c = {
    lat: roofPolygon.reduce((s, p) => s + p.lat, 0) / roofPolygon.length,
    lng: roofPolygon.reduce((s, p) => s + p.lng, 0) / roofPolygon.length,
  };

  try {
    // ── dataLayers: spatial rasters, independent of building detection ──
    const dl = await fetch(
      `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${c.lat}&location.longitude=${c.lng}` +
        `&radiusMeters=80&view=IMAGERY_AND_ANNUAL_FLUX_LAYERS&requiredQuality=BASE&pixelSizeMeters=0.5&key=${key}`
    );
    if (!dl.ok) return { available: false, reason: `no Solar API coverage here (HTTP ${dl.status})`, warnings };
    const layers = (await dl.json()) as {
      annualFluxUrl?: string; maskUrl?: string; imageryQuality?: string;
      imageryDate?: { year: number; month: number; day: number };
    };
    if (!layers.annualFluxUrl) return { available: false, reason: "no flux layer for this location", warnings };

    const poly = roofPolygon.map((p) => toUTM(p.lat, p.lng));
    const [flux, mask] = await Promise.all([
      loadRaster(layers.annualFluxUrl, key),
      layers.maskUrl ? loadRaster(layers.maskUrl, key).catch(() => null) : Promise.resolve(null),
    ]);

    // sample every pixel whose center falls inside the confirmed roof
    const pxX = (flux.bbox[2] - flux.bbox[0]) / flux.w;
    const pxY = (flux.bbox[3] - flux.bbox[1]) / flux.h;
    const vals: number[] = [];
    let maskOn = 0, maskTotal = 0;
    for (let py = 0; py < flux.h; py++) {
      for (let px = 0; px < flux.w; px++) {
        const X = flux.bbox[0] + (px + 0.5) * pxX;
        const Y = flux.bbox[3] - (py + 0.5) * pxY;
        if (!pointInPoly(X, Y, poly)) continue;
        const v = flux.data[py * flux.w + px];
        if (v != null && !Number.isNaN(v) && v > -9999) vals.push(v);
        if (mask && mask.w === flux.w && mask.h === flux.h) {
          const m = mask.data[py * mask.w + px];
          maskTotal++;
          if (m != null && m > 0.5) maskOn++;
        }
      }
    }
    if (vals.length < 20) return { available: false, reason: "not enough raster data over this roof", warnings };

    vals.sort((a, b) => a - b);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const p95 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))];
    // Relative derate only: Google's absolute scale differs from PVWatts, but the
    // ratio of average to best-exposed roof area is a sound shading measure.
    const shadingFactor = Math.min(1, Math.max(0.5, p95 > 0 ? mean / p95 : 1));
    const maskCoverage = maskTotal > 0 ? maskOn / maskTotal : undefined;

    if (maskCoverage !== undefined && maskCoverage < 0.7) {
      warnings.push(
        `Only ${Math.round(maskCoverage * 100)}% of your outline sits on a roof in Google's building data — check that it isn't overlapping ground, trees or a neighbour.`
      );
    }
    if (shadingFactor < 0.9) {
      warnings.push(
        `Measured shading: this roof averages ${Math.round(shadingFactor * 100)}% of its best-exposed area, so production is derated accordingly.`
      );
    }

    const out: RoofCheck = {
      available: true,
      imageryQuality: layers.imageryQuality,
      imageryDate: layers.imageryDate ? `${layers.imageryDate.year}-${String(layers.imageryDate.month).padStart(2, "0")}` : undefined,
      maskCoverage,
      shadingFactor,
      fluxMean: Math.round(mean),
      fluxP95: Math.round(p95),
      samplePixels: vals.length,
      warnings,
    };

    // ── buildingInsights: pitch/azimuth, only if its building really is ours ──
    try {
      const bi = await fetch(
        `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${c.lat}` +
          `&location.longitude=${c.lng}&requiredQuality=BASE&key=${key}`
      );
      if (bi.ok) {
        const b = (await bi.json()) as {
          solarPotential?: {
            wholeRoofStats?: { areaMeters2?: number };
            roofSegmentStats?: { pitchDegrees?: number; azimuthDegrees?: number; stats?: { areaMeters2?: number } }[];
          };
        };
        const detectedArea = b.solarPotential?.wholeRoofStats?.areaMeters2;
        const ourArea = vals.length * pxX * pxY; // roof area implied by sampled pixels
        out.detectedAreaM2 = detectedArea ? Math.round(detectedArea) : undefined;
        const ratio = detectedArea && ourArea > 0 ? detectedArea / ourArea : 0;
        if (ratio >= 0.7 && ratio <= 1.43) {
          // areas agree → trust its measured geometry
          const segs = b.solarPotential?.roofSegmentStats ?? [];
          const biggest = segs.slice().sort((x, y) => (y.stats?.areaMeters2 ?? 0) - (x.stats?.areaMeters2 ?? 0))[0];
          const pitch = biggest?.pitchDegrees;
          if (pitch != null) out.detectedPitchDeg = Math.round(pitch);
          // Azimuth is only meaningful on a genuinely sloped roof. On a flat or
          // near-flat roof panels sit on racking aimed at the optimal direction,
          // so a detected azimuth there is noise — never let it override ours.
          if (biggest?.azimuthDegrees != null && pitch != null && pitch >= 10) {
            out.detectedAzimuthDeg = Math.round(biggest.azimuthDegrees);
          }
        } else if (detectedArea) {
          warnings.push(
            `Google detected a ${Math.round(detectedArea)} m² building here vs your ${Math.round(ourArea)} m² outline — its roof data was ignored (your outline is used).`
          );
        }
      }
    } catch {
      // buildingInsights is optional
    }

    void panels; // reserved: per-panel flux sampling
    return out;
  } catch (e) {
    return { available: false, reason: String(e), warnings };
  }
}
