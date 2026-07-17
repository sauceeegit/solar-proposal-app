// ── Typical-day energy balance with optional battery (spec §5.3) ──────
import { SOLAR_SHAPE, EXPORT, type BuildingUse } from "@/config/assumptions";
import { typicalDayLoadKwh, daytimeLoadShare } from "./load";
import type { EnergyFlows } from "./types";

/** kWh per hour of a typical day for a given annual production. */
export function typicalDaySolarKwh(annualProductionKwh: number): number[] {
  const sum = SOLAR_SHAPE.reduce((a, b) => a + b, 0);
  const daily = annualProductionKwh / 365;
  return SOLAR_SHAPE.map((v) => (v / sum) * daily);
}

/**
 * Simulate the daily cycle (two consecutive days; day 2 = steady state).
 * Battery: usable capacity = kWh × DoD 0.9, round-trip efficiency 0.9.
 */
export function simulateFlows(params: {
  annualProductionKwh: number;
  annualLoadKwh: number;
  use: BuildingUse;
  batteryKwh: number;
  exportEligible: boolean; // residential ≤10 kW & registered
}): EnergyFlows {
  const { annualProductionKwh, annualLoadKwh, use, batteryKwh, exportEligible } = params;
  const prod = typicalDaySolarKwh(annualProductionKwh);
  const load = typicalDayLoadKwh(annualLoadKwh, use);
  const cap = batteryKwh * 0.9; // usable
  const eff = 0.9; // round-trip

  let soc = 0;
  let direct = 0, fromBattery = 0, excess = 0, imported = 0;
  for (let day = 0; day < 2; day++) {
    if (day === 1) { direct = 0; fromBattery = 0; excess = 0; imported = 0; }
    for (let h = 0; h < 24; h++) {
      const d = Math.min(prod[h], load[h]);
      direct += d;
      let surplus = prod[h] - d;
      let deficit = load[h] - d;
      if (surplus > 0 && cap > 0) {
        const charge = Math.min(surplus, cap - soc);
        soc += charge * Math.sqrt(eff);
        surplus -= charge;
      }
      if (deficit > 0 && soc > 0) {
        const discharge = Math.min(deficit, soc * Math.sqrt(eff));
        soc -= discharge / Math.sqrt(eff);
        fromBattery += discharge;
        deficit -= discharge;
      }
      excess += surplus;
      imported += deficit;
    }
  }

  const selfConsumed = (direct + fromBattery) * 365;
  const excessAnnual = excess * 365;
  const exported = exportEligible ? excessAnnual : 0;
  const lost = exportEligible ? 0 : excessAnnual;

  // daytime coverage: production used directly vs daytime load
  const daytimeLoad = annualLoadKwh * daytimeLoadShare(use);
  const daytimeCoverage = Math.min(1, (direct * 365) / Math.max(1, daytimeLoad));

  return {
    annualProductionKwh,
    selfConsumedKwh: selfConsumed,
    exportedKwh: exported,
    lostKwh: lost,
    gridImportKwh: imported * 365,
    daytimeLoadCoverage: daytimeCoverage,
  };
}

export function isExportEligible(use: BuildingUse, systemKw: number): boolean {
  return (!EXPORT.residentialOnly || use === "residential") && systemKw <= EXPORT.maxSystemKw;
}
