"use client";

import { PRESETS } from "@/lib/chaos/config";
import { PRESET_NAMES, type ChaosPresetName } from "@/lib/chaos/types";

interface Props {
  active: ChaosPresetName | null;
  onPick: (name: ChaosPresetName) => void;
  onRandom: () => void;
}

/** Named presets as quiet text chips; Random is set apart because it's an action, not a place. */
export function PresetBar({ active, onPick, onRandom }: Props) {
  return (
    <div role="group" aria-label="Presets" className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
      {PRESET_NAMES.map((name) => (
        <button
          key={name}
          type="button"
          className="chip"
          aria-pressed={active === name}
          onClick={() => onPick(name)}
        >
          {PRESETS[name].label}
        </button>
      ))}
      <span aria-hidden className="mx-2 hidden h-4 w-px bg-line lg:block" />
      <button type="button" className="chip" onClick={onRandom}>
        Random
      </button>
    </div>
  );
}
