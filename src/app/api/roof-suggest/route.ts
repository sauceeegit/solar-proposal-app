import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { latLngFromPixel } from "@/lib/mercator";
import type { LatLng } from "@/lib/engine/types";

const SIZE = 640; // requested size; scale=2 doubles the actual pixels
const IMG = SIZE * 2; // 1280×1280 image sent to the vision model

const POLYGON_SCHEMA = {
  type: "object",
  properties: {
    polygon: {
      type: "array",
      description: "Roof outline vertices in pixel coordinates, ordered around the roof edge",
      items: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
        additionalProperties: false,
      },
    },
  },
  required: ["polygon"],
  additionalProperties: false,
} as const;

async function fetchMapImage(lat: number, lng: number, zoom: number, key: string, path?: string): Promise<string> {
  const url =
    `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}` +
    `&zoom=${zoom}&size=${SIZE}x${SIZE}&scale=2&maptype=satellite${path ?? ""}&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`static map HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

async function tracePolygon(client: Anthropic, b64: string, prompt: string): Promise<{ x: number; y: number }[]> {
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
    output_config: { format: { type: "json_schema", schema: POLYGON_SCHEMA } },
  });
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) return [];
  return (JSON.parse(text).polygon ?? []) as { x: number; y: number }[];
}

/**
 * GET /api/roof-suggest?lat=..&lng=..&zoom=..
 * Two-pass roof tracing with Claude Opus 4.8 vision (pixel-accurate
 * localization): pass 1 traces the roof; pass 2 sees its own outline drawn
 * on the image and corrects it. The user always confirms or redraws (spec §7).
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const lat = Number(p.get("lat")), lng = Number(p.get("lng"));
  const zoom = Math.round(Number(p.get("zoom") ?? 20));
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!mapsKey) return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY not set" }, { status: 500 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  if (!isFinite(lat) || !isFinite(lng)) return NextResponse.json({ error: "bad coords" }, { status: 400 });

  try {
    const client = new Anthropic();
    const center = { lat, lng };
    // scale=2 image: pixel space is 2× → equivalent to zoom+1 over IMG×IMG
    const toLatLng = (pt: { x: number; y: number }): LatLng => latLngFromPixel(pt.x, pt.y, center, zoom + 1, IMG, IMG);

    // ── Pass 1: trace the roof ──
    const base = await fetchMapImage(lat, lng, zoom, mapsKey);
    const first = await tracePolygon(
      client,
      base,
      `This is a ${IMG}x${IMG} pixel satellite image centered on a building. ` +
        `Trace the outline of the MAIN building's roof at the image center as precisely as you can. ` +
        `Give 4 to 14 vertices in pixel coordinates (origin top-left), ordered around the roof edge. ` +
        `Follow the actual roof edges closely, including L-shapes and notches. ` +
        `Stay on the roof: exclude trees, shadows, ground, pool decks, and neighbouring buildings.`
    );
    if (first.length < 3) return NextResponse.json({ error: "no polygon detected" }, { status: 422 });

    // ── Pass 2: show the attempt drawn on the image, ask for corrections ──
    const firstLatLng = first.map(toLatLng);
    const pathPts = [...firstLatLng, firstLatLng[0]]
      .map((v) => `${v.lat.toFixed(6)},${v.lng.toFixed(6)}`)
      .join("|");
    let polygon = firstLatLng;
    try {
      const overlaid = await fetchMapImage(lat, lng, zoom, mapsKey, `&path=color:0xff9900ff|weight:3|${pathPts}`);
      const corrected = await tracePolygon(
        client,
        overlaid,
        `This is a ${IMG}x${IMG} pixel satellite image. The ORANGE polygon is a previous attempt ` +
          `to outline the MAIN building's roof at the image center. Compare it against the actual roof edges ` +
          `and output a CORRECTED polygon (4 to 14 vertices, pixel coordinates, origin top-left) that hugs ` +
          `the true roof outline. Fix any offset, missed sections, or overshoot onto ground/trees/neighbours. ` +
          `If the orange outline is already accurate, return the same shape.`
      );
      if (corrected.length >= 3) polygon = corrected.map(toLatLng);
    } catch {
      // refinement is best-effort — fall back to the first pass
    }

    return NextResponse.json({ polygon });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
