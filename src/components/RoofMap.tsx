"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { fitRectangle, rectangleOvershoot } from "@/lib/engine/rect";
import { packPanels, polygonAreaM2, toLocalMeters } from "@/lib/engine/roof";
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
  const obsShapesRef = useRef<google.maps.Polygon[]>([]);
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const obsListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const cancelObsRef = useRef<(() => void) | null>(null);
  /** the outline exactly as drawn/detected, before the rectangle assumption */
  const rawPolyRef = useRef<LatLng[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [vertices, setVertices] = useState<LatLng[]>([]);
  const [status, setStatus] = useState("Click “Detect roof” to find the building automatically, or “Draw roof” to trace it yourself.");
  const [aiBusy, setAiBusy] = useState(false);
  const [warn, setWarn] = useState("");
  const [snap, setSnap] = useState(true);
  const [rectAssume, setRectAssume] = useState(true);
  const [obsCount, setObsCount] = useState(0);
  const [addingObs, setAddingObs] = useState(false);
  const [obsPts, setObsPts] = useState(0);
  /** mirrors polyRef for rendering — a ref read during render can be stale */
  const [hasPoly, setHasPoly] = useState(false);
  // the drawing listeners are created once, so they read the toggles from refs
  const snapRef = useRef(true);
  const rectRef = useRef(true);
  useEffect(() => { snapRef.current = snap; }, [snap]);
  useEffect(() => { rectRef.current = rectAssume; }, [rectAssume]);

  const clearPanels = () => {
    panelShapesRef.current.forEach((p) => p.setMap(null));
    panelShapesRef.current = [];
  };

  /**
   * Shapes on top of the map swallow clicks meant for the map, so every one of
   * them goes inert while the user is clicking corners for a roof or a keep-out.
   */
  const setShapesInert = useCallback((inert: boolean) => {
    const opts = { clickable: !inert, draggable: !inert, editable: !inert };
    polyRef.current?.setOptions(opts);
    for (const s of obsShapesRef.current) s.setOptions(opts);
  }, []);

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
        draggable: true,
        fillColor: "#f59e0b",
        fillOpacity: 0.1,
        strokeColor: "#f59e0b",
        strokeWeight: 2,
      });
      polyRef.current = gp;
      setHasPoly(true);
      const sync = () => {
        const p: LatLng[] = gp.getPath().getArray().map((v) => ({ lat: v.lat(), lng: v.lng() }));
        commitPolygon(p);
      };
      ["set_at", "insert_at", "remove_at"].forEach((ev) => gp.getPath().addListener(ev, sync));
      // dragging the whole outline fires no path events. Obstructions stay put:
      // they mark real things on the ground, so moving the roof over them is a
      // correction to the roof, not to where the water tank sits.
      gp.addListener("dragend", sync);
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
    setHasPoly(false);
    clearPanels();
    setWarn("");
    setVertices([]);
    setDrawing(true);
    setShapesInert(true); // keep-out boxes must not swallow the corner clicks
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
      setShapesInert(false);
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
        draggable: true,
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
      shape.addListener("dragend", recommit);
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
    if (!map || !polyRef.current) return;
    setAddingObs(true);
    setObsPts(0);
    setShapesInert(true);
    setStatus("Click the 4 corners of the obstruction (stairwell, water tank, AC platform…) — it snaps to a rectangle.");

    const pts: LatLng[] = [];
    const markers: google.maps.Marker[] = [];
    let outline: google.maps.Polyline | null = null;
    const done = () => {
      obsListenerRef.current?.remove();
      obsListenerRef.current = null;
      markers.forEach((m) => m.setMap(null));
      outline?.setMap(null);
      setShapesInert(false);
      setAddingObs(false);
      setObsPts(0);
    };
    cancelObsRef.current = () => {
      done();
      setStatus("Obstruction cancelled.");
    };
    obsListenerRef.current = map.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      const p = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      pts.push(p);
      setObsPts(pts.length);
      markers.push(
        new google.maps.Marker({
          map,
          position: p,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 4, fillColor: "#dc2626", fillOpacity: 1, strokeWeight: 1 },
        })
      );
      outline?.setMap(null);
      outline = new google.maps.Polyline({ map, path: pts, strokeColor: "#dc2626", strokeWeight: 2 });
      if (pts.length < 4) {
        setStatus(`Corner ${pts.length} of 4 — keep clicking round the obstruction.`);
        return;
      }
      // the four corners are traced by hand, so square them off the same way
      // the roof outline is: the tightest rectangle that contains them
      const rect = fitRectangle(pts);
      done();
      if (polygonAreaM2(toLocalMeters(rect).pts) < 0.1) {
        setStatus("Those corners were too close together — try again.");
        return;
      }
      addObstructionShape(rect);
    });
  };

  /**
   * Detect the roof. Primary: Google's building mask (measured segmentation,
   * 0.5 m). Fallback: vision model outline. Either way the user confirms.
   */
  const detectRoof = async () => {
    if (!mapRef.current) return;
    setAiBusy(true);
    setWarn("");
    setStatus("Detecting buildings from Google's roof data…");
    try {
      const c = mapRef.current.getCenter()!;
      const det = await fetch(`/api/roof-detect?lat=${c.lat()}&lng=${c.lng()}`).then((r) => r.json());
      if (det.available && det.candidates?.length > 0) {
        // only the best-matching building is drawn — the neighbours used to be
        // shown as clickable grey footprints, which just cluttered the map and
        // made it easy to wipe a corrected outline by accident
        const best = det.candidates[det.recommended] ?? det.candidates[0];
        placePolygon(best.polygon);
        setStatus(
          `Detected a ${best.areaM2} m² building from Google roof data (${det.imageryQuality}${det.imageryDate ? ` ${det.imageryDate}` : ""}). ` +
            `Drag it to reposition, drag a corner to reshape, or redraw.`
        );

        // Google's roof data can lag the live satellite view by years. We used
        // to drop an AI trace of the current image on top as a second opinion,
        // but it landed asynchronously — often after the user had started
        // redrawing — and one stray click replaced their work. Warn instead.
        if (det.stale) {
          const yrs = det.imageryAgeMonths != null ? (det.imageryAgeMonths / 12).toFixed(1) : "?";
          setWarn(
            `Google's roof data here is from ${det.imageryDate} — ${yrs} years older than the satellite view below. If this building was built or extended since, this outline will be wrong: compare it against the image and redraw the roof yourself if it does not match.`
          );
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
          {drawing ? `Drawing… (${vertices.length} pts)` : hasPoly ? "Redraw roof" : "Draw roof"}
        </button>
        <button onClick={detectRoof} disabled={aiBusy || drawing || addingObs} className="rounded border border-amber-500 px-3 py-1.5 text-sm font-semibold text-amber-600 hover:bg-amber-50 disabled:opacity-50">
          {aiBusy ? "Detecting…" : "Detect roof"}
        </button>
        <button
          onClick={() => (addingObs ? cancelObsRef.current?.() : startObstruction())}
          disabled={drawing || !hasPoly}
          title="Block out a stairwell, water tank or AC platform — panels keep 200 mm clear of it"
          className="rounded border border-red-400 px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          {addingObs ? `Cancel — ${obsPts}/4 corners` : "+ Obstruction"}
        </button>
        {obsCount > 0 && (
          <button onClick={clearObstructions} className="rounded border border-slate-300 px-2 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50">
            Clear {obsCount} obstruction{obsCount > 1 ? "s" : ""}
          </button>
        )}
        {!rectAssume && (
          <button
            onClick={squareUp}
            disabled={drawing || addingObs || !hasPoly}
            title={`Corners within ${SQUARE_TOLERANCE_DEG}° of square become exactly 90°`}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Square corners
          </button>
        )}
      </div>
      {/* only two shapes are ever on the map, and one colour means one thing */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm border-2 border-amber-500 bg-amber-500/10" />
          The roof being quoted — drag it to move, drag a corner to reshape
        </span>
        {obsCount > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-4 rounded-sm border border-red-300 bg-red-600/40" />
              No-panel zone — stays put when the roof moves; drag to move, right-click to remove
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
