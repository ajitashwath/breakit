"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { SliderSpec } from "@/lib/ui/scales";

interface Props {
  spec: SliderSpec;
  /** The real config value (ms, %, kbps). */
  value: number;
  onChange: (value: number) => void;
}

const GLIDE_MS = 480;
const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3);

/**
 * Layout: one row — label, track, value — so six controls read as a single
 * quiet list rather than six form fields.
 *
 * Motion: dragging is immediate. When the value changes from *outside* (a
 * preset, Random) the thumb glides to its new position and the number rolls
 * with it, which is what makes presets feel like a physical object moving.
 */
export function ChaosSlider({ spec, value, onChange }: Props) {
  const id = useId();
  const target = spec.toPos(value);
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const frame = useRef(0);
  const fromUser = useRef(false);

  const show = (p: number) => {
    shownRef.current = p;
    setShown(p);
  };

  useEffect(() => {
    if (shownRef.current === target) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (fromUser.current || reduce) {
      fromUser.current = false;
      cancelAnimationFrame(frame.current);
      show(target);
      return;
    }
    const from = shownRef.current;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / GLIDE_MS);
      show(k === 1 ? target : from + (target - from) * easeOutCubic(k));
      if (k < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [target]);

  const gliding = shown !== target;
  // While gliding, the label rolls with the thumb; at rest it is the exact value.
  const label = spec.format(gliding ? spec.fromPos(Math.round(shown)) : value);
  const off = gliding ? Math.round(shown) === 0 : value <= 0;

  return (
    <div className="chaos-row">
      <label htmlFor={id} className="chaos-label">
        {spec.label}
      </label>
      <input
        id={id}
        className="chaos-slider"
        type="range"
        min={0}
        max={spec.steps}
        // "any" lets the thumb sit between integer positions while gliding.
        step="any"
        value={shown}
        style={{ "--r": shown / spec.steps } as CSSProperties}
        aria-valuetext={spec.format(value)}
        onPointerDown={() => cancelAnimationFrame(frame.current)}
        onChange={(e) => {
          const pos = Math.round(Number(e.target.value));
          fromUser.current = true;
          show(pos);
          onChange(spec.fromPos(pos));
        }}
      />
      <output htmlFor={id} className="chaos-value" data-off={off}>
        {label}
      </output>
    </div>
  );
}
