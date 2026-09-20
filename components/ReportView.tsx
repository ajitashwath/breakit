"use client";

import { useEffect, useState } from "react";
import type { RunResponse } from "@/lib/api";
import type { CriticalFailure } from "@/lib/chaos/report";
import { exportExperiment, formatMs } from "@/lib/ui/client";
import { Rise } from "./Rise";

const TOP_FAILURES = 8;

function useCountUp(target: number, ms = 1400) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = setTimeout(() => setValue(target), 0);
      return () => clearTimeout(t);
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      setValue(Math.round(target * (1 - Math.pow(1 - k, 4)))); // easeOutQuart: fast, then settles
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

function cause(f: CriticalFailure) {
  if (f.cause === "not_requested") return { text: "Never requested", hot: false };
  if (f.cause === "aborted") return { text: "Aborted", hot: true };
  return { text: f.status ? `Failed ${f.status}` : "Failed", hot: true };
}

interface Props {
  data: RunResponse;
  onReplay: () => void;
  onNew: () => void;
}

export function ReportView({ data, onReplay, onNew }: Props) {
  const { result, report } = data;
  const [showFormula, setShowFormula] = useState(false);
  const shown = useCountUp(report.survivalPct);
  const host = new URL(result.url).host;
  const failed = report.counts.aborted + report.counts.failed;
  const { load } = report;

  return (
    <div className="w-full">
      {/* ------------------------------------------------------------ headline */}
      <section className="fade-in mx-auto flex min-h-[88dvh] w-full max-w-[860px] flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-ink-3">{host}</p>

        <div
          className="mt-4 font-normal leading-[0.86] tracking-[-0.07em] tabular-nums text-[clamp(120px,24vw,240px)]"
          aria-label={`${report.survivalPct} percent survived`}
        >
          {shown}
          <span className="ml-[0.04em] align-top text-[0.36em] leading-[1.6] tracking-normal text-ink-3">%</span>
        </div>
        <p className="mt-5 text-[24px] tracking-[-0.025em] text-ink-2">survived</p>

        <dl className="mt-16 grid w-full max-w-[640px] grid-cols-1 gap-10 sm:grid-cols-3 sm:gap-6">
          <Fact label="Load time">
            {load.neverFinished ? (
              <span className="text-accent">Never</span>
            ) : (
              <>
                <span className="text-ink-3">{formatMs(load.baselineMs ?? 0)}</span>
                <span className="mx-1.5 text-ink-3">→</span>
                {formatMs(load.chaosMs ?? 0)}
              </>
            )}
          </Fact>
          <Fact label={report.counts.notRequested > 0 ? `Failed · ${report.counts.notRequested} never requested` : "Failed"}>
            <span className={failed > 0 ? "text-accent" : undefined}>{failed}</span>
            <span className="text-ink-3"> of {report.counts.total}</span>
          </Fact>
          <Fact label="Delayed">
            {report.counts.delayed}
            <span className="text-ink-3"> of {report.counts.total}</span>
          </Fact>
        </dl>

        <div className="mt-16 flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
          <button type="button" className="chip" onClick={onReplay}>
            Replay
          </button>
          <button type="button" className="chip" onClick={() => exportExperiment(data)}>
            Export JSON
          </button>
          <button type="button" className="chip" onClick={onNew}>
            New test
          </button>
        </div>

        <div className="mt-8 max-w-[520px] text-ink-3">
          <button type="button" className="text-btn" aria-expanded={showFormula} onClick={() => setShowFormula((v) => !v)}>
            How is this calculated?
          </button>
          {showFormula && <p className="fade-in mt-3">{report.survivalFormula}</p>}
        </div>
      </section>

      {/* ------------------------------------------------------------ evidence */}
      <div className="mx-auto w-full max-w-[1040px] px-6 pb-32">
        <Rise>
          <h2 className="text-[24px] tracking-[-0.025em]">Before and after</h2>
          <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
            <Shot label="Before" src={result.baseline.screenshot} />
            <Shot label="After" src={result.chaos.screenshot} />
          </div>
        </Rise>

        <Rise className="mt-28">
          <h2 className="text-[24px] tracking-[-0.025em]">Critical failures</h2>
          {report.criticalFailures.length === 0 ? (
            <p className="mt-4 text-ink-3">Nothing critical was lost.</p>
          ) : (
            <ul className="mt-6 divide-y divide-line border-y border-line">
              {report.criticalFailures.slice(0, TOP_FAILURES).map((f, i) => {
                const c = cause(f);
                return (
                  <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-0.5 py-3.5">
                    <span className="truncate" title={f.url}>
                      {f.path}
                      {f.thirdParty && <span className="text-ink-3"> · {f.host}</span>}
                    </span>
                    <span className={c.hot ? "text-accent" : "text-ink-3"}>{c.text}</span>
                    <span className="text-ink-3">{f.reason}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {report.criticalFailures.length > TOP_FAILURES && (
            <p className="mt-3 text-ink-3">+ {report.criticalFailures.length - TOP_FAILURES} more in the export</p>
          )}
        </Rise>

        {report.affectedFeatures.length > 0 && (
          <Rise className="mt-28">
            <h2 className="text-[24px] tracking-[-0.025em]">Affected features</h2>
            <p className="mt-2 text-ink-3">Inferred from URLs and resource types. Best effort, not authoritative.</p>
            <ul className="mt-6 divide-y divide-line border-y border-line">
              {report.affectedFeatures.map((f) => (
                <li key={f.name} className="grid grid-cols-[1fr_auto] items-center gap-x-6 py-3.5 sm:grid-cols-[220px_1fr_auto]">
                  <span>{f.name}</span>
                  <span className="hidden h-[3px] rounded-full bg-line sm:block" aria-hidden>
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${Math.round((f.lost / f.total) * 100)}%` }}
                    />
                  </span>
                  <span className="text-ink-3 tabular-nums">
                    {f.lost} of {f.total} lost
                  </span>
                </li>
              ))}
            </ul>
          </Rise>
        )}

        {report.newPageErrors.length > 0 && (
          <Rise className="mt-28">
            <h2 className="text-[24px] tracking-[-0.025em]">Errors the page threw</h2>
            <ul className="mt-6 divide-y divide-line border-y border-line">
              {report.newPageErrors.map((e, i) => (
                <li key={i} className="py-3.5 text-ink-2">
                  {e}
                </li>
              ))}
            </ul>
          </Rise>
        )}

        <Rise className="mt-28 text-center text-ink-3">
          <p>
            Seed <span className="text-ink-2">{result.seed}</span>. Replay repeats the same failures on the same requests.
          </p>
        </Rise>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // DOM order is label-then-value (what <dl> requires); flex-col-reverse puts the number on top.
    <div className="flex flex-col-reverse gap-3">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-[24px] leading-none tracking-[-0.025em] tabular-nums">{children}</dd>
    </div>
  );
}

function Shot({ label, src }: { label: string; src: string | null }) {
  return (
    <figure>
      <figcaption className="mb-3 text-ink-3">{label}</figcaption>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- inline base64 from the API, nothing to optimise
        <img className="shot" src={`data:image/jpeg;base64,${src}`} alt={`${label} chaos, page screenshot`} />
      ) : (
        <div className="shot grid place-items-center text-ink-3">No screenshot: the page never rendered.</div>
      )}
    </figure>
  );
}
