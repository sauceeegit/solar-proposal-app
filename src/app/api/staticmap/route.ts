import { NextRequest, NextResponse } from "next/server";

/** Proxies Google Static Maps so the server key never reaches the browser. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const lat = Number(p.get("lat")), lng = Number(p.get("lng"));
  const zoom = Number(p.get("zoom") ?? 20);
  const w = Math.min(640, Number(p.get("w") ?? 640));
  const h = Math.min(640, Number(p.get("h") ?? 400));
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY not set" }, { status: 500 });
  if (!isFinite(lat) || !isFinite(lng)) return NextResponse.json({ error: "bad coords" }, { status: 400 });

  const url =
    `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}` +
    `&zoom=${zoom}&size=${w}x${h}&scale=2&maptype=satellite&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) return NextResponse.json({ error: `static map HTTP ${res.status}` }, { status: 502 });
  return new NextResponse(res.body, {
    headers: { "content-type": res.headers.get("content-type") ?? "image/png", "cache-control": "public, max-age=86400" },
  });
}
