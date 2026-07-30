"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { roof3dFromPolygon } from "@/lib/engine/roof3d";
import Roof3D from "@/components/Roof3D";
import type { OptimizationMode, ProposalResult, SystemOption } from "@/lib/engine/types";

const MAX_PHOTOS = 1;

const MODES: { id: OptimizationMode; label: string }[] = [
  { id: "max-savings", label: "Maximum savings" },
  { id: "daytime-load", label: "Cover 100% daytime load" },
  { id: "shortest-payback", label: "Shortest payback" },
  { id: "max-roof", label: "Maximum roof utilization" },
];

const thb = (n: number) => `฿${n.toLocaleString("en-US")}`;

function OptionCard({ o }: { o: SystemOption }) {
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <h4 className="font-bold text-slate-900">{o.label}</h4>
        <span className="text-lg font-black text-amber-600">{thb(o.priceTHB)}</span>
      </div>
      <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
        <div><dt className="text-xs text-slate-400">Panels</dt><dd className="font-semibold">{o.panelCount} × 450 W</dd></div>
        <div><dt className="text-xs text-slate-400">Inverter</dt><dd className="font-semibold">{o.inverterCount > 1 ? `${o.inverterCount}× ` : ""}{o.inverter.model}</dd></div>
        <div><dt className="text-xs text-slate-400">Battery</dt><dd className="font-semibold">{o.batteryKwh > 0 ? `${o.batteryKwh} kWh` : "—"}</dd></div>
        <div><dt className="text-xs text-slate-400">Breakeven</dt><dd className="font-semibold">{o.paybackYears !== null ? `${o.paybackYears} yrs` : ">25 yrs"}</dd></div>
        <div><dt className="text-xs text-slate-400">Production</dt><dd>{Math.round(o.flows.annualProductionKwh).toLocaleString()} kWh/yr</dd></div>
        <div><dt className="text-xs text-slate-400">1st-yr savings</dt><dd>{thb(o.firstYearSavingsTHB)}</dd></div>
        <div><dt className="text-xs text-slate-400">25-yr savings</dt><dd>{thb(o.totalSavings25yrTHB)}</dd></div>
        <div><dt className="text-xs text-slate-400">NPV</dt><dd>{thb(o.npvTHB)}</dd></div>
      </dl>
      <p className="text-xs leading-relaxed text-slate-500">{o.rationale}</p>
    </div>
  );
}

