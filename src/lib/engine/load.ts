// ── Load model (spec §3) ───────────────────────────────────────────────
import { EUI_KWH_PER_M2_YR, LOAD_PROFILES, type BuildingUse } from "@/config/assumptions";

/** Annual consumption from a monthly bill. */
export function annualLoadFromBill(monthlyBillTHB: number, tariffTHBPerKwh: number): number {
  return (monthlyBillTHB / tariffTHBPerKwh) * 12;
}

/** Annual consumption from EUI × gross floor area (roof footprint × floors). */
export function annualLoadFromEUI(use: BuildingUse, footprintM2: number, floors: number): number {
  return EUI_KWH_PER_M2_YR[use] * footprintM2 * Math.max(1, floors);
}

/** Hourly fractions of daily energy (sum = 1) from the usage-pattern profiles. */
export function hourlyLoadFractions(use: BuildingUse): number[] {
  const profile = LOAD_PROFILES[use];
  const sum = profile.reduce((a, b) => a + b, 0);
  return profile.map((v) => v / sum);
}

/** kWh per hour of a typical day. */
export function typicalDayLoadKwh(annualKwh: number, use: BuildingUse): number[] {
  const daily = annualKwh / 365;
  return hourlyLoadFractions(use).map((f) => f * daily);
}

/** Share of daily load that falls in solar hours (approx 06:00–18:00). */
export function daytimeLoadShare(use: BuildingUse): number {
  const f = hourlyLoadFractions(use);
  return f.slice(6, 18).reduce((a, b) => a + b, 0);
}
