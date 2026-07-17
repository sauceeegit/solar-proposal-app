// ── MEA vs PEA from the geocoded province (spec §2) ────────────────────
import { MEA_PROVINCES, TARIFF_THB_PER_KWH, type BuildingUse, type Utility } from "@/config/assumptions";

export function utilityForProvince(province: string): Utility {
  const p = province.toLowerCase();
  return MEA_PROVINCES.some((m) => p.includes(m.toLowerCase())) ? "MEA" : "PEA";
}

export function defaultTariff(utility: Utility, use: BuildingUse): number {
  const cls = use === "residential" ? "residential" : "commercial";
  return TARIFF_THB_PER_KWH[utility][cls];
}
