import { NextRequest, NextResponse } from "next/server";
import { detectRoofs } from "@/lib/roof-detect";

// Downloads and processes a mask raster.
export const maxDuration = 60;

/**
 * GET /api/roof-detect?lat=..&lng=..
 * Candidate roof outlines traced from Google's building mask, ranked with the
 * best guess first. The user confirms, switches candidate, or draws manually.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const lat = Number(p.get("lat")), lng = Number(p.get("lng"));
  if (!isFinite(lat) || !isFinite(lng)) {
    return NextResponse.json({ available: false, reason: "bad coords", candidates: [], recommended: -1 }, { status: 400 });
  }
  return NextResponse.json(await detectRoofs(lat, lng));
}
