import { formatCents } from "@/lib/money";

/**
 * How far the ledger has READ a bill that came due and that no posting covers — the split every arrears sentence is
 * said through.
 *
 * ⛔ ONE SPLIT, EVERY SURFACE. "Not posted" is a negative claim, so it may be made only of the part of the arrears on
 * days an import has reached for the accounts the bill pays from (`arrearsReadCents`, carried by `arrearsThisMonth`).
 * The rest is "no import has covered it yet" — ⚖️ staleness between uploads is normal, never a warning (his words
 * 2026-08-05; the class approved 2026-10-07).
 *
 * 🔴 The runway learned this on 2026-10-07 and the bill's own page did not. On a copy of his ledger 2026-10-08,
 * `/recurring/<Flamingo South Beach (rent)>` read "Already due, and not posted" in warning colour over Oct 1 — rent
 * posts from Wells Fargo, read through Sep 24 — while the runway said "A further $2,291.21 came due earlier this month
 * and no import has covered it yet." So did `/recurring`'s Next column ("Oct 1 — not posted"), `/categories/<Housing>`
 * and the math table ("came due Oct 1 and has not posted"): four surfaces, one bill, the runway's half of the rule.
 */
export interface ArrearsReading {
  /** what came due and no posting covers, as a positive money-out magnitude */
  owedCents: number;
  /** of `owedCents`, the part on days no import has reached — the rest has been read */
  unreadCents: number;
}

export type ArrearsKind = "read" | "unread" | "mixed";

export interface ArrearsSplit {
  readCents: number;
  unreadCents: number;
  kind: ArrearsKind;
}

/** The read and unread halves, clamped: never more unread than is owed, never less than nothing. */
export function arrearsSplit({ owedCents, unreadCents }: ArrearsReading): ArrearsSplit {
  const owed = Math.max(0, owedCents);
  const unread = Math.min(owed, Math.max(0, unreadCents));
  const read = owed - unread;
  return { readCents: read, unreadCents: unread, kind: unread === 0 ? "read" : read === 0 ? "unread" : "mixed" };
}

/** The words for the unread half — /budgets' and the runway's. */
export const NO_IMPORT_YET = "no import has covered it yet";

/** A mixed split in the runway's voice: "$R <notPosted>, and no import has covered the other $U yet". */
export function splitClause(split: ArrearsSplit, notPosted: string): string {
  const read = formatCents(split.readCents);
  return `${read} ${notPosted}, and no import has covered the other ${formatCents(split.unreadCents)} yet`;
}

/**
 * What follows a lead such as "came due Oct 1": " and <notPosted>", " and no import has covered it yet", or
 * ": $R <notPosted>, and no import has covered the other $U yet". `notPosted` is the surface's own word for the read
 * half ("never posted" on the runway, "has not posted" in the math table).
 */
export function arrearsTail(reading: ArrearsReading, notPosted: string): string {
  const split = arrearsSplit(reading);
  if (split.kind === "read") return ` and ${notPosted}`;
  if (split.kind === "unread") return ` and ${NO_IMPORT_YET}`;
  return `: ${splitClause(split, notPosted)}`;
}
