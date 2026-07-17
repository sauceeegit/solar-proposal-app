import { NextRequest, NextResponse } from "next/server";

/** Streams a Places photo (keeps the API key server-side). */
export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get("ref");
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY not set" }, { status: 500 });
  if (!ref || !/^places\/[\w-]+\/photos\/[\w-]+$/.test(ref)) {
    return NextResponse.json({ error: "bad ref" }, { status: 400 });
  }
  const res = await fetch(`https://places.googleapis.com/v1/${ref}/media?maxWidthPx=900&key=${key}`);
  if (!res.ok) return NextResponse.json({ error: `photo HTTP ${res.status}` }, { status: 502 });
  return new NextResponse(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "image/jpeg",
      "cache-control": "public, max-age=86400",
    },
  });
}
