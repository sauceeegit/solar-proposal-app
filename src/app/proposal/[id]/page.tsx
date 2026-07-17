import fs from "fs";
import path from "path";
import { notFound } from "next/navigation";
import { PRICES_LAST_REVIEWED } from "@/config/pricing";
import { cashFlowSeries } from "@/lib/engine/economics";
import { toLocalMeters } from "@/lib/engine/roof";
import { centroid, fitZoom, pixelInImage } from "@/lib/mercator";
import type { Narrative } from "@/lib/narrative";
import type { LatLng, ProposalResult, SystemOption } from "@/lib/engine/types";

const thb = (n: number) => `฿${n.toLocaleString("en-US")}`;
const IMG_W = 640, IMG_H = 420;
const EARTH_R = 6_371_000;

function metersToLatLng(origin: LatLng, x: number, y: number): LatLng {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    lat: origin.lat + ((y / EARTH_R) * 180) / Math.PI,
    lng: origin.lng + ((x / (EARTH_R * cosLat)) * 180) / Math.PI,
  };
}

function PanelOverlay({ result }: { result: ProposalResult }) {
  const poly = result.site.roofPolygon;
  const c = centroid(poly);
  const zoom = fitZoom(poly, IMG_W, IMG_H);
  const { origin } = toLocalMeters(poly);

  const outline = poly.map((p) => pixelInImage(p, c, zoom, IMG_W, IMG_H));
  const panelPolys = result.packing.panels.map((p) => {
    const rot = (p.rotDeg * Math.PI) / 180;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    return [
      [-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [p.w / 2, p.h / 2], [-p.w / 2, p.h / 2],
    ].map(([dx, dy]) => {
      const ll = metersToLatLng(origin, p.x + dx * cos - dy * sin, p.y + dx * sin + dy * cos);
      return pixelInImage(ll, c, zoom, IMG_W, IMG_H);
    });
  });

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/staticmap?lat=${c.lat}&lng=${c.lng}&zoom=${zoom}&w=${IMG_W}&h=${IMG_H}`} alt="Roof top view" width={IMG_W} height={IMG_H} className="block w-full" />
      <svg viewBox={`0 0 ${IMG_W} ${IMG_H}`} className="absolute inset-0 h-full w-full">
        <polygon points={outline.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#f59e0b" strokeWidth="2" />
        {panelPolys.map((corners, i) => (
          <polygon key={i} points={corners.map((p) => `${p.x},${p.y}`).join(" ")} fill="#0f2c56" fillOpacity="0.9" stroke="#7fb2ff" strokeWidth="0.5" />
        ))}
      </svg>
      <div className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-1 text-xs font-semibold text-white">
        {result.packing.count} × 450 W panels — exact designed layout
      </div>
    </div>
  );
}

function CashFlowChart({ option, tariff }: { option: SystemOption; tariff: number }) {
  const series = cashFlowSeries(option.priceTHB, option.flows, tariff);
  const W = 640, H = 200, PAD = 38;
  const min = Math.min(...series), max = Math.max(...series);
  const x = (i: number) => PAD + (i / (series.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / (max - min)) * (H - PAD * 2);
  const zeroY = y(0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-2xl border bg-white">
      <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="#cbd5e1" strokeDasharray="4 3" />
      <polyline points={series.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke="#f59e0b" strokeWidth="3" />
      {option.paybackYears !== null && (
        <>
          <line x1={x(option.paybackYears)} y1={16} x2={x(option.paybackYears)} y2={H - PAD} stroke="#0f2c56" strokeDasharray="3 3" />
          <text x={x(option.paybackYears) + 5} y={26} fontSize="12" fill="#0f2c56" fontWeight="bold">
            breakeven {option.paybackYears} yrs
          </text>
        </>
      )}
      <text x={PAD} y={H - 8} fontSize="10" fill="#94a3b8">year 0</text>
      <text x={W - PAD - 38} y={H - 8} fontSize="10" fill="#94a3b8">year 25</text>
    </svg>
  );
}

function OptionCard({ o, highlight }: { o: SystemOption; highlight: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${highlight ? "border-amber-400 bg-amber-50/60 shadow-sm" : "bg-white"}`}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h4 className="font-bold text-slate-900">{o.batteryKwh > 0 ? `With ${o.batteryKwh} kWh battery` : "Solar only"}</h4>
        {highlight && <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Recommended</span>}
      </div>
      <div className="mb-3 text-2xl font-black text-slate-900">{thb(o.priceTHB)}</div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-slate-100 p-2">
          <div className="text-base font-bold text-slate-900">{o.dcKw}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">kWp</div>
        </div>
        <div className="rounded-lg bg-slate-100 p-2">
          <div className="text-base font-bold text-slate-900">{o.paybackYears ?? ">25"}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">yrs payback</div>
        </div>
        <div className="rounded-lg bg-slate-100 p-2">
          <div className="text-base font-bold text-green-700">{thb(o.firstYearSavingsTHB)}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">yr-1 savings</div>
        </div>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold text-slate-500 hover:text-slate-700">System details &amp; reasoning</summary>
        <table className="mt-2 w-full text-xs">
          <tbody>
            <tr><td className="py-0.5 text-slate-400">Panels</td><td className="text-right font-semibold">{o.panelCount} × 450 W</td></tr>
            <tr><td className="py-0.5 text-slate-400">Inverter</td><td className="text-right font-semibold">{o.inverterCount > 1 ? `${o.inverterCount} × ` : ""}{o.inverter.brand} {o.inverter.model}</td></tr>
            <tr><td className="py-0.5 text-slate-400">Battery</td><td className="text-right font-semibold">{o.batteryKwh > 0 ? `${o.batteryKwh} kWh LFP` : "—"}</td></tr>
            <tr><td className="py-0.5 text-slate-400">Annual production</td><td className="text-right">{Math.round(o.flows.annualProductionKwh).toLocaleString()} kWh</td></tr>
            <tr><td className="py-0.5 text-slate-400">25-yr savings</td><td className="text-right">{thb(o.totalSavings25yrTHB)}</td></tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{o.rationale}</p>
      </details>
    </div>
  );
}

