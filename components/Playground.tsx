"use client";

import { useEffect, useRef, useState } from "react";
import type { RunResponse } from "@/lib/api";
import { NO_CHAOS, PRESETS, randomConfig } from "@/lib/chaos/config";
import { PRESET_NAMES, type ChaosConfig, type ChaosPresetName } from "@/lib/chaos/types";
import { looksLikeTarget, normalizeTargetUrl } from "@/lib/chaos/url";
import { RunFailed, runOnServer } from "@/lib/ui/client";
import { SLIDERS, sameSettings } from "@/lib/ui/scales";
import { ChaosSlider } from "./ChaosSlider";
import { PresetBar } from "./PresetBar";
import { ReportView } from "./ReportView";
import { RunningView } from "./RunningView";
import { UrlField } from "./UrlField";

type View =
  | { kind: "config" }
  | { kind: "running"; host: string }
  | { kind: "report"; data: RunResponse }
  | { kind: "error"; message: string };

/**
 * Layout: a single centred column. At first load it holds one element, the URL
 * field. Once the URL looks real, the controls unfold beneath it and the whole
 * block re-centres, so the field glides up rather than jumping.
 *
 * Reading order inside the reveal: presets (the fast path) → six sliders (fine
 * tuning; Network and Failures separated by whitespace, no headings) → the button.
 *
 * Break it swaps this whole column for the running view, then the report.
 */
export function Playground() {
  const [url, setUrl] = useState("");
  const [config, setConfig] = useState<ChaosConfig>(NO_CHAOS);
  const [revealed, setRevealed] = useState(false);
  const [view, setView] = useState<View>({ kind: "config" });
  const inFlight = useRef<AbortController | null>(null);

  const valid = looksLikeTarget(url);

  // Reveal shortly after the URL becomes plausible; collapse only when cleared,
  // so editing the address never makes the controls flicker away.
  useEffect(() => {
    if (revealed || !valid) return;
    const t = setTimeout(() => setRevealed(true), 320);
    return () => clearTimeout(t);
  }, [valid, revealed]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const onUrlChange = (next: string) => {
    setUrl(next);
    if (next.trim() === "") setRevealed(false);
  };

  const active: ChaosPresetName | null =
    PRESET_NAMES.find((n) => sameSettings(PRESETS[n].config, config)) ?? null;

  const setSlider = (key: (typeof SLIDERS)[number]["key"], value: number) =>
    setConfig((c) => ({ ...c, [key]: value }));

  /** No seed => a fresh one is rolled server-side. Replay passes the previous seed. */
  const run = async (target: string, cfg: ChaosConfig, seed?: string) => {
    inFlight.current?.abort();
    const ctl = new AbortController();
    inFlight.current = ctl;
    setView({ kind: "running", host: new URL(normalizeTargetUrl(target)).host });
    window.scrollTo({ top: 0 });
    try {
      const data = await runOnServer({ url: target, config: cfg, seed }, ctl.signal);
      if (!ctl.signal.aborted) setView({ kind: "report", data });
    } catch (err) {
      if ((err as Error).name === "AbortError") return; // cancelled: the view was already reset
      setView({ kind: "error", message: err instanceof RunFailed ? err.message : "Something went wrong." });
    }
  };

  const backToConfig = () => {
    inFlight.current?.abort();
    setView({ kind: "config" });
    window.scrollTo({ top: 0 });
  };

  const wordmark = (
    <button
      type="button"
      onClick={backToConfig}
      disabled={view.kind === "config"}
      className="fade-in absolute left-8 top-7 font-medium text-ink-2 transition-colors enabled:hover:text-ink sm:left-10 sm:top-9"
    >
      breakit
    </button>
  );

  if (view.kind === "report") {
    return (
      <main className="relative min-h-dvh">
        {wordmark}
        <ReportView
          data={view.data}
          onReplay={() => run(view.data.result.url, view.data.result.config, view.data.result.seed)}
          onNew={backToConfig}
        />
      </main>
    );
  }

  if (view.kind === "running" || view.kind === "error") {
    return (
      <main className="relative flex min-h-dvh flex-col items-center justify-center px-6 py-24">
        {wordmark}
        {view.kind === "running" ? (
          <RunningView host={view.host} onCancel={backToConfig} />
        ) : (
          <div className="fade-in w-full max-w-[520px] text-center">
            <h1 className="text-[24px] tracking-[-0.025em]">Couldn&rsquo;t break it.</h1>
            <p className="mt-4 text-ink-2" role="alert">
              {view.message}
            </p>
            <button type="button" className="chip mt-8" onClick={backToConfig}>
              Back
            </button>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-6 py-24">
      {wordmark}

      <div className="fade-in w-full max-w-[720px]">
        <UrlField value={url} onChange={onUrlChange} onSubmit={() => valid && setRevealed(true)} />

        {/* Fades out on reveal but keeps its height, becoming the gap above the presets. */}
        <p
          className="mt-6 h-[22px] text-center text-ink-3 transition-opacity duration-500"
          style={{ opacity: revealed ? 0 : 1 }}
          aria-hidden={revealed}
        >
          Enter a website to break.
        </p>

        <div className="reveal" data-open={revealed} inert={!revealed}>
          <div className="reveal-inner">
            <div className="pt-6">
              {/* Wider than the slider column so all six chips share one line. */}
              <div className="lg:-mx-16">
                <PresetBar
                  active={active}
                  onPick={(name) => setConfig(active === name ? NO_CHAOS : PRESETS[name].config)}
                  onRandom={() => setConfig(randomConfig())}
                />
              </div>
              <p className="mt-3 min-h-[22px] text-center text-ink-3" aria-live="polite">
                {active ? (
                  PRESETS[active].description
                ) : config.thirdPartyOnly ? (
                  <>
                    Only third-party requests are affected.{" "}
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => setConfig((c) => ({ ...c, thirdPartyOnly: false }))}
                    >
                      Apply to everything
                    </button>
                  </>
                ) : null}
              </p>

              <div className="mt-6">
                {SLIDERS.map((spec, i) => (
                  <div key={spec.key} className={i === 3 ? "mt-4" : undefined}>
                    <ChaosSlider spec={spec} value={config[spec.key]} onChange={(v) => setSlider(spec.key, v)} />
                  </div>
                ))}
              </div>

              <div className="mt-10 flex justify-center pb-2">
                <button type="button" className="break-btn" disabled={!valid} onClick={() => run(url, config)}>
                  <span className="skull" aria-hidden>
                    💀
                  </span>
                  Break it
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