export default function ResultsView({
  result,
  mode,
  onModeChange,
  onBack,
  busy,
}: {
  result: ProposalResult;
  mode: OptimizationMode;
  onModeChange: (m: OptimizationMode) => void;
  onBack: () => void;
  busy: boolean;
}) {
  const router = useRouter();
  // the outline is fixed by now, so only recompute if the site itself changes
  const roof3d = useMemo(
    () => roof3dFromPolygon(result.site.roofPolygon, result.site.obstructions),
    [result.site.roofPolygon, result.site.obstructions]
  );
  // the 3D always shows the roof filled — not the smaller export-eligible
  // option — so it reads as "here is everything this roof can take"
  const maxPanels = result.packing.count;
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [saveErr, setSaveErr] = useState("");
  const [saveToDrive, setSaveToDrive] = useState(true);
  const [photos, setPhotos] = useState<{ ref: string }[]>([]);
  const [photoErr, setPhotoErr] = useState("");
  const [approved, setApproved] = useState<string[]>([]);

  // building photos via Google Places — user approves each before inclusion (spec §2)
  useEffect(() => {
    const { address, location } = result.site;
    fetch(`/api/photos?q=${encodeURIComponent(address)}&lat=${location.lat}&lng=${location.lng}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setPhotoErr(d.error) : setPhotos(d.photos ?? [])))
      .catch((e) => setPhotoErr(String(e)));
  }, [result.site]);

  const toggle = (ref: string) =>
    setApproved((cur) =>
      cur.includes(ref) ? cur.filter((r) => r !== ref) : cur.length < MAX_PHOTOS ? [...cur, ref] : cur
    );

  const generate = async () => {
    setSaving(true);
    setSaveErr("");
    setSaveStatus("Generating proposal…");
    try {
      const res = await fetch("/api/proposal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ result, photoRefs: approved }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      // File a PDF copy into Google Drive only if the user opted in (best-effort)
      if (saveToDrive) {
        setSaveStatus("Saving a PDF to your Google Drive…");
        try {
          await fetch("/api/archive-pdf", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: data.id }),
          });
        } catch {
          // Drive archive is optional
        }
      }
      router.push(data.url);
    } catch (e) {
      setSaveErr(String(e));
      setSaving(false);
      setSaveStatus("");
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-700">Optimize for:</span>
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => onModeChange(m.id)}
            disabled={busy}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${mode === m.id ? "bg-slate-900 text-white" : "border text-slate-600 hover:bg-slate-50"}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <p className="text-sm text-slate-600">
        Output {result.outputType} · {result.site.address} · {result.site.utility} · yield {result.site.yieldKwhPerKwpYr} kWh/kWp/yr (tilt {result.site.tiltDeg}°, azimuth {Math.round(result.site.azimuthDeg)}°) · roof fits {result.packing.count} panels ({result.packing.maxKw.toFixed(1)} kWp)
      </p>

      {roof3d && (
        <div className="space-y-2">
          <h3 className="font-bold text-slate-900">
            3D preview — full roof, {maxPanels} panels ({result.packing.maxKw.toFixed(1)} kWp)
            <span className="text-sm font-normal text-slate-500"> — check this before generating the proposal; it is what the customer will see</span>
          </h3>
          <Roof3D roof={roof3d} panelCount={maxPanels} tilted={result.site.roofType === "flat"} />
        </div>
      )}

      {result.scenarios.map((s, i) => (
        <div key={i} className="space-y-3">
          <div>
            <h3 className="font-bold text-slate-900">{s.name}</h3>
            <p className="text-xs text-slate-500">{s.description} · assumed consumption {Math.round(s.annualLoadKwh).toLocaleString()} kWh/yr</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {s.options.map((o, j) => (
              <OptionCard key={j} o={o} />
            ))}
          </div>
        </div>
      ))}

      {(photos.length > 0 || photoErr) && (
        <div className="space-y-2">
          <h3 className="font-bold text-slate-900">
            Building photo <span className="text-sm font-normal text-slate-500">— pick the ONE photo that best shows the roof and building exterior; AI will render your panels onto it ({approved.length}/{MAX_PHOTOS} selected)</span>
          </h3>
          {photoErr && <p className="text-xs text-amber-600">Photos unavailable: {photoErr}</p>}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {photos.map((p) => {
              const on = approved.includes(p.ref);
              return (
                <button
                  key={p.ref}
                  onClick={() => toggle(p.ref)}
                  className={`relative overflow-hidden rounded-lg border-4 text-left ${on ? "border-green-500" : "border-transparent hover:border-amber-300"}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/photos/media?ref=${encodeURIComponent(p.ref)}`} alt="Building" className="h-36 w-full object-cover" loading="lazy" />
                  <span className={`absolute right-1.5 top-1.5 rounded-full px-2 py-0.5 text-xs font-bold ${on ? "bg-green-500 text-white" : "bg-black/50 text-white"}`}>
                    {on ? "✓ included" : "tap to include"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
        <b>Assumptions & notes:</b>
        <ul className="mt-1 list-inside list-disc">
          {result.assumptionNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </div>

      {saveErr && <p className="text-sm text-red-600">{saveErr}</p>}
      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={saveToDrive}
          onChange={(e) => setSaveToDrive(e.target.checked)}
          disabled={saving}
          className="h-4 w-4 accent-amber-500"
        />
        Save a PDF copy to my Google Drive
      </label>
      <div className="flex items-center gap-3">
        <button onClick={onBack} disabled={saving} className="rounded border px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          ← Adjust roof
        </button>
        <button onClick={generate} disabled={saving} className="rounded bg-amber-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
          {saving ? "Generating…" : "Generate proposal link →"}
        </button>
        {saving && saveStatus && <span className="text-sm text-slate-500">{saveStatus}</span>}
      </div>
    </section>
  );
}
