"use client";

import { useEffect, useRef } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

/**
 * The only thing on screen at first load. Type is huge and shrinks smoothly as
 * the URL grows so a long address never wraps or scrolls sideways.
 */
export function UrlField({ value, onChange, onSubmit }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const size = Math.max(30, Math.min(72, 72 - Math.max(0, value.length - 12) * 2.4));

  return (
    <div className="url-field">
      <input
        ref={ref}
        className="url-input"
        style={{ fontSize: `min(${size}px, 11vw)` }}
        type="text"
        inputMode="url"
        aria-label="Website URL"
        placeholder="example.com"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
      />
    </div>
  );
}
