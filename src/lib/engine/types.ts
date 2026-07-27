import type { BuildingUse, RoofType, Utility } from "@/config/assumptions";
import type { InverterModel, Phase } from "@/config/pricing";

export interface LatLng {
  lat: number;
  lng: number;
}

/** Everything the engine needs to size a system. */
export interface SiteInput {
  address: string;
  location: LatLng;
  province: string;
  utility: Utility;
  use: BuildingUse;
  roofType: RoofType;
  phase: Phase;
  roofPolygon: LatLng[]; // confirmed by the user
  floors: number;
  monthlyBillTHB?: number; // optional — decides Output A vs B
  tariffTHBPerKwh: number;
  /** annual production per kWp from PVWatts for the chosen tilt/azimuth,
   *  already derated by shadingFactor when one was measured */
  yieldKwhPerKwpYr: number;
  tiltDeg: number;
  azimuthDeg: number;
  /** 0..1 measured shading derate from Google Solar API; undefined = not measured */
  shadingFactor?: number;
}

/** One panel rectangle in local meters (for the overlay). */
export interface PanelRect {
  x: number; // center x, meters east of polygon centroid
  y: number; // center y, meters north of polygon centroid
  w: number; // plan width (m)
  h: number; // plan depth (m)
  rotDeg: number; // rotation of the grid
}

export interface PackingResult {
  panels: PanelRect[];
  count: number;
  footprintM2: number;
  usableM2: number;
  maxKw: number;
  rowAxisDeg: number; // orientation of rows (deg from north, clockwise)
  azimuthDeg: number; // panel facing direction (compass), closest edge-normal to south
}

export interface EnergyFlows {
  annualProductionKwh: number;
  selfConsumedKwh: number;
  exportedKwh: number; // paid export (residential ≤10kW only)
  lostKwh: number; // curtailed / unpaid excess
  gridImportKwh: number;
  daytimeLoadCoverage: number; // 0..1, share of daytime load covered
}

export interface SystemOption {
  label: string;
  panelCount: number;
  dcKw: number;
  inverter: InverterModel;
  inverterCount: number; // units of the same model (large systems)
  batteryKwh: number; // 0 = no battery
  priceTHB: number;
  flows: EnergyFlows;
  firstYearSavingsTHB: number;
  paybackYears: number | null; // null = beyond horizon
  npvTHB: number;
  totalSavings25yrTHB: number;
  rationale: string;
}

export type OptimizationMode = "max-savings" | "daytime-load" | "shortest-payback" | "max-roof";

export interface Scenario {
  name: string;
  description: string;
  annualLoadKwh: number;
  options: SystemOption[]; // [no-battery, with-battery]
}

export interface ProposalResult {
  outputType: "A" | "B";
  mode: OptimizationMode;
  scenarios: Scenario[];
  packing: PackingResult;
  site: SiteInput;
  assumptionNotes: string[];
}
