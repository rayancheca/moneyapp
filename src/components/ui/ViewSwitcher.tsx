"use client";

import { type ViewDimension } from "@/lib/view-state";
import { PRESSED_SLOT } from "./letterpress";

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
    // the mockup's range-slug: a well pressed INTO the page (leaf tone plus the
    // inner ink pool, no catch-light) holding one chip that has risen out of it
    //
    // `flex-wrap` is load-bearing, not cosmetic. A non-wrapping flex row's
    // min-content width is the SUM of its children, so the well could never be
    // narrower than every pill laid end to end — and, being an ordinary block
    // in the page flow, it dragged the whole document sideways rather than
    // clipping. Measured on the dashboard the moment a seventh option
    // ("terrain") was appended to this dimension: the well's min-content went
    // to 441px and `/` overflowed by 44px at 440 and 164px at 320 (0 and 100
    // with that one pill hidden — the row was already at the edge at six).
    // Wrapping makes the well's minimum the WIDEST SINGLE PILL instead of the
    // whole row, so options are never pushed off-screen and adding one costs a
    // second line rather than a horizontal scrollbar. Above the break the
    // computed layout is byte-identical — wrapping only engages when the row
    // would not have fit anyway. Same one-token fix as PeriodSelector's
    // granularity nav, which is the same control in a different costume.
    <div
      role="group"
      aria-label={ariaLabel}
      className={`flex flex-wrap gap-1 rounded-full border border-line bg-surface-leaf p-1 ${PRESSED_SLOT}`}
    >
      {dimension.options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onSelect(opt)}
            className={`rounded-full px-3 py-1 text-xs transition-colors duration-(--duration-tap) ease-(--ease-ink) disabled:opacity-60 ${
              active
                ? "bg-surface-raised font-medium text-ink-display shadow-press-1"
                : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
            }`}
          >
            {labels?.[opt] ?? opt}
          </button>
        );
      })}
    </div>
  );
}
