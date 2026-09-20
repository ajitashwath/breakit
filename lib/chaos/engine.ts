import { chromium, type Browser, type Request as PwRequest } from "playwright";
import { NO_CHAOS, normalizeConfig } from "./config";
import { chance, newSeed, roll } from "./rng";
import { isNetworkUrl, isThirdParty, normalizeTargetUrl } from "./url";
import type {
  ChaosConfig,
  ChaosRule,
  EngineEvent,
  ExperimentResult,
  PassResult,
  RequestInitiator,
  RequestOutcome,
  RequestRecord,
} from "./types";

export interface RunOptions {
  url: string;
  config: Partial<ChaosConfig>;
  /** Reuse a seed to replay the exact same failures. Generated if omitted. */
  seed?: string;
  viewport?: { width: number; height: number };
  /** Navigation timeout per pass. Default 60s. */
  timeoutMs?: number;
  /** How long to wait for the network to go idle after `load`. Default 8s. */
  settleMs?: number;
  /**
   * Load the page once, unrecorded, before the baseline. Default true. Without
   * it the baseline pays for cold DNS/TLS and the chaos pass gets them free,
   * which can make "chaos" load faster than "no chaos".
   */
  warmup?: boolean;
  onEvent?: (e: EngineEvent) => void;
  /** Aborting closes the browser and rejects the run. */
  signal?: AbortSignal;
}

interface PassOptions {
  label: "baseline" | "chaos";
  url: string;
  config: ChaosConfig;
  seed: string;
  viewport: { width: number; height: number };
  timeoutMs: number;
  settleMs: number;
  /** Throwaway pass: no screenshot, no events. */
  warm?: boolean;
  onEvent?: (e: EngineEvent) => void;
}

export class EngineError extends Error {}

/**
 * One experiment = one browser, two isolated contexts (baseline, then chaos).
 *
 * Two contexts rather than one because a shared context would let the baseline
 * warm the HTTP cache and make the chaos pass look faster than it is. Every
 * context is closed in `finally`, and so is the browser, so a failed run never
 * leaks a Chromium process.
 */
