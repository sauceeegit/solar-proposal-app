import { NextRequest, NextResponse } from "next/server";
import { readBinary } from "@/lib/storage";

/** Serves a saved proposal photo: /api/proposal-photo?id=..&n=0 (or n=render) */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const id = p.get("id");
  const n = p.get("n") ?? "";
  if (!id || !/^[\w-]+$/.test(id) || !/^([0-9]|render)$/.test(n)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  const buf = await readBinary(`proposals/${id}-photos/${n}.jpg`);
  if (!buf) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(buf), {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" },
  });
}
