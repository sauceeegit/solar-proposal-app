import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/photos?q=<place name/address>&lat=..&lng=..
 * Returns photo references for the building via Google Places (licensed
 * imagery of the actual place — replaces Google-Images scraping, spec §2).
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const q = p.get("q")?.trim();
  const lat = Number(p.get("lat")), lng = Number(p.get("lng"));
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY not set" }, { status: 500 });
  if (!q) return NextResponse.json({ error: "missing q" }, { status: 400 });

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.photos",
      },
      body: JSON.stringify({
        textQuery: q,
        maxResultCount: 1,
        ...(isFinite(lat) && isFinite(lng)
          ? { locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 300 } } }
          : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg: string = data.error?.message ?? `Places HTTP ${res.status}`;
      const hint = /not been used|disabled|PERMISSION_DENIED/i.test(msg)
        ? " — enable “Places API (New)” for your key in Google Cloud Console"
        : "";
      return NextResponse.json({ error: msg + hint }, { status: 502 });
    }
    interface PlacePhoto { name: string; widthPx?: number; heightPx?: number }
    const photos = ((data.places?.[0]?.photos ?? []) as PlacePhoto[]).slice(0, 8);
    return NextResponse.json({
      place: data.places?.[0]?.displayName?.text ?? q,
      photos: photos.map((ph) => ({ ref: ph.name })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
