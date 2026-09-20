// Proves each chaos rule against a fixture site with known contents.
//   npx tsx scripts/verify-engine.ts
import assert from "node:assert/strict";
import { runExperiment } from "../lib/chaos/engine";
import type { ChaosConfig, ExperimentResult, RequestRecord } from "../lib/chaos/types";
import { API_CALLS, BIG_CSS_BYTES, startFixture } from "./fixture-server";

const fixture = await startFixture();
let failures = 0;

async function scenario(
  name: string,
  config: Partial<ChaosConfig>,
  check: (r: ExperimentResult) => void,
  seed = "verify",
) {
  const t = Date.now();
  try {
    const r = await runExperiment({ url: fixture.url, config, seed, settleMs: 3000 });
    check(r);
    console.log(`  ok    ${name}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${(err as Error).message.split("\n").join("\n        ")}`);
  }
}

const by = (rs: RequestRecord[], type: string) => rs.filter((r) => r.resourceType === type);
const aborted = (rs: RequestRecord[]) => rs.filter((r) => r.outcome === "aborted");

console.log(`fixture: ${fixture.url}\n`);

await scenario("baseline is clean", {}, (r) => {
  const rs = r.baseline.requests;
  const kinds = new Set(rs.map((x) => x.resourceType));
  assert.ok(rs.length >= 20, `expected >=20 requests, saw ${rs.length}`);
  for (const k of ["document", "stylesheet", "image", "script", "fetch"]) {
    assert.ok(kinds.has(k), `no ${k} request recorded (saw ${[...kinds]})`);
  }
  assert.ok(rs.every((x) => x.outcome === "passed" && x.rule === null), "baseline had chaos");
  assert.equal(by(rs, "fetch").length, API_CALLS);
  assert.ok(r.baseline.loadTimeMs !== null && r.baseline.screenshot, "no load time / screenshot");
  console.log(`        baseline: ${rs.length} requests, load ${r.baseline.loadTimeMs}ms`);
});

await scenario("latency 400ms delays every request", { latencyMs: 400 }, (r) => {
  const rs = r.chaos.requests;
  assert.ok(rs.every((x) => x.outcome === "delayed" && x.injectedDelayMs === 400));
  assert.ok(rs.every((x) => x.durationMs! >= 395), "a request finished faster than the injected delay");
  assert.ok(r.chaos.loadTimeMs! >= r.baseline.loadTimeMs! + 400, "load time did not grow by >=400ms");
  console.log(`        load ${r.baseline.loadTimeMs}ms -> ${r.chaos.loadTimeMs}ms`);
});

await scenario("packet loss 100% aborts everything except the protected document", { packetLossPct: 100 }, (r) => {
  const rs = r.chaos.requests;
  const doc = rs.find((x) => x.resourceType === "document")!;
  assert.equal(doc.outcome, "passed", "document should be protected");
  const others = rs.filter((x) => x.id !== doc.id);
  assert.ok(others.length >= 20);
  assert.ok(others.every((x) => x.outcome === "aborted" && x.rule === "packet_loss"));
});

await scenario("packet loss can hit the document when unprotected", { packetLossPct: 100, protectDocument: false }, (r) => {
  assert.ok(r.chaos.navigationError, "expected navigation to fail");
  assert.equal(r.chaos.loadTimeMs, null);
});

await scenario("image failure 100% only touches images", { imageFailurePct: 100 }, (r) => {
  const rs = r.chaos.requests;
  const imgs = by(rs, "image");
  assert.ok(imgs.length >= 7);
  assert.ok(imgs.every((x) => x.outcome === "aborted" && x.rule === "image_failure"));
  assert.equal(aborted(rs).length, imgs.length, "non-image requests were aborted");
});

await scenario("js failure 100% only touches scripts", { jsFailurePct: 100 }, (r) => {
  const rs = r.chaos.requests;
  const js = by(rs, "script");
  assert.ok(js.length >= 5);
  assert.ok(js.every((x) => x.outcome === "aborted" && x.rule === "js_failure"));
  assert.equal(aborted(rs).length, js.length);
});

