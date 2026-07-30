import { NextResponse } from "next/server";

/**
 * Serve the Solvio 3D rooftop model from our own origin.
 *
 * The model lives at sauceeegit.github.io and exposes window.solvioSetRoof()
 * to drive the roof outline. Cross-origin iframes cannot be scripted, and the
 * model's postMessage API only covers panel type and module count — so the
 * page is proxied here instead. Same origin means the proposal can call
 * solvioSetRoof directly, using the model's own API untouched, and any update
 * pushed to the 3D repo shows up here on the next revalidation.
 */
const SOURCE = "https://sauceeegit.github.io/solvio-panel-3d/rooftop.html";

export const revalidate = 3600; // an hour is plenty; the model changes rarely

export async function GET() {
  try {
    const res = await fetch(SOURCE, { next: { revalidate } });
    if (!res.ok) return NextResponse.json({ error: `model HTTP ${res.status}` }, { status: 502 });
    const html = await res.text();
    return new NextResponse(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
