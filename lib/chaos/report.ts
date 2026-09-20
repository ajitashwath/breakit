import { pathOf } from "./url";
import type { ChaosConfig, ExperimentResult, RequestRecord } from "./types";

// ---------------------------------------------------------------------------
// SURVIVAL %  — a heuristic, not a measurement.
//
//   1. Take every request the page made in the *baseline* pass that worked
//      (status < 400). Requests that were already broken without chaos are not
//      held against the chaos run.
//   2. Give each a weight by resource type (WEIGHTS below): a script or API
//      call matters more than a decorative image.
//   3. A baseline request "survives" if the chaos pass made the same request
//      (same method + URL, matched in order) and it completed with status < 400.
//      Delay does not count against survival — slowness is reported separately
//      as the load-time comparison.
//   4. A request the chaos pass never made counts as lost ("not_requested").
//      That is deliberate: when a script fails, everything it would have
//      fetched next silently disappears, and that is real damage.
//
//   survival = 100 × (weight of survivors) / (weight of all working baseline requests)
//
// Rounded to a whole number, but never displayed as 100 if anything was lost or
// 0 if anything survived.
// ---------------------------------------------------------------------------

export const SURVIVAL_FORMULA =
  "Every request that worked without chaos, weighted by type (page 5, scripts and API calls 4, " +
  "stylesheets 3, fonts 2, everything else 1). Survival is the share of that weight that still " +
  "completed successfully. Requests the page never got to make count as lost. It is a heuristic, " +
  "not a measurement.";

const WEIGHTS: Record<string, number> = {
  document: 5,
  script: 4,
  fetch: 4,
  xhr: 4,
  stylesheet: 3,
  font: 2,
};
const weightOf = (type: string) => WEIGHTS[type] ?? 1;

export type LossCause = "aborted" | "failed" | "not_requested";
export type CriticalReason = "page" | "api" | "critical path" | "app code";

export interface LostRequest {
  url: string;
  host: string;
  path: string;
  method: string;
  resourceType: string;
  cause: LossCause;
  status: number | null;
  /** Which injected rule killed it, if we killed it. */
  rule: RequestRecord["rule"];
  weight: number;
  thirdParty: boolean;
}

export interface CriticalFailure extends LostRequest {
  reason: CriticalReason;
}

/** Best-effort inference from URL and resource type. Never authoritative. */
export interface AffectedFeature {
  name: string;
  lost: number;
  total: number;
}

export interface ChaosReport {
  /** 0–100, see SURVIVAL_FORMULA. */
  survivalPct: number;
  survivalFormula: string;
  load: {
    baselineMs: number | null;
    /** Null if the chaos pass never reached the load event. */
    chaosMs: number | null;
    neverFinished: boolean;
    deltaMs: number | null;
    /** chaosMs / baselineMs */
    factor: number | null;
  };
  counts: {
    /** Requests in the chaos pass. */
    total: number;
    passed: number;
    delayed: number;
    failed: number;
    aborted: number;
    /** Working in baseline, never attempted under chaos. */
    notRequested: number;
    baselineTotal: number;
  };
  criticalFailures: CriticalFailure[];
  affectedFeatures: AffectedFeature[];
  /** JS errors that appeared only under chaos. */
  newPageErrors: string[];
}

const ok = (r: RequestRecord) => r.outcome === "passed" || r.outcome === "delayed";

const CRITICAL_TOKENS = new Set([
  "checkout", "cart", "basket", "payment", "payments", "pay", "billing", "order", "orders",
  "login", "signin", "auth", "oauth", "session", "sessions", "account", "token", "subscribe",
]);

const FEATURE_TOKENS: [name: string, tokens: string[]][] = [
  ["Checkout & payments", ["checkout", "cart", "basket", "payment", "payments", "pay", "billing", "order", "orders", "stripe", "paypal"]],
  ["Sign-in & accounts", ["login", "signin", "auth", "oauth", "session", "sessions", "account", "sso", "token"]],
  ["Search", ["search", "suggest", "autocomplete", "typeahead"]],
];
const ANALYTICS_HOSTS = [
  "google-analytics", "googletagmanager", "doubleclick", "segment", "hotjar", "sentry",
  "datadog", "newrelic", "mixpanel", "amplitude", "metrics", "analytics", "telemetry",
];
const ANALYTICS_TOKENS = new Set(["analytics", "metrics", "track", "tracking", "telemetry", "beacon", "pixel", "gtm", "gtag", "collect"]);
const AD_HOST_TOKENS = new Set(["ads", "adservice", "adsystem", "adserver", "tracking", "stats"]);

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

