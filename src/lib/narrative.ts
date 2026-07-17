// ── Claude-generated proposal narrative (server-only) ─────────────────
// The calculation engine owns every number; Claude writes the words.
import Anthropic from "@anthropic-ai/sdk";
import type { ProposalResult } from "@/lib/engine/types";

export interface Narrative {
  headline: string; // ≤12-word hook, leads the proposal
  intro: string; // ONE personalized sentence referencing the building
  bullets: string[]; // exactly 3 short selling points
  recommendationNote: string; // ≤3 short sentences on why this configuration
  // legacy fields from older proposals
  executiveSummary?: string;
}

const thb = (n: number) => `฿${n.toLocaleString("en-US")}`;

/**
 * Generates narrative text for a proposal. Returns null when no API key is
 * configured or the call fails — the proposal still works without it.
 */
export async function generateNarrative(result: ProposalResult): Promise<Narrative | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const rec = result.scenarios[0]?.options[0];
    if (!rec) return null;

    const facts = {
      address: result.site.address,
      buildingUse: result.site.use,
      utility: result.site.utility,
      roofFootprintM2: Math.round(result.packing.footprintM2),
      maxPanels: result.packing.count,
      yieldKwhPerKwpYr: result.site.yieldKwhPerKwpYr,
      recommended: {
        label: rec.label,
        panels: rec.panelCount,
        systemKw: rec.dcKw,
        inverter: `${rec.inverterCount > 1 ? rec.inverterCount + "× " : ""}${rec.inverter.brand} ${rec.inverter.model}`,
        batteryKwh: rec.batteryKwh,
        price: thb(rec.priceTHB),
        firstYearSavings: thb(rec.firstYearSavingsTHB),
        paybackYears: rec.paybackYears,
        savings25yr: thb(rec.totalSavings25yrTHB),
        annualProductionKwh: Math.round(rec.flows.annualProductionKwh),
        daytimeCoveragePct: Math.round(rec.flows.daytimeLoadCoverage * 100),
      },
      optimizationMode: result.mode,
      exportNote:
        result.site.use === "residential"
          ? "residential systems ≤10 kW can export excess at 2.2 THB/kWh (subject to registration)"
          : "commercial buildings receive no payment for exported excess, so the system is sized for self-consumption",
      assumptionNotes: result.assumptionNotes,
    };

    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system:
        "You write PUNCHY, scannable proposal copy for Solvio, a Thai solar installation company, in clear professional English. " +
        "Style: short sentences. Lead with money. No filler, no jargon, no paragraphs longer than 3 sentences. " +
        "HARD RULES: use ONLY the numbers provided in the facts JSON — never invent, round differently, or recompute any figure. " +
        "No hype words like 'revolutionary' or 'game-changing'. Confident, warm, factual. No emoji.",
      messages: [
        {
          role: "user",
          content:
            `Write narrative sections for a solar proposal using exactly these facts:\n${JSON.stringify(facts, null, 1)}`,
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              headline: {
                type: "string",
                description: "Attention-grabbing hook, max 12 words, leads with the money benefit (e.g. savings per year or payback). No period at the end.",
              },
              intro: {
                type: "string",
                description: "ONE sentence, personalized to the specific building and location",
              },
              bullets: {
                type: "array",
                description: "Exactly 3 selling points, each max 14 words, each leading with a number where possible",
                items: { type: "string" },
              },
              recommendationNote: {
                type: "string",
                description: "Max 3 short sentences: WHY this configuration (roof, usage pattern, export rules, battery decision). Honest.",
              },
            },
            required: ["headline", "intro", "bullets", "recommendationNote"],
            additionalProperties: false,
          },
        },
      },
    });

    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return null;
    return JSON.parse(text) as Narrative;
  } catch (e) {
    console.error("narrative generation failed:", e);
    return null;
  }
}
