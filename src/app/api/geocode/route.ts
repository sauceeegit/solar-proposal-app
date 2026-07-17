import { NextRequest, NextResponse } from "next/server";

const KEY = process.env.GOOGLE_MAPS_API_KEY;

/** Extract lat/lng from a Google Maps URL (!3d..!4d.. or @lat,lng). */
function coordsFromMapsUrl(url: string): { lat: number; lng: number } | null {
  const m1 = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
  const m2 = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
  return null;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "missing q" }, { status: 400 });
  if (!KEY) return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY not set in .env.local" }, { status: 500 });

  try {
    // Pasted Google Maps link (incl. maps.app.goo.gl short links)
    if (/^https?:\/\//i.test(q)) {
      let url = q;
      if (/maps\.app\.goo\.gl|goo\.gl/.test(q)) {
        const r = await fetch(q, { redirect: "manual" });
        url = r.headers.get("location") ?? q;
      }
      const coords = coordsFromMapsUrl(decodeURIComponent(url));
      if (!coords) return NextResponse.json({ error: "could not read coordinates from that link" }, { status: 422 });
      // reverse geocode for address + province
      const rev = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${coords.lat},${coords.lng}&key=${KEY}`
      ).then((r) => r.json());
      const first = rev.results?.[0];
      const nameMatch = decodeURIComponent(url).match(/\/maps\/place\/([^/@]+)/);
      const placeName = nameMatch ? nameMatch[1].replace(/\+/g, " ") : undefined;
      return NextResponse.json({
        candidates: [
          {
            address: placeName ? `${placeName} — ${first?.formatted_address ?? ""}` : first?.formatted_address ?? q,
            location: coords,
            province: provinceOf(first),
          },
        ],
      });
    }

    // Free-text address
    const geo = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=th&key=${KEY}`
    ).then((r) => r.json());
    if (geo.status !== "OK") {
      return NextResponse.json({ error: `geocoding failed: ${geo.status}${geo.error_message ? " — " + geo.error_message : ""}` }, { status: 422 });
    }
    interface GeoResult { formatted_address: string; geometry: { location: { lat: number; lng: number } }; types?: string[]; address_components?: { long_name: string; types: string[] }[] }
    const candidates = (geo.results as GeoResult[]).slice(0, 5).map((r) => ({
      address: r.formatted_address,
      location: r.geometry.location,
      province: provinceOf(r),
      // street addresses need area clarification per spec §2
      isStreetAddress: (r.types ?? []).some((t: string) => ["route", "street_address"].includes(t)),
    }));
    return NextResponse.json({ candidates });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function provinceOf(result: { address_components?: { long_name: string; types: string[] }[] } | undefined): string {
  if (!result?.address_components) return "";
  const admin1 = result.address_components.find((c) => c.types.includes("administrative_area_level_1"));
  return admin1?.long_name ?? "";
}
