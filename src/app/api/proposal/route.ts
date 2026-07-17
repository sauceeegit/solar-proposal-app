import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PRICES_LAST_REVIEWED } from "@/config/pricing";
import { generateNarrative } from "@/lib/narrative";
import type { ProposalResult } from "@/lib/engine/types";

const DATA_DIR = path.join(process.cwd(), "data");
const PROP_DIR = path.join(DATA_DIR, "proposals");
const LOG_FILE = path.join(DATA_DIR, "log.csv");

// Column layout mirrors the future Google Sheet (spec §1) — swap is one function.
const CSV_HEADER =
  "date,proposal_id,address,province,utility,building_use,phase,roof_type,floors,monthly_bill_thb,tariff_thb_kwh,footprint_m2,max_panels,output_type,mode,recommended_system,price_thb,payback_years,config_version\n";

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GPT-image edit: overlay the designed panels onto the approved building photo. */
async function generatePanelRender(photoPath: string, outPath: string, panelCount: number, dcKw: number): Promise<boolean> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return false;
  try {
    const form = new FormData();
    form.append("model", "gpt-image-1");
    form.append("image", new Blob([new Uint8Array(fs.readFileSync(photoPath))], { type: "image/jpeg" }), "building.jpg");
    form.append(
      "prompt",
      `Photorealistic edit: install a rooftop solar system of exactly ${panelCount} dark-blue monocrystalline solar panels ` +
        `(${dcKw} kW) on the roof of the main building in this photo, arranged in neat straight rows aligned with the roof edges, ` +
        `mounted flush on low-tilt racking. Match the photo's lighting, perspective and shadows. ` +
        `Change NOTHING else in the image — same building, sky, surroundings, colors.`
    );
    form.append("size", "auto");
    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("render failed:", data.error?.message ?? res.status);
      return false;
    }
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) return false;
    fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
    return true;
  } catch (e) {
    console.error("render failed:", e);
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  // accept both { result, photoRefs } and a bare ProposalResult (older callers)
  const result = (body.result ?? body) as ProposalResult;
  const photoRefs: string[] = Array.isArray(body.photoRefs) ? body.photoRefs.slice(0, 4) : [];
  const id = crypto.randomBytes(6).toString("base64url"); // unguessable slug
  // Claude writes the narrative; the engine owns all numbers. Never blocks the save.
  const narrative = await generateNarrative(result);

  // download approved building photos so the proposal is self-contained
  let photoCount = 0;
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key && photoRefs.length > 0) {
    const photoDir = path.join(PROP_DIR, `${id}-photos`);
    fs.mkdirSync(photoDir, { recursive: true });
    for (const ref of photoRefs) {
      if (!/^places\/[\w-]+\/photos\/[\w-]+$/.test(ref)) continue;
      try {
        const res = await fetch(`https://places.googleapis.com/v1/${ref}/media?maxWidthPx=1200&key=${key}`);
        if (!res.ok) continue;
        fs.writeFileSync(path.join(photoDir, `${photoCount}.jpg`), Buffer.from(await res.arrayBuffer()));
        photoCount++;
      } catch {
        // skip failed photo — never block the proposal
      }
    }
  }

  // AI panel render on the approved photo (best-effort, never blocks)
  let hasRender = false;
  const rec0 = result.scenarios[0]?.options[0];
  if (photoCount > 0 && rec0) {
    const photoDir = path.join(PROP_DIR, `${id}-photos`);
    hasRender = await generatePanelRender(
      path.join(photoDir, "0.jpg"),
      path.join(photoDir, "render.jpg"),
      rec0.panelCount,
      rec0.dcKw
    );
  }

  fs.mkdirSync(PROP_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PROP_DIR, `${id}.json`),
    JSON.stringify({ id, createdAt: new Date().toISOString(), result, narrative, photoCount, hasRender }, null, 1)
  );

  const rec = result.scenarios[0]?.options[0];
  const row = [
    new Date().toISOString(),
    id,
    result.site.address,
    result.site.province,
    result.site.utility,
    result.site.use,
    result.site.phase,
    result.site.roofType,
    result.site.floors,
    result.site.monthlyBillTHB ?? "",
    result.site.tariffTHBPerKwh,
    Math.round(result.packing.footprintM2),
    result.packing.count,
    result.outputType,
    result.mode,
    rec ? `${rec.dcKw}kW / ${rec.batteryKwh}kWh / ${rec.inverterCount > 1 ? rec.inverterCount + "x " : ""}${rec.inverter.model}` : "",
    rec?.priceTHB ?? "",
    rec?.paybackYears ?? "",
    PRICES_LAST_REVIEWED,
  ]
    .map(csvEscape)
    .join(",");

  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, CSV_HEADER);
  fs.appendFileSync(LOG_FILE, row + "\n");

  return NextResponse.json({ id, url: `/proposal/${id}` });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id || !/^[\w-]+$/.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const file = path.join(PROP_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(JSON.parse(fs.readFileSync(file, "utf8")));
}
