/**
 * What a set of TICKED holdings adds up to — the payoff for selecting rows in
 * the portfolio table ("tick some holdings and see what they add up to").
 *
 * HONESTY DOCTRINE (the reason this is a module and not three lines of JSX):
 * every figure on a holding row is NULLABLE. An unpriced symbol has no market
 * value, a symbol with one cached close has no day change, and allocation
 * exists only while the portfolio is worth something. Coercing those nulls to
 * 0 would print a total that is WRONG and look confident doing it, so this
 * reducer sums only the values that exist and REPORTS HOW MANY it summed — the
 * caller states that coverage next to the figure ("2 of 3 priced"). A total
 * over zero contributors is null, never $0.00: "none of these is priced" and
 * "these are worth nothing" are different claims and must not render alike.
 *
 * Allocation is summed the same way, and that is correct rather than a
 * double count: services/portfolio.ts computes allocationPct PER LEG
 * (this row's value ÷ the whole portfolio), so two accounts holding the same
 * symbol are two independent shares whose sum is the combined share.
 */

import { formatCents, formatCentsSigned } from "./money";

/** The nullable fields a subtotal reads — HoldingRow satisfies this structurally. */
export interface SubtotalSource {
  valueCents: number | null;
  dayChangeCents: number | null;
  allocationPct: number | null;
}

/** One summed figure: the total, and how many selected rows actually fed it. */
export interface SubtotalFigure {
  /** null when no selected row carried this figure — never a fabricated 0 */
  total: number | null;
  contributors: number;
}

export interface HoldingSubtotal {
  /** rows ticked, priced or not */
  selected: number;
  valueCents: SubtotalFigure;
  dayChangeCents: SubtotalFigure;
  allocationPct: SubtotalFigure;
}

function sumPresent(values: readonly (number | null)[]): SubtotalFigure {
  const present = values.filter((v): v is number => v !== null);
  return {
    total: present.length === 0 ? null : present.reduce((sum, v) => sum + v, 0),
    contributors: present.length,
  };
}

/** Sums the selected holdings, one figure at a time, omitting nothing silently. */
export function subtotalHoldings(rows: readonly SubtotalSource[]): HoldingSubtotal {
  return {
    selected: rows.length,
    valueCents: sumPresent(rows.map((r) => r.valueCents)),
    dayChangeCents: sumPresent(rows.map((r) => r.dayChangeCents)),
    allocationPct: sumPresent(rows.map((r) => r.allocationPct)),
  };
}

/**
 * The disclosure that a total left something out: "2 of 3 priced". Null when
 * every selected row fed the figure, so a complete total carries no caveat.
 */
export function subtotalCoverage(
  figure: SubtotalFigure,
  selected: number,
  contributed: string,
): string | null {
  if (figure.contributors === selected) return null;
  return `${figure.contributors} of ${selected} ${contributed}`;
}

/** Allocation share, at the precision the Alloc column already prints. */
export function formatSharePct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

function withCoverage(text: string, note: string | null): string {
  return note === null ? text : `${text} (${note})`;
}

/**
 * The polite live-region sentence: a screen-reader user hears the whole
 * subtotal — including which rule applied — without hunting for the bar.
 * Empty string when nothing is selected, so the region announces nothing.
 *
 * `dayTerm` is INJECTED rather than hardcoded. This sentence used to end
 * "…, +$481.18 today." — but the summed figure is each holding's last close
 * against its previous one, which is only today's move when prices were
 * refreshed today. On the real ledger the closes trail by a week, so the word
 * was false on every read, in the one channel whose user cannot see the
 * price-age note that contradicts it.
 *
 * It is a bare LABEL ("today", "last close") and never a pair of dates: the
 * subtotal spans holdings that may each carry a different `quotedOn`, so there
 * is no single interval this sentence could honestly name. Same reason
 * `holdingPriceSectionNotes` anchors on the oldest close instead of claiming
 * one date for every position.
 */
export function subtotalAnnouncement(subtotal: HoldingSubtotal, dayTerm: string): string {
  if (subtotal.selected === 0) return "";
  const head = `${subtotal.selected} holding${subtotal.selected === 1 ? "" : "s"} selected`;
  const value =
    subtotal.valueCents.total === null
      ? "no market value — none of them is priced"
      : withCoverage(
          formatCents(subtotal.valueCents.total),
          subtotalCoverage(subtotal.valueCents, subtotal.selected, "priced"),
        );
  const share =
    subtotal.allocationPct.total === null
      ? "no share of the portfolio"
      : withCoverage(
          `${formatSharePct(subtotal.allocationPct.total)} of the portfolio`,
          subtotalCoverage(subtotal.allocationPct, subtotal.selected, "with a share"),
        );
  const day =
    subtotal.dayChangeCents.total === null
      ? "no day change"
      : withCoverage(
          `${formatCentsSigned(subtotal.dayChangeCents.total)} ${dayTerm}`,
          subtotalCoverage(subtotal.dayChangeCents, subtotal.selected, "with a day change"),
        );
  return `${head}: ${value}, ${share}, ${day}.`;
}
