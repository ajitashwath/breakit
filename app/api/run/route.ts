import { EngineError, ON_VERCEL, runExperiment } from "@/lib/chaos/engine";
import { buildReport } from "@/lib/chaos/report";
import { normalizeTargetUrl } from "@/lib/chaos/url";
import type { RunError, RunRequest, RunResponse } from "@/lib/api";

// Playwright needs a long-lived Node process, not the edge runtime.
export const runtime = "nodejs";

// A run is warm-up + baseline + chaos, each a real page load. 60 s is the most
// every Vercel plan allows; raise it (up to 300) on plans that do.
export const maxDuration = 60;

// On Vercel the whole run must fit in maxDuration (cold start ~5 s, then three
// passes), so each pass gets a tight budget. A page that can't load inside it
// under chaos is reported as "never finished", which is a real answer.
const BUDGET = ON_VERCEL ? { timeoutMs: 14_000, settleMs: 3_000 } : {};

// Each run owns a whole Chromium. Refuse to pile them up.
const MAX_CONCURRENT = 2;
let active = 0;

const fail = (error: string, status: number) => Response.json({ error } satisfies RunError, { status });

/**
 * Runs one experiment synchronously and returns the result plus its report.
 *
 * Security note: this fetches whatever URL it is given, from this machine.
 * That is what a local chaos tool is for (testing localhost, staging), but
 * exposing this route to the public internet would make it an SSRF proxy.
 */
export async function POST(request: Request) {
  let body: RunRequest;
  try {
    body = await request.json();
  } catch {
    return fail("Request body must be JSON.", 400);
  }
  if (typeof body.url !== "string" || body.url.trim() === "") return fail("Enter a URL to test.", 400);
  if (body.seed !== undefined && !/^[\w-]{1,64}$/.test(body.seed)) return fail("Invalid seed.", 400);

  let url: string;
  try {
    url = normalizeTargetUrl(body.url);
  } catch (err) {
    return fail((err as Error).message, 400);
  }

  if (active >= MAX_CONCURRENT) return fail("Too many experiments are running. Try again in a moment.", 429);
  active++;
  try {
    const result = await runExperiment({
      url,
      config: body.config ?? {},
      seed: body.seed,
      ...BUDGET,
      // If the client goes away, close the browser instead of finishing a run nobody will read.
      signal: request.signal,
    });
    return Response.json({ result, report: buildReport(result) } satisfies RunResponse);
  } catch (err) {
    if (err instanceof EngineError) return fail(err.message, 422);
    console.error("[breakit] run failed", err);
    return fail("The experiment crashed. Check the server log.", 500);
  } finally {
    active--;
  }
}
