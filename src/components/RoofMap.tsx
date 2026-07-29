"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { fitRectangle, rectangleOvershoot } from "@/lib/engine/rect";
import { packPanels, toLocalMeters } from "@/lib/engine/roof";
import { SQUARE_TOLERANCE_DEG, snapRightAngles, squareNextPoint } from "@/lib/engine/snap";
import type { LatLng, PackingResult } from "@/lib/engine/types";
import type { RoofType } from "@/config/assumptions";

interface Props {
  center: LatLng;
  roofType: RoofType;
  onPolygonChange: (poly: LatLng[], packing: PackingResult | null, obstructions: LatLng[][]) => void;
}

const EARTH_R = 6_371_000;
/** Warn above this much extra area — the building probably is not a rectangle. */
const OVERSHOOT_WARN = 0.2;

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
  const obsShapesRef = useRef<google.maps.Polygon[]>([]);
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  /** the outline exactly as drawn/detected, before the rectangle assumption */
  const rawPolyRef = useRef<LatLng[]>([]);
  /** row direction of the current layout (rad, CCW from east) — obstruction boxes follow it */
  const gridAngleRef = useRef(0);
  const [drawing, setDrawing] = useState(false);
  const [vertices, setVertices] = useState<LatLng[]>([]);
  const [status, setStatus] = useState("Click “Detect roof” to find the building automatically, or “Draw roof” to trace it yourself.");
  const [aiBusy, setAiBusy] = useState(false);
  const [altCount, setAltCount] = useState(0);
  const [warn, setWarn] = useState("");
  const [snap, setSnap] = useState(true);
  const [rectAssume, setRectAssume] = useState(true);
  const [obsCount, setObsCount] = useState(0);
  const [addingObs, setAddingObs] = useState(false);
  // the drawing listeners are created once, so they read the toggles from refs
  const snapRef = useRef(true);
  snapRef.current = snap;
  const rectRef = useRef(true);
  rectRef.current = rectAssume;

  const clearPanels = () => {
    panelShapesRef.current.forEach((p) => p.setMap(null));
    panelShapesRef.current = [];
  };

  const clearAlts = () => {
    altShapesRef.current.forEach((p) => p.setMap(null));
    altShapesRef.current = [];
    setAltCount(0);
  };

  const obstructionPaths = useCallback(
    (): LatLng[][] => obsShapesRef.current.map((s) => s.getPath().getArray().map((v) => ({ lat: v.lat(), lng: v.lng() }))),
    []
  );

  const renderPacking = useCallback(
    (poly: LatLng[]) => {
      clearPanels();
      if (poly.length < 3) return null;
      const obstructions = obstructionPaths();
      const packing = packPanels(poly, roofType, undefined, obstructions);
      gridAngleRef.current = ((90 - packing.rowAxisDeg) * Math.PI) / 180;
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
      setStatus(
        `Roof: ${Math.round(packing.footprintM2)} m² footprint${packing.obstructedM2 > 0 ? ` − ${Math.round(packing.obstructedM2)} m² blocked` : ""} → ${packing.count} panels (${packing.maxKw.toFixed(1)} kWp max).`
      );
      return packing;
    },
    [roofType, obstructionPaths]
  );

  const commitPolygon = useCallback(
    (poly: LatLng[]) => {
      const packing = renderPacking(poly);
      onPolygonChange(poly, packing, obstructionPaths());
    },
    [renderPacking, onPolygonChange, obstructionPaths]
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

  /**
   * Put a freshly drawn/detected outline on the map, applying the rectangular
   * footprint assumption (or, when that is off, the 90° corner snap).
   */
  const placePolygon = useCallback(
    (raw: LatLng[]) => {
      rawPolyRef.current = raw;
      if (!rectRef.current) {
        setPolygonOnMap(snapRef.current ? snapRightAngles(raw) : raw);
        return;
      }
      const rect = fitRectangle(raw);
      const over = rectangleOvershoot(raw, rect);
      setPolygonOnMap(rect);
      setWarn(
        over > OVERSHOOT_WARN
          ? `The rectangle assumption added ${Math.round(over * 100)}% area to this outline, so this building probably is not a simple rectangle. Untick “Rectangular roof” to keep the shape you drew.`
          : ""
      );
    },
    [setPolygonOnMap]
  );

  /** Re-apply (or undo) the rectangle assumption on the outline already placed. */
  const toggleRectangle = (on: boolean) => {
    setRectAssume(on);
    rectRef.current = on;
    if (!polyRef.current) return;
    if (on) {
      // fit to what is on the map now, so corner edits since placement are kept
      const cur = polyRef.current.getPath().getArray().map((v) => ({ lat: v.lat(), lng: v.lng() }));
      rawPolyRef.current = cur;
      placePolygon(cur);
    } else if (rawPolyRef.current.length >= 3) {
      setWarn("");
      setPolygonOnMap(snapRef.current ? snapRightAngles(rawPolyRef.current) : rawPolyRef.current);
    }
  };

  const startDrawing = () => {
    if (!mapRef.current) return;
    polyRef.current?.setMap(null);
    polyRef.current = null;
    clearPanels();
    clearAlts();
    setWarn("");
    setVertices([]);
    setDrawing(true);
    setStatus(
      rectRef.current
        ? "Click the roof corners — the outline becomes the tightest rectangle around them. Double-click (or click the first point) to finish."
        : snapRef.current
          ? `Click the roof corners — anything within ${SQUARE_TOLERANCE_DEG}° of square snaps to exactly 90°. Double-click (or click the first point) to finish.`
          : "Click the roof corners. Double-click (or click the first point) to finish."
    );
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
      if (pts.length < 3) return setStatus("Need at least 3 points — try again.");
      // the last corner and the closing corner only exist once the ring is
      // closed, so square the finished outline as a whole
      placePolygon([...pts]);
    };

    clickListenerRef.current = map.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      const raw = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      // clicking near the first point closes the polygon
      if (pts.length >= 3) {
        const first = pts[0];
        const d = Math.hypot((raw.lat - first.lat) * 111320, (raw.lng - first.lng) * 111320 * Math.cos((raw.lat * Math.PI) / 180));
        if (d < 1.5) return finish();
      }
      // the rectangle fit supersedes the corner snap, so only snap without it
      const p = snapRef.current && !rectRef.current ? squareNextPoint(pts, raw) : raw;
      const snapped = p !== raw;
      pts.push(p);
      setVertices([...pts]);
      markers.push(
        new google.maps.Marker({
          map,
          position: p,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 4, fillColor: snapped ? "#22c55e" : "#f59e0b", fillOpacity: 1, strokeWeight: 1 },
        })
      );
      if (snapped) setStatus(`Corner ${pts.length - 1} squared to 90°. Keep clicking corners; double-click to finish.`);
      tempLine?.setMap(null);
      tempLine = new google.maps.Polyline({ map, path: pts, strokeColor: "#f59e0b", strokeWeight: 2 });
    });
    map.addListener("dblclick", finish);
  };

  /** Square up the outline currently on the map (detected outlines included). */
  const squareUp = () => {
    const gp = polyRef.current;
    if (!gp) return;
    const cur: LatLng[] = gp.getPath().getArray().map((v) => ({ lat: v.lat(), lng: v.lng() }));
    const snapped = snapRightAngles(cur);
    if (snapped === cur) {
      setStatus(`Nothing to square — no corner is within ${SQUARE_TOLERANCE_DEG}° of 90° (or the correction would have moved the outline too far).`);
      return;
    }
    setPolygonOnMap(snapped);
    // setPolygonOnMap queues the packing status — append rather than clobber it
    setStatus((s) => `${s} Corners squared to 90°.`);
  };

  // ── Obstructions: rectangles the panels must keep clear of ──────────
  const addObstructionShape = useCallback(
    (path: LatLng[]) => {
      const shape = new google.maps.Polygon({
        map: mapRef.current!,
        paths: path,
        editable: true,
        clickable: true,
        fillColor: "#dc2626",
        fillOpacity: 0.35,
        strokeColor: "#fecaca",
        strokeWeight: 1.5,
        zIndex: 5,
      });
      obsShapesRef.current.push(shape);
      setObsCount(obsShapesRef.current.length);
      const recommit = () => {
        const gp = polyRef.current;
        if (gp) commitPolygon(gp.getPath().getArray().map((v) => ({ lat: v.lat(), lng: v.lng() })));
      };
      ["set_at", "insert_at", "remove_at"].forEach((ev) => shape.getPath().addListener(ev, recommit));
      // right-click to delete — left-click is taken by corner editing
      shape.addListener("rightclick", () => {
        shape.setMap(null);
        obsShapesRef.current = obsShapesRef.current.filter((s) => s !== shape);
        setObsCount(obsShapesRef.current.length);
        recommit();
      });
      recommit();
    },
    [commitPolygon]
  );

  const clearObstructions = () => {
    obsShapesRef.current.forEach((s) => s.setMap(null));
    obsShapesRef.current = [];
    setObsCount(0);
    const gp = polyRef.current;
    if (gp) commitPolygon(gp.getPath().getArray().map((v) => ({ lat: v.lat(), lng: v.lng() })));
  };

  /** Two clicks give opposite corners; the box is aligned to the panel rows. */
  const startObstruction = () => {
    const map = mapRef.current;
    const gp = polyRef.current;
    if (!map || !gp) return;
    setAddingObs(true);
    setStatus("Click two opposite corners of the obstruction (stairwell, water tank, AC platform…).");
    const origin = toLocalMeters(gp.getPath().getArray().map((v) => ({ lat: v.lat(), lng: v.lng() }))).origin;
    const ang = gridAngleRef.current;
    const cosA = Math.cos(-ang), sinA = Math.sin(-ang);
    const toFrame = (ll: LatLng) => {
      const cosLat = Math.cos((origin.lat * Math.PI) / 180);
      const x = ((ll.lng - origin.lng) * Math.PI / 180) * EARTH_R * cosLat;
      const y = ((ll.lat - origin.lat) * Math.PI / 180) * EARTH_R;
      return { x: x * cosA - y * sinA, y: x * sinA + y * cosA };
    };
    const fromFrame = (x: number, y: number) =>
      metersToLatLng(origin, x * Math.cos(ang) - y * Math.sin(ang), x * Math.sin(ang) + y * Math.cos(ang));

    let first: { x: number; y: number } | null = null;
    let marker: google.maps.Marker | null = null;
    const listener = map.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      const p = toFrame({ lat: e.latLng.lat(), lng: e.latLng.lng() });
      if (!first) {
        first = p;
        marker = new google.maps.Marker({
          map,
          position: { lat: e.latLng.lat(), lng: e.latLng.lng() },
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 4, fillColor: "#dc2626", fillOpacity: 1, strokeWeight: 1 },
        });
        return;
      }
      const x0 = Math.min(first.x, p.x), x1 = Math.max(first.x, p.x);
      const y0 = Math.min(first.y, p.y), y1 = Math.max(first.y, p.y);
      listener.remove();
      marker?.setMap(null);
      setAddingObs(false);
      if (x1 - x0 < 0.3 || y1 - y0 < 0.3) {
        setStatus("That box was too small — try again with two opposite corners.");
        return;
      }
      addObstructionShape([fromFrame(x0, y0), fromFrame(x1, y0), fromFrame(x1, y1), fromFrame(x0, y1)]);
    });
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
          placePolygon(cand.polygon);
          setStatus(`Switched to the ${cand.areaM2} m² building — drag corners to fine-tune, or redraw.`);
        });
        altShapesRef.current.push(shape);
      }
      setAltCount(cands.length);
    },
    [placePolygon]
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
        placePolygon(best.polygon);
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
                placePolygon(vis.polygon);
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
        placePolygon(data.polygon);
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
        <button onClick={startDrawing} disabled={drawing || addingObs} className="rounded bg-amber-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
          {drawing ? `Drawing… (${vertices.length} pts)` : polyRef.current ? "Redraw roof" : "Draw roof"}
        </button>
        <button onClick={detectRoof} disabled={aiBusy || drawing || addingObs} className="rounded border border-amber-500 px-3 py-1.5 text-sm font-semibold text-amber-600 hover:bg-amber-50 disabled:opacity-50">
          {aiBusy ? "Detecting…" : "Detect roof"}
        </button>
        <button
          onClick={startObstruction}
          disabled={drawing || addingObs || !polyRef.current}
          title="Block out a stairwell, water tank or AC platform — panels keep 200 mm clear of it"
          className="rounded border border-red-400 px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          {addingObs ? "Click 2 corners…" : "+ Obstruction"}
        </button>
        {obsCount > 0 && (
          <button onClick={clearObstructions} className="rounded border border-slate-300 px-2 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50">
            Clear {obsCount} obstruction{obsCount > 1 ? "s" : ""}
          </button>
        )}
        {!rectAssume && (
          <button
            onClick={squareUp}
            disabled={drawing || addingObs || !polyRef.current}
            title={`Corners within ${SQUARE_TOLERANCE_DEG}° of square become exactly 90°`}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Square corners
          </button>
        )}
        {altCount > 0 && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
            {altCount} other building{altCount > 1 ? "s" : ""} — click to switch
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600" title="The outer footprint is replaced by the tightest rectangle around your outline">
          <input type="checkbox" checked={rectAssume} onChange={(e) => toggleRectangle(e.target.checked)} className="h-3.5 w-3.5" />
          Rectangular roof
        </label>
        {!rectAssume && (
          <label className="flex items-center gap-1.5 text-xs text-slate-600" title={`While drawing, corners within ${SQUARE_TOLERANCE_DEG}° of square snap to exactly 90°`}>
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} className="h-3.5 w-3.5" />
            Snap to 90°
          </label>
        )}
        <span className="text-xs text-slate-500">{status}</span>
      </div>
      {warn && (
        <p className="rounded-lg border border-amber-400 bg-amber-50 p-2.5 text-xs font-medium text-amber-800">
          ⚠ {warn}
        </p>
      )}
      {obsCount > 0 && (
        <p className="text-xs text-slate-500">
          {obsCount} obstruction{obsCount > 1 ? "s" : ""} blocked out — drag the corners to resize, right-click to remove.
        </p>
      )}
      <div ref={divRef} className="h-[480px] w-full rounded-lg border" />
    </div>
  );
}
