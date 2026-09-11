import { xirr, type CashFlow } from "./xirr";
import { formatDayFull } from "./format-date";

/**
 * A window's money-weighted return, or an explicit refusal to state one.
 *
 * Pure, and separated from the service that gathers its inputs, because the
 * REFUSALS are the valuable part and they need the 100%-branch gate over them.
 * A mutation that deleted the incomplete-opening guard survived the service's
 * own tests: it takes a seeded portfolio with prices and holdings to reach that
 * branch through the database, so in practice it was never reached at all.
 *
 * ⛔ **An XIRR is dominated by its two boundary valuations.** Measured on the
 * real ledger, 2025 opens on a day when only one of two investment accounts
 * could be valued — $21.70 of visible portfolio against a $65,038.62 close —
 * and a return computed from that reads as an astronomical gain that describes
 * missing data rather than money. Withholding it and saying why is the more
 * useful answer, and it is the rule the coverage panels already follow.
 */

export interface ReturnBoundary {
  day: string;
  valueCents: number;
  /** every investment account could be valued that day */
  complete: boolean;
  coveredAccounts: number;
  totalAccounts: number;
}

export interface MoneyWeightedInput {
  /** the valuation the window opens on, or null when there is none */
  open: ReturnBoundary | null;
  /** the valuation the window closes on, or null when there is none */
  close: ReturnBoundary | null;
  /**
   * External flows inside the window, investor-signed: money INTO the
   * investment is negative, money coming back out is positive. Boundary values
   * are added here, not by the caller.
   */
  flows: readonly CashFlow[];
  /** the last day of the window being described — a year end, typically */
  windowEnd: string;
}

export type MoneyWeightedReturn =
  | {
      computed: true;
      /** an ANNUAL rate, even when the window is shorter than a year */
      rate: number;
      openCents: number;
      closeCents: number;
      /** boundary valuations included */
      flowCount: number;
      fromDay: string;
      throughDay: string;
      /** the window has not finished, so `rate` annualises a partial period */
      partial: boolean;
    }
  | { computed: false; reason: string };

export function moneyWeightedReturn(input: MoneyWeightedInput): MoneyWeightedReturn {
  const { open, close, windowEnd } = input;

  if (!open) return { computed: false, reason: "the portfolio has no valuation to open from" };
  if (!close) return { computed: false, reason: "the portfolio has no valuation to close on" };

  if (!open.complete) {
    return {
      computed: false,
      reason: `the portfolio's value on ${formatDayFull(open.day)} covers only ${open.coveredAccounts} of ${open.totalAccounts} investment accounts, so a return measured from it would be meaningless`,
    };
  }
  if (!close.complete) {
    return {
      computed: false,
      reason: `the portfolio's value on ${formatDayFull(close.day)} covers only ${close.coveredAccounts} of ${close.totalAccounts} investment accounts`,
    };
  }
  /*
   * Opening at nothing is not a rate. With a zero opening the window has no
   * capital to measure a return ON — every cent of the close is a contribution
   * or a gain on contributions, and XIRR's answer depends entirely on which
   * day the money arrived. A first year of investing is exactly this shape.
   */
  if (open.valueCents <= 0) {
    return {
      computed: false,
      reason: `the portfolio was worth nothing on ${formatDayFull(open.day)}, so there is no opening balance to measure a return against`,
    };
  }

  const flows: CashFlow[] = [
    { day: open.day, amountCents: -open.valueCents },
    ...input.flows.filter((f) => f.amountCents !== 0),
    { day: close.day, amountCents: close.valueCents },
  ];

  const rate = xirr(flows);
  if (rate === null) {
    return { computed: false, reason: "these cash flows do not resolve to a single rate of return" };
  }

  return {
    computed: true,
    rate,
    openCents: open.valueCents,
    closeCents: close.valueCents,
    flowCount: flows.length,
    fromDay: open.day,
    throughDay: close.day,
    partial: close.day < windowEnd,
  };
}
