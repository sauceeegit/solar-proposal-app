import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

/** Serves a saved proposal photo: /api/proposal-photo?id=..&n=0 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const id = p.get("id");
  const n = p.get("n") ?? "";
  if (!id || !/^[\w-]+$/.test(id) || !/^([0-9]|render)$/.test(n)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  const file = path.join(process.cwd(), "data", "proposals", `${id}-photos`, `${n}.jpg`);
  if (!fs.existsSync(file)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(fs.readFileSync(file)), {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" },
  });
}
