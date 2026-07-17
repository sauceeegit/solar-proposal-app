// ── Web Mercator pixel math for static-map overlays ────────────────────
import type { LatLng } from "@/lib/engine/types";

const TILE = 256;

export function worldPx(p: LatLng): { x: number; y: number } {
  const siny = Math.min(Math.max(Math.sin((p.lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: TILE * (0.5 + p.lng / 360),
    y: TILE * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)),
  };
}

/** Pixel position of `p` inside an image of size w×h centered on `center` at `zoom` (scale 1). */
export function pixelInImage(p: LatLng, center: LatLng, zoom: number, w: number, h: number) {
  const s = Math.pow(2, zoom);
  const cp = worldPx(center);
  const pp = worldPx(p);
  return { x: (pp.x - cp.x) * s + w / 2, y: (pp.y - cp.y) * s + h / 2 };
}

/** Zoom that fits the polygon bounds into w×h with padding. */
export function fitZoom(poly: LatLng[], w: number, h: number, pad = 60): number {
  const xs = poly.map((p) => worldPx(p).x);
  const ys = poly.map((p) => worldPx(p).y);
  const dx = Math.max(...xs) - Math.min(...xs);
  const dy = Math.max(...ys) - Math.min(...ys);
  let z = 21;
  while (z > 15 && (dx * Math.pow(2, z) > w - pad || dy * Math.pow(2, z) > h - pad)) z--;
  return z;
}

/** Inverse: pixel inside a w×h image centered on `center` at `zoom` → LatLng. */
export function latLngFromPixel(px: number, py: number, center: LatLng, zoom: number, w: number, h: number): LatLng {
  const s = Math.pow(2, zoom);
  const cp = worldPx(center);
  const wx = cp.x + (px - w / 2) / s;
  const wy = cp.y + (py - h / 2) / s;
  const lng = (wx / TILE - 0.5) * 360;
  const lat = (Math.asin(Math.tanh((0.5 - wy / TILE) * 4 * Math.PI / 2)) * 180) / Math.PI;
  return { lat, lng };
}

export function centroid(poly: LatLng[]): LatLng {
  return {
    lat: poly.reduce((s, p) => s + p.lat, 0) / poly.length,
    lng: poly.reduce((s, p) => s + p.lng, 0) / poly.length,
  };
}
