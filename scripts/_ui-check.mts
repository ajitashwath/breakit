// Scratch: drives the real UI in a full-frame-rate Chromium to check glide, Export and Cancel.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const count = () =>
  Number(
    execFileSync("powershell", ["-NoProfile", "-Command",
      "(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*breakit-cache*pw*' }).Count"],
    ).toString().trim() || 0,
  );

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
await page.goto("http://localhost:3000");
await page.fill("input[aria-label='Website URL']", "news.ycombinator.com");
await page.waitForSelector(".reveal[data-open='true']");
await page.waitForTimeout(1200);

// ---- 1. glide -------------------------------------------------------------
await page.evaluate(`(() => {
  window.__s = [];
  const lat = document.querySelectorAll("input[type=range]")[0];
  const out = document.querySelectorAll("output")[0];
  const tick = () => { window.__s.push([performance.now(), lat.value, out.textContent || ""]); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})()`);
await page.getByRole("button", { name: "Everything is slow" }).click();
await page.waitForTimeout(900);
const samples = (await page.evaluate("window.__s")) as [number, string, string][];
const vals = samples.map((s) => Number(s[1]));
const distinct = [...new Set(vals.map((v) => Math.round(v * 10) / 10))];
const mid = distinct.filter((v) => v > 0 && v < 40);
const mono = vals.every((v, i) => i === 0 || v >= vals[i - 1]);
const labels = [...new Set(samples.map((s) => s[2]))];
console.log(`glide: ${samples.length} frames, ${mid.length} intermediate positions between 0 and 40, monotonic=${mono}, ends at ${vals.at(-1)}`);
console.log(`       labels rolled through: ${labels.join(" -> ")}`);

// ---- 2. run + Export JSON --------------------------------------------------
await page.getByRole("button", { name: "Break it" }).click();
await page.getByText("survived").waitFor({ timeout: 90_000 });
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "Export JSON" }).click(),
]);
const file = `E:/.breakit-cache/${download.suggestedFilename()}`;
await download.saveAs(file);
const exp = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(`export: ${download.suggestedFilename()} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
console.log(`        keys: ${Object.keys(exp).join(", ")}`);
console.log(`        seed=${exp.seed} config.latencyMs=${exp.config.latencyMs} survival=${exp.report.survivalPct} requests(chaos)=${exp.result.chaos.requests.length} screenshots=${exp.result.chaos.screenshot}`);

// ---- 3. Cancel -------------------------------------------------------------
await page.getByRole("button", { name: "New test" }).click();
await page.waitForSelector("input[aria-label='Website URL']");
await page.waitForTimeout(500);
const idle = count();
await page.getByRole("button", { name: "Break it" }).click();
await page.getByText("Breaking").waitFor();
await page.waitForTimeout(3000);
const running = count();
await page.getByRole("button", { name: "Cancel" }).click();
await page.waitForSelector("input[aria-label='Website URL']");
const backToConfig = await page.getByRole("button", { name: "Break it" }).isVisible();
await page.waitForTimeout(6000);
const after = count();
console.log(`cancel: chromium processes idle=${idle}, while running=${running}, 6s after Cancel=${after}; back on config screen=${backToConfig}`);

await browser.close();
