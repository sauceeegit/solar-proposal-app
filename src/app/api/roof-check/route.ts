import { NextRequest, NextResponse } from "next/server";
import { checkRoof } from "@/lib/solar-api";
import type { LatLng } from "@/lib/engine/types";

// Downloads and parses two GeoTIFFs — allow room on slow connections.
export const maxDuration = 60;

/**
 * POST { polygon: LatLng[] }
 * Cross-checks the confirmed roof outline against Google Solar API rasters and
 * returns measured shading. Advisory only — never alters area, panels or price.
 */
export async function POST(req: NextRequest) {
  try {
    const { polygon } = (await req.json()) as { polygon?: LatLng[] };
    if (!Array.isArray(polygon) || polygon.length < 3) {
      return NextResponse.json({ available: false, reason: "bad polygon", warnings: [] }, { status: 400 });
    }
    return NextResponse.json(await checkRoof(polygon));
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e), warnings: [] });
  }
}