export async function runExperiment(opts: RunOptions): Promise<ExperimentResult> {
  const url = normalizeTargetUrl(opts.url);
  const config = normalizeConfig(opts.config);
  const seed = opts.seed ?? newSeed();
  const startedAt = new Date().toISOString();
  const shared = {
    url,
    seed,
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    timeoutMs: opts.timeoutMs ?? 60_000,
    settleMs: opts.settleMs ?? 8_000,
    onEvent: opts.onEvent,
  };

  const browser = await launch();
  const onAbort = () => void browser.close().catch(() => {});
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (opts.warmup !== false) {
      emit(opts.onEvent, { type: "phase", phase: "warmup" });
      await runPass(browser, {
        ...shared,
        label: "baseline",
        config: NO_CHAOS,
        settleMs: 1_500,
        warm: true,
        onEvent: undefined,
      });
    }

    emit(opts.onEvent, { type: "phase", phase: "baseline" });
    const baseline = await runPass(browser, { ...shared, label: "baseline", config: NO_CHAOS });
    if (baseline.result.navigationError) {
      throw new EngineError(
        `Could not load ${url} even without chaos: ${baseline.result.navigationError}`,
      );
    }

    emit(opts.onEvent, { type: "phase", phase: "chaos" });
    const chaos = await runPass(browser, { ...shared, label: "chaos", config });

    emit(opts.onEvent, { type: "phase", phase: "done" });
    return {
      version: 1,
      url,
      finalUrl: baseline.finalUrl,
      startedAt,
      config,
      seed,
      baseline: baseline.result,
      chaos: chaos.result,
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    await browser.close().catch(() => {});
  }
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|browserType\.launch/.test(msg)) {
      throw new EngineError(
        "Chromium is not installed for Playwright. Run: npx playwright install chromium",
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

/** A request record plus the bookkeeping we don't ship in the report. */
interface Draft extends RequestRecord {
  injected: "abort" | "http" | null;
  endAt: number | null;
  /** When response headers arrived; the fallback end time for unfinished bodies. */
  respondedAt: number | null;
  finalized: boolean;
}

async function runPass(
  browser: Browser,
  o: PassOptions,
): Promise<{ result: PassResult; finalUrl: string | null }> {
  const { config: cfg, seed } = o;
  const passStart = performance.now();
  const now = () => performance.now() - passStart;
  const round = (n: number) => Math.round(n * 10) / 10;

  // Normal-looking UA: headless Chromium announces itself as "HeadlessChrome",
  // which some sites answer differently and would pollute the comparison.
  const chromeVersion = browser.version();
  const context = await browser.newContext({
    viewport: o.viewport,
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    // A service worker can answer requests without touching the network, which
    // would bypass both page.route() and bandwidth emulation.
    serviceWorkers: "block",
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
  });
  const sleeper = new Sleeper();

  try {
    const page = await context.newPage();
    const drafts = new Map<PwRequest, Draft>();
    const seenKeys = new Map<string, number>();
    const pendingWork = new Set<Promise<unknown>>();
    const pageErrors: string[] = [];
    const initiatorsByUrl = new Map<string, RequestInitiator[]>();
    let seq = 0;

    const draftFor = (req: PwRequest): Draft | null => {
      const url = req.url();
      if (!isNetworkUrl(url)) return null; // data:, blob:, chrome-extension: …
      let d = drafts.get(req);
      if (!d) {
        d = {
          id: seq++,
          url,
          method: req.method(),
          resourceType: req.resourceType(),
          startedAt: round(now()),
          durationMs: null,
          status: null,
          outcome: "passed",
          rule: null,
          injectedDelayMs: 0,
          ttfbMs: null,
          downloadMs: null,
          bytes: null,
          error: null,
          initiator: null,
          thirdParty: isThirdParty(url, o.url),
          injected: null,
          endAt: null,
          respondedAt: null,
          finalized: false,
        };
        drafts.set(req, d);
      }
      return d;
    };

    const finalize = (d: Draft) => {
      if (d.finalized) return;
      d.finalized = true;
      if (d.injected === "http" && d.status === null) d.status = 500;
      d.outcome = outcomeOf(d);
      if (d.endAt !== null) d.durationMs = round(d.endAt - d.startedAt);
      emit(o.onEvent, { type: "request", pass: o.label, record: toRecord(d) });
    };

    page.on("request", (req) => void draftFor(req));
    page.on("response", (res) => {
      const d = draftFor(res.request());
      if (!d) return;
      d.status = res.status();
      d.respondedAt = now();
    });
    page.on("requestfinished", (req) => {
      const d = draftFor(req);
      if (!d) return;
      d.endAt = now();
      const work = (async () => {
        try {
          d.bytes = (await req.sizes()).responseBodySize;
          const t = req.timing();
          if (t.responseStart >= 0) d.ttfbMs = round(t.responseStart);
          if (t.responseStart >= 0 && t.responseEnd >= 0) {
            d.downloadMs = round(t.responseEnd - t.responseStart);
          }
        } catch {
          // Sizes are unavailable for some request kinds; not worth failing over.
        }
        finalize(d);
      })();
      pendingWork.add(work);
      void work.finally(() => pendingWork.delete(work));
    });
    page.on("requestfailed", (req) => {
      const d = draftFor(req);
      if (!d) return;
      d.endAt = now();
      d.error = req.failure()?.errorText ?? "request failed";
      finalize(d);
    });
    page.on("pageerror", (err) => {
      if (pageErrors.length < 50) pageErrors.push(String(err.message).split("\n")[0].slice(0, 300));
    });

    // --- CDP: initiator capture + bandwidth --------------------------------
    // Playwright's public API doesn't expose who triggered a request; CDP does.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (e) => {
      if (e.initiator.type === "preflight") return; // CORS preflights aren't Playwright requests
      const list = initiatorsByUrl.get(e.request.url) ?? [];
      list.push({
        type: e.initiator.type,
        url: e.initiator.url ?? e.initiator.stack?.callFrames?.[0]?.url,
      });
      initiatorsByUrl.set(e.request.url, list);
    });

    if (cfg.bandwidthKbps > 0) {
      // Route-level delays add latency but cannot slow a transfer down. Only
      // the browser's network stack can, so use CDP's emulation.
      const bytesPerSec = (cfg.bandwidthKbps * 1000) / 8;
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0, // latency is injected per request in the route handler
        downloadThroughput: bytesPerSec,
        uploadThroughput: bytesPerSec,
      });
    }

    // --- Per-request chaos --------------------------------------------------
    const needsRoute =
      cfg.latencyMs > 0 ||
      cfg.packetLossPct > 0 ||
      cfg.apiFailurePct > 0 ||
      cfg.imageFailurePct > 0 ||
      cfg.jsFailurePct > 0;

    if (needsRoute) {
      await page.route("**/*", async (route) => {
        const req = route.request();
        const d = draftFor(req);
        if (!d) return safely(() => route.continue());

        // Decisions are keyed on request identity, not arrival order — see rng.ts.
        const base = `${req.method()} ${req.url()}`;
        const nth = seenKeys.get(base) ?? 0;
        seenKeys.set(base, nth + 1);
        const key = `${base}#${nth}`;

        const inScope = !cfg.thirdPartyOnly || d.thirdParty;
        if (!inScope) return safely(() => route.continue());

        const isMainDocument =
          req.isNavigationRequest() && req.frame() === page.mainFrame();
        const canFail = !(cfg.protectDocument && isMainDocument);
        const type = d.resourceType;

        let fail:
          | { rule: ChaosRule; mode: "abort" }
          | { rule: ChaosRule; mode: "http"; status: number }
          | null = null;

        if (canFail) {
          // Specific rules first so a failure is attributed to the most
          // meaningful cause; packet loss is the catch-all.
          if (type === "image" && chance(seed, key, "image", cfg.imageFailurePct)) {
            fail = { rule: "image_failure", mode: "abort" };
          } else if (type === "script" && chance(seed, key, "js", cfg.jsFailurePct)) {
            fail = { rule: "js_failure", mode: "abort" };
          } else if (isApi(req.url(), type, cfg) && chance(seed, key, "api", cfg.apiFailurePct)) {
            // Half of API failures look like a dead connection, half like a
            // sick server. Both happen in the wild and break code differently.
            fail =
              roll(seed, key, "api-mode") < 0.5
                ? { rule: "api_failure", mode: "abort" }
                : {
                    rule: "api_failure",
                    mode: "http",
                    status: roll(seed, key, "api-status") < 0.5 ? 500 : 503,
                  };
          } else if (chance(seed, key, "loss", cfg.packetLossPct)) {
            fail = { rule: "packet_loss", mode: "abort" };
          }
        }

        // Record intent before awaiting anything: page events for this request
        // can fire while we are still inside route.abort()/fulfill().
        d.injectedDelayMs = cfg.latencyMs;
        d.rule = fail?.rule ?? (cfg.latencyMs > 0 ? "latency" : null);
        d.injected = fail?.mode ?? null;

        // Latency comes first, even for requests that will fail: a dead
        // connection also takes time to be declared dead.
        if (cfg.latencyMs > 0) await sleeper.sleep(cfg.latencyMs);

        const f = fail;
        if (!f) return safely(() => route.continue());
        if (f.mode === "abort") return safely(() => route.abort("failed"));
        return safely(() =>
          route.fulfill({
            status: f.status,
            contentType: type === "fetch" || type === "xhr" ? "application/json" : "text/plain",
            body: JSON.stringify({ error: "breakit: injected failure" }),
          }),
        );
      });
    }

    // --- Navigate and capture ----------------------------------------------
    let timedOut = false;
    let navigationError: string | null = null;
    let navigated = false;
    const navStart = performance.now();
    try {
      await page.goto(o.url, { waitUntil: "load", timeout: o.timeoutMs });
      navigated = true;
    } catch (err) {
      timedOut = err instanceof Error && err.name === "TimeoutError";
      navigationError = firstLine(err);
    }
    const nodeLoadMs = performance.now() - navStart;

    let settled = false;
    if (navigated) {
      // "Stable point": the network has gone quiet. Under heavy throttling it
      // never will, so cap the wait and screenshot whatever exists.
      settled = await page
        .waitForLoadState("networkidle", { timeout: o.settleMs })
        .then(() => true)
        .catch(() => false);
    }
    await page.waitForTimeout(400).catch(() => {}); // let the last paint land

    let loadTimeMs: number | null = null;
    let domContentLoadedMs: number | null = null;
    if (navigated) {
      // Browser-side navigation timing is the standard definition of load time.
      const nav = await page
        .evaluate(() => {
          const e = performance.getEntriesByType("navigation")[0] as
            | PerformanceNavigationTiming
            | undefined;
          return e ? { load: e.loadEventEnd, dcl: e.domContentLoadedEventEnd } : null;
        })
        .catch(() => null);
      loadTimeMs = round(nav && nav.load > 0 ? nav.load : nodeLoadMs);
      domContentLoadedMs = nav && nav.dcl > 0 ? round(nav.dcl) : null;
    }

    let screenshot: string | null = null;
    if (!o.warm) {
      try {
        const buf = await page.screenshot({
          type: "jpeg",
          quality: 80,
          animations: "disabled",
          caret: "hide",
          timeout: 15_000,
        });
        screenshot = buf.toString("base64");
      } catch {
        // A page that can't be screenshotted is still a valid (bad) result.
      }
    }

    const pageTitle = await page.title().catch(() => null);
    const finalUrl = page.url() || null;

    // Let in-flight size lookups finish, then close out whatever never ended.
    await Promise.allSettled([...pendingWork]);
    const endOfPass = now();
    for (const d of drafts.values()) {
      if (d.finalized) continue;
      // Chromium never reports a body as finished until the page reads it, so
      // long-lived streams and unread fetch() bodies land here. If headers
      // arrived, the request worked: report time-to-response as its duration.
      const gotResponse = d.status !== null && d.status < 400;
      d.error = gotResponse
        ? "body not finished when the pass ended (duration is time to response)"
        : "no response before the pass ended";
      d.endAt = gotResponse ? (d.respondedAt ?? endOfPass) : endOfPass;
      finalize(d);
    }

    // Attach initiators: the i-th request for a URL gets the i-th CDP entry.
    const ordered = [...drafts.values()].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
    const cursor = new Map<string, number>();
    for (const d of ordered) {
      const i = cursor.get(d.url) ?? 0;
      cursor.set(d.url, i + 1);
      d.initiator = initiatorsByUrl.get(d.url)?.[i] ?? null;
    }

    return {
      finalUrl,
      result: {
        label: o.label,
        loadTimeMs,
        domContentLoadedMs,
        timedOut,
        navigationError,
        settled,
        screenshot,
        pageTitle,
        pageErrors,
        requests: ordered.map(toRecord),
        totalMs: round(now()),
      },
    };
  } finally {
    sleeper.cancelAll();
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isApi(url: string, resourceType: string, cfg: ChaosConfig): boolean {
  return (
    resourceType === "fetch" ||
    resourceType === "xhr" ||
    cfg.apiPatterns.some((p) => p !== "" && url.includes(p))
  );
}

function outcomeOf(d: Draft): RequestOutcome {
  if (d.injected === "abort") return "aborted";
  if (d.error !== null && !(d.status !== null && d.status < 400)) return "failed";
  if (d.status !== null && d.status >= 400) return "failed";
  return d.injectedDelayMs > 0 ? "delayed" : "passed";
}

function toRecord(d: Draft): RequestRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { injected, endAt, respondedAt, finalized, ...record } = d;
  return record;
}

/**
 * Sleeps that can all be cut short at once. One shared canceller per pass,
 * instead of an abort listener per request (dozens run concurrently).
 */
class Sleeper {
  private wakers = new Set<() => void>();
  private cancelled = false;

  sleep(ms: number): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(t);
        this.wakers.delete(wake);
        resolve();
      };
      const t = setTimeout(wake, ms);
      this.wakers.add(wake);
    });
  }

  cancelAll() {
    this.cancelled = true;
    for (const wake of [...this.wakers]) wake();
  }
}

/** route.* throws if the page closed mid-flight; that's expected at teardown. */
async function safely(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    /* page or context already closed */
  }
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

function emit(fn: RunOptions["onEvent"], e: EngineEvent) {
  try {
    fn?.(e);
  } catch {
    // A misbehaving listener must never break the experiment.
  }
}
