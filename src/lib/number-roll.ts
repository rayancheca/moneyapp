/**
 * Pure slot diffing for the NumberRoll odometer (plan §2.5).
 *
 * Aligns prev/next right-to-left (money grows leading digits: $99.99 →
 * $100.00 keeps the cents slots stable) and marks which digit slots changed.
 * `prev === null` means first render: every slot is unchanged so nothing
 * animates on mount. Non-digit slots ($ , . -) are never marked changed —
 * they render static.
 */

export interface NumberRollSlot {
  char: string;
  changed: boolean;
  isDigit: boolean;
}

const DIGIT_RE = /^[0-9]$/;

export function numberRollSlots(prev: string | null, next: string): NumberRollSlot[] {
  const slots: NumberRollSlot[] = [];
  for (let i = 0; i < next.length; i++) {
    const char = next.charAt(i);
    const offsetFromRight = next.length - 1 - i;
    const prevIndex = prev === null ? -1 : prev.length - 1 - offsetFromRight;
    // a slot with no prev counterpart (value grew a digit) counts as changed
    const prevChar = prev !== null && prevIndex >= 0 ? prev.charAt(prevIndex) : null;
    const isDigit = DIGIT_RE.test(char);
    const changed = prev !== null && isDigit && prevChar !== char;
    slots.push({ char, changed, isDigit });
  }
  return slots;
}
