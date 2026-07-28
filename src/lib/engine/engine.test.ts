import { describe, expect, it } from "vitest";
import { packPanels, polygonAreaM2, toLocalMeters } from "./roof";
import { annualLoadFromBill, annualLoadFromEUI, daytimeLoadShare, hourlyLoadFractions } from "./load";
import { isExportEligible, simulateFlows } from "./battery";
import { computeEconomics } from "./economics";
import { utilityForProvince } from "./utility";
import { optimize } from "./optimizer";
import type { SiteInput } from "./types";

// ~30m × 20m rectangle near Phuket (7.8376 N, 98.2997 E)
const M_PER_DEG_LAT = 111_320;
const lat0 = 7.8376, lng0 = 98.2997;
const dLat = 20 / M_PER_DEG_LAT;
const dLng = 30 / (M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180));
const rectRoof = [
  { lat: lat0, lng: lng0 },
  { lat: lat0, lng: lng0 + dLng },
  { lat: lat0 + dLat, lng: lng0 + dLng },
  { lat: lat0 + dLat, lng: lng0 },
];

const hotelSite: SiteInput = {
  address: "Golden Paradise Hotel, Phuket",
  location: { lat: lat0, lng: lng0 },
  province: "Phuket",
  utility: "PEA",
  use: "hotel",
  roofType: "flat",
  phase: "three",
  roofPolygon: rectRoof,
  floors: 4,
  tariffTHBPerKwh: 4.7,
  yieldKwhPerKwpYr: 1400, // typical Phuket
  tiltDeg: 10,
  azimuthDeg: 180,
};

describe("roof geometry", () => {
  it("computes a 600 m² rectangle correctly", () => {
    const { pts } = toLocalMeters(rectRoof);
    expect(polygonAreaM2(pts)).toBeGreaterThan(590);
    expect(polygonAreaM2(pts)).toBeLessThan(610);
  });

  it("packs a plausible number of panels on a flat 600 m² roof", () => {
    const p = packPanels(rectRoof, "flat");
    // 600 m² flat roof at GCR 0.65 & walkways → roughly 120–220 panels
    expect(p.count).toBeGreaterThan(100);
    expect(p.count).toBeLessThan(250);
    expect(p.maxKw).toBeCloseTo((p.count * 450) / 1000, 5);
    // every panel inside the footprint bounding box
    for (const panel of p.panels) {
      expect(Math.abs(panel.x)).toBeLessThan(16);
      expect(Math.abs(panel.y)).toBeLessThan(11);
    }
  });

  it("panels face the roof edge direction closest to south", () => {
    // axis-aligned rectangle: one edge normal points due south → azimuth 180
    expect(packPanels(rectRoof, "flat").azimuthDeg).toBe(180);

    // rectangle rotated 30°: edge normals at 150/330 and 60/240 → closest to south is 150
    const cx = 7.8376, cy = 98.2997;
    const rot = (x: number, y: number) => {
      const a = (30 * Math.PI) / 180;
      const cosLat = Math.cos((cx * Math.PI) / 180);
      return {
        lat: cx + ((x * Math.sin(a) + y * Math.cos(a)) / 111320),
        lng: cy + ((x * Math.cos(a) - y * Math.sin(a)) / (111320 * cosLat)),
      };
    };
    const rotated = [rot(-15, -10), rot(15, -10), rot(15, 10), rot(-15, 10)];
    expect(packPanels(rotated, "flat").azimuthDeg).toBe(150);
  });

  it("rendered panel corners stay inside a ROTATED roof (regression: rotDeg sign)", () => {
    // 30°-rotated rectangle — same as the azimuth test
    const cx = 7.8376, cy = 98.2997;
    const rot = (x: number, y: number) => {
      const a = (30 * Math.PI) / 180;
      const cosLat = Math.cos((cx * Math.PI) / 180);
      return {
        lat: cx + ((x * Math.sin(a) + y * Math.cos(a)) / 111320),
        lng: cy + ((x * Math.cos(a) - y * Math.sin(a)) / (111320 * cosLat)),
      };
    };
    const roof = [rot(-15, -10), rot(15, -10), rot(15, 10), rot(-15, 10)];
    const packing = packPanels(roof, "flat");
    expect(packing.count).toBeGreaterThan(10);

    // replicate the overlay renderer: corners = center + R(rotDeg)·(±w/2, ±h/2)
    const { pts } = toLocalMeters(roof);
    const inside = (px: number, py: number) => {
      let ok = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) ok = !ok;
      }
      return ok;
    };
    for (const p of packing.panels) {
      const r = (p.rotDeg * Math.PI) / 180;
      const cos = Math.cos(r), sin = Math.sin(r);
      for (const [dx, dy] of [[-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [p.w / 2, p.h / 2], [-p.w / 2, p.h / 2]]) {
        expect(inside(p.x + dx * cos - dy * sin, p.y + dx * sin + dy * cos)).toBe(true);
      }
    }
  });

  it("pitched roof panels have a shallower plan depth, so never pack fewer", () => {
    const flat = packPanels(rectRoof, "flat");
    const pitched = packPanels(rectRoof, "tilted-two", 20);
    // steeper tilt → smaller plan-view footprint per panel
    expect(pitched.panels[0].h).toBeLessThan(flat.panels[0].h);
    expect(pitched.count).toBeGreaterThanOrEqual(flat.count);
  });

  it("honours the layout spec: 200 mm edges, 100 mm within a row, 400 mm between rows", () => {
    const p = packPanels(rectRoof, "flat");
    const { pts } = toLocalMeters(rectRoof);
    expect(p.panels.length).toBeGreaterThan(50);
    expect(p.panels[0].rotDeg).toBeCloseTo(0, 6); // axis-aligned test roof

    // 200 mm clearance: every corner at least 0.2 m inside the outline
    const distToSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      if (l2 === 0) return Math.hypot(px - ax, py - ay);
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    for (const pan of p.panels) {
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const cx = pan.x + (dx * pan.w) / 2, cy = pan.y + (dy * pan.h) / 2;
        let min = Infinity;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          min = Math.min(min, distToSeg(cx, cy, pts[j].x, pts[j].y, pts[i].x, pts[i].y));
        }
        expect(min).toBeGreaterThanOrEqual(0.2 - 1e-6);
      }
    }

    // 100 mm within a row: group by row, check edge-to-edge gaps
    const rows = new Map<string, typeof p.panels>();
    for (const pan of p.panels) {
      const k = pan.y.toFixed(3);
      rows.set(k, [...(rows.get(k) ?? []), pan]);
    }
    let checkedInRow = 0;
    for (const row of rows.values()) {
      const xs = row.map((r) => r.x).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i] - xs[i - 1] - p.panels[0].w).toBeCloseTo(0.1, 6);
        checkedInRow++;
      }
    }
    expect(checkedInRow).toBeGreaterThan(0);

    // 400 mm between rows (use real y values, not the rounded group keys)
    const ys = [...rows.values()].map((r) => r[0].y).sort((a, b) => a - b);
    expect(ys.length).toBeGreaterThan(1);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1] - p.panels[0].h).toBeCloseTo(0.4, 6);
    }
  });
});

