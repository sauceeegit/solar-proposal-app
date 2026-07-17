import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/floors?lat=..&lng=..
 * Street View photo → OpenAI vision floor count (spec §2). User confirms.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const lat = Number(p.get("lat")), lng = Number(p.get("lng"));
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!mapsKey || !openaiKey) return NextResponse.json({ error: "API keys not set" }, { status: 500 });
  if (!isFinite(lat) || !isFinite(lng)) return NextResponse.json({ error: "bad coords" }, { status: 400 });

  try {
    // Probe several radii and keep the NEWEST outdoor panorama — the nearest
    // one is often an old user photosphere (e.g. taken from inside a tuk-tuk),
    // while official Street View car captures are newer and further away.
    interface SvMeta { status: string; date?: string; pano_id?: string; location?: { lat: number; lng: number } }
    let meta: SvMeta | null = null;
    for (const radius of [50, 150, 300, 500]) {
      const m: SvMeta = await fetch(
        `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&radius=${radius}&source=outdoor&key=${mapsKey}`
      ).then((r) => r.json());
      if (m.status === "OK" && (!meta || (m.date ?? "") > (meta.date ?? ""))) meta = m;
    }
    if (!meta) return NextResponse.json({ error: "no outdoor Street View coverage here" }, { status: 422 });

    // aim the camera from the panorama toward the building
    const pLat = meta.location?.lat ?? lat, pLng = meta.location?.lng ?? lng;
    const heading = (Math.atan2(
      Math.sin(((lng - pLng) * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180),
      Math.cos((pLat * Math.PI) / 180) * Math.sin((lat * Math.PI) / 180) -
        Math.sin((pLat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.cos(((lng - pLng) * Math.PI) / 180)
    ) * 180) / Math.PI;

    const imgRes = await fetch(
      `https://maps.googleapis.com/maps/api/streetview?size=640x480&pano=${meta.pano_id}&heading=${Math.round((heading + 360) % 360)}&fov=90&pitch=10&key=${mapsKey}`
    );
    if (!imgRes.ok) throw new Error(`street view HTTP ${imgRes.status}`);
    const b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

    const model = process.env.OPENAI_VISION_MODEL || "gpt-4o";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: 'Count the number of above-ground floors (storeys) of the main building in this photo. If no building is clearly visible, use floors: null. Respond with JSON: {"floors": <integer or null>, "confidence": "high"|"medium"|"low"}.',
              },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
            ],
          },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message ?? `OpenAI HTTP ${res.status}`);
    const parsed = JSON.parse(data.choices[0].message.content);
    if (!parsed.floors || parsed.floors < 1) {
      return NextResponse.json({ error: "no building visible in the Street View image — please enter floors manually" }, { status: 422 });
    }
    return NextResponse.json({ floors: parsed.floors, confidence: parsed.confidence ?? "low" });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
