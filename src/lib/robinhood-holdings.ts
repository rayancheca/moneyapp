import type { HoldingEventKind } from "@/db/schema/holding-events";

/**
 * The share book, reconstructed from the Robinhood activity export.
 *
 * The export is the RECORD of every share movement — 1,992 of them across 33
 * symbols since 2023-12-05 — and it is the only source that carries them. The
 * brokerage statements print a Portfolio Summary but no share history, so a
 * holdings table built by hand from statement snapshots can only ever be a
 * frozen guess between two of them. This module derives the whole timeline.
 *
 * THREE things had to be true before the numbers agreed with the statements.
 * Each was measured, none is a fitted constant (docs/HANDOFF-2026-08-06-pass40.md
 * §10 — every number traces to a line of a source document):
 *
 * 1. SETTLE DATE, not activity date. A position is shares you are on the books
 *    for, and Robinhood's Portfolio Summary counts settled shares. Accumulating
 *    on Activity Date matches 20 of the export's 44 dividend share counts;
 *    accumulating on Settle Date matches 40. It is also the whole of the
 *    "AAPL is 5 shares off" mystery: the 2026-07-31 buy of 5 AAPL settles
 *    2026-08-03, so it belongs to August and is correctly absent from July.
 *
 * 2. SPLITS ARE A RATIO, not the printed delta. The one SPL row prints
 *    `9.0131` COKE against a held 1.001455 — a 10-for-1, whose exact delta is
 *    1.001455 x 9 = 9.013095. The export rounded it to four decimals and lost
 *    5e-6 of a share.
 *
 * 3. LOW-PRECISION ROWS ARE CALIBRATED AGAINST THE DIVIDEND LINES. The two
 *    price-less rows (that SPL and the 2023-12-05 AAPL referral share) are the
 *    only ones printed to four decimals; every other quantity carries six. A
 *    dividend's description states the share count it was paid on
 *    ("... - 15.606784 shares at 0.27"), which is an independent statement of
 *    the position on a date — so the true quantity of a rounded row is read
 *    back out of the next dividend rather than guessed. See calibrateRounded.
 *
 * All three are re-checked by verifyAgainstDividends, which is the point: if a
 * correction here were ever wrong, dividend lines disagree and the rebuild
 * refuses to run instead of quietly moving money.
 *
 * Quantities are exact 1e-8 integers via BigInt — never floats (schema.md).
 */

/** 1e-8 units per share — the schema's exact quantity unit. */
const E8 = 100_000_000n;

/**
 * Half a unit in the last place of a 4-decimal printed quantity. A calibrated
 * quantity that differs from the printed one by more than this is not a
 * rounding artefact, and calibration refuses it.
 */
const ROUNDING_TOLERANCE_E8 = 5_000n; // 0.00005 shares

/** Codes that move shares. Everything else in the export is cash-only. */
const SELL_CODE = "Sell";
const SPLIT_CODE = "SPL";

export class ReconstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconstructionError";
  }
}

/** One row of the activity export, already split into fields. */
export interface ActivityRow {
  /** ISO settle date — the basis the whole book is accumulated on */
  settleDate: string;
  /** ISO trade date, carried through for provenance only */
  activityDate: string;
  symbol: string;
  /** the export's `Trans Code` (Buy / Sell / SPL / REC / CDIV / …) */
  code: string;
  /** raw decimal string as printed, e.g. "0.059926"; "" for cash-only rows */
  quantity: string;
  /** signed cents actually paid or received; null when the row moves no cash */
  amountCents: number | null;
  /** the row's description, flattened to one line */
  description: string;
}

/** A signed quantity change, ready for the holding_events table. */
export interface ShareEvent {
  symbol: string;
  /** settle date — see rule 1 */
  occurredOn: string;
  quantityDeltaE8: bigint;
  /** cash actually paid for this event; null when it moved no cash */
  costCents: number | null;
  /** provenance when the printed quantity was not used verbatim */
  note: string | null;
  /**
   * 🔴 A split is not a trade, and the valuation reads the difference: the cost
   * walk drops splits and pre-split quantities are rescaled against split-adjusted
   * closes. The rebuild once wrote every row as the column default `trade`,
   * erasing COKE's 2025-05-27 marker — spring-2025 NAV fell by up to $1,021.71
   * until it was re-marked (2026-09-15). The kind is decided HERE, where the split
   * row is recognised, so every writer carries it.
   */
  eventKind: HoldingEventKind;
}