describe("load model", () => {
  it("derives annual kWh from a bill", () => {
    expect(annualLoadFromBill(47_000, 4.7)).toBeCloseTo(120_000, 0);
  });
  it("hotel EUI 322 kWh/m²/yr × area × floors", () => {
    expect(annualLoadFromEUI("hotel", 600, 4)).toBeCloseTo(322 * 600 * 4, 0);
  });
  it("profiles normalize to 1 and hotel daytime share is ~45–60%", () => {
    for (const use of ["residential", "hotel", "office"] as const) {
      const sum = hourlyLoadFractions(use).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 10);
    }
    const s = daytimeLoadShare("hotel");
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(0.65);
    // office is day-heavy, residential evening-heavy
    expect(daytimeLoadShare("office")).toBeGreaterThan(daytimeLoadShare("residential"));
  });
});

describe("battery & export rules", () => {
  it("hotel never export-eligible; residential ≤10kW is", () => {
    expect(isExportEligible("hotel", 5)).toBe(false);
    expect(isExportEligible("residential", 10)).toBe(true);
    expect(isExportEligible("residential", 12)).toBe(false);
  });

  it("battery raises self-consumption, lowers lost excess", () => {
    const base = { annualProductionKwh: 14_000, annualLoadKwh: 20_000, use: "residential" as const, exportEligible: false };
    const noBatt = simulateFlows({ ...base, batteryKwh: 0 });
    const withBatt = simulateFlows({ ...base, batteryKwh: 10 });
    expect(withBatt.selfConsumedKwh).toBeGreaterThan(noBatt.selfConsumedKwh);
    expect(withBatt.lostKwh).toBeLessThan(noBatt.lostKwh);
    // energy conservation: self + excess ≈ production
    expect(noBatt.selfConsumedKwh + noBatt.lostKwh).toBeCloseTo(14_000, -2);
  });

  it("hotel with flat-ish daytime load self-consumes most of a right-sized system", () => {
    const f = simulateFlows({ annualProductionKwh: 50_000, annualLoadKwh: 300_000, use: "hotel", batteryKwh: 0, exportEligible: false });
    expect(f.selfConsumedKwh / f.annualProductionKwh).toBeGreaterThan(0.95);
  });
});

