"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { packPanels, toLocalMeters } from "@/lib/engine/roof";
import type { LatLng, PackingResult } from "@/lib/engine/types";
import type { RoofType } from "@/config/assumptions";

interface Props {
  center: LatLng;
  roofType: RoofType;
  onPolygonChange: (poly: LatLng[], packing: PackingResult | null) => void;
}

const EARTH_R = 6_371_000;

/** local meters (relative to origin) → LatLng */
function metersToLatLng(origin: LatLng, x: number, y: number): LatLng {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    lat: origin.lat + ((y / EARTH_R) * 180) / Math.PI,
    lng: origin.lng + ((x / (EARTH_R * cosLat)) * 180) / Math.PI,
  };
}

export default function RoofMap({ center, roofType, onPolygonChange }: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const polyRef = useRef<google.maps.Polygon | null>(null);
  const panelShapesRef = useRef<google.maps.Polygon[]>([]);
  const altShapesRef = useRef<google.maps.Polygon[]>([]);
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [vertices, setVertices] = useState<LatLng[]>([]);
  const [status, setStatus] = useState("Click “Detect roof” to find the building automatically, or “Draw roof” to trace it yourself.");
  const [aiBusy, setAiBusy] = useState(false);
  const [altCount, setAltCount] = useState(0);
  const [warn, setWarn] = useState("");

  const clearPanels = () => {
    panelShapesRef.current.forEach((p) => p.setMap(null));
    panelShapesRef.current = [];
  };

  const clearAlts = () => {
    altShapesRef.current.forEach((p) => p.setMap(null));
    altShapesRef.current = [];
    setAltCount(0);
  };

  const renderPacking = useCallback(
    (poly: LatLng[]) => {
      clearPanels();
      if (poly.length < 3) return null;
      const packing = packPanels(poly, roofType);
      const { origin } = toLocalMeters(poly);
      const map = mapRef.current!;
      for (const p of packing.panels) {
        const rot = (p.rotDeg * Math.PI) / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const corners = [
          [-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [p.w / 2, p.h / 2], [-p.w / 2, p.h / 2],
        ].map(([dx, dy]) => metersToLatLng(origin, p.x + dx * cos - dy * sin, p.y + dx * sin + dy * cos));
        panelShapesRef.current.push(
          new google.maps.Polygon({
            map,
            paths: corners,
            fillColor: "#0f2c56",
            fillOpacity: 0.85,
            strokeColor: "#7fb2ff",
            strokeWeight: 0.5,
            clickable: false,
          })
        );
      }
      setStatus(`Roof: ${Math.round(packing.footprintM2)} m² footprint → ${packing.count} panels (${packing.maxKw.toFixed(1)} kWp max).`);
      return packing;
    },
    [roofType]
  );

  const commitPolygon = useCallback(
    (poly: LatLng[]) => {
      const packing = renderPacking(poly);
      onPolygonChange(poly, packing);
    },
    [renderPacking, onPolygonChange]
  );

  // init map
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || !divRef.current) return;
    setOptions({ key, v: "weekly" });
    importLibrary("maps").then(() => {
      mapRef.current = new google.maps.Map(divRef.current!, {
        center,
        zoom: 20,
        mapTypeId: "satellite",
        tilt: 0,
        disableDefaultUI: false,
        streetViewControl: false,
        fullscreenControl: false,
      });
    });
    return () => clearPanels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.setCenter(center);
  }, [center]);

  const setPolygonOnMap = useCallback(
    (path: LatLng[]) => {
      polyRef.current?.setMap(null);
      const gp = new google.maps.Polygon({
        map: mapRef.current!,
        paths: path,
        editable: true,
        fillColor: "#f59e0b",
        fillOpacity: 0.1,
        strokeColor: "#f59e0b",
        strokeWeight: 2,
      });
      polyRef.current = gp;
      const sync = () => {
        const p: LatLng[] = gp.getPath().getArray().map((v) => ({ lat: v.lat(), lng: v.lng() }));
        commitPolygon(p);
      };
      ["set_at", "insert_at", "remove_at"].forEach((ev) => gp.getPath().addListener(ev, sync));
      sync();
    },
    [commitPolygon]
  );

  const startDrawing = () => {
    if (!mapRef.current) return;
    polyRef.current?.setMap(null);
    polyRef.current = null;
    clearPanels();
    clearAlts();
    setWarn("");
    setVertices([]);
    setDrawing(true);
    setStatus("Click the roof corners. Double-click (or click the first point) to finish.");
    const map = mapRef.current;
    const pts: LatLng[] = [];
    const markers: google.maps.Marker[] = [];
    let tempLine: google.maps.Polyline | null = null;

    const finish = () => {
      clickListenerRef.current?.remove();
      google.maps.event.clearListeners(map, "dblclick");
      markers.forEach((m) => m.setMap(null));
      tempLine?.setMap(null);
      setDrawing(false);
      if (pts.length >= 3) setPolygonOnMap([...pts]);
      else setStatus("Need at least 3 points — try again.");
    };

    clickListenerRef.current = map.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      const p = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      // clicking near the first point closes the polygon
      if (pts.length >= 3) {
        const first = pts[0];
        const d = Math.hypot((p.lat - first.lat) * 111320, (p.lng - first.lng) * 111320 * Math.cos((p.lat * Math.PI) / 180));
        if (d < 1.5) return finish();
      }
      pts.push(p);
      setVertices([...pts]);
      markers.push(new google.maps.Marker({ map, position: p, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 4, fillColor: "#f59e0b", fillOpacity: 1, strokeWeight: 1 } }));
      tempLine?.setMap(null);
      tempLine = new google.maps.Polyline({ map, path: pts, strokeColor: "#f59e0b", strokeWeight: 2 });
    });
    map.addListener("dblclick", finish);
  };

  /** Draw the non-selected candidates faintly; clicking one swaps it in. */
  const showAlternates = useCallback(
    (cands: { polygon: LatLng[]; areaM2: number }[]) => {
      clearAlts();
      const map = mapRef.current!;
      for (const cand of cands) {
        const shape = new google.maps.Polygon({
          map,
          paths: cand.polygon,
          clickable: true,
          fillColor: "#94a3b8",
          fillOpacity: 0.12,
          strokeColor: "#e2e8f0",
          strokeWeight: 2,
          zIndex: 1,
        });
        shape.addListener("click", () => {
          setPolygonOnMap(cand.polygon);
          setStatus(`Switched to the ${cand.areaM2} m² building — drag corners to fine-tune, or redraw.`);
        });
        altShapesRef.current.push(shape);
      }
      setAltCount(cands.length);
    },
    [setPolygonOnMap]
  );

  /**
   * Detect the roof. Primary: Google's building mask (measured segmentation,
   * 0.5 m). Fallback: vision model outline. Either way the user confirms.
   */
  const detectRoof = async () => {
    if (!mapRef.current) return;
    setAiBusy(true);
    clearAlts();
    setWarn("");
    setStatus("Detecting buildings from Google's roof data…");
    try {
      const c = mapRef.current.getCenter()!;
      const det = await fetch(`/api/roof-detect?lat=${c.lat()}&lng=${c.lng()}`).then((r) => r.json());
      if (det.available && det.candidates?.length > 0) {
        const best = det.candidates[det.recommended] ?? det.candidates[0];
        setPolygonOnMap(best.polygon);
        const others = det.candidates.filter((_: unknown, i: number) => i !== (det.recommended ?? 0));
        if (others.length > 0) showAlternates(others);
        setStatus(
          `Detected a ${best.areaM2} m² building from Google roof data (${det.imageryQuality}${det.imageryDate ? ` ${det.imageryDate}` : ""}). ` +
            (others.length > 0 ? `${others.length} other building${others.length > 1 ? "s" : ""} nearby — click one to switch. ` : "") +
            `Drag corners to fine-tune, or redraw.`
        );

        // Google's roof data can lag the live satellite view by years. When it
        // does, also trace the CURRENT image so the user can compare and pick.
        if (det.stale) {
          const yrs = det.imageryAgeMonths != null ? (det.imageryAgeMonths / 12).toFixed(1) : "?";
          setWarn(
            `Google's roof data here is from ${det.imageryDate} — ${yrs} years older than the satellite view below. If this building was built or extended since, this outline will be wrong. An AI trace of the current image is shown in amber — click it to use that instead, or redraw manually.`
          );
          try {
            const zoom = mapRef.current.getZoom() ?? 20;
            const vis = await fetch(`/api/roof-suggest?lat=${c.lat()}&lng=${c.lng()}&zoom=${zoom}`).then((r) => r.json());
            if (vis.polygon?.length >= 3) {
              const shape = new google.maps.Polygon({
                map: mapRef.current!,
                paths: vis.polygon,
                clickable: true,
                fillColor: "#f59e0b",
                fillOpacity: 0.1,
                strokeColor: "#f59e0b",
                strokeWeight: 3,
                zIndex: 2,
              });
              shape.addListener("click", () => {
                setPolygonOnMap(vis.polygon);
                setStatus("Switched to the AI trace of the current satellite image — drag corners to fine-tune.");
              });
              altShapesRef.current.push(shape);
              setAltCount((n) => n + 1);
            }
          } catch {
            // comparison trace is best-effort
          }
        }
        return;
      }

      // fallback: vision-model outline
      setStatus("No Google roof data here — asking AI to trace it instead…");
      const zoom = mapRef.current.getZoom() ?? 20;
      const data = await fetch(`/api/roof-suggest?lat=${c.lat()}&lng=${c.lng()}&zoom=${zoom}`).then((r) => r.json());
      if (data.polygon?.length >= 3) {
        setPolygonOnMap(data.polygon);
        setStatus("AI-traced outline placed (less precise than roof data) — check it carefully and drag corners to correct.");
      } else {
        setStatus(`Could not detect the roof${det.reason ? ` (${det.reason})` : ""} — please draw it manually.`);
      }
    } catch {
      setStatus("Detection failed — please draw the roof manually.");
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={startDrawing} disabled={drawing} className="rounded bg-amber-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
          {drawing ? `Drawing… (${vertices.length} pts)` : polyRef.current ? "Redraw roof" : "Draw roof"}
        </button>
        <button onClick={detectRoof} disabled={aiBusy || drawing} className="rounded border border-amber-500 px-3 py-1.5 text-sm font-semibold text-amber-600 hover:bg-amber-50 disabled:opacity-50">
          {aiBusy ? "Detecting…" : "Detect roof"}
        </button>
        {altCount > 0 && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
            {altCount} other building{altCount > 1 ? "s" : ""} — click to switch
          </span>
        )}
        <span className="text-xs text-slate-500">{status}</span>
      </div>
      {warn && (
        <p className="rounded-lg border border-amber-400 bg-amber-50 p-2.5 text-xs font-medium text-amber-800">
          ⚠ {warn}
        </p>
      )}
      <div ref={divRef} className="h-[480px] w-full rounded-lg border" />
    </div>
  );
}
