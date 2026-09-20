// Shared types for the chaos engine, report generator, CLI and UI.
// Keep this file dependency-free so it can be imported from anywhere.

/**
 * Every knob the UI exposes. `0` always means "off" — including bandwidth,
 * where 0 means unthrottled.
 */
export interface ChaosConfig {
  /** Extra delay added to every affected request, in ms. 0–10000. */
  latencyMs: number;
  /** Probability (%) that any affected request is aborted. 0–100. */
  packetLossPct: number;
  /** Download/upload cap in kbps, applied via CDP. 0 = unlimited. */
  bandwidthKbps: number;
  /** Probability (%) that an API request fails. 0–100. */
  apiFailurePct: number;
  /** Probability (%) that an image request is aborted. 0–100. */
  imageFailurePct: number;
  /** Probability (%) that a script request is aborted. 0–100. */
  jsFailurePct: number;

  /**
   * Not a slider. Substrings matched against the request URL to decide what
   * counts as an "API" request. In addition, every `fetch`/`xhr` request is
   * treated as an API request regardless of URL.
   */
  apiPatterns: string[];
  /**
   * Apply latency / packet loss / failures only to requests whose site differs
   * from the target page's site. Bandwidth is a property of the whole
   * connection and cannot be scoped, so it is unaffected by this flag.
   */
  thirdPartyOnly: boolean;
  /**
   * Never inject failures into the top-level navigation document (latency and
   * bandwidth still apply). A dead document produces a blank report, which is
   * a boring answer to an interesting question.
   */
  protectDocument: boolean;
}

export const PRESET_NAMES = [
  "3g",
  "terrible_wifi",
  "api_outage",
  "third_party_apocalypse",
  "everything_is_slow",
] as const;
export type ChaosPresetName = (typeof PRESET_NAMES)[number];

export interface ChaosPreset {
  name: ChaosPresetName;
  /** Human-friendly label for buttons. */
  label: string;
  /** One line, shown as a hint. */
  description: string;
  config: ChaosConfig;
}

/** Which injected behaviour, if any, determined the fate of a request. */
export type ChaosRule =
  | "latency"
  | "packet_loss"
  | "api_failure"
  | "image_failure"
  | "js_failure";

/**
 * - `passed`  — completed with a non-error status, nothing injected on it
 * - `delayed` — completed with a non-error status after injected latency
 * - `failed`  — completed with an error status (>=400, injected or natural),
 *               or the network request failed on its own
 * - `aborted` — connection killed by us (packet loss / image / JS / API abort)
 */
export type RequestOutcome = "passed" | "delayed" | "failed" | "aborted";

export interface RequestInitiator {
  /** CDP initiator type: parser | script | preload | SignedExchange | other */
  type: string;
  /** URL of the document/script that triggered this request, if known. */
  url?: string;
}

export interface RequestRecord {
  /** Sequential within a pass, in order of first sighting. */
  id: number;
  url: string;
  method: string;
  /** Playwright resource type: document, script, image, fetch, xhr, ... */
  resourceType: string;
  /** Milliseconds since the pass started. */
  startedAt: number;
  /** Total time from first sighting to completion, including injected delay. */
  durationMs: number | null;
  /** HTTP status seen by the page (injected 5xx included), null if none. */
  status: number | null;
  outcome: RequestOutcome;
  /** The rule responsible for a failure, or `latency` if only delayed. */
  rule: ChaosRule | null;
  /** Latency we injected on this request (0 if none). */
  injectedDelayMs: number;
  /** Time between request start and first response byte, from Chromium. */
  ttfbMs: number | null;
  /** Time between first and last response byte, from Chromium. */
  downloadMs: number | null;
  /** Encoded response body size in bytes. */
  bytes: number | null;
  /** Failure text (e.g. `net::ERR_FAILED`) or note about how the request ended. */
  error: string | null;
  /** Best-effort: what triggered this request. Feeds the dependency graph. */
  initiator: RequestInitiator | null;
  /** True if the request was to a different site than the target page. */
  thirdParty: boolean;
}

export interface PassResult {
  label: "baseline" | "chaos";
  /** `load` event time from navigation start. Null if the page never loaded. */
  loadTimeMs: number | null;
  domContentLoadedMs: number | null;
  /** Navigation hit the timeout or the document itself failed. */
  timedOut: boolean;
  navigationError: string | null;
  /** True if the network went idle before we took the screenshot. */
  settled: boolean;
  /** Base64-encoded JPEG of the viewport at the stable point, or null. */
  screenshot: string | null;
  pageTitle: string | null;
  /** Uncaught JS exceptions raised in the page during the pass. */
  pageErrors: string[];
  requests: RequestRecord[];
  /** Wall-clock length of the whole pass. */
  totalMs: number;
}

export interface ExperimentResult {
  version: 1;
  url: string;
  finalUrl: string | null;
  startedAt: string;
  config: ChaosConfig;
  /**
   * Seed for every probabilistic decision. Reusing it (with the same config and
   * target) makes the same requests fail. See `lib/chaos/rng.ts`.
   */
  seed: string;
  baseline: PassResult;
  chaos: PassResult;
}

/** Streamed to listeners while an experiment runs. */
export type EngineEvent =
  | { type: "phase"; phase: "warmup" | "baseline" | "chaos" | "done" }
  | { type: "request"; pass: "baseline" | "chaos"; record: RequestRecord };