/** A symbol's reconstructed position and cost. */
export interface Position {
  symbol: string;
  quantityE8: bigint;
  /** total cash paid for the shares still held, average-cost basis */
  costCents: number;
  /** costCents per whole share, rounded — the holdings.avg_cost_cents unit */
  avgCostCents: number | null;
}

/* ── exact decimal helpers ──────────────────────────────────────────── */

/** "1,234.5678" → 123456780000n. Rejects anything that is not a decimal. */
export function parseQuantityE8(input: string): bigint {
  const s = input.trim().replaceAll(",", "");
  const m = /^(\d*)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[1] === "" && m[2] === undefined)) {
    throw new ReconstructionError(`Cannot parse quantity "${input}"`);
  }
  const frac = m[2] ?? "";
  if (frac.length > 8) {
    throw new ReconstructionError(`Quantity "${input}" has more than 8 decimal places`);
  }
  // m[1] is "" for a bare ".5"; the fraction is always 8 digits after padding
  return BigInt(m[1] || "0") * E8 + BigInt(frac.padEnd(8, "0"));
}

/** 2673700n → "0.026737". Display and note text only. */
export function formatQuantityE8(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const frac = (abs % E8).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / E8}${frac === "" ? "" : `.${frac}`}`;
}

/** |a| — BigInt has no Math.abs. */
function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Ascending compare for the ISO dates and symbols sorted here. One helper
 * rather than three inline ternaries so every ordering in this file agrees,
 * and so "which way round" is stated once.
 */
function ascending(a: string, b: string): number {
  return a < b ? -1 : 1;
}

/* ── the export's own columns ───────────────────────────────────────── */

/** real exports don't zero-pad ("6/5/2026"), matching csv-profiles' RH_DATE_RE */
const MDY_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * "7/31/2026" → "2026-07-31". Pure string math: a Date here would resolve
 * against the local zone and shift the day (vitest pins TZ to UTC+14 precisely
 * to catch that).
 */
export function mdyToIso(input: string): string | null {
  const m = MDY_RE.exec(input.trim());
  if (!m) return null;
  return `${m[3]}-${(m[1] as string).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`;
}

/**
 * Maps parsed CSV records onto ActivityRow, dropping the trailing disclaimer
 * lines (which carry no parseable date). A row whose Settle Date is missing
 * settles the day it traded — true of every cash row in the export.
 */
export function toActivityRows(
  records: readonly Record<string, string | undefined>[],
  parseAmount: (raw: string) => number,
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const r of records) {
    const activityDate = mdyToIso(r["Activity Date"] ?? "");
    if (activityDate === null) continue;
    const amountRaw = (r.Amount ?? "").trim();
    rows.push({
      activityDate,
      settleDate: mdyToIso(r["Settle Date"] ?? "") ?? activityDate,
      symbol: (r.Instrument ?? "").trim(),
      code: (r["Trans Code"] ?? "").trim(),
      quantity: (r.Quantity ?? "").trim(),
      amountCents: amountRaw === "" ? null : parseAmount(amountRaw),
      description: (r.Description ?? "").replace(/\s+/g, " ").trim(),
    });
  }
  return rows;
}

/* ── the dividend arbiter ───────────────────────────────────────────── */

/** A share count a dividend line states for a record date. */
export interface DividendShareCount {
  symbol: string;
  /** the dividend's record date, "R/D 2026-05-11" */
  recordDate: string;
  quantityE8: bigint;
}

const DIVIDEND_RE = /R\/D (\d{4}-\d{2}-\d{2}).*?- ([\d.,]+) shares/;

/**
 * Pulls the share counts Robinhood prints inside its own dividend descriptions.
 * These are the second arbiter: 44 independent statements of a position on a
 * date, inside the same file, owing nothing to the statement PDFs.
 */
export function extractDividendShareCounts(rows: readonly ActivityRow[]): DividendShareCount[] {
  const counts: DividendShareCount[] = [];
  for (const row of rows) {
    if (row.symbol === "") continue;
    const m = DIVIDEND_RE.exec(row.description);
    if (!m) continue;
    counts.push({
      symbol: row.symbol,
      recordDate: m[1] as string,
      quantityE8: parseQuantityE8(m[2] as string),
    });
  }
  return counts;
}

/* ── reconstruction ─────────────────────────────────────────────────── */

/**
 * Rows that move shares, in the order the book must apply them.
 *
 * Settle date orders the book, but several rows routinely share one — a
 * recurring buy and a liquidation both settle T+1 from the same trade day. The
 * order INSIDE a settle date does not change the day's net, so it cannot change
 * a position; it changes the average cost a sale releases, and it decides
 * whether the walk dips transiently negative. Both are settled by applying the
 * rows in the order they were actually traded, and, for the same trade day,
 * acquisitions before disposals: on 2025-06-24 a 0.099319 buy and an 18.184176
 * sell settle together against 18.084857 held, which is only non-negative if
 * the buy lands first. A split re-denominates whatever is held once the day's
 * trades are in, so it always goes last.
 */
function shareRows(rows: readonly ActivityRow[]): ActivityRow[] {
  return rows
    .filter((r) => r.symbol !== "" && r.quantity.trim() !== "")
    .sort((a, b) => {
      if (a.settleDate !== b.settleDate) return ascending(a.settleDate, b.settleDate);
      if (a.activityDate !== b.activityDate) return ascending(a.activityDate, b.activityDate);
      return sameDayRank(a) - sameDayRank(b);
    });
}

/** acquisitions (0) → disposals (1) → splits (2), within one settle date */
function sameDayRank(row: ActivityRow): number {
  if (row.code === SPLIT_CODE) return 2;
  return row.code === SELL_CODE ? 1 : 0;
}

/**
 * The true quantity of a row whose printed value was rounded to four decimals.
 *
 * Reads it back out of the next dividend that states a share count for the
 * symbol: everything else in the window is printed to six decimals, so the
 * dividend's count minus those events IS the rounded row. Returns null when the
 * symbol never paid a dividend afterwards and there is therefore nothing to
 * calibrate against — the caller then keeps what the export printed and says so.
 */
function calibrateRounded(
  row: ActivityRow,
  printedE8: bigint,
  peers: readonly ActivityRow[],
  dividends: readonly DividendShareCount[],
): bigint | null {
  let next: DividendShareCount | undefined;
  for (const d of dividends) {
    if (d.symbol !== row.symbol || d.recordDate < row.settleDate) continue;
    if (next === undefined || d.recordDate < next.recordDate) next = d;
  }
  if (next === undefined) return null;

  // only THIS symbol's other events — a dividend states a position in one
  // instrument, so summing the whole book against it would be nonsense. Today
  // this function runs exactly once, on the 2023-12-05 receipt, before any
  // other symbol has been traded; the filter is what keeps that an accident
  // rather than a dependency.
  let others = 0n;
  for (const peer of peers) {
    if (peer === row || peer.symbol !== row.symbol) continue;
    if (peer.settleDate > next.recordDate) continue;
    others += signedPrintedDelta(peer);
  }

  const calibrated = next.quantityE8 - others;
  if (absBig(calibrated - printedE8) > ROUNDING_TOLERANCE_E8) {
    throw new ReconstructionError(
      `${row.symbol} ${row.code} on ${row.settleDate}: dividend on ${next.recordDate} implies ` +
        `${formatQuantityE8(calibrated)} shares but the export prints ` +
        `${formatQuantityE8(printedE8)} — too far apart to be a rounding artefact`,
    );
  }
  return calibrated;
}

/** A row's delta taking the printed quantity at face value. */
function signedPrintedDelta(row: ActivityRow): bigint {
  const q = parseQuantityE8(row.quantity);
  return row.code === SELL_CODE ? -q : q;
}

/**
 * Splits multiply the position rather than adding a printed number of shares.
 * Recovers the integer multiplier from the rounded delta the export prints and
 * re-applies it exactly, so no precision is lost.
 */
function splitDelta(row: ActivityRow, printedE8: bigint, heldE8: bigint): bigint {
  if (heldE8 <= 0n) {
    throw new ReconstructionError(
      `${row.symbol} split on ${row.settleDate} with no position to split`,
    );
  }
  // integer ratio, rounded: (printed + held/2) / held
  const multiplier = (printedE8 + heldE8 / 2n) / heldE8;
  if (multiplier < 1n) {
    throw new ReconstructionError(
      `${row.symbol} split on ${row.settleDate}: printed delta ` +
        `${formatQuantityE8(printedE8)} is smaller than the ${formatQuantityE8(heldE8)} held`,
    );
  }
  return heldE8 * multiplier;
}

export interface ReconstructionResult {
  events: ShareEvent[];
  /** final position per symbol, including the ones now exited (quantity 0) */
  positions: Position[];
}

/**
 * Walks the export into a share-event timeline and the positions it implies.
 *
 * Cost is average-cost: a buy adds the cash it actually took (the Amount
 * column, not price x quantity — fees and the odd penny live in the difference),
 * a sell releases cost in proportion to the shares leaving, and a split or a
 * free share changes the share count without changing what was paid.
 */
export function reconstructHoldings(rows: readonly ActivityRow[]): ReconstructionResult {
  const ordered = shareRows(rows);
  const dividends = extractDividendShareCounts(rows);

  const quantity = new Map<string, bigint>();
  const cost = new Map<string, number>();
  const events: ShareEvent[] = [];

  for (const row of ordered) {
    const printed = parseQuantityE8(row.quantity);
    const held = quantity.get(row.symbol) ?? 0n;

    let delta: bigint;
    let note: string | null = null;

    if (row.code === SPLIT_CODE) {
      delta = splitDelta(row, printed, held);
      note = `split ${formatQuantityE8(held + delta)}/${formatQuantityE8(held)} — export printed ${row.quantity}`;
    } else if (row.amountCents === null) {
      // the only price-less non-split rows are share receipts, and they are the
      // other place the export drops to four decimals
      const calibrated = calibrateRounded(row, printed, ordered, dividends);
      delta = calibrated ?? printed;
      note =
        calibrated === null
          ? `${row.code} — export printed ${row.quantity}, no later dividend to calibrate against`
          : `${row.code} — export printed ${row.quantity}, dividend record implies ${formatQuantityE8(calibrated)}`;
    } else {
      delta = row.code === SELL_CODE ? -printed : printed;
    }

    const nextQuantity = held + delta;
    if (nextQuantity < 0n) {
      throw new ReconstructionError(
        `${row.symbol} goes negative on ${row.settleDate}: ${formatQuantityE8(held)} ${formatQuantityE8(delta)}`,
      );
    }

    const heldCost = cost.get(row.symbol) ?? 0;
    let eventCost: number | null = null;
    if (row.amountCents !== null && delta > 0n) {
      eventCost = -row.amountCents; // buys are printed negative — cash out
      cost.set(row.symbol, heldCost + eventCost);
    } else if (delta < 0n) {
      // average-cost release: the fraction of the position leaving. `held` is
      // necessarily positive here — a negative delta that exceeded it would
      // have thrown above — so this division is safe without a zero guard.
      const released = Math.round((heldCost * Number(-delta)) / Number(held));
      eventCost = -released;
      cost.set(row.symbol, heldCost - released);
    }

    quantity.set(row.symbol, nextQuantity);
    events.push({
      symbol: row.symbol,
      occurredOn: row.settleDate,
      quantityDeltaE8: delta,
      costCents: eventCost,
      note,
      eventKind: row.code === SPLIT_CODE ? "split" : "trade",
    });
  }

  const positions: Position[] = [...quantity.entries()]
    .map(([symbol, quantityE8]) => {
      const costCents = quantityE8 === 0n ? 0 : (cost.get(symbol) ?? 0);
      return {
        symbol,
        quantityE8,
        costCents,
        avgCostCents:
          quantityE8 > 0n ? Math.round((costCents * Number(E8)) / Number(quantityE8)) : null,
      };
    })
    .sort((a, b) => ascending(a.symbol, b.symbol));

  return { events, positions };
}

/* ── verification ───────────────────────────────────────────────────── */

export interface DividendCheck {
  symbol: string;
  recordDate: string;
  expectedE8: bigint;
  actualE8: bigint;
  matches: boolean;
}

/**
 * Replays the timeline against every share count the export's own dividend
 * lines state. This is what makes the corrections above safe to ship: a wrong
 * one shows up here as a mismatch instead of as money.
 */
export function verifyAgainstDividends(
  events: readonly ShareEvent[],
  rows: readonly ActivityRow[],
): DividendCheck[] {
  const dividends = extractDividendShareCounts(rows);
  return dividends.map((d) => {
    let actualE8 = 0n;
    for (const e of events) {
      if (e.symbol === d.symbol && e.occurredOn <= d.recordDate) actualE8 += e.quantityDeltaE8;
    }
    return {
      symbol: d.symbol,
      recordDate: d.recordDate,
      expectedE8: d.quantityE8,
      actualE8,
      matches: actualE8 === d.quantityE8,
    };
  });
}

/** Position per symbol as of a day — the shape a statement can be checked against. */
export function positionsAsOf(
  events: readonly ShareEvent[],
  day: string,
): Map<string, bigint> {
  const held = new Map<string, bigint>();
  for (const e of events) {
    if (e.occurredOn > day) continue;
    held.set(e.symbol, (held.get(e.symbol) ?? 0n) + e.quantityDeltaE8);
  }
  return held;
}
