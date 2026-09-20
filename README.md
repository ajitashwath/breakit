# breakit

Website chaos engineering. Point it at a URL, turn up the failure, see what survives.

> Status: engine, report generator, config screen, synchronous run API and report view
> work end to end. Not built yet: live WebSocket stream, request waterfall, dependency
> graph, CLI.

## Run the app

```bash
npm install
npx playwright-core install chromium
npm run dev        # http://localhost:3000
```

Type a URL, pick a preset or drag the sliders, hit **Break it**. A run takes 10–30 s
(warm-up, baseline, chaos) and ends in the report. `POST /api/run` is the same thing as JSON.
Machine-specific paths (Playwright browser dir, temp) go in `.env.local`, which is gitignored.

The survival % is a documented heuristic, not a measurement: see `lib/chaos/report.ts`.
`npm run verify:report` pins down its edge cases.

## Try the engine

```bash
npm install
npx playwright-core install chromium

# Prove every rule works against a local fixture site (about 45 s)
npm run verify:engine

# Run against a real site; JSON + before/after screenshots land in ./out
npm run engine -- https://www.apple.com terrible_wifi --seed demo3
npm run engine -- https://example.com --latency 800 --loss 10 --api 50
```

Presets: `3g`, `terrible_wifi`, `api_outage`, `third_party_apocalypse`, `everything_is_slow`.

## How the engine works

`lib/chaos/engine.ts` launches one Chromium and runs three passes in separate contexts:
an unrecorded warm-up (so cold DNS/TLS doesn't pollute the comparison), a baseline, and
the chaos pass. Every context and the browser are closed in `finally`.

| Chaos          | Mechanism                                                                         |
| -------------- | --------------------------------------------------------------------------------- |
| Latency        | `page.route` holds every request for N ms                                         |
| Packet loss    | `route.abort('failed')` at probability p                                          |
| Bandwidth      | CDP `Network.emulateNetworkConditions` (route delays cannot slow a transfer)      |
| API failures   | URL pattern or `fetch`/`xhr` type; half abort, half return 500/503                |
| Image / JS     | resource type `image` / `script`, aborted at probability p                        |

**Determinism.** Each failure decision is `seedrandom(seed + request identity + purpose)`,
not the next value in one shared stream. Browsers issue requests in a different order every
run, so a shared stream would fail different resources on replay. Limit: URLs that embed a
random cache-buster get a different identity each run and can't be replayed exactly.

**Known limits, stated plainly**

- Latency is added *per request* on top of real network time; it is not an RTT model.
- Load time is one sample per pass. Treat small differences as noise.
- The main document is protected from injected failures by default (`protectDocument`).
- "Third party" uses a heuristic registrable-domain check, not the public-suffix list.
