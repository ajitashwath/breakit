import type { ChaosConfig, ChaosPreset, ChaosPresetName } from "./types";

export const DEFAULT_API_PATTERNS = ["/api/", "/graphql", "/trpc/"];

/** Everything off. The baseline pass uses this implicitly. */
export const NO_CHAOS: ChaosConfig = {
  latencyMs: 0,
  packetLossPct: 0,
  bandwidthKbps: 0,
  apiFailurePct: 0,
  imageFailurePct: 0,
  jsFailurePct: 0,
  apiPatterns: DEFAULT_API_PATTERNS,
  thirdPartyOnly: false,
  protectDocument: true,
};

/** Slider bounds. The UI reads these so limits live in one place. */
export const LIMITS = {
  latencyMs: { min: 0, max: 5000, step: 50 },
  packetLossPct: { min: 0, max: 100, step: 1 },
  // 0 is "unlimited"; the real floor is 50 kbps.
  bandwidthKbps: { min: 0, max: 10000, step: 50 },
  apiFailurePct: { min: 0, max: 100, step: 1 },
  imageFailurePct: { min: 0, max: 100, step: 1 },
  jsFailurePct: { min: 0, max: 100, step: 1 },
} as const;

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

/**
 * Fill defaults and clamp every value into range. Use on anything that came
 * from outside (HTTP body, CLI flags, imported JSON).
 */
export function normalizeConfig(input: Partial<ChaosConfig> = {}): ChaosConfig {
  const c = { ...NO_CHAOS, ...input };
  return {
    latencyMs: Math.round(clamp(c.latencyMs, 0, 10_000)),
    packetLossPct: clamp(c.packetLossPct, 0, 100),
    bandwidthKbps: c.bandwidthKbps > 0 ? Math.max(8, Math.round(c.bandwidthKbps)) : 0,
    apiFailurePct: clamp(c.apiFailurePct, 0, 100),
    imageFailurePct: clamp(c.imageFailurePct, 0, 100),
    jsFailurePct: clamp(c.jsFailurePct, 0, 100),
    apiPatterns: Array.isArray(c.apiPatterns) ? c.apiPatterns.map(String) : DEFAULT_API_PATTERNS,
    thirdPartyOnly: Boolean(c.thirdPartyOnly),
    protectDocument: c.protectDocument !== false,
  };
}

export function isNoChaos(c: ChaosConfig): boolean {
  return (
    c.latencyMs === 0 &&
    c.packetLossPct === 0 &&
    c.bandwidthKbps === 0 &&
    c.apiFailurePct === 0 &&
    c.imageFailurePct === 0 &&
    c.jsFailurePct === 0
  );
}

// Latency here is *per request*, added on top of real network time, so it is
// tuned lower than the RTT you would quote for the same real-world network.
export const PRESETS: Record<ChaosPresetName, ChaosPreset> = {
  "3g": {
    name: "3g",
    label: "3G",
    description: "750 kbps and a 300 ms tax on every request.",
    config: normalizeConfig({ latencyMs: 300, bandwidthKbps: 750 }),
  },
  terrible_wifi: {
    name: "terrible_wifi",
    label: "Terrible Wi-Fi",
    description: "Some bandwidth, some latency, and 1 in 8 requests just vanish.",
    config: normalizeConfig({ latencyMs: 150, packetLossPct: 12, bandwidthKbps: 1500 }),
  },
  api_outage: {
    name: "api_outage",
    label: "API outage",
    description: "Pages load. Every data call fails.",
    config: normalizeConfig({ apiFailurePct: 100 }),
  },
  third_party_apocalypse: {
    name: "third_party_apocalypse",
    label: "Third-party apocalypse",
    description: "Everything you don't host is slow and mostly broken.",
    config: normalizeConfig({
      latencyMs: 1200,
      jsFailurePct: 70,
      imageFailurePct: 50,
      apiFailurePct: 50,
      thirdPartyOnly: true,
    }),
  },
  everything_is_slow: {
    name: "everything_is_slow",
    label: "Everything is slow",
    description: "Nothing fails. Everything takes forever.",
    config: normalizeConfig({ latencyMs: 2000, bandwidthKbps: 200 }),
  },
};

/** Randomised config inside bounds that will hurt but not obliterate a page. */
export function randomConfig(rng: () => number = Math.random): ChaosConfig {
  const int = (lo: number, hi: number, step = 1) =>
    Math.round((lo + rng() * (hi - lo)) / step) * step;
  return normalizeConfig({
    latencyMs: int(0, 2500, 50),
    packetLossPct: int(0, 25),
    bandwidthKbps: rng() < 0.35 ? 0 : int(250, 5000, 50),
    apiFailurePct: int(0, 60),
    imageFailurePct: int(0, 60),
    jsFailurePct: int(0, 40),
  });
}
