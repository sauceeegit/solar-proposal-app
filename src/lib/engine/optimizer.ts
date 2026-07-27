// ── System optimizer: Output A / B, 4 modes (spec §5.3, §6) ───────────
import { PANEL, SYSTEM } from "@/config/assumptions";
import { BATTERY_SIZES_KWH as BATTERY_SIZES, INVERTERS, batteryPrice, solarSystemPrice, type InverterModel } from "@/config/pricing";
import { annualLoadFromBill, annualLoadFromEUI, daytimeLoadShare } from "./load";
import { isExportEligible, simulateFlows } from "./battery";
import { computeEconomics } from "./economics";
import { packPanels } from "./roof";
import type { OptimizationMode, PackingResult, ProposalResult, Scenario, SiteInput, SystemOption } from "./types";

function eligibleInverter(dcKw: number, site: SiteInput): { inverter: InverterModel; units: number } | null {
  const pool = INVERTERS.filter((inv) => {
    if (site.utility === "MEA" && !inv.approvedMEA) return false;
    if (site.utility === "PEA" && !inv.approvedPEA) return false;
    if (site.phase === "single" && inv.phase !== "single") return false;
    return true; // three-phase buildings may take either phase
  });
  // try 1..n units of the same model; prefer fewest units, then ratio ≈ 1.15
  let best: { inverter: InverterModel; units: number; score: number } | null = null;
  for (const inv of pool) {
    const units = Math.max(1, Math.round(dcKw / (inv.kW * 1.15)));
    for (const n of [units, units + 1]) {
      const ratio = dcKw / (inv.kW * n);
      if (ratio < 0.9 || ratio > 1.35) continue;
      const score = n * 10 + Math.abs(ratio - 1.15); // fewer units wins first
      if (!best || score < best.score) best = { inverter: inv, units: n, score };
    }
  }
  return best ? { inverter: best.inverter, units: best.units } : null;
}

function buildOption(
  panelCount: number,
  batteryKwh: number,
  annualLoadKwh: number,
  site: SiteInput
): SystemOption | null {
  const dcKw = (panelCount * PANEL.watt) / 1000;
  if (dcKw < SYSTEM.minKw) return null;
  const sel = eligibleInverter(dcKw, site);
  if (!sel) return null;
  const { inverter, units } = sel;

  const priceTHB = solarSystemPrice(dcKw) + (batteryKwh > 0 ? batteryPrice(batteryKwh, site.utility) : 0);
  const flows = simulateFlows({
    annualProductionKwh: dcKw * site.yieldKwhPerKwpYr,
    annualLoadKwh,
    use: site.use,
    batteryKwh,
    exportEligible: isExportEligible(site.use, dcKw),
  });
  const econ = computeEconomics(priceTHB, flows, site.tariffTHBPerKwh);

  return {
    label: batteryKwh > 0 ? `${dcKw.toFixed(2)} kW + ${batteryKwh} kWh battery` : `${dcKw.toFixed(2)} kW solar only`,
    panelCount,
    dcKw: Math.round(dcKw * 100) / 100,
    inverter,
    inverterCount: units,
    batteryKwh,
    priceTHB,
    flows,
    ...econ,
    rationale: "",
  };
}

function metric(o: SystemOption, mode: OptimizationMode): number {
  switch (mode) {
    case "max-savings":
      return o.npvTHB;
    case "daytime-load":
      // prefer full coverage with the smallest system
      return o.flows.daytimeLoadCoverage >= 0.99 ? 1e12 - o.priceTHB : o.flows.daytimeLoadCoverage * 1e9;
    case "shortest-payback":
      return o.paybackYears === null ? -1e12 : -o.paybackYears * 1e6 + o.npvTHB / 1e6;
    case "max-roof":
      return o.dcKw * 1e9 + o.npvTHB;
  }
}

function bestOption(
  counts: number[],
  batteries: readonly number[],
  annualLoadKwh: number,
  site: SiteInput,
  mode: OptimizationMode
): SystemOption | null {
  let best: SystemOption | null = null;
  for (const c of counts) {
    for (const b of batteries) {
      const o = buildOption(c, b, annualLoadKwh, site);
      if (o && (!best || metric(o, mode) > metric(best, mode))) best = o;
    }
  }
  return best;
}

