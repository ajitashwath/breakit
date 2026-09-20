"use client";

import { useEffect, useState } from "react";

/**
 * Layout: the target's name at display size, one quiet line, one hairline that
 * breathes. No spinner, no fake progress: the synchronous API can't report
 * phases, so all we can honestly show is elapsed time. (Live phases arrive with
 * the WebSocket stream.)
 */
export function RunningView({ host, onCancel }: { host: string; onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="fade-in flex w-full max-w-[720px] flex-col items-center text-center">
      <p className="text-ink-3">Breaking</p>
      <h1 className="mt-3 w-full truncate text-[clamp(36px,7vw,72px)] leading-[1.1] tracking-[-0.035em]">{host}</h1>
      <div className="breathe mt-8 h-px w-full" aria-hidden />
      <p className="mt-6 text-ink-3 tabular-nums" role="status">
        {elapsed}s &middot; warm-up, baseline, then chaos
      </p>
      <button type="button" className="text-btn mt-10" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
