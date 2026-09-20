"use client";

import { useEffect, useState } from "react";
import { NO_CHAOS, PRESETS, randomConfig } from "@/lib/chaos/config";
import { PRESET_NAMES, type ChaosConfig, type ChaosPresetName } from "@/lib/chaos/types";
import { looksLikeTarget } from "@/lib/chaos/url";
import { SLIDERS, sameSettings } from "@/lib/ui/scales";
import { ChaosSlider } from "./ChaosSlider";
import { PresetBar } from "./PresetBar";
import { UrlField } from "./UrlField";

/**
 * Layout: a single centred column. At first load it holds one element, the URL
 * field. Once the URL looks real, the controls unfold beneath it and the whole
 * block re-centres, so the field glides up rather than jumping.
 *
 * Reading order inside the reveal: presets (the fast path) → six sliders (fine
 * tuning; Network and Failures separated by whitespace, no headings) → the button.
 */
export function Playground() {
  const [url, setUrl] = useState("");
  const [config, setConfig] = useState<ChaosConfig>(NO_CHAOS);
  const [revealed, setRevealed] = useState(false);

  const valid = looksLikeTarget(url);

  // Reveal shortly after the URL becomes plausible; collapse only when cleared,
  // so editing the address never makes the controls flicker away.
  useEffect(() => {
    if (revealed || !valid) return;
    const t = setTimeout(() => setRevealed(true), 320);
    return () => clearTimeout(t);
  }, [valid, revealed]);

  const onUrlChange = (next: string) => {
    setUrl(next);
    if (next.trim() === "") setRevealed(false);
  };

  const active: ChaosPresetName | null =
    PRESET_NAMES.find((n) => sameSettings(PRESETS[n].config, config)) ?? null;

  const setSlider = (key: (typeof SLIDERS)[number]["key"], value: number) =>
    setConfig((c) => ({ ...c, [key]: value }));

  const onBreak = () => {
    // Wiring comes next; for now just show what would run.
    console.info("[breakit] would run", { url, config });
  };

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-6 py-24">
      <span className="fade-in absolute left-8 top-7 font-medium text-ink-2 sm:left-10 sm:top-9">
        breakit
      </span>

      <div className="fade-in w-full max-w-[720px]">
        <UrlField
          value={url}
          onChange={onUrlChange}
          onSubmit={() => valid && setRevealed(true)}
        />

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
              <div className="sm:-mx-16">
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
                    <ChaosSlider
                      spec={spec}
                      value={config[spec.key]}
                      onChange={(v) => setSlider(spec.key, v)}
                    />
                  </div>
                ))}
              </div>

              <div className="mt-10 flex justify-center pb-2">
                <button type="button" className="break-btn" disabled={!valid} onClick={onBreak}>
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