function rationaleFor(o: SystemOption, alt: SystemOption | null, site: SiteInput, mode: OptimizationMode): string {
  const cov = Math.round(o.flows.daytimeLoadCoverage * 100);
  const self = Math.round((o.flows.selfConsumedKwh / Math.max(1, o.flows.annualProductionKwh)) * 100);
  const parts: string[] = [];
  const invLabel = o.inverterCount > 1 ? `${o.inverterCount} × ${o.inverter.brand} ${o.inverter.model}` : `a ${o.inverter.brand} ${o.inverter.model}`;
  parts.push(
    `${o.panelCount} × ${PANEL.watt} W panels (${o.dcKw} kW) with ${invLabel} (${o.inverter.kW} kW, ${o.inverter.phase === "single" ? "1-phase" : "3-phase"}, ${site.utility}-approved).`
  );
  parts.push(`Covers ~${cov}% of daytime load; ${self}% of production is used on site.`);
  if (o.batteryKwh > 0) {
    parts.push(
      `The ${o.batteryKwh} kWh battery shifts midday excess to the evening${site.use !== "residential" ? " (no paid export is available for this building type)" : ""}.`
    );
    if (alt && alt.paybackYears !== null && o.paybackYears !== null && alt.paybackYears < o.paybackYears) {
      parts.push(
        `Note: payback is ${o.paybackYears} yrs vs ${alt.paybackYears} yrs without the battery — the battery adds backup power and energy independence at the cost of a longer payback.`
      );
    }
  } else if (mode === "max-savings" && alt && alt.batteryKwh > 0 && o.npvTHB >= alt.npvTHB) {
    parts.push(`No battery is recommended for maximum savings: 25-yr NPV is higher without it (฿${o.npvTHB.toLocaleString()} vs ฿${alt.npvTHB.toLocaleString()}).`);
  }
  if (o.paybackYears !== null) parts.push(`Estimated breakeven: ${o.paybackYears} years (with 0.5%/yr degradation and 2%/yr tariff escalation).`);
  return parts.join(" ");
}

function makeScenario(
  name: string,
  description: string,
  annualLoadKwh: number,
  counts: number[],
  site: SiteInput,
  mode: OptimizationMode
): Scenario {
  const noBatt = bestOption(counts, [0], annualLoadKwh, site, mode);
  const withBatt = bestOption(counts, BATTERY_SIZES, annualLoadKwh, site, mode === "max-savings" ? "max-savings" : mode);
  const options: SystemOption[] = [];
  if (noBatt) {
    noBatt.rationale = rationaleFor(noBatt, withBatt, site, mode);
    options.push(noBatt);
  }
  if (withBatt && withBatt.batteryKwh > 0) {
    withBatt.rationale = rationaleFor(withBatt, noBatt, site, mode);
    options.push(withBatt);
  } else if (noBatt) {
    // force a with-battery comparison option even when the optimizer says no battery
    const forced = bestOption(counts, BATTERY_SIZES.filter((b) => b > 0), annualLoadKwh, site, mode);
    if (forced) {
      forced.rationale = rationaleFor(forced, noBatt, site, mode);
      options.push(forced);
    }
  }
  return { name, description, annualLoadKwh: Math.round(annualLoadKwh), options };
}

export function optimize(site: SiteInput, mode: OptimizationMode = "max-savings"): ProposalResult {
  const packing: PackingResult = packPanels(site.roofPolygon, site.roofType, site.tiltDeg);
  const minPanels = Math.ceil((SYSTEM.minKw * 1000) / PANEL.watt);
  const counts: number[] = [];
  for (let c = minPanels; c <= packing.count; c++) counts.push(c);
  if (counts.length === 0 && packing.count >= 1) counts.push(packing.count);

  const notes: string[] = [
    site.roofType === "flat"
      ? "Roof treated as flat (default assumption): 10° tilted racking, rows paired back-to-back with 1.5 m walkways between pairs; confirm at site survey."
      : `Roof type: ${site.roofType === "tilted-one" ? "tilted (one side)" : "tilted (both sides)"} at ~${site.tiltDeg}° tilt.`,
    `Panels face azimuth ${Math.round(site.azimuthDeg)}° (roof edge direction closest to south).`,
    "Roof material assumed standard; structural check pending site survey.",
    site.shadingFactor != null
      ? `Shading measured from Google Solar API imagery: this roof averages ${Math.round(site.shadingFactor * 100)}% of its best-exposed area, and production is derated accordingly.`
      : "No shading obstructions assumed; final layout subject to site survey.",
    `Prices last reviewed 2026-07-12; final price subject to site survey.`,
  ];

  const scenarios: Scenario[] = [];
  let outputType: "A" | "B";

  if (site.monthlyBillTHB && site.monthlyBillTHB > 0) {
    outputType = "A";
    const load = annualLoadFromBill(site.monthlyBillTHB, site.tariffTHBPerKwh);
    scenarios.push(makeScenario("Based on your electricity bill", `Annual consumption derived from your ฿${site.monthlyBillTHB.toLocaleString()}/month bill.`, load, counts, site, mode));
  } else {
    outputType = "B";
    const load = annualLoadFromEUI(site.use, packing.footprintM2, site.floors);
    notes.push(`Energy use estimated from building type and size (no bill provided).`);
    scenarios.push(
      makeScenario("Scenario 1 — estimated consumption", `Assumed usage from building type (${site.use}), ${Math.round(packing.footprintM2)} m² footprint × ${site.floors} floor(s).`, load, counts, site, mode)
    );
    scenarios.push(
      makeScenario("Scenario 2 — maximum roof utilization", `The largest system the roof allows (${packing.count} panels), evaluated against the same assumed usage pattern.`, load, [packing.count], site, "max-roof")
    );
  }

  // daytime share note for context
  const dayShare = Math.round(daytimeLoadShare(site.use) * 100);
  notes.push(`${site.use} usage pattern: ~${dayShare}% of daily consumption falls in solar hours (06:00–18:00).`);

  return { outputType, mode, scenarios, packing, site, assumptionNotes: notes };
}
