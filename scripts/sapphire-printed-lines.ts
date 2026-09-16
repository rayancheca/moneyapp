/**
 * Which hand-entered ledger row records the money a statement line prints —
 * the pure half of `attach-sapphire-payment-rows-2026-09-14.ts`.
 *
 * The identity is the importer's own: same amount, and the row claims the
 * printed day as its POSTED day or, failing that, as its TRANSACTION day
 * (`identityWeight` in services/import/service.ts). Chase prints one date per
 * row and it is the transaction date, which is why the second lens exists: the
 * reconstructed $100.00 payment posted 2026-07-01 is printed as `06/30`.
 *
 * Two deliberate differences from the importer:
 *
 *  1. Rows a statement already backs claim their lines FIRST. A hand row may
 *     only take a line no document-backed row records, so a hand row can never
 *     acquire a badge by standing next to a real statement row of equal money
 *     (2025-02-11 prints -350.00 and -300.00; only the $350.00 is hand-made).
 *  2. A row's OWN day — its transaction day when it carries one, else its
 *     posted day — is matched across every row before any row falls back to
 *     its other date. Chase prints the transaction day, and the Spending Report
 *     rows post one to two days later. Matching posted days first was measured
 *     wrong on this card: in dense runs of equal fares and vending charges a row
 *     posted on D took the line printed D that belonged to its neighbour
 *     transacted on D, and 59 lines (−$185.82) were left recording nothing
 *     though every one of their rows exists.
 *
 * Each line is claimed at most once and each row attaches at most once, in a
 * pinned order — lines by (period, print order), rows by (posted day,
 * occurrence index, id) — so the one row a duplicated day gives up is always
 * the later occurrence.
 */

export interface PrintedLine {
  /** the import file whose statement period this line belongs to */
  fileId: string;
  fileName: string;
  periodStart: string;
  periodEnd: string;
  /** the date printed on the line, year inferred by the parser */
  day: string;
  /** net-worth-signed, exactly as the parser stores it */
  amountCents: number;
  description: string;
  /** position in the statement, for a stable claim order */
  order: number;
}

export interface LedgerLeg {
  id: string;
  postedOn: string;
  transactedOn: string | null;
  amountCents: number;
  occurrenceIndex: number;
}

export type MatchLens = "posted" | "transacted";

export interface Attachment {
  rowId: string;
  line: PrintedLine;
  lens: MatchLens;
}

export interface PrintedMatch {
  attachments: Attachment[];
  /** candidate rows no remaining printed line records */
  unprinted: LedgerLeg[];
  /** printed lines no row — backed or candidate — records */
  unclaimedLines: PrintedLine[];
}

/** Pass 1 is the row's own day; pass 2 is the other date, only when it has one. */
function dayFor(leg: LedgerLeg, pass: 1 | 2): { day: string; lens: MatchLens } | null {
  const own = leg.transactedOn !== null ? { day: leg.transactedOn, lens: "transacted" as const } : { day: leg.postedOn, lens: "posted" as const };
  if (pass === 1) return own;
  return leg.transactedOn !== null ? { day: leg.postedOn, lens: "posted" } : null;
}

function byLineOrder(a: PrintedLine, b: PrintedLine): number {
  return a.periodStart.localeCompare(b.periodStart) || a.order - b.order;
}

function byLegOrder(a: LedgerLeg, b: LedgerLeg): number {
  return a.postedOn.localeCompare(b.postedOn) || a.occurrenceIndex - b.occurrenceIndex || a.id.localeCompare(b.id);
}

/** Claim lines for `legs`, never touching a line already in `taken`. */
function claim(
  lines: readonly PrintedLine[],
  legs: readonly LedgerLeg[],
  taken: Set<PrintedLine>,
): Map<string, { line: PrintedLine; lens: MatchLens }> {
  const claimed = new Map<string, { line: PrintedLine; lens: MatchLens }>();
  const orderedLegs = [...legs].sort(byLegOrder);
  for (const pass of [1, 2] as const) {
    for (const leg of orderedLegs) {
      if (claimed.has(leg.id)) continue;
      const target = dayFor(leg, pass);
      if (target === null) continue;
      const hit = lines.find((l) => !taken.has(l) && l.day === target.day && l.amountCents === leg.amountCents);
      if (hit === undefined) continue;
      taken.add(hit);
      claimed.set(leg.id, { line: hit, lens: target.lens });
    }
  }
  return claimed;
}

export function matchPrintedLines(
  lines: readonly PrintedLine[],
  backed: readonly LedgerLeg[],
  candidates: readonly LedgerLeg[],
): PrintedMatch {
  const ordered = [...lines].sort(byLineOrder);
  const taken = new Set<PrintedLine>();
  claim(ordered, backed, taken);
  const claimed = claim(ordered, candidates, taken);
  const orderedCandidates = [...candidates].sort(byLegOrder);
  return {
    attachments: orderedCandidates.flatMap((leg) => {
      const hit = claimed.get(leg.id);
      return hit ? [{ rowId: leg.id, line: hit.line, lens: hit.lens }] : [];
    }),
    unprinted: orderedCandidates.filter((leg) => !claimed.has(leg.id)),
    unclaimedLines: ordered.filter((l) => !taken.has(l)),
  };
}

export interface KeyedDiff<V> {
  changed: { key: string; before: V; after: V }[];
  removed: string[];
  added: string[];
}

/** Every key whose value moved, vanished or appeared — for before/after guards. */
export function diffKeyed<V>(before: ReadonlyMap<string, V>, after: ReadonlyMap<string, V>): KeyedDiff<V> {
  const changed: KeyedDiff<V>["changed"] = [];
  const removed: string[] = [];
  for (const [key, value] of before) {
    if (!after.has(key)) removed.push(key);
    else if (after.get(key) !== value) changed.push({ key, before: value, after: after.get(key)! });
  }
  const added = [...after.keys()].filter((key) => !before.has(key));
  return { changed, removed, added };
}
