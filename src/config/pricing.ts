// ── Pricing config — single source of truth (spec §4) ─────────────────
// All THB. Review quarterly; the date below is printed in proposal footers.

export const PRICES_LAST_REVIEWED = "2026-07-12";

/** Installed system price without battery: THB = perKw * kW + fixed */
export const SOLAR_PRICE = { perKw: 18_500, fixed: 79_000 };

/**
 * Battery adder, per kWh (spec §4.4).
 * premium: Huawei battery-ready inverter + LUNA2000 — valid in MEA and PEA areas.
 * budget:  PEA areas only (approved Deye models + LFP modules).
 */
export const BATTERY_PRICE_PER_KWH = { premium: 11_000, budget: 8_000 };

export const BATTERY_SIZES_KWH = [5, 10, 12, 15, 30] as const;

export type Phase = "single" | "three";

export interface InverterModel {
  model: string;
  brand: string;
  kW: number;
  phase: Phase;
  approvedMEA: boolean;
  approvedPEA: boolean;
  batteryReady: boolean; // battery attaches without a hybrid-inverter swap
  priceTHB: number; // retail equipment price (midpoint where a range was found)
  priceEstimated?: boolean;
}

/** Approved inverter catalogue (spec §4.2, reviewed 2026-07-12). */
export const INVERTERS: InverterModel[] = [
  { model: "SUN2000-3KTL-L1",  brand: "Huawei",  kW: 3,  phase: "single", approvedMEA: true,  approvedPEA: true,  batteryReady: true,  priceTHB: 23_772 },
  { model: "SUN-3K-G05P1",     brand: "Deye",    kW: 3,  phase: "single", approvedMEA: false, approvedPEA: true,  batteryReady: false, priceTHB: 20_000, priceEstimated: true },
  { model: "SUN2000-5KTL-L1",  brand: "Huawei",  kW: 5,  phase: "single", approvedMEA: true,  approvedPEA: true,  batteryReady: true,  priceTHB: 33_600 },
  { model: "MIN 5000TL-X",     brand: "Growatt", kW: 5,  phase: "single", approvedMEA: true,  approvedPEA: true,  batteryReady: false, priceTHB: 25_900 },
  { model: "SUN2000-6KTL-L1",  brand: "Huawei",  kW: 6,  phase: "single", approvedMEA: true,  approvedPEA: true,  batteryReady: true,  priceTHB: 35_000, priceEstimated: true },
  { model: "SUN2000-8KTL-M1",  brand: "Huawei",  kW: 8,  phase: "three",  approvedMEA: true,  approvedPEA: true,  batteryReady: true,  priceTHB: 55_000, priceEstimated: true },
  { model: "SUN2000-10KTL-M1", brand: "Huawei",  kW: 10, phase: "three",  approvedMEA: true,  approvedPEA: true,  batteryReady: true,  priceTHB: 63_270 },
  { model: "SUN2000-12KTL-M2", brand: "Huawei",  kW: 12, phase: "three",  approvedMEA: true,  approvedPEA: true,  batteryReady: false, priceTHB: 86_000 },
  { model: "SUN2000-15KTL-M5", brand: "Huawei",  kW: 15, phase: "three",  approvedMEA: true,  approvedPEA: true,  batteryReady: false, priceTHB: 62_000 },
  { model: "SUN2000-20KTL-M5", brand: "Huawei",  kW: 20, phase: "three",  approvedMEA: true,  approvedPEA: true,  batteryReady: false, priceTHB: 95_500 },
  { model: "SUN2000-30KTL-M3", brand: "Huawei",  kW: 30, phase: "three",  approvedMEA: true,  approvedPEA: true,  batteryReady: false, priceTHB: 116_000 },
];

/** System price without battery. */
export function solarSystemPrice(kW: number): number {
  return Math.round(SOLAR_PRICE.perKw * kW + SOLAR_PRICE.fixed);
}

/** Battery adder. Budget route only allowed in PEA areas (spec §4.3/4.4). */
export function batteryPrice(kWh: number, utility: "MEA" | "PEA"): number {
  const perKwh =
    utility === "PEA" ? BATTERY_PRICE_PER_KWH.budget : BATTERY_PRICE_PER_KWH.premium;
  return Math.round(kWh * perKwh);
}
