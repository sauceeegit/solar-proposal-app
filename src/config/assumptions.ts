// ── Assumption config — single source of truth (spec §3, §5) ──────────

export type BuildingUse = "residential" | "hotel" | "office";
export type RoofType = "flat" | "tilted-one" | "tilted-two";
export type Utility = "MEA" | "PEA";

/** Energy-use intensity, kWh per m² of gross floor area per year (spec §3). */
export const EUI_KWH_PER_M2_YR: Record<BuildingUse, number> = {
  residential: 80,
  hotel: 322,
  office: 120, // not in spec — engineering placeholder, flag in proposal notes
};

/**
 * Hourly load profiles, % of that building's daily peak (h0..h23).
 * Digitized from the usage-pattern graph in spec §3.
 */
export const LOAD_PROFILES: Record<BuildingUse, number[]> = {
  residential: [45, 42, 40, 38, 38, 40, 55, 70, 55, 42, 40, 40, 42, 41, 40, 42, 45, 60, 85, 100, 100, 92, 75, 58],
  hotel:       [62, 58, 54, 51, 52, 55, 65, 80, 85, 75, 71, 73, 78, 80, 85, 82, 81, 85, 95, 100, 98, 90, 80, 70],
  office:      [25, 22, 21, 21, 21, 22, 30, 55, 80, 95, 97, 98, 87, 95, 100, 97, 88, 68, 48, 40, 34, 30, 27, 25],
};

/**
 * Solar generation shape, % of peak (h0..h23) — used for hourly
 * self-consumption when PVWatts hourly data is not fetched.
 */
export const SOLAR_SHAPE = [0, 0, 0, 0, 0, 2, 10, 28, 50, 72, 88, 97, 100, 97, 85, 65, 40, 15, 3, 0, 0, 0, 0, 0];

/** Flat defaults, THB/kWh incl. Ft — configurable (spec §3). */
export const TARIFF_THB_PER_KWH: Record<Utility, Record<"residential" | "commercial", number>> = {
  MEA: { residential: 4.5, commercial: 4.7 },
  PEA: { residential: 4.5, commercial: 4.7 },
};

/** Export credit: residential ≤10 kW only, subject to registration + quota. */
export const EXPORT = { rateTHB: 2.2, maxSystemKw: 10, residentialOnly: true };

/** MEA service area; everywhere else in Thailand is PEA. */
export const MEA_PROVINCES = ["Bangkok", "กรุงเทพมหานคร", "Nonthaburi", "นนทบุรี", "Samut Prakan", "สมุทรปราการ"];

// ── Financial model (spec §5.4) ────────────────────────────────────────
export const FINANCE = {
  degradationPerYear: 0.005, // 0.5 %/yr panel degradation
  tariffEscalationPerYear: 0.02, // 2 %/yr, on tariff incl. Ft
  discountRate: 0.05, // for NPV
  horizonYears: 25,
};

// ── Panels & packing (spec §4, §5.1–5.2) ──────────────────────────────
export const PANEL = { watt: 450, lengthM: 1.76, widthM: 1.13 };
/** Panel layout spacing rules. */
export const PACKING = {
  /** panel to the building edge, all around the outline */
  edgeClearanceM: 0.2,
  /** between panels within a row, short edge to short edge */
  withinRowGapM: 0.1,
  /** row to row */
  betweenRowsGapM: 0.4,
};
export const SYSTEM = {
  minKw: 3,
  dcAcRatioMin: 1.0,
  dcAcRatioMax: 1.3,
};

/** Default panel tilt in degrees by roof type (Thailand). */
export const DEFAULT_TILT_DEG: Record<RoofType, number> = {
  flat: 10, // racking tilt on flat roofs (self-cleaning minimum)
  "tilted-one": 20,
  "tilted-two": 20,
};
