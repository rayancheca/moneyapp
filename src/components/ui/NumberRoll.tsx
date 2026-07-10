"use client";

import { useEffect, useRef } from "react";
import { numberRollSlots } from "@/lib/number-roll";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
/** Each digit is 1/10 of the strip, so digit d sits at -d × 10%. */
const STRIP_STEP_PERCENT = 10;

interface NumberRollProps {
  /** Pre-formatted value, e.g. from formatCents — this component never formats. */
  value: string;
  className?: string;
}

/**
 * Odometer for money/values (plan §2.5). CSS-transition only; never animates
 * on first paint; fixed-width 1ch digit slots so `.figures` never reflows.
 * The full value is exposed as real sr-only text (aria-label on a generic
 * <span> is prohibited ARIA and dropped by some AT); the animated digit
 * strips are presentation-only inside a single aria-hidden wrapper.
 */
export function NumberRoll({ value, className }: NumberRollProps) {
  const prevValueRef = useRef<string | null>(null);
  const isMountedRef = useRef(false);
  const slots = numberRollSlots(prevValueRef.current, value);

  useEffect(() => {
    prevValueRef.current = value;
    // flips after paint without re-rendering: the transition class only
    // appears on renders caused by a real value change, never the first
    isMountedRef.current = true;
  });

  const stripClass = isMountedRef.current
    ? "block transition-transform duration-(--duration-normal) ease-(--ease-out-expo)"
    : "block";

  return (
    <span className={`figures inline-flex ${className ?? ""}`.trim()}>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true" className="inline-flex">
        {slots.map((slot, i) => {
          // keyed from the right so a value growing a leading digit keeps
          // its trailing slots mounted (and thus animating, not remounting)
          const slotKey = slots.length - i;
          if (!slot.isDigit) {
            return <span key={`char-${slotKey}`}>{slot.char}</span>;
          }
          const digit = Number(slot.char);
          return (
            <span key={`digit-${slotKey}`} className="inline-block h-[1lh] w-[1ch] overflow-hidden">
              <span
                className={stripClass}
                style={{ transform: `translateY(-${digit * STRIP_STEP_PERCENT}%)` }}
                data-changed={slot.changed || undefined}
              >
                {DIGITS.map((d) => (
                  <span key={d} className="block h-[1lh]">
                    {d}
                  </span>
                ))}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
