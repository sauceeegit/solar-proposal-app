"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { DEFAULT_TILT_DEG, type BuildingUse, type RoofType } from "@/config/assumptions";
import { defaultTariff, utilityForProvince } from "@/lib/engine/utility";
import { optimize } from "@/lib/engine/optimizer";
import type { LatLng, OptimizationMode, PackingResult, ProposalResult } from "@/lib/engine/types";
import type { RoofCheck } from "@/lib/solar-api";
import ResultsView from "@/components/ResultsView";

const RoofMap = dynamic(() => import("@/components/RoofMap"), { ssr: false });

interface Candidate {
  address: string;
  location: LatLng;
  province: string;
  isStreetAddress?: boolean;
}

export default function Home() {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // step 1
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [use, setUse] = useState<BuildingUse>("residential");
  const [bill, setBill] = useState("");
  const [tariff, setTariff] = useState("");
  const [floors, setFloors] = useState("");
  const [phase, setPhase] = useState<"auto" | "single" | "three">("auto");
  const [roofType, setRoofType] = useState<RoofType>("flat");
  const [geoErr, setGeoErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [floorsBusy, setFloorsBusy] = useState(false);

  // step 2
  const [polygon, setPolygon] = useState<LatLng[]>([]);
  const [packing, setPacking] = useState<PackingResult | null>(null);
  const [roofConfirmed, setRoofConfirmed] = useState(false);
  const [roofCheck, setRoofCheck] = useState<RoofCheck | null>(null);
  const [checking, setChecking] = useState(false);

  // step 3
  const [mode, setMode] = useState<OptimizationMode>("max-savings");
  const [result, setResult] = useState<ProposalResult | null>(null);
  const [calcErr, setCalcErr] = useState("");

  const utility = picked ? utilityForProvince(picked.province) : "PEA";
  const effectivePhase = phase !== "auto" ? phase : use === "residential" ? "single" : "three";
  const effectiveTariff = tariff ? parseFloat(tariff) : defaultTariff(utility, use);

  const search = async () => {
    setBusy(true);
    setGeoErr("");
    setCandidates(null);
    setPicked(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data.error) setGeoErr(data.error);
      else {
        setCandidates(data.candidates);
        if (data.candidates.length === 1 && !data.candidates[0].isStreetAddress) setPicked(data.candidates[0]);
      }
    } catch (e) {
      setGeoErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onPolygonChange = useCallback((poly: LatLng[], pack: PackingResult | null) => {
    setPolygon(poly);
    setPacking(pack);
    setRoofConfirmed(false); // any change to the outline requires re-verification
    setRoofCheck(null); // and invalidates the Solar API cross-check
  }, []);

  /** On confirm, cross-check the outline against Google Solar API rasters. */
  const confirmRoof = async (checked: boolean) => {
    setRoofConfirmed(checked);
    if (!checked || polygon.length < 3 || roofCheck) return;
    setChecking(true);
    try {
      const r = await fetch("/api/roof-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ polygon }),
      });
      setRoofCheck(await r.json());
    } catch {
      setRoofCheck({ available: false, reason: "check unavailable", warnings: [] });
    } finally {
      setChecking(false);
    }
  };

  const calculate = async (m: OptimizationMode) => {
    if (!picked || !packing) return;
    setBusy(true);
    setCalcErr("");
    try {
      // Measured roof pitch wins on genuinely sloped roofs; otherwise our default.
      const tilt = roofCheck?.detectedPitchDeg != null && roofCheck.detectedPitchDeg >= 10
        ? roofCheck.detectedPitchDeg
        : DEFAULT_TILT_DEG[roofType];
      // panels face the roof-edge normal closest to south (computed by the packer),
      // unless Solar API measured a real slope direction
      const azimuth = roofCheck?.detectedAzimuthDeg ?? packing.azimuthDeg;
      const res = await fetch(
        `/api/pvwatts?lat=${picked.location.lat}&lon=${picked.location.lng}&tilt=${tilt}&azimuth=${Math.round(azimuth)}`
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      // Apply measured shading from Solar API (PVWatts' 14% loss excludes shading,
      // so this is not double-counted). Unshaded roofs get a factor of 1.
      const shading = roofCheck?.available ? roofCheck.shadingFactor ?? 1 : 1;
      const yieldKwhPerKwpYr = Math.round(data.yieldKwhPerKwpYr * shading);
      setResult(
        optimize(
          {
            address: picked.address,
            location: picked.location,
            province: picked.province,
            utility,
            use,
            roofType,
            phase: effectivePhase,
            roofPolygon: polygon,
            floors: floors ? parseInt(floors) : 1,
            monthlyBillTHB: bill ? parseFloat(bill) : undefined,
            tariffTHBPerKwh: effectiveTariff,
            yieldKwhPerKwpYr,
            tiltDeg: tilt,
            azimuthDeg: azimuth,
            shadingFactor: roofCheck?.available ? roofCheck.shadingFactor : undefined,
          },
          m
        )
      );
      setStep(3);
    } catch (e) {
      setCalcErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const missingKey = !process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const stepTitle = useMemo(() => ["Building details", "Outline the roof", "System options"][step - 1], [step]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="text-2xl font-black tracking-tight text-slate-900">
          SOLVIO<span className="text-amber-500">.</span>
        </span>
        <span className="text-sm text-slate-500">Solar Proposal Builder</span>
        <span className="ml-auto text-sm font-medium text-slate-400">
          Step {step}/3 — {stepTitle}
        </span>
      </header>

      {missingKey && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          <b>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set.</b> Paste your key into <code>solvio-app/.env.local</code> and restart the dev server.
        </div>
      )}

      {step === 1 && (
        <section className="space-y-5">
          <div>
            <label className="mb-1 block text-sm font-semibold text-slate-700">Google address or Maps link</label>
            <div className="flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder="Building name, address, or https://maps.app.goo.gl/… link"
                className="w-full rounded border px-3 py-2 text-sm"
              />
              <button onClick={search} disabled={busy || !query} className="rounded bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
                {busy ? "Searching…" : "Search"}
              </button>
            </div>
            {geoErr && <p className="mt-1 text-sm text-red-600">{geoErr}</p>}
            {candidates && candidates.length > 0 && (
              <div className="mt-2 space-y-1">
                {candidates.some((c) => c.isStreetAddress) && (
                  <p className="text-xs text-amber-600">That looks like a street address — please confirm which building you mean:</p>
                )}
                {candidates.map((c, i) => (
                  <button
                    key={i}
                    onClick={() => setPicked(c)}
                    className={`block w-full rounded border px-3 py-2 text-left text-sm ${picked === c ? "border-amber-500 bg-amber-50" : "hover:bg-slate-50"}`}
                  >
                    {c.address} <span className="text-xs text-slate-400">({c.province || "?"} → {utilityForProvince(c.province)})</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">Building usage</label>
              <select value={use} onChange={(e) => setUse(e.target.value as BuildingUse)} className="w-full rounded border px-3 py-2 text-sm">
                <option value="residential">Residential</option>
                <option value="hotel">Hotel</option>
                <option value="office">Office</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">
                Roof type <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <select value={roofType} onChange={(e) => setRoofType(e.target.value as RoofType)} className="w-full rounded border px-3 py-2 text-sm">
                <option value="flat">Flat (default)</option>
                <option value="tilted-one">Tilted — one side</option>
                <option value="tilted-two">Tilted — both sides</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">Electrical phase</label>
              <select value={phase} onChange={(e) => setPhase(e.target.value as "auto" | "single" | "three")} className="w-full rounded border px-3 py-2 text-sm">
                <option value="auto">Auto ({use === "residential" ? "1-phase" : "3-phase"})</option>
                <option value="single">Single-phase</option>
                <option value="three">Three-phase</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">
                Electricity bill <span className="font-normal text-slate-400">(THB/month, optional)</span>
              </label>
              <input value={bill} onChange={(e) => setBill(e.target.value)} type="number" placeholder="e.g. 45000" className="w-full rounded border px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">
                Tariff <span className="font-normal text-slate-400">(THB/kWh, optional)</span>
              </label>
              <input value={tariff} onChange={(e) => setTariff(e.target.value)} type="number" step="0.1" placeholder={`default ${defaultTariff(utility, use)}`} className="w-full rounded border px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">
                Floors <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <div className="flex gap-1">
                <input value={floors} onChange={(e) => setFloors(e.target.value)} type="number" placeholder="e.g. 4" className="w-full rounded border px-3 py-2 text-sm" />
                <button
                  onClick={async () => {
                    if (!picked) return;
                    setFloorsBusy(true);
                    try {
                      const r = await fetch(`/api/floors?lat=${picked.location.lat}&lng=${picked.location.lng}`).then((r) => r.json());
                      if (r.floors) setFloors(String(r.floors));
                      else setGeoErr(r.error ?? "floor count failed");
                    } finally {
                      setFloorsBusy(false);
                    }
                  }}
                  disabled={!picked || floorsBusy}
                  title="Count floors from Street View (AI) — please verify the result"
                  className="whitespace-nowrap rounded border border-amber-500 px-2 py-1 text-xs font-semibold text-amber-600 hover:bg-amber-50 disabled:opacity-40"
                >
                  {floorsBusy ? "…" : "Auto"}
                </button>
              </div>
            </div>
          </div>

          <button
            onClick={() => setStep(2)}
            disabled={!picked}
            className="rounded bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Continue → outline the roof
          </button>
        </section>
      )}

      {step === 2 && picked && (
        <section className="space-y-4">
          <p className="text-sm text-slate-600">
            <b>{picked.address}</b> — {utility} area · {use} · {roofType} roof
          </p>
          <RoofMap center={picked.location} roofType={roofType} onPolygonChange={onPolygonChange} />
          {calcErr && <p className="text-sm text-red-600">{calcErr}</p>}

          {packing && packing.count > 0 && (
            <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${roofConfirmed ? "border-green-500 bg-green-50" : "border-amber-400 bg-amber-50"}`}>
              <input
                type="checkbox"
                checked={roofConfirmed}
                onChange={(e) => confirmRoof(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-green-600"
              />
              <span className="text-slate-700">
                <b>I&apos;ve verified the roof outline.</b> The orange polygon matches the actual building footprint (
                {Math.round(packing.footprintM2)} m², {packing.count} panels max). Drag the corners to correct it, or redraw —
                the AI suggestion is only a starting point.
              </span>
            </label>
          )}

          {/* Google Solar API cross-check — advisory only, never changes the design */}
          {checking && <p className="text-sm text-slate-500">Cross-checking against Google Solar data…</p>}
          {roofCheck && !checking && (
            <div className={`rounded-lg border p-3 text-sm ${roofCheck.warnings.length > 0 ? "border-amber-400 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
              <div className="mb-1 font-semibold text-slate-800">
                Google Solar cross-check{roofCheck.available ? "" : " — unavailable"}
              </div>
              {!roofCheck.available && (
                <p className="text-xs text-slate-500">
                  No Solar API data for this location ({roofCheck.reason}). Your outline is used as-is; shading is assumed none.
                </p>
              )}
              {roofCheck.available && (
                <ul className="space-y-0.5 text-xs text-slate-600">
                  {roofCheck.maskCoverage !== undefined && (
                    <li>
                      {roofCheck.maskCoverage >= 0.7 ? "✓" : "⚠"} <b>{Math.round(roofCheck.maskCoverage * 100)}%</b> of your outline sits on a roof in Google&apos;s building data
                    </li>
                  )}
                  {roofCheck.shadingFactor !== undefined && (
                    <li>
                      {roofCheck.shadingFactor >= 0.9 ? "✓" : "⚠"} Measured shading: roof averages <b>{Math.round(roofCheck.shadingFactor * 100)}%</b> of its best-exposed area
                      {roofCheck.shadingFactor < 1 && " — production is derated by this"}
                    </li>
                  )}
                  {roofCheck.detectedAreaM2 !== undefined && (
                    <li>Google measures this building at <b>{roofCheck.detectedAreaM2} m²</b>{packing ? ` (yours: ${Math.round(packing.footprintM2)} m²)` : ""}</li>
                  )}
                  {roofCheck.detectedPitchDeg !== undefined && (
                    <li>
                      Measured roof pitch <b>{roofCheck.detectedPitchDeg}°</b>
                      {roofCheck.detectedAzimuthDeg !== undefined ? `, facing ${roofCheck.detectedAzimuthDeg}°` : " (flat — panels aimed south on racking)"}
                    </li>
                  )}
                  <li className="text-slate-400">
                    Source: Google Solar API {roofCheck.imageryQuality} imagery{roofCheck.imageryDate ? `, ${roofCheck.imageryDate}` : ""} · {roofCheck.samplePixels} samples · advisory only, your outline decides the design
                  </li>
                </ul>
              )}
              {roofCheck.warnings.map((w, i) => (
                <p key={i} className="mt-1.5 text-xs font-medium text-amber-700">⚠ {w}</p>
              ))}
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={() => setStep(1)} className="rounded border px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
              ← Back
            </button>
            <button
              onClick={() => calculate(mode)}
              disabled={!packing || packing.count === 0 || !roofConfirmed || busy}
              title={!roofConfirmed ? "Verify the roof outline first" : undefined}
              className="rounded bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
            >
              {busy ? "Calculating…" : `Calculate options (${packing?.count ?? 0} panels max)`}
            </button>
          </div>
        </section>
      )}

      {step === 3 && result && (
        <ResultsView
          result={result}
          mode={mode}
          onModeChange={(m) => {
            setMode(m);
            calculate(m);
          }}
          onBack={() => setStep(2)}
          busy={busy}
        />
      )}
    </main>
  );
}
