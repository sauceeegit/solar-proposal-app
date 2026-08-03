// ── System optimizer: Output A / B, 4 modes (spec §5.3, §6) ───────────
import { EXPORT, PANEL, RESIDENTIAL_FULL_ROOF_MIN_KW, SYSTEM } from "@/config/assumptions";
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

/**
 * Largest system that still earns the export credit — 22 panels at 450 W is
 * 9.9 kW, just under the 10 kW ceiling. Derived, not hard-coded, so it stays
 * right if the panel wattage or the ceiling ever moves.
 */
export const EXPORT_CAP_PANELS = Math.floor((EXPORT.maxSystemKw * 1000) / PANEL.watt);

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
  const packing: PackingResult = packPanels(site.roofPolygon, site.roofType, site.tiltDeg, site.obstructions);

  const notes: string[] = [
    site.roofType === "flat"
      ? `Roof treated as flat (default assumption) with ${site.tiltDeg}° tilted racking; confirm at site survey.`
      : `Roof type: ${site.roofType === "tilted-one" ? "tilted (one side)" : "tilted (both sides)"} at ~${site.tiltDeg}° tilt.`,
    "Panel layout: 200 mm clearance from all roof edges, 100 mm between panels within a row, 400 mm between rows.",
    ...(packing.obstructedM2 > 0
      ? [
          (site.obstructions ?? []).length === 1
            ? `One rooftop obstruction of ~${Math.round(packing.obstructedM2)} m² is kept clear of panels, with the same 200 mm clearance around it.`
            : `${(site.obstructions ?? []).length} rooftop obstructions totalling ~${Math.round(packing.obstructedM2)} m² are kept clear of panels, with the same 200 mm clearance around each.`,
        ]
      : []),
    `Panels face azimuth ${Math.round(site.azimuthDeg)}° (roof edge direction closest to south).`,
    "Roof material assumed standard; structural check pending site survey.",
    site.shadingFactor != null
      ? `Shading measured from Google Solar API imagery: this roof averages ${Math.round(site.shadingFactor * 100)}% of its best-exposed area, and production is derated accordingly.`
      : "No shading obstructions assumed; final layout subject to site survey.",
    `Prices last reviewed 2026-07-12; final price subject to site survey.`,
  ];

  // Consumption comes from the bill when there is one, otherwise from the
  // building type and size. That is what Output A vs B means; it is separate
  // from how the system is sized below.
  const billed = !!site.monthlyBillTHB && site.monthlyBillTHB > 0;
  const outputType: "A" | "B" = billed ? "A" : "B";
  const load = billed
    ? annualLoadFromBill(site.monthlyBillTHB!, site.tariffTHBPerKwh)
    : annualLoadFromEUI(site.use, packing.footprintM2, site.floors);
  notes.push(
    billed
      ? `Annual consumption derived from your ฿${site.monthlyBillTHB!.toLocaleString()}/month bill.`
      : `Energy use estimated from building type (${site.use}), ${Math.round(packing.footprintM2)} m² footprint × ${site.floors} floor(s) — no bill provided.`
  );

  const exportKw = (EXPORT_CAP_PANELS * PANEL.watt) / 1000;
  const fullRoof = () =>
    makeScenario(
      "Maximum roof utilization",
      `The largest system this roof allows — ${packing.count} panels (${packing.maxKw.toFixed(1)} kWp).`,
      load,
      [packing.count],
      site,
      "max-roof"
    );
  const exportEligible = () =>
    makeScenario(
      `Export-eligible system — ${EXPORT_CAP_PANELS} panels`,
      `${EXPORT_CAP_PANELS} panels (${exportKw.toFixed(2)} kWp), the largest system that stays under the ${EXPORT.maxSystemKw} kW ceiling for the ฿${EXPORT.rateTHB}/kWh export credit.`,
      load,
      [EXPORT_CAP_PANELS],
      site,
      mode
    );

  const scenarios: Scenario[] = [];
  if (site.use !== "residential") {
    // Commercial consumes far more than the roof can generate and earns no
    // export credit, so more panels is simply more saving: quote the lot.
    scenarios.push(fullRoof());
  } else if (packing.maxKw <= EXPORT.maxSystemKw) {
    // Whole roof already fits under the ceiling — it IS the export-eligible
    // system, so there is nothing to compare it against.
    scenarios.push(fullRoof());
    notes.push(
      `This roof holds ${packing.count} panels (${packing.maxKw.toFixed(1)} kWp), already within the ${EXPORT.maxSystemKw} kW export ceiling, so no smaller alternative is shown.`
    );
  } else if (packing.maxKw < RESIDENTIAL_FULL_ROOF_MIN_KW) {
    // Only just over the ceiling: the extra kWp are not worth losing the export
    // credit on the whole system, so the full roof is not offered at all.
    scenarios.push(exportEligible());
    notes.push(
      `The roof could hold ${packing.count} panels (${packing.maxKw.toFixed(1)} kWp), but going over ${EXPORT.maxSystemKw} kW forfeits the ฿${EXPORT.rateTHB}/kWh export credit on the whole system for only ${(packing.maxKw - exportKw).toFixed(1)} kWp more, so it is not quoted below ${RESIDENTIAL_FULL_ROOF_MIN_KW} kWp.`
    );
  } else {
    // Big enough that the extra capacity is worth putting on the table.
    scenarios.push(fullRoof(), exportEligible());
  }

  // daytime share note for context
  const dayShare = Math.round(daytimeLoadShare(site.use) * 100);
  notes.push(`${site.use} usage pattern: ~${dayShare}% of daily consumption falls in solar hours (06:00–18:00).`);

  return { outputType, mode, scenarios, packing, site, assumptionNotes: notes };
}
