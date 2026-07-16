"use client";

import { type ViewDimension } from "@/lib/view-state";

/**
 * The a11y segmented control for one switchable dimension (NS#2 Pillar 2) — the
 * standardized "flip this data to another lens" affordance, analogous to how
 * <InlineEditableText> standardized editing. A toggle group of buttons with
 * aria-pressed (keyboard-native), styled like PeriodSelector's granularity pills.
 */
interface ViewSwitcherProps {
  dimension: ViewDimension;
  /** the currently active option value */
  value: string;
  onSelect: (value: string) => void;
  /** display label per option value; falls back to the raw value */
  labels?: Record<string, string>;
  /** accessible group label, e.g. "Cash flow view" */
  ariaLabel: string;
  disabled?: boolean;
}

export function ViewSwitcher({ dimension, value, onSelect, labels, ariaLabel, disabled }: ViewSwitcherProps) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex gap-1 rounded-full bg-surface-sunken p-1">
      {dimension.options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onSelect(opt)}
            className={`rounded-full px-3 py-1 text-xs transition-colors duration-(--duration-fast) disabled:opacity-60 ${
              active ? "bg-surface-raised font-medium shadow-sm" : "text-ink-muted hover:text-ink"
            }`}
          >
            {labels?.[opt] ?? opt}
          </button>
        );
      })}
    </div>
  );
}
