// ── Server-side PDF of a proposal, mirroring the web design ───────────
import React from "react";
import { Document, Page, View, Text, Image, Svg, Polygon, Polyline, Line, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { cashFlowSeries } from "@/lib/engine/economics";
import type { Narrative } from "@/lib/narrative";
import type { ProposalResult, SystemOption } from "@/lib/engine/types";

const thb = (n: number) => `THB ${n.toLocaleString("en-US")}`;

// The built-in Helvetica lacks a few glyphs (฿, ✓, ≤); map them to safe text.
const clean = (t: string) =>
  t.replace(/฿\s?/g, "THB ").replace(/≤\s?/g, "up to ").replace(/≥\s?/g, "at least ").replace(/[✓�]/g, "").trim();

export interface OverlayGeom {
  w: number;
  h: number;
  outline: { x: number; y: number }[];
  panels: { x: number; y: number }[][];
}
export interface PdfImages {
  mapDataUri?: string;
  renderDataUri?: string;
  photoDataUri?: string;
}

const NAVY = "#0f2c56";
const AMBER = "#f59e0b";
const s = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 40, paddingHorizontal: 40, fontFamily: "Helvetica", color: "#0f172a", fontSize: 10 },
  hero: { backgroundColor: NAVY, borderRadius: 14, padding: 22, color: "#fff", marginBottom: 16 },
  brandRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 },
  brand: { fontFamily: "Helvetica-Bold", fontSize: 18, color: "#fff" },
  brandDot: { color: AMBER },
  headline: { fontFamily: "Helvetica-Bold", fontSize: 20, lineHeight: 1.2, marginBottom: 6, color: "#fff" },
  sub: { fontSize: 9, color: "#cbd5e1", marginBottom: 14 },
  statRow: { flexDirection: "row", gap: 8 },
  stat: { flex: 1, backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 8, padding: 8 },
  statVal: { fontFamily: "Helvetica-Bold", fontSize: 12, color: AMBER },
  statLbl: { fontSize: 7, color: "#cbd5e1", textTransform: "uppercase", marginTop: 2 },
  intro: { fontSize: 11, lineHeight: 1.5, marginBottom: 10, color: "#334155" },
  bullet: { flexDirection: "row", marginBottom: 5, alignItems: "center" },
  bulletDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#15803d", marginRight: 7 },
  bulletText: { flex: 1, fontSize: 10.5, fontFamily: "Helvetica-Bold", color: "#1e293b" },
  h2: { fontFamily: "Helvetica-Bold", fontSize: 13, marginTop: 16, marginBottom: 8, color: "#0f172a" },
  img: { width: "100%", borderRadius: 10, objectFit: "cover" },
  caption: { fontSize: 8, color: "#94a3b8", marginTop: 4 },
  cardRow: { flexDirection: "row", gap: 8 },
  card: { flex: 1, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 12, padding: 10 },
  cardHi: { flex: 1, borderWidth: 1, borderColor: AMBER, backgroundColor: "#fffbeb", borderRadius: 12, padding: 10 },
  cardTitle: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  cardPrice: { fontFamily: "Helvetica-Bold", fontSize: 16, marginTop: 2, marginBottom: 6 },
  miniRow: { flexDirection: "row", gap: 4 },
  mini: { flex: 1, backgroundColor: "#f1f5f9", borderRadius: 6, padding: 5, alignItems: "center" },
  miniVal: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  miniLbl: { fontSize: 6, color: "#94a3b8", textTransform: "uppercase", marginTop: 1 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1.5 },
  rowKey: { color: "#94a3b8", fontSize: 9 },
  rowVal: { fontFamily: "Helvetica-Bold", fontSize: 9 },
  why: { borderLeftWidth: 3, borderLeftColor: AMBER, backgroundColor: "#fffbeb", borderRadius: 8, padding: 12, marginTop: 6 },
  fine: { backgroundColor: "#f8fafc", borderRadius: 8, padding: 10, marginTop: 10, fontSize: 8, color: "#64748b", lineHeight: 1.4 },
  footer: { marginTop: 16, borderTopWidth: 1, borderTopColor: "#e2e8f0", paddingTop: 8, textAlign: "center", fontSize: 8, color: "#94a3b8" },
});

function pts(a: { x: number; y: number }[]) {
  return a.map((p) => `${p.x},${p.y}`).join(" ");
}

