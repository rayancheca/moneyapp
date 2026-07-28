/**
 * The blast radius a destructive action states, and the pure helpers that
 * phrase it. Deliberately NOT in Confirm.tsx: that module is `"use client"`,
 * and everything exported from a client module is a client *reference* — the
 * server may render it as a component, never call it. The two pages that
 * measure their own blast radius (`/imports`, `/accounts/[id]`) are Server
 * Components, so calling `countPhrase()` there against the client module threw
 * "Attempted to call countPhrase() from the server" and took the whole page
 * down with it. Types are erased and functions are pure, so this file is safe
 * on both sides of the boundary — which is exactly why it lives apart.
 */

/** One measured consequence, in the owner's units — a count or an amount. */
export interface BlastRadiusLine {
  /** what the number measures, in plain English */
  label: string;
  /** the number itself, already formatted (countPhrase / formatCents) */
  value: string;
  /** the consequence that cannot be undone — carries the negative tone */
  irreversible?: boolean;
}

/** The full, measured consequence of one irreversible action. */
export interface BlastRadius {
  /** what the action does, one sentence, in plain English */
  headline: string;
  /** the measured lines — money and counts, never row ids */
  lines?: readonly BlastRadiusLine[];
  /** what SURVIVES: derived state rebuilds, so say so instead of implying loss */
  reassurance?: string;
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/**
 * "1 transaction" / "1,332 transactions" / "no transactions". A count is one of
 * the owner's units too: a blast radius states what was touched, not which ids.
 */
export function countPhrase(n: number, singular: string, plural = `${singular}s`): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Invalid count: ${n}`);
  if (n === 0) return `no ${plural}`;
  return `${COUNT_FORMAT.format(n)} ${n === 1 ? singular : plural}`;
}

/** Sentence-cases a fragment's terminator so joined parts read as prose. */
function endWithStop(part: string): string {
  const trimmed = part.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The whole consequence as ONE sentence — what a screen reader hears as the
 * confirm button's description, before the button can be activated. Pure, so
 * the copy that stands between the owner and his data is tested, not eyeballed.
 */
export function blastRadiusSentence(radius: BlastRadius): string {
  const parts = [
    radius.headline,
    ...(radius.lines ?? []).map((l) => `${l.label.trim()}: ${l.value.trim()}`),
  ];
  if (radius.reassurance) parts.push(radius.reassurance);
  return parts
    .filter((p) => p.trim() !== "")
    .map(endWithStop)
    .join(" ");
}
