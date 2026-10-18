// SPDX-License-Identifier: AGPL-3.0-only
import type { Range } from "./types";
export const rangeSeconds: Record<Range, number> = {
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
};
export const rangeLabels: Record<Range, string> = {
  "15m": "15 minutes",
  "1h": "1 hour",
  "6h": "6 hours",
  "24h": "24 hours",
};
export function RangeSelector({
  value,
  onChange,
  label = "Historical time range",
  custom = false,
  short = false,
}: {
  value: Range | "custom";
  onChange: (value: Range | "custom") => void;
  label?: string;
  custom?: boolean;
  short?: boolean;
}) {
  return (
    <div className="range-picker" role="group" aria-label={label}>
      {(Object.keys(rangeSeconds) as Range[]).map((r) => (
        <button
          type="button"
          key={r}
          aria-pressed={value === r}
          className={value === r ? "active" : ""}
          onClick={() => onChange(r)}
        >
          {short ? r : rangeLabels[r]}
        </button>
      ))}
      {custom && (
        <button
          type="button"
          aria-pressed={value === "custom"}
          className={value === "custom" ? "active" : ""}
          onClick={() => onChange("custom")}
        >
          Custom
        </button>
      )}
    </div>
  );
}