export default async function ProposalPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  if (!/^[\w-]+$/.test(id)) notFound();
  const file = path.join(process.cwd(), "data", "proposals", `${id}.json`);
  if (!fs.existsSync(file)) notFound();
  const { result, createdAt, narrative, photoCount, hasRender } = JSON.parse(fs.readFileSync(file, "utf8")) as {
    result: ProposalResult;
    createdAt: string;
    narrative?: Narrative | null;
    photoCount?: number;
    hasRender?: boolean;
  };
  const recommended = result.scenarios[0]?.options[0];
  const dateStr = new Date(createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      {/* ── Hero ── */}
      <header className="mb-6 overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 to-slate-800 p-8 text-white">
        <div className="mb-6 flex items-baseline justify-between">
          <span className="text-2xl font-black tracking-tight">
            SOLVIO<span className="text-amber-400">.</span>
          </span>
          <span className="text-xs text-slate-400">www.solvio.solar</span>
        </div>
        <h1 className="mb-2 text-3xl font-black leading-tight md:text-4xl">
          {narrative?.headline ?? "Your Solar Proposal"}
        </h1>
        <p className="mb-6 text-sm text-slate-300">
          {result.site.address} · {dateStr}
        </p>
        {recommended && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              [`${recommended.dcKw} kWp`, "System size"],
              [thb(recommended.priceTHB), "Investment"],
              [thb(recommended.firstYearSavingsTHB), "First-year savings"],
              [recommended.paybackYears !== null ? `${recommended.paybackYears} yrs` : ">25 yrs", "Payback"],
            ].map(([value, label]) => (
              <div key={label} className="rounded-2xl bg-white/10 p-3 backdrop-blur">
                <div className="text-lg font-black text-amber-400">{value}</div>
                <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
              </div>
            ))}
          </div>
        )}
      </header>

      {/* ── Intro + bullets ── */}
      {narrative?.intro && <p className="mb-4 text-base leading-relaxed text-slate-700">{narrative.intro}</p>}
      {narrative?.bullets && narrative.bullets.length > 0 && (
        <ul className="mb-8 space-y-2">
          {narrative.bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[15px] font-medium text-slate-800">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-100 text-xs font-bold text-green-700">✓</span>
              {b}
            </li>
          ))}
        </ul>
      )}

      {/* ── Photo + AI render ── */}
      {(photoCount ?? 0) > 0 && (
        <section className="mb-8">
          {hasRender ? (
            <>
              <h2 className="mb-3 text-lg font-black text-slate-900">Your building with solar</h2>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/proposal-photo?id=${id}&n=render`} alt="Building with solar panels (visualization)" className="w-full rounded-2xl border object-cover" />
              <div className="mt-2 flex items-start justify-between gap-3">
                <p className="text-xs text-slate-400">
                  AI visualization on the actual building photo — {recommended?.panelCount} panels as designed. Final layout confirmed at site survey.
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/proposal-photo?id=${id}&n=0`} alt="Original building photo" className="h-20 w-28 shrink-0 rounded-lg border object-cover" title="Original photo" />
              </div>
            </>
          ) : (
            <>
              <h2 className="mb-3 text-lg font-black text-slate-900">The property</h2>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/proposal-photo?id=${id}&n=0`} alt={result.site.address} className="w-full rounded-2xl border object-cover" />
            </>
          )}
        </section>
      )}

      {/* ── Layout ── */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-black text-slate-900">Panel layout</h2>
        <PanelOverlay result={result} />
        <p className="mt-2 text-xs text-slate-400">
          {Math.round(result.packing.footprintM2)} m² roof · up to {result.packing.count} panels ({result.packing.maxKw.toFixed(1)} kWp) ·
          facing {Math.round(result.site.azimuthDeg)}° · yield {result.site.yieldKwhPerKwpYr} kWh/kWp/yr (NREL PVWatts)
        </p>
      </section>

      {/* ── Options ── */}
      {result.scenarios.map((s, i) => (
        <section key={i} className="mb-8">
          <h2 className="text-lg font-black text-slate-900">{s.name}</h2>
          <p className="mb-3 text-xs text-slate-400">{s.description} · {Math.round(s.annualLoadKwh).toLocaleString()} kWh/yr assumed</p>
          <div className="grid gap-3 md:grid-cols-2">
            {s.options.map((o, j) => (
              <OptionCard key={j} o={o} highlight={i === 0 && j === 0} />
            ))}
          </div>
        </section>
      ))}

      {/* ── Why + chart ── */}
      {narrative?.recommendationNote && (
        <section className="mb-8 rounded-2xl border-l-4 border-amber-500 bg-amber-50 p-5">
          <h2 className="mb-1 font-black text-slate-900">Why this configuration</h2>
          <p className="text-sm leading-relaxed text-slate-700">{narrative.recommendationNote}</p>
        </section>
      )}

      {recommended && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-black text-slate-900">Your money back in {recommended.paybackYears ?? "—"} years</h2>
          <CashFlowChart option={recommended} tariff={result.site.tariffTHBPerKwh} />
        </section>
      )}

      {/* ── Fine print ── */}
      <section className="mb-6 rounded-2xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-500">
        <h3 className="mb-1 font-bold text-slate-700">Assumptions &amp; disclaimers</h3>
        <ul className="list-inside list-disc space-y-0.5">
          {result.assumptionNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
          <li>Residential export credit (฿2.2/kWh, systems ≤10 kW) subject to net-billing registration, utility approval and annual quota.</li>
          <li>Final price subject to site survey.</li>
        </ul>
      </section>

      <footer className="border-t pt-4 text-center text-xs text-slate-400">
        SOLVIO · www.solvio.solar · prices last reviewed {PRICES_LAST_REVIEWED}
      </footer>
    </main>
  );
}
