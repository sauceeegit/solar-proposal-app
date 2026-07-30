// End-to-end pipeline test against the RUNNING dev server (real PVWatts + real API routes).
// Skipped automatically if the server isn't up.
import { describe, expect, it, beforeAll } from "vitest";
import { optimize } from "./optimizer";
import type { LatLng, SiteInput } from "./types";
import { utilityForProvince, defaultTariff } from "./utility";

const BASE = "http://localhost:3000";
const HOTEL: LatLng = { lat: 7.837576, lng: 98.2997106 }; // Golden Paradise Hotel, Karon, Phuket

// Representative ~34 m × 20 m rooftop footprint centered on the building.
const M_LAT = 111_320;
const dLat = 20 / M_LAT;
const dLng = 34 / (M_LAT * Math.cos((HOTEL.lat * Math.PI) / 180));
const roof: LatLng[] = [
  { lat: HOTEL.lat - dLat / 2, lng: HOTEL.lng - dLng / 2 },
  { lat: HOTEL.lat - dLat / 2, lng: HOTEL.lng + dLng / 2 },
  { lat: HOTEL.lat + dLat / 2, lng: HOTEL.lng + dLng / 2 },
  { lat: HOTEL.lat + dLat / 2, lng: HOTEL.lng - dLng / 2 },
];

let up = false;
beforeAll(async () => {
  try {
    const r = await fetch(`${BASE}/`, { method: "HEAD" });
    up = r.ok;
  } catch {
    up = false;
  }
});

describe("E2E: Golden Paradise Hotel via live server", () => {
  it("runs geocode → PVWatts → optimizer → proposal → readback", async () => {
    if (!up) {
      console.warn("dev server not running on :3000 — skipping live E2E");
      return;
    }

    // 1. real PVWatts (server hits NREL)
    const pv = await fetch(`${BASE}/api/pvwatts?lat=${HOTEL.lat}&lon=${HOTEL.lng}&tilt=10&azimuth=180`).then((r) => r.json());
    expect(pv.yieldKwhPerKwpYr, `pvwatts error: ${pv.error}`).toBeGreaterThan(1200);
    expect(pv.yieldKwhPerKwpYr).toBeLessThan(1700); // Phuket sanity band
    console.log("PVWatts yield:", pv.yieldKwhPerKwpYr, "kWh/kWp/yr @", pv.station);

    // 2. build site (hotel / PEA / commercial), no bill → Output B
    const utility = utilityForProvince("Phuket");
    expect(utility).toBe("PEA");
    const site: SiteInput = {
      address: "Golden Paradise Hotel, Karon, Phuket",
      location: HOTEL,
      province: "Phuket",
      utility,
      use: "hotel",
      roofType: "flat",
      phase: "three",
      roofPolygon: roof,
      floors: 4,
      tariffTHBPerKwh: defaultTariff(utility, "hotel"),
      yieldKwhPerKwpYr: pv.yieldKwhPerKwpYr,
      tiltDeg: 10,
      azimuthDeg: 180,
    };

    // 3. real optimizer
    const result = optimize(site, "max-savings");
    expect(result.outputType).toBe("B");
    // commercial → one scenario, the whole roof
    expect(result.scenarios).toHaveLength(1);
    const rec = result.scenarios[0].options[0];
    console.log("Recommended:", rec.label, "→", rec.priceTHB, "THB, payback", rec.paybackYears, "yrs");
    console.log("Roof fits", result.packing.count, "panels =", result.packing.maxKw, "kWp");

    // hotel → no paid export anywhere; inverters PEA-approved
    for (const s of result.scenarios)
      for (const o of s.options) {
        expect(o.flows.exportedKwh).toBe(0);
        expect(o.inverter.approvedPEA).toBe(true);
        expect(o.paybackYears).not.toBeNull();
      }
    // the quoted system IS the full roof
    expect(rec.panelCount).toBe(result.packing.count);

    // 4. persist via real API
    const post = await fetch(`${BASE}/api/proposal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
    }).then((r) => r.json());
    expect(post.id).toBeTruthy();
    console.log("Proposal URL:", `${BASE}${post.url}`);

    // 5. read it back
    const back = await fetch(`${BASE}/api/proposal?id=${post.id}`).then((r) => r.json());
    expect(back.result.site.address).toContain("Golden Paradise");
    expect(back.result.packing.count).toBe(result.packing.count);

    // 6. proposal HTML renders with the overlay + real numbers
    const html = await fetch(`${BASE}${post.url}`).then((r) => r.text());
    expect(html).toContain("SOLVIO");
    expect(html).toContain("450 W panels");
    expect(html).toContain("PVWatts");
    expect(html).toContain("subject to site survey");
  }, 60_000);
});
