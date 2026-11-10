"use client";

import { useState } from "react";

export default function ColorNumberField({ label, value, min, max, step = 1, disabled, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = (next: number) => {
    const bounded = Math.max(min, Math.min(max, next));
    setDraft(String(bounded));
    onChange(bounded);
  };
  return <label>{label}<input type="text" inputMode="decimal" role="spinbutton"
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    value={draft} disabled={disabled}
    onChange={(event) => {
      const text = event.target.value;
      setDraft(text);
      if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
        const parsed = Number(text);
        if (Number.isFinite(parsed)) onChange(Math.max(min, Math.min(max, parsed)));
      }
    }}
    onBlur={() => {
      const parsed = Number(draft);
      commit(draft.trim() && Number.isFinite(parsed) ? parsed : value);
    }}
    onKeyDown={(event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        commit(Number((value + (event.key === "ArrowUp" ? step : -step)).toFixed(4)));
      }
    }} /></label>;
}
