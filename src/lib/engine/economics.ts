// ── Financial model: degraded, escalated cash flows (spec §5.4) ───────
import { EXPORT, FINANCE } from "@/config/assumptions";
import type { EnergyFlows } from "./types";

export interface Economics {
  firstYearSavingsTHB: number;
  paybackYears: number | null;
  npvTHB: number;
  totalSavings25yrTHB: number;
}

/** Cumulative cash-flow series, year 0..horizon (year 0 = -price). */
export function cashFlowSeries(priceTHB: number, flows: EnergyFlows, tariffTHBPerKwh: number): number[] {
  const { degradationPerYear, tariffEscalationPerYear, horizonYears } = FINANCE;
  const series = [-priceTHB];
  let cum = -priceTHB;
  for (let t = 0; t < horizonYears; t++) {
    const deg = Math.pow(1 - degradationPerYear, t);
    const tariff = tariffTHBPerKwh * Math.pow(1 + tariffEscalationPerYear, t);
    cum += flows.selfConsumedKwh * deg * tariff + flows.exportedKwh * deg * EXPORT.rateTHB;
    series.push(Math.round(cum));
  }
  return series;
}

export function computeEconomics(
  priceTHB: number,
  flows: EnergyFlows,
  tariffTHBPerKwh: number
): Economics {
  const { degradationPerYear, tariffEscalationPerYear, discountRate, horizonYears } = FINANCE;

  let cumulative = -priceTHB;
  let npv = -priceTHB;
  let payback: number | null = null;
  let firstYear = 0;
  let total = 0;

  for (let t = 0; t < horizonYears; t++) {
    const deg = Math.pow(1 - degradationPerYear, t);
    const tariff = tariffTHBPerKwh * Math.pow(1 + tariffEscalationPerYear, t);
    // export rate is a program rate — held flat, production still degrades
    const savings = flows.selfConsumedKwh * deg * tariff + flows.exportedKwh * deg * EXPORT.rateTHB;
    if (t === 0) firstYear = savings;
    total += savings;
    const prev = cumulative;
    cumulative += savings;
    if (payback === null && cumulative >= 0) {
      payback = t + (0 - prev) / savings; // interpolate within the year
    }
    npv += savings / Math.pow(1 + discountRate, t + 1);
  }

  return {
    firstYearSavingsTHB: Math.round(firstYear),
    paybackYears: payback === null ? null : Math.round(payback * 10) / 10,
    npvTHB: Math.round(npv),
    totalSavings25yrTHB: Math.round(total),
  };
}
