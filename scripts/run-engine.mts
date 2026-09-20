// Phase 1 harness: run the engine against a URL, print the raw JSON result.
//   npx tsx scripts/run-engine.mts <url> [preset | --latency 300 --loss 10 ...] [--seed abc]
// Screenshots are written next to the JSON in ./out and replaced by file names
// in the printed JSON (base64 images would drown the output).
import fs from "node:fs";
import path from "node:path";
import { runExperiment } from "../lib/chaos/engine";
import { PRESETS } from "../lib/chaos/config";
import type { ChaosConfig, ChaosPresetName } from "../lib/chaos/types";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--") && !(a in PRESETS) && !/^\d+$/.test(a) && a !== flagValueOf("seed"));
const preset = args.find((a) => a in PRESETS) as ChaosPresetName | undefined;

function flagValueOf(name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
if (!url) {
  console.error(
    "usage: run-engine <url> [3g|terrible_wifi|api_outage|third_party_apocalypse|everything_is_slow] " +
      "[--latency ms] [--loss %] [--bandwidth kbps] [--api %] [--image %] [--js %] [--third-party-only] [--seed s]",
  );
  process.exit(2);
}

const config: Partial<ChaosConfig> = { ...(preset ? PRESETS[preset].config : {}) };
for (const [key, cli] of [
  ["latencyMs", "latency"],
  ["packetLossPct", "loss"],
  ["bandwidthKbps", "bandwidth"],
  ["apiFailurePct", "api"],
  ["imageFailurePct", "image"],
  ["jsFailurePct", "js"],
] as const) {
  const v = flagValueOf(cli);
  if (v !== undefined) config[key] = Number(v);
}
if (args.includes("--third-party-only")) config.thirdPartyOnly = true;

const t0 = Date.now();
const secs = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const streamed = { baseline: 0, chaos: 0 };
const result = await runExperiment({
  url,
  config,
  seed: flagValueOf("seed"),
  onEvent: (e) => {
    if (e.type === "phase") console.error(`${secs()} phase: ${e.phase}`);
    else streamed[e.pass]++;
  },
});
console.error(`${secs()} streamed ${streamed.baseline} baseline + ${streamed.chaos} chaos request events`);

fs.mkdirSync("out", { recursive: true });
const slug = new URL(result.url).hostname.replace(/[^a-z0-9]+/gi, "-");
const stem = `${slug}-${preset ?? "custom"}-${result.seed}`;
const printable = structuredClone(result);
for (const pass of ["baseline", "chaos"] as const) {
  const shot = result[pass].screenshot;
  if (shot) {
    const file = path.join("out", `${stem}-${pass}.jpg`);
    fs.writeFileSync(file, Buffer.from(shot, "base64"));
    printable[pass].screenshot = `${file} (${Math.round((shot.length * 3) / 4 / 1024)} KB jpeg)`;
  }
}
const jsonPath = path.join("out", `${stem}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(printable, null, 2));
console.error(`wrote ${jsonPath}`);
console.log(JSON.stringify(printable, null, 2));
