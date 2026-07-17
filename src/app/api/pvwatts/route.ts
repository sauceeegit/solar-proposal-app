import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const CACHE_FILE = path.join(process.cwd(), "data", "pvwatts-cache.json");

function readCache(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}

/**
 * GET /api/pvwatts?lat=..&lon=..&tilt=..&azimuth=..
 * Returns { yieldKwhPerKwpYr, monthly } for a 1 kWp fixed roof-mount array.
 * Cached to disk — PVWatts DEMO_KEY is heavily rate-limited.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const lat = Number(p.get("lat")), lon = Number(p.get("lon"));
  const tilt = Number(p.get("tilt") ?? 10), azimuth = Number(p.get("azimuth") ?? 180);
  if (!isFinite(lat) || !isFinite(lon)) return NextResponse.json({ error: "missing lat/lon" }, { status: 400 });

  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${Math.round(tilt)},${Math.round(azimuth)}`;
  const cache = readCache();
  if (cache[key]) return NextResponse.json(cache[key]);

  const apiKey = process.env.NREL_API_KEY || "DEMO_KEY";
  const url =
    `https://developer.nlr.gov/api/pvwatts/v8.json?api_key=${apiKey}` +
    `&lat=${lat}&lon=${lon}&system_capacity=1&module_type=0&array_type=1` +
    `&tilt=${tilt}&azimuth=${azimuth}&losses=14`;

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.outputs) {
    return NextResponse.json({ error: data.errors?.join("; ") ?? `PVWatts HTTP ${res.status}` }, { status: 502 });
  }

  const out = {
    yieldKwhPerKwpYr: Math.round(data.outputs.ac_annual),
    monthlyKwhPerKwp: (data.outputs.ac_monthly as number[]).map((v) => Math.round(v)),
    solradAnnual: data.outputs.solrad_annual,
    station: data.station_info?.location ?? null,
  };
  cache[key] = out;
  writeCache(cache);
  return NextResponse.json(out);
}
