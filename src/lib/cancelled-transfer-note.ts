/**
 * The one sentence for CANCELLED transfers (transfer-links' `cancelledTransfers`):
 * money that left an account and came back to it, so it moved nothing between
 * accounts.
 *
 * Said on four surfaces — the dashboard's transfers card, /flow's
 * reconciliation card, the matrix footer and the spine's `<desc>` — which
 * differ only in where the money is NOT (`notIn`). One definition, so no two of
 * them can describe the same cancellation differently. Measured 2026-09-15:
 * with the card saying "cancelled" and /flow's three surfaces still reading the
 * group as one that "could not be matched", one $115.00 cancellation printed as
 * $230.00 of unmatched money on /flow.
 *
 * Null when nothing was cancelled: a surface prints no sentence about nothing.
 */
export function cancelledTransferNote(
  count: number,
  cents: number,
  fmt: (cents: number) => string,
  notIn: string,
): string | null {
  if (count === 0) return null;
  return count === 1
    ? `1 cancelled transfer — ${fmt(cents)} — left an account and came back to it, so it moved nothing and is not ${notIn}.`
    : `${count} cancelled transfers — ${fmt(cents)} — each left an account and came back to it, so they moved nothing and are not ${notIn}.`;
}
