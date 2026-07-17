import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PRICES_LAST_REVIEWED } from "@/config/pricing";
import { generateNarrative } from "@/lib/narrative";
import { readText, saveBinary, saveText } from "@/lib/storage";
import type { ProposalResult } from "@/lib/engine/types";

const LOG_FILE = path.join(process.cwd(), "data", "log.csv");

// Column layout mirrors the future Google Sheet (spec §1) — swap is one function.
const CSV_HEADER =
  "date,proposal_id,address,province,utility,building_use,phase,roof_type,floors,monthly_bill_thb,tariff_thb_kwh,footprint_m2,max_panels,output_type,mode,recommended_system,price_thb,payback_years,config_version\n";

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GPT-image edit: overlay the designed panels onto the approved building photo. Returns the render bytes or null. */
async function generatePanelRender(photo: Buffer, panelCount: number, dcKw: number): Promise<Buffer | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const form = new FormData();
    form.append("model", "gpt-image-1");
    form.append("image", new Blob([new Uint8Array(photo)], { type: "image/jpeg" }), "building.jpg");
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
      return null;
    }
    const b64 = data.data?.[0]?.b64_json;
    return b64 ? Buffer.from(b64, "base64") : null;
  } catch (e) {
    console.error("render failed:", e);
    return null;
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
  let firstPhoto: Buffer | null = null;
  const gkey = process.env.GOOGLE_MAPS_API_KEY;
  if (gkey && photoRefs.length > 0) {
    for (const ref of photoRefs) {
      if (!/^places\/[\w-]+\/photos\/[\w-]+$/.test(ref)) continue;
      try {
        const res = await fetch(`https://places.googleapis.com/v1/${ref}/media?maxWidthPx=1200&key=${gkey}`);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        await saveBinary(`proposals/${id}-photos/${photoCount}.jpg`, buf, "image/jpeg");
        if (photoCount === 0) firstPhoto = buf;
        photoCount++;
      } catch {
        // skip failed photo — never block the proposal
      }
    }
  }

  // AI panel render on the approved photo (best-effort, never blocks)
  let hasRender = false;
  const rec0 = result.scenarios[0]?.options[0];
  if (firstPhoto && rec0) {
    const render = await generatePanelRender(firstPhoto, rec0.panelCount, rec0.dcKw);
    if (render) {
      await saveBinary(`proposals/${id}-photos/render.jpg`, render, "image/jpeg");
      hasRender = true;
    }
  }

  await saveText(
    `proposals/${id}.json`,
    JSON.stringify({ id, createdAt: new Date().toISOString(), result, narrative, photoCount, hasRender }, null, 1)
  );

  // Local record of every proposal (best-effort). On read-only serverless
  // filesystems this is skipped silently; the Google Sheet is the future home.
  try {
    const rec = result.scenarios[0]?.options[0];
    const row = [
      new Date().toISOString(), id, result.site.address, result.site.province, result.site.utility,
      result.site.use, result.site.phase, result.site.roofType, result.site.floors,
      result.site.monthlyBillTHB ?? "", result.site.tariffTHBPerKwh, Math.round(result.packing.footprintM2),
      result.packing.count, result.outputType, result.mode,
      rec ? `${rec.dcKw}kW / ${rec.batteryKwh}kWh / ${rec.inverterCount > 1 ? rec.inverterCount + "x " : ""}${rec.inverter.model}` : "",
      rec?.priceTHB ?? "", rec?.paybackYears ?? "", PRICES_LAST_REVIEWED,
    ].map(csvEscape).join(",");
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, CSV_HEADER);
    fs.appendFileSync(LOG_FILE, row + "\n");
  } catch {
    // read-only fs (serverless) — logging is optional, never block the proposal
  }

  return NextResponse.json({ id, url: `/proposal/${id}` });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id || !/^[\w-]+$/.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const text = await readText(`proposals/${id}.json`);
  if (!text) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(JSON.parse(text));
}