await scenario("api failure 100% fails every API call, both ways", { apiFailurePct: 100 }, (r) => {
  const api = by(r.chaos.requests, "fetch");
  assert.equal(api.length, API_CALLS);
  assert.ok(api.every((x) => x.rule === "api_failure" && (x.outcome === "aborted" || x.outcome === "failed")));
  const http = api.filter((x) => x.outcome === "failed" && (x.status === 500 || x.status === 503));
  const dead = api.filter((x) => x.outcome === "aborted");
  assert.ok(http.length > 0 && dead.length > 0, `want a mix of 5xx and aborts, got ${http.length}/${dead.length}`);
  assert.ok(r.chaos.requests.filter((x) => x.resourceType !== "fetch").every((x) => x.outcome === "passed"));
  console.log(`        ${http.length} returned 5xx, ${dead.length} connection aborts`);
});

await scenario("third-party-only scope spares first-party requests", { jsFailurePct: 100, imageFailurePct: 100, thirdPartyOnly: true }, (r) => {
  const rs = r.chaos.requests;
  const hit = aborted(rs);
  assert.ok(hit.length >= 2, "expected the third-party img + script to fail");
  assert.ok(hit.every((x) => x.thirdParty), "a first-party request was aborted");
  assert.ok(rs.filter((x) => !x.thirdParty && (x.resourceType === "image" || x.resourceType === "script")).every((x) => x.outcome === "passed"));
});

await scenario("bandwidth 400 kbps really slows the transfer (CDP, no route)", { bandwidthKbps: 400 }, (r) => {
  const css = r.chaos.requests.find((x) => x.url.endsWith("/big.css"))!;
  const base = r.baseline.requests.find((x) => x.url.endsWith("/big.css"))!;
  const expectMs = ((BIG_CSS_BYTES * 8) / 400_000) * 1000; // ~6000ms
  const kbps = ((css.bytes ?? 0) * 8) / (css.durationMs! / 1000) / 1000;
  console.log(`        big.css: ${base.durationMs}ms -> ${css.durationMs}ms (cap alone predicts ~${expectMs}ms), ~${kbps.toFixed(0)} kbps effective`);
  assert.ok(css.durationMs! > expectMs * 0.6, `throttle not applied: css took only ${css.durationMs}ms`);
  assert.ok(r.chaos.loadTimeMs! > 3 * r.baseline.loadTimeMs!, "page load barely changed");
  assert.ok(r.chaos.requests.every((x) => x.injectedDelayMs === 0), "bandwidth-only run should not use the route handler");
});

await scenario("bandwidth throttle still works when page.route is also active", { bandwidthKbps: 400, latencyMs: 100 }, (r) => {
  const css = r.chaos.requests.find((x) => x.url.endsWith("/big.css"))!;
  const expectMs = ((BIG_CSS_BYTES * 8) / 400_000) * 1000;
  console.log(`        big.css took ${css.durationMs}ms with route+CDP together (cap alone predicts ~${expectMs}ms)`);
  assert.ok(css.durationMs! > expectMs * 0.6, `throttle lost when routing: css took ${css.durationMs}ms`);
});

{
  const cfg = { packetLossPct: 40 };
  const set = async (seed: string) => {
    const r = await runExperiment({ url: fixture.url, config: cfg, seed, settleMs: 3000 });
    return aborted(r.chaos.requests).map((x) => x.url).sort();
  };
  const [a1, a2, b] = [await set("alpha"), await set("alpha"), await set("beta")];
  try {
    assert.deepEqual(a1, a2, "same seed produced different failures");
    assert.notDeepEqual(a1, b, "different seeds produced identical failures");
    assert.ok(a1.length > 0 && a1.length < 24, "expected a partial failure set");
    console.log(`  ok    seeded replay: seed "alpha" aborted ${a1.length} URLs twice, identically; "beta" aborted ${b.length}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  seeded replay\n        ${(err as Error).message}`);
  }
}

await scenario("initiators are captured", {}, (r) => {
  const rs = r.baseline.requests;
  const img = rs.find((x) => x.resourceType === "image")!;
  const api = rs.find((x) => x.resourceType === "fetch")!;
  assert.equal(img.initiator?.type, "parser");
  assert.equal(api.initiator?.type, "script");
  console.log(`        img <- ${img.initiator?.type}:${img.initiator?.url}\n        api <- ${api.initiator?.type}:${api.initiator?.url}`);
});

await fixture.close();
console.log(failures === 0 ? "\nall scenarios passed" : `\n${failures} scenario(s) failed`);
process.exit(failures === 0 ? 0 : 1);
