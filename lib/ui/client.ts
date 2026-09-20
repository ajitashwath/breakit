import type { RunError, RunRequest, RunResponse } from "../api";

export class RunFailed extends Error {}

/** POST /api/run. Aborting `signal` makes the server close its browser. */
export async function runOnServer(req: RunRequest, signal?: AbortSignal): Promise<RunResponse> {
  let res: Response;
  try {
    res = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new RunFailed("Couldn't reach the breakit server. Is it still running?");
  }
  const body = (await res.json().catch(() => null)) as RunResponse | RunError | null;
  if (!res.ok || !body || "error" in body) {
    throw new RunFailed(body && "error" in body ? body.error : `The server answered ${res.status}.`);
  }
  return body;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${+(ms / 1000).toFixed(1)} s`;
}

/** Download the experiment as JSON: config, seed, report and the full request log. */
export function exportExperiment(data: RunResponse) {
  const { result, report } = data;
  const strip = (p: typeof result.baseline) => ({ ...p, screenshot: p.screenshot ? "omitted" : null });
  const payload = {
    exportedBy: "breakit",
    exportedAt: new Date().toISOString(),
    url: result.url,
    seed: result.seed,
    config: result.config,
    report,
    result: { ...result, baseline: strip(result.baseline), chaos: strip(result.chaos) },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `breakit-${new URL(result.url).hostname}-${result.seed}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