function OptionCard({ o, hi }: { o: SystemOption; hi: boolean }) {
  return (
    <View style={hi ? s.cardHi : s.card}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={s.cardTitle}>{o.batteryKwh > 0 ? `With ${o.batteryKwh} kWh battery` : "Solar only"}</Text>
        {hi && <Text style={{ fontSize: 7, fontFamily: "Helvetica-Bold", color: AMBER }}>RECOMMENDED</Text>}
      </View>
      <Text style={s.cardPrice}>{thb(o.priceTHB)}</Text>
      <View style={s.miniRow}>
        <View style={s.mini}><Text style={s.miniVal}>{o.dcKw}</Text><Text style={s.miniLbl}>kWp</Text></View>
        <View style={s.mini}><Text style={s.miniVal}>{o.paybackYears ?? ">25"}</Text><Text style={s.miniLbl}>yrs payback</Text></View>
        <View style={s.mini}><Text style={{ ...s.miniVal, color: "#15803d" }}>{thb(o.firstYearSavingsTHB)}</Text><Text style={s.miniLbl}>yr-1 saved</Text></View>
      </View>
    </View>
  );
}

function ProposalDoc({ result, narrative, images, overlay, createdAt }: {
  result: ProposalResult; narrative: Narrative | null | undefined; images: PdfImages; overlay: OverlayGeom; createdAt: string;
}) {
  const rec = result.scenarios[0]?.options[0];
  const dateStr = new Date(createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const series = rec ? cashFlowSeries(rec.priceTHB, rec.flows, result.site.tariffTHBPerKwh) : [];
  const cw = 515, ch = 150, pad = 30;
  const cmin = Math.min(...series), cmax = Math.max(...series);
  const cx = (i: number) => pad + (i / Math.max(1, series.length - 1)) * (cw - pad * 2);
  const cy = (v: number) => ch - pad - ((v - cmin) / Math.max(1, cmax - cmin)) * (ch - pad * 2);

  return (
    <Document title={`Solvio Solar Proposal — ${result.site.address}`}>
      <Page size="A4" style={s.page} wrap>
        <View style={s.hero}>
          <View style={s.brandRow}>
            <Text style={s.brand}>SOLVIO<Text style={s.brandDot}>.</Text></Text>
            <Text style={{ fontSize: 8, color: "#94a3b8" }}>www.solvio.solar</Text>
          </View>
          <Text style={s.headline}>{narrative?.headline ? clean(narrative.headline) : "Your Solar Proposal"}</Text>
          <Text style={s.sub}>{result.site.address} · {dateStr}</Text>
          {rec && (
            <View style={s.statRow}>
              {[[`${rec.dcKw} kWp`, "System size"], [thb(rec.priceTHB), "Investment"], [thb(rec.firstYearSavingsTHB), "First-year savings"], [rec.paybackYears !== null ? `${rec.paybackYears} yrs` : ">25 yrs", "Payback"]].map(([v, l]) => (
                <View key={l} style={s.stat}><Text style={s.statVal}>{v}</Text><Text style={s.statLbl}>{l}</Text></View>
              ))}
            </View>
          )}
        </View>

        {narrative?.intro && <Text style={s.intro}>{clean(narrative.intro)}</Text>}
        {narrative?.bullets?.map((b, i) => (
          <View key={i} style={s.bullet}><View style={s.bulletDot} /><Text style={s.bulletText}>{clean(b)}</Text></View>
        ))}

        {images.renderDataUri && (
          <View wrap={false}>
            <Text style={s.h2}>Your building with solar</Text>
            <Image src={images.renderDataUri} style={s.img} />
            <Text style={s.caption}>AI visualization on the actual building photo — {rec?.panelCount} panels as designed. Final layout confirmed at site survey.</Text>
          </View>
        )}
        {!images.renderDataUri && images.photoDataUri && (
          <View wrap={false}>
            <Text style={s.h2}>The property</Text>
            <Image src={images.photoDataUri} style={s.img} />
          </View>
        )}

        {images.mapDataUri && (
          <View wrap={false}>
            <Text style={s.h2}>Panel layout</Text>
            <View style={{ position: "relative", width: overlay.w, height: overlay.h }}>
              <Image src={images.mapDataUri} style={{ width: overlay.w, height: overlay.h, borderRadius: 8 }} />
              <Svg style={{ position: "absolute", top: 0, left: 0 }} width={overlay.w} height={overlay.h} viewBox={`0 0 ${overlay.w} ${overlay.h}`}>
                <Polygon points={pts(overlay.outline)} fill="none" stroke={AMBER} strokeWidth={2} />
                {overlay.panels.map((p, i) => (
                  <Polygon key={i} points={pts(p)} fill={NAVY} fillOpacity={0.9} stroke="#7fb2ff" strokeWidth={0.5} />
                ))}
              </Svg>
            </View>
            <Text style={s.caption}>{Math.round(result.packing.footprintM2)} m² roof · up to {result.packing.count} panels ({result.packing.maxKw.toFixed(1)} kWp) · facing {Math.round(result.site.azimuthDeg)}° · yield {result.site.yieldKwhPerKwpYr} kWh/kWp/yr (NREL PVWatts)</Text>
          </View>
        )}

        {result.scenarios.map((sc, i) => (
          <View key={i} style={{ marginTop: 12 }} wrap={false}>
            <Text style={s.h2}>{sc.name}</Text>
            <Text style={{ fontSize: 8, color: "#94a3b8", marginBottom: 6 }}>{sc.description} · {Math.round(sc.annualLoadKwh).toLocaleString()} kWh/yr assumed</Text>
            <View style={s.cardRow}>
              {sc.options.map((o, j) => <OptionCard key={j} o={o} hi={i === 0 && j === 0} />)}
            </View>
          </View>
        ))}

        {rec && (
          <View wrap={false}>
            <Text style={s.h2}>Recommended system details</Text>
            <View style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 10, padding: 12 }}>
              <View style={s.row}><Text style={s.rowKey}>Panels</Text><Text style={s.rowVal}>{rec.panelCount} × 450 W</Text></View>
              <View style={s.row}><Text style={s.rowKey}>Inverter</Text><Text style={s.rowVal}>{rec.inverterCount > 1 ? `${rec.inverterCount} × ` : ""}{rec.inverter.brand} {rec.inverter.model}</Text></View>
              <View style={s.row}><Text style={s.rowKey}>Battery</Text><Text style={s.rowVal}>{rec.batteryKwh > 0 ? `${rec.batteryKwh} kWh LFP` : "None"}</Text></View>
              <View style={s.row}><Text style={s.rowKey}>Annual production</Text><Text style={s.rowVal}>{Math.round(rec.flows.annualProductionKwh).toLocaleString()} kWh</Text></View>
              <View style={s.row}><Text style={s.rowKey}>25-year savings</Text><Text style={s.rowVal}>{thb(rec.totalSavings25yrTHB)}</Text></View>
            </View>
          </View>
        )}

        {narrative?.recommendationNote && (
          <View wrap={false} style={s.why}>
            <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 11, marginBottom: 3 }}>Why this configuration</Text>
            <Text style={{ fontSize: 10, lineHeight: 1.5, color: "#334155" }}>{clean(narrative.recommendationNote)}</Text>
          </View>
        )}

        {rec && series.length > 1 && (
          <View wrap={false}>
            <Text style={s.h2}>Your money back in {rec.paybackYears ?? "—"} years</Text>
            <Svg width={cw} height={ch} viewBox={`0 0 ${cw} ${ch}`} style={{ borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8 }}>
              <Line x1={pad} y1={cy(0)} x2={cw - pad} y2={cy(0)} stroke="#cbd5e1" strokeWidth={1} strokeDasharray="4 3" />
              <Polyline points={series.map((v, i) => `${cx(i)},${cy(v)}`).join(" ")} fill="none" stroke={AMBER} strokeWidth={2.5} />
              {rec.paybackYears !== null && <Line x1={cx(rec.paybackYears)} y1={14} x2={cx(rec.paybackYears)} y2={ch - pad} stroke={NAVY} strokeWidth={1} strokeDasharray="3 3" />}
            </Svg>
          </View>
        )}

        <View style={s.fine}>
          <Text style={{ fontFamily: "Helvetica-Bold", color: "#475569", marginBottom: 2 }}>Assumptions & disclaimers</Text>
          {result.assumptionNotes.map((n, i) => <Text key={i}>• {clean(n)}</Text>)}
          <Text>• Residential export credit (THB 2.2/kWh, systems up to 10 kW) subject to net-billing registration, utility approval and annual quota.</Text>
          <Text>• Final price subject to site survey.</Text>
        </View>

        <Text style={s.footer} fixed>SOLVIO · www.solvio.solar</Text>
      </Page>
    </Document>
  );
}

export async function renderProposalPdf(args: {
  result: ProposalResult; narrative: Narrative | null | undefined; images: PdfImages; overlay: OverlayGeom; createdAt: string;
}): Promise<Buffer> {
  return renderToBuffer(<ProposalDoc {...args} />);
}
