// Pins down the survival formula and the report's edge cases, then runs it on
// any real experiment JSON found in ./out.
//   npx tsx scripts/verify-report.mts [path/to/experiment.json]
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildReport } from "../lib/chaos/report";
import { NO_CHAOS } from "../lib/chaos/config";
import type { ExperimentResult, PassResult, RequestRecord } from "../lib/chaos/types";

let n = 0;
const rec = (o: Partial<RequestRecord> & { url: string }): RequestRecord => ({
  id: n++, method: "GET", resourceType: "image", startedAt: 0, durationMs: 10, status: 200,
  outcome: "passed", rule: null, injectedDelayMs: 0, ttfbMs: 5, downloadMs: 5, bytes: 100,
  error: null, initiator: null, thirdParty: false, ...o,
});
const dead = (o: Partial<RequestRecord> & { url: string }) =>
  rec({ status: null, outcome: "aborted", rule: "packet_loss", error: "net::ERR_FAILED", ...o });

const pass = (label: "baseline" | "chaos", requests: RequestRecord[], extra: Partial<PassResult> = {}): PassResult => ({
  label, loadTimeMs: 1000, domContentLoadedMs: 900, timedOut: false, navigationError: null,
  settled: true, screenshot: null, pageTitle: "t", pageErrors: [], requests, totalMs: 1500, ...extra,
});
const exp = (b: RequestRecord[], c: RequestRecord[], cx: Partial<PassResult> = {}): ExperimentResult => ({
  version: 1, url: "https://site.test/", finalUrl: "https://site.test/", startedAt: "", seed: "s",
  config: NO_CHAOS, baseline: pass("baseline", b), chaos: pass("chaos", c, cx),
});

const H = "https://site.test";
const doc = (o: Partial<RequestRecord> = {}) => rec({ url: `${H}/`, resourceType: "document", ...o });
const img = (i: number, o: Partial<RequestRecord> = {}) => rec({ url: `${H}/i${i}.png`, ...o });
const imgs = (count: number) => Array.from({ length: count }, (_, i) => img(i));

const cases: [string, () => void][] = [
  ["identical passes -> 100%, nothing lost", () => {
    const r = buildReport(exp([doc(), ...imgs(5)], [doc(), ...imgs(5)]));
    assert.equal(r.survivalPct, 100);
    assert.equal(r.criticalFailures.length, 0);
  }],
  ["weights: 1 of 10 images lost, with a doc(5) and script(4) => 18/19 = 95%", () => {
    const script = () => rec({ url: `${H}/app.js`, resourceType: "script" });
    const c = [doc(), script(), ...imgs(10).map((x, i) => (i === 0 ? dead({ url: x.url }) : x))];
    assert.equal(buildReport(exp([doc(), script(), ...imgs(10)], c)).survivalPct, 95);
  }],
  ["never shows 100% if anything was lost", () => {
    const b = [doc(), ...imgs(2000)];
    const c = [doc(), dead({ url: `${H}/i0.png` }), ...imgs(2000).slice(1)];
    assert.equal(buildReport(exp(b, c)).survivalPct, 99);
  }],
  ["never shows 0% if anything survived", () => {
    const b = [doc(), ...imgs(2000).map((x) => rec({ url: x.url, resourceType: "script" }))];
    const c = [doc(), ...b.slice(1).map((x) => dead({ url: x.url, resourceType: "script" }))];
    // doc survives (5) of 5 + 2000*4 => 0.06% -> rounds to 0 -> clamped to 1
    assert.equal(buildReport(exp(b, c)).survivalPct, 1);
  }],
  ["a request chaos never made counts as lost (not_requested)", () => {
    const r = buildReport(exp([doc(), img(1), img(2)], [doc(), img(1)]));
    assert.equal(r.survivalPct, 86); // doc(5) + one image(1) survive, of 5+1+1 => 6/7
    assert.equal(r.counts.notRequested, 1);
  }],
  ["requests that already failed in baseline are not charged to chaos", () => {
    const broken = rec({ url: `${H}/404.png`, status: 404, outcome: "failed" });
    const r = buildReport(exp([doc(), img(1), broken], [doc(), img(1), dead({ url: broken.url })]));
    assert.equal(r.survivalPct, 100);
  }],
  ["duplicate URLs match in order", () => {
    const a = () => rec({ url: `${H}/api/x`, resourceType: "fetch" });
    const r = buildReport(exp([doc(), a(), a()], [doc(), a(), dead({ url: `${H}/api/x`, resourceType: "fetch" })]));
    assert.equal(r.counts.aborted, 1);
    assert.equal(r.criticalFailures.length, 1);
  }],
  ["critical failures: api, checkout path, first-party script yes; third-party script and image no", () => {
    const b = [
      doc(),
      rec({ url: `${H}/api/user`, resourceType: "fetch" }),
      rec({ url: `${H}/checkout/pay.js`, resourceType: "script" }),
      rec({ url: `${H}/app.js`, resourceType: "script" }),
      rec({ url: "https://ads.other.io/t.js", resourceType: "script", thirdParty: true }),
      img(1),
    ];
    const c = [doc(), ...b.slice(1).map((x) => dead({ url: x.url, resourceType: x.resourceType, thirdParty: x.thirdParty }))];
    const r = buildReport(exp(b, c));
    const reasons = Object.fromEntries(r.criticalFailures.map((f) => [f.path, f.reason]));
    assert.deepEqual(reasons, { "/api/user": "api", "/checkout/pay.js": "critical path", "/app.js": "app code" });
    assert.ok(r.affectedFeatures.some((f) => f.name === "Checkout & payments"));
    assert.ok(r.affectedFeatures.some((f) => f.name === "Analytics & ads"));
  }],
  ["document lost => 0%, load never finished", () => {
    const r = buildReport(exp([doc(), img(1)], [dead({ url: `${H}/`, resourceType: "document" })], { loadTimeMs: null, timedOut: true }));
    assert.equal(r.survivalPct, 0);
    assert.equal(r.load.neverFinished, true);
    assert.equal(r.load.factor, null);
  }],
  ["load comparison and new page errors", () => {
    const e = exp([doc()], [doc()], { loadTimeMs: 4200, pageErrors: ["boom", "old"] });
    e.baseline.pageErrors = ["old"];
    const r = buildReport(e);
    assert.equal(r.load.factor, 4.2);
    assert.equal(r.load.deltaMs, 3200);
    assert.deepEqual(r.newPageErrors, ["boom"]);
  }],
];

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${(err as Error).message.split("\n")[0]}`); }
}

// ---- real data ----------------------------------------------------------
const file = process.argv[2] ?? fs.readdirSync("out").filter((f) => f.endsWith(".json")).map((f) => `out/${f}`)[0];
if (file) {
  const real = JSON.parse(fs.readFileSync(file, "utf8")) as ExperimentResult;
  const r = buildReport(real);
  console.log(`\nreal experiment: ${file}`);
  console.log(JSON.stringify({ ...r, survivalFormula: "…", criticalFailures: r.criticalFailures.slice(0, 3) }, null, 2));
}
process.exit(failed ? 1 : 0);
