"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Roof3D as RoofGeom } from "@/lib/engine/roof3d";

interface Props {
  roof: RoofGeom;
  /** panels in the quoted design — the model clamps to what its own layout fits */
  panelCount: number;
}

/** window shape the 3D model exposes on its own document. */
interface ModelWindow extends Window {
  solvioSetRoof?: (o: { outline: [number, number][]; width: number; length: number }) => unknown;
  solvioSetConfig?: (c: { modules?: number; panel?: string }) => unknown;
}

/** Above this the roof is off-axis enough to need the model's angled layout. */
const OFF_AXIS_NEEDS_ANGLED_DEG = 2;

/**
 * The model opens on whichever *axis-aligned* layout fits more panels, so on a
 * roof that sits at an angle to north the rows run diagonally across it. Its
 * third mode, "angled", rotates the whole array to the angle that fits best —
 * which on an angled roof is parallel to its edges. That mode is only reachable
 * through the toolbar button, so cycle it (same-origin, so this is allowed).
 */
function selectAngledLayout(win: ModelWindow): boolean {
  const btn = win.document.getElementById("orientBtn");
  if (!btn) return false;
  for (let i = 0; i < 3; i++) {
    if (btn.textContent?.includes("Angled")) return true;
    btn.click();
  }
  return !!btn.textContent?.includes("Angled");
}

export default function Roof3D({ roof, panelCount }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const appliedRef = useRef(false);
  const [failed, setFailed] = useState(false);

  /**
   * Push the traced roof into the model. Safe to call more than once — both
   * the load event and the model's own "ready" message trigger it, and
   * whichever wins first wins.
   */
  const apply = useCallback(() => {
    if (appliedRef.current) return;
    const win = frameRef.current?.contentWindow as ModelWindow | null | undefined;
    if (!win?.solvioSetRoof) return;
    try {
      win.solvioSetRoof({ outline: roof.outline, width: roof.widthM, length: roof.lengthM });
      // rows must follow the roof edges, so pick the layout before the count —
      // switching mode re-caps the maximum the roof can hold
      if (roof.offAxisDeg > OFF_AXIS_NEEDS_ANGLED_DEG) selectAngledLayout(win);
      // keep the 3D panel count honest against the quote
      win.solvioSetConfig?.({ modules: panelCount });
      appliedRef.current = true;
    } catch {
      setFailed(true);
    }
  }, [roof, panelCount]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "solvio-ready") apply();
    };
    window.addEventListener("message", onMessage);
    // the model may already have loaded and fired its ready message before this
    // effect ran; retry off the effect body so a failure can't cascade renders
    const t = setTimeout(apply, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("message", onMessage);
    };
  }, [apply]);

  return (
    <div>
      <div className="relative w-full overflow-hidden rounded-2xl border bg-slate-100" style={{ aspectRatio: "16 / 10" }}>
        <iframe
          ref={frameRef}
          src="/api/rooftop3d?embed=1"
          title="3D view of the roof with the panel layout"
          onLoad={apply}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full border-0"
          loading="lazy"
          allow="fullscreen"
        />
      </div>
      <p className="mt-1.5 text-xs text-slate-500">
        {failed
          ? "The 3D view could not be loaded — the 2D layout above is the design of record."
          : `Your roof to scale: ${roof.widthM} m east–west × ${roof.lengthM} m north–south, oriented as it sits on the ground (the arrow on the deck points north). Drag to orbit, scroll to zoom.`}
      </p>
    </div>
  );
}