describe("economics", () => {
  it("payback uses escalated, degraded flows", () => {
    const flows = { annualProductionKwh: 14_000, selfConsumedKwh: 13_000, exportedKwh: 0, lostKwh: 1_000, gridImportKwh: 0, daytimeLoadCoverage: 0.8 };
    const e = computeEconomics(264_000, flows, 4.7); // 10 kW system
    // ~13,000 kWh × 4.7 ≈ ฿61k/yr → payback just over 4 years
    expect(e.paybackYears).toBeGreaterThan(3.5);
    expect(e.paybackYears).toBeLessThan(5);
    expect(e.npvTHB).toBeGreaterThan(0);
    expect(e.totalSavings25yrTHB).toBeGreaterThan(1_000_000);
  });
});

describe("utility lookup", () => {
  it("Bangkok → MEA, Phuket → PEA", () => {
    expect(utilityForProvince("Bangkok")).toBe("MEA");
    expect(utilityForProvince("กรุงเทพมหานคร")).toBe("MEA");
    expect(utilityForProvince("Phuket")).toBe("PEA");
    expect(utilityForProvince("Chiang Mai")).toBe("PEA");
  });
});

describe("optimizer end-to-end (hotel, Output B)", () => {
  const result = optimize(hotelSite, "max-savings");

  it("produces Output B with 2 scenarios × 2 options", () => {
    expect(result.outputType).toBe("B");
    expect(result.scenarios).toHaveLength(2);
    for (const s of result.scenarios) {
      expect(s.options.length).toBeGreaterThanOrEqual(1);
      expect(s.options.length).toBeLessThanOrEqual(2);
    }
  });

  it("selects only PEA-approved, phase-compatible inverters", () => {
    for (const s of result.scenarios) {
      for (const o of s.options) {
        expect(o.inverter.approvedPEA).toBe(true);
        const ratio = o.dcKw / (o.inverter.kW * o.inverterCount);
        expect(ratio).toBeGreaterThanOrEqual(0.9);
        expect(ratio).toBeLessThanOrEqual(1.35);
      }
    }
  });

  it("hotel gets no paid export in any option", () => {
    for (const s of result.scenarios) {
      for (const o of s.options) {
        expect(o.flows.exportedKwh).toBe(0);
      }
    }
  });

  it("scenario 2 uses the full roof", () => {
    const s2 = result.scenarios[1];
    expect(s2.options[0].panelCount).toBe(result.packing.count);
  });

  it("reports measured shading when Solar API provided it, else the assumption", () => {
    const noShade = optimize(hotelSite, "max-savings");
    expect(noShade.assumptionNotes.some((n) => /No shading obstructions assumed/.test(n))).toBe(true);

    const measured = optimize({ ...hotelSite, shadingFactor: 0.83 }, "max-savings");
    expect(measured.assumptionNotes.some((n) => /Shading measured from Google Solar API.*83%/.test(n))).toBe(true);
    expect(measured.assumptionNotes.some((n) => /No shading obstructions assumed/.test(n))).toBe(false);
  });

  it("a shading derate lowers production and savings", () => {
    const full = optimize(hotelSite, "max-savings").scenarios[0].options[0];
    const shaded = optimize({ ...hotelSite, yieldKwhPerKwpYr: Math.round(1400 * 0.83) }, "max-savings").scenarios[0].options[0];
    expect(shaded.flows.annualProductionKwh).toBeLessThan(full.flows.annualProductionKwh);
    expect(shaded.firstYearSavingsTHB).toBeLessThan(full.firstYearSavingsTHB);
  });

  it("Output A when a bill is provided", () => {
    const a = optimize({ ...hotelSite, monthlyBillTHB: 100_000 }, "max-savings");
    expect(a.outputType).toBe("A");
    expect(a.scenarios).toHaveLength(1);
    expect(a.scenarios[0].annualLoadKwh).toBeCloseTo((100_000 / 4.7) * 12, -2);
  });
});