function featureOf(r: { url: string; resourceType: string; thirdParty: boolean }): string {
  const host = hostOf(r.url).toLowerCase();
  const toks = new Set(tokens(pathOf(r.url).split("?")[0]));
  for (const [name, words] of FEATURE_TOKENS) if (words.some((w) => toks.has(w))) return name;
  if (
    ANALYTICS_HOSTS.some((h) => host.includes(h)) ||
    tokens(host).some((t) => AD_HOST_TOKENS.has(t)) ||
    [...toks].some((t) => ANALYTICS_TOKENS.has(t))
  ) {
    return "Analytics & ads";
  }
  switch (r.resourceType) {
    case "fetch":
    case "xhr":
      return "Data loading";
    case "image":
      return "Images";
    case "media":
      return "Video & audio";
    case "stylesheet":
      return "Styling";
    case "font":
      return "Fonts";
    case "document":
      return "Page";
    case "script":
      return r.thirdParty ? "Third-party scripts" : "Interactivity";
    default:
      return "Other";
  }
}

function criticalReason(r: LostRequest, cfg: ChaosConfig): CriticalReason | null {
  if (r.resourceType === "document") return "page";
  // Losing analytics is never what breaks a page, even when it is first-party.
  if (featureOf(r) === "Analytics & ads") return null;
  if (r.resourceType === "fetch" || r.resourceType === "xhr" || cfg.apiPatterns.some((p) => p && r.url.includes(p))) {
    return "api";
  }
  if (tokens(r.path.split("?")[0]).some((t) => CRITICAL_TOKENS.has(t))) return "critical path";
  if (!r.thirdParty && (r.resourceType === "script" || r.resourceType === "stylesheet")) return "app code";
  return null;
}

export function buildReport(result: ExperimentResult): ChaosReport {
  const { baseline, chaos, config } = result;

  // Index chaos requests by identity, in order, so the nth baseline request for
  // a URL is compared with the nth chaos request for that URL.
  const key = (r: RequestRecord) => `${r.method} ${r.url}`;
  const chaosByKey = new Map<string, RequestRecord[]>();
  for (const r of chaos.requests) {
    const list = chaosByKey.get(key(r)) ?? [];
    list.push(r);
    chaosByKey.set(key(r), list);
  }
  const seen = new Map<string, number>();

  let totalWeight = 0;
  let survivedWeight = 0;
  const lost: LostRequest[] = [];
  const featureTotals = new Map<string, number>();
  const featureLost = new Map<string, number>();

  for (const b of baseline.requests) {
    if (!ok(b)) continue; // already broken without chaos: not chaos's fault
    const k = key(b);
    const nth = seen.get(k) ?? 0;
    seen.set(k, nth + 1);
    const c = chaosByKey.get(k)?.[nth];

    const w = weightOf(b.resourceType);
    const feature = featureOf(b);
    totalWeight += w;
    featureTotals.set(feature, (featureTotals.get(feature) ?? 0) + 1);

    if (c && ok(c)) {
      survivedWeight += w;
      continue;
    }
    featureLost.set(feature, (featureLost.get(feature) ?? 0) + 1);
    lost.push({
      url: b.url,
      host: hostOf(b.url),
      path: pathOf(b.url),
      method: b.method,
      resourceType: b.resourceType,
      cause: !c ? "not_requested" : c.outcome === "aborted" ? "aborted" : "failed",
      status: c?.status ?? null,
      rule: c?.rule ?? null,
      weight: w,
      thirdParty: b.thirdParty,
    });
  }

  let survival = totalWeight === 0 ? 100 : (100 * survivedWeight) / totalWeight;
  survival = Math.round(survival);
  if (lost.length > 0 && survival === 100) survival = 99;
  if (survivedWeight > 0 && survival === 0) survival = 1;

  const criticalFailures: CriticalFailure[] = [];
  for (const l of lost) {
    const reason = criticalReason(l, config);
    if (reason) criticalFailures.push({ ...l, reason });
  }
  criticalFailures.sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));

  const affectedFeatures: AffectedFeature[] = [...featureLost.entries()]
    .map(([name, n]) => ({ name, lost: n, total: featureTotals.get(name) ?? n }))
    .sort((a, b) => b.lost / b.total - a.lost / a.total || b.lost - a.lost);

  const count = (o: RequestRecord["outcome"]) => chaos.requests.filter((r) => r.outcome === o).length;
  const bMs = baseline.loadTimeMs;
  const cMs = chaos.loadTimeMs;
  const baselineErrors = new Set(baseline.pageErrors);

  return {
    survivalPct: survival,
    survivalFormula: SURVIVAL_FORMULA,
    load: {
      baselineMs: bMs,
      chaosMs: cMs,
      neverFinished: cMs === null,
      deltaMs: bMs !== null && cMs !== null ? Math.round(cMs - bMs) : null,
      factor: bMs !== null && cMs !== null && bMs > 0 ? Math.round((cMs / bMs) * 10) / 10 : null,
    },
    counts: {
      total: chaos.requests.length,
      passed: count("passed"),
      delayed: count("delayed"),
      failed: count("failed"),
      aborted: count("aborted"),
      notRequested: lost.filter((l) => l.cause === "not_requested").length,
      baselineTotal: baseline.requests.length,
    },
    criticalFailures,
    affectedFeatures,
    newPageErrors: chaos.pageErrors.filter((e) => !baselineErrors.has(e)),
  };
}
