import type { ChaosConfig } from "../chaos/types";

// How each config field maps to a slider and to a label.
//
// Every slider works in integer "positions" 0..steps so the UI code is uniform;
// the spec converts between a position and the real config value. Position 0
// always means "off" and more fill always means more chaos — including
// bandwidth, which therefore runs from Unlimited (left) to 50 kbps (right).

export type SliderKey =
  | "latencyMs"
  | "packetLossPct"
  | "bandwidthKbps"
  | "apiFailurePct"
  | "imageFailurePct"
  | "jsFailurePct";

export interface SliderSpec {
  key: SliderKey;
  label: string;
  steps: number;
  toPos: (value: number) => number;
  fromPos: (pos: number) => number;
  format: (value: number) => string;
  /** Shown dimly with a different word when nothing is applied. */
  offLabel: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const linear = (max: number, steps = 100) => ({
  steps,
  toPos: (v: number) => clamp(Math.round((v / max) * steps), 0, steps),
  fromPos: (p: number) => (clamp(p, 0, steps) / steps) * max,
});

const pct = (v: number) => `${Math.round(v)}%`;

// Bandwidth: log scale between 5 Mbps (pos 1) and 50 kbps (pos 100).
const BW_MAX = 5000;
const BW_MIN = 50;
const BW_STEPS = 100;
const bwSpan = Math.log(BW_MAX / BW_MIN);

/** Two significant figures: 743 -> 740, 1480 -> 1500. Display only. */
const twoSig = (n: number) => Number(n.toPrecision(2));

export function formatBandwidth(kbps: number): string {
  if (kbps <= 0) return "Unlimited";
  const k = twoSig(kbps);
  return k >= 1000 ? `${+(k / 1000).toFixed(1)} Mbps` : `${k} kbps`;
}

export function formatLatency(ms: number): string {
  if (ms <= 0) return "Off";
  return ms >= 1000 ? `${+(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export const SLIDERS: SliderSpec[] = [
  {
    key: "latencyMs",
    label: "Latency",
    ...linear(5000),
    format: formatLatency,
    offLabel: "Off",
  },
  {
    key: "packetLossPct",
    label: "Packet loss",
    ...linear(100),
    format: (v) => (v <= 0 ? "Off" : pct(v)),
    offLabel: "Off",
  },
  {
    key: "bandwidthKbps",
    label: "Bandwidth",
    steps: BW_STEPS,
    toPos: (k) =>
      k <= 0
        ? 0
        : clamp(Math.round(1 + ((BW_STEPS - 1) * Math.log(BW_MAX / k)) / bwSpan), 1, BW_STEPS),
    // Not rounded to "nice" numbers here: the value must survive a round trip
    // through toPos() or the thumb would fight the pointer while dragging.
    fromPos: (p) =>
      p <= 0 ? 0 : Math.round(BW_MAX * Math.exp((-bwSpan * (clamp(p, 1, BW_STEPS) - 1)) / (BW_STEPS - 1))),
    format: formatBandwidth,
    offLabel: "Unlimited",
  },
  {
    key: "apiFailurePct",
    label: "API failures",
    ...linear(100),
    format: (v) => (v <= 0 ? "Off" : pct(v)),
    offLabel: "Off",
  },
  {
    key: "imageFailurePct",
    label: "Image failures",
    ...linear(100),
    format: (v) => (v <= 0 ? "Off" : pct(v)),
    offLabel: "Off",
  },
  {
    key: "jsFailurePct",
    label: "JS failures",
    ...linear(100),
    format: (v) => (v <= 0 ? "Off" : pct(v)),
    offLabel: "Off",
  },
];

/** Do these two configs describe the same slider positions (and scope)? */
export function sameSettings(a: ChaosConfig, b: ChaosConfig): boolean {
  return (
    a.thirdPartyOnly === b.thirdPartyOnly &&
    SLIDERS.every((s) => a[s.key] === b[s.key])
  );
}
