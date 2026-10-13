import { describe, expect, test } from "vitest";
import { formatCents } from "@/lib/money";
import {
  seriesEndHeadline,
  seriesEndInput,
  seriesEndLines,
  seriesEndReassurance,
  type SeriesEndInput,
  type SeriesEndSubject,
} from "./end-radius";

const base: SeriesEndInput = {
  kind: "bill",
  drawnAsRecurringByEnding: false,
  annualizedCents: -2_530_800,
  overdueCents: 0,
  overdueUnreadCents: 0,
  overdueOn: null,
  overdueCount: 0,
  nextChargeOn: "2026-10-01",
  endsOn: null,
  linkedCount: 4,
};

/** Arrears of `cents` on days no checked statement has reached. */
const unread = (cents: number): SeriesEndInput => ({ ...base, overdueCents: cents, overdueUnreadCents: cents });
const labels = (i: SeriesEndInput) => seriesEndLines(i, formatCents).map((l) => l.label);
const value = (i: SeriesEndInput, label: string) =>
  seriesEndLines(i, formatCents).find((l) => l.label === label)?.value;

/**
 * 🔴 `/recurring/<Flamingo South Beach (rent)>`, 2026-09-10: the dialog read
 * "Upcoming charges off the calendar: 3 charges" — Oct 1, Nov 1, Dec 1 — over a
 * Sep 1 charge of $2,109.00 the same page shows as "Already due, and not
 * posted … The forecast counts it, and so does this month's budget", and which
 * ending the series removes too.
 */
describe("seriesEndLines", () => {
  test("nothing overdue names no arrears line at all", () => {
    expect(labels(base)).toEqual([
      "Leaving the forecast",
      "Upcoming charges off the calendar",
      "Linked transactions kept",
    ]);
  });

  test("the arrears come BEFORE the future, as they do on /budgets", () => {
    // rent's Sep 1, on a day no checked statement had reached
    const late = { ...unread(210_900), overdueOn: "2026-09-01", overdueCount: 1 };
    expect(labels(late)).toEqual([
      "Leaving the forecast",
      "Already due this month, no statement has covered it yet",
      "Upcoming charges off the calendar",
      "Linked transactions kept",
    ]);
    expect(value(late, "Already due this month, no statement has covered it yet")).toBe("$2,109.00");
  });

  test("more than one late occurrence says how many", () => {
    const late = { ...unread(421_800), overdueOn: "2026-09-01", overdueCount: 2 };
    expect(value(late, "Already due this month, no statement has covered it yet")).toBe("$4,218.00 across 2 charges");
  });

  /*
   * 🔴 "Already due this month, not imported" whatever the ledger had read. Where an import HAD covered the day, the
   * page's own card said "Already due, and not posted" in warning colour while this dialog, on the same page, said
   * "not imported" — false of a day that was imported (review of 2e6c74b, 2026-10-08). ⛔ The card's split, the
   * runway's (`arrearsClause`): "not posted" only of read days, "no statement has covered it yet" of the rest.
   */
  test("a due day the ledger has read says not posted — the card's words, not 'not imported'", () => {
    const late = { ...base, overdueCents: 210_900, overdueUnreadCents: 0, overdueOn: "2026-07-01", overdueCount: 1 };
    expect(labels(late)).toContain("Already due this month, not posted");
    expect(labels(late).join(" ")).not.toMatch(/not imported|no import/);
    expect(value(late, "Already due this month, not posted")).toBe("$2,109.00");
  });

  test("a mix names both halves by amount, as the card does", () => {
    const late = { ...base, overdueCents: 3_000, overdueUnreadCents: 1_000, overdueOn: "2026-07-01", overdueCount: 3 };
    const label = "Already due this month, $20.00 not posted, and no statement has covered the other $10.00 yet";
    expect(labels(late)).toContain(label);
    expect(value(late, label)).toBe("$30.00 across 3 charges");
  });

  test("an open-ended series loses EVERY charge, not three", () => {
    // 🔴 NEXT_EXPECTED_COUNT = 3 caps the preview; "3 charges" was that cap
    expect(value(base, "Upcoming charges off the calendar")).toBe(
      "every charge from Oct 1, 2026 on",
    );
  });

  test("a series with an end date names the span it really loses", () => {
    expect(value({ ...base, endsOn: "2027-06-01" }, "Upcoming charges off the calendar")).toBe(
      "every charge from Oct 1, 2026 to Jun 1, 2027",
    );
  });

  test("nothing projected says so rather than naming a span", () => {
    expect(value({ ...base, nextChargeOn: null }, "Upcoming charges off the calendar")).toBe(
      "none scheduled",
    );
  });

  test("the forecast line is dropped when the series carries no annual figure", () => {
    expect(labels({ ...base, annualizedCents: null })).toEqual([
      "Upcoming charges off the calendar",
      "Linked transactions kept",
    ]);
  });

  test("one linked transaction is singular", () => {
    expect(value({ ...base, linkedCount: 1 }, "Linked transactions kept")).toBe("1 transaction");
    expect(value(base, "Linked transactions kept")).toBe("4 transactions");
  });

  /*
   * 🔴 The page's "Nothing expected" card learned to word itself by kind and the End dialog on the same page did not.
   * On his ledger copy 2026-10-12 `/recurring/<It America LLC (weekly pay)>`'s dialog read "Upcoming charges off the
   * calendar · every charge from Oct 15, 2026 on" — of his weekly deposits. ⛔ The card's words (`seriesPostingWords`);
   * a bill's and a subscription's are as he has always read them.
   */
  test("worded by what the series posts: pay's deposits, a transfer's transfers, an other series' payments", () => {
    const pay: SeriesEndInput = { ...base, kind: "income", annualizedCents: 5_937_984, nextChargeOn: "2026-10-15" };
    expect(labels(pay)).toEqual(["Leaving the forecast", "Upcoming deposits off the calendar", "Linked transactions kept"]);
    expect(value(pay, "Upcoming deposits off the calendar")).toBe("every deposit from Oct 15, 2026 on");
    expect(value({ ...base, kind: "transfer", endsOn: "2027-06-01" }, "Upcoming transfers off the calendar")).toBe(
      "every transfer from Oct 1, 2026 to Jun 1, 2027",
    );
    const other: SeriesEndInput = { ...unread(3_000), kind: "other", overdueOn: "2026-07-01", overdueCount: 3 };
    expect(value(other, "Already due this month, no statement has covered it yet")).toBe("$30.00 across 3 payments");
    expect(labels(other)).toContain("Upcoming payments off the calendar");
    for (const kind of ["bill", "subscription"] as const) {
      expect(labels({ ...base, kind })).toContain("Upcoming charges off the calendar");
      expect(value({ ...base, kind }, "Upcoming charges off the calendar")).toBe("every charge from Oct 1, 2026 on");
    }
  });

  /*
   * 🔴 Ending a series he said is NOT recurring adds something, and no line said what. Ended draws as recurring and
   * dismissed does not (`seriesDrawsAsRecurring`): its linked rows take the R badge, are drawn on the recurring calendar
   * and leave his recent pace — on his ledger copy 2026-10-12, ending PURA VIDA BAY ROAD MIAMI BEACH moves October's
   * projected spending by -$7.33 and YA-FIT Smoothie Bar by -$10.73. The kept line says they are counted as recurring.
   */
  test("ending a series he said is not recurring says its kept rows are counted as recurring", () => {
    const notRecurring: SeriesEndInput = {
      ...base,
      drawnAsRecurringByEnding: true,
      annualizedCents: null,
      nextChargeOn: null,
      linkedCount: 10,
    };
    expect(labels(notRecurring)).toEqual([
      "Upcoming charges off the calendar",
      "Linked transactions kept, counted as recurring",
    ]);
    expect(value(notRecurring, "Linked transactions kept, counted as recurring")).toBe("10 transactions");
    expect(labels(base)).not.toContain("Linked transactions kept, counted as recurring");
  });
});

/**
 * 🔴 "Nothing is deleted — the charges stay in your ledger" stood under pay's dialog — on his ledger copy 2026-10-12,
 * over It America LLC's deposits and, dismissed, STOCK LENDING (SPY)'s and (COKE)'s, whose own card one block below
 * says "Its deposits below stay in the ledger."
 */
describe("seriesEndReassurance", () => {
  test("names what the series posts, as the card under it does", () => {
    expect(seriesEndReassurance("bill")).toBe(
      "Nothing is deleted — the charges stay in your ledger, and Confirm brings the series back if it starts again.",
    );
    expect(seriesEndReassurance("subscription")).toBe(seriesEndReassurance("bill"));
    expect(seriesEndReassurance("income")).toBe(
      "Nothing is deleted — the deposits stay in your ledger, and Confirm brings the series back if it starts again.",
    );
    expect(seriesEndReassurance("transfer")).toContain("the transfers stay in your ledger");
    expect(seriesEndReassurance("other")).toContain("the payments stay in your ledger");
  });
});

/**
 * 🔴 THE HEADLINE PROMISED WHAT THE LINES DID NOT SHOW. On a LAPSED series the dialog read "Amazon Prime stops being
 * expected: it leaves the forecast, the recurring calendar, and every budget's expected tail." over "Upcoming charges
 * off the calendar · none scheduled" and the kept rows — nothing leaving, because the forecast had already let it go
 * (`seriesIsForecast`), and so had the calendar and every budget's tail. ⛔ The predicate the page's "Nothing
 * expected" card and its cadence sentence ask (`seriesIsProjected`), so the headline cannot disagree with them.
 */
describe("seriesEndHeadline", () => {
  const subject = (over: Partial<SeriesEndSubject>): SeriesEndSubject => ({
    name: "Rent",
    status: "confirmed",
    evidence: "active",
    kind: "bill",
    nextExpectedAmountCents: -210_900,
    isHisPay: false,
    onEarnedVsBanked: false,
    linkedTxns: [],
    ...over,
  });
  const linked = (n: number): readonly unknown[] => Array.from({ length: n }, (_, i) => ({ i }));

  test("a series the forecast projects leaves the forecast, the calendar and every budget's tail", () => {
    for (const status of ["confirmed", "detected"] as const) {
      for (const evidence of ["active", "never-billed", "awaiting-statements", "running-late"] as const) {
        expect(seriesEndHeadline(subject({ status, evidence })), `${status} · ${evidence}`).toBe(
          "Rent stops being expected: it leaves the forecast, the recurring calendar, and every budget's expected tail.",
        );
      }
    }
  });

  /*
   * 🔴 Pay is in no budget's tail — `budgetTail` keeps money out alone (`o.amountCents < 0`) — and on his ledger copy
   * 2026-10-12 `/recurring/<It America LLC (weekly pay)>`'s dialog said it would leave "every budget's expected tail".
   * 🔴 …and then it named the two it left and not what pay IS in (review of 17ff00a): the monthly income /budgets
   * grades against and the runway counts on, and Earned vs banked's line. Each checked against what ending it moves,
   * on a ledger, in `pay-page-passed-paydays.test.ts`.
   */
  test("money in leaves no budget's tail — his pay leaves the income your budgets and runway count on", () => {
    const pay = subject({
      name: "It America LLC (weekly pay)",
      kind: "income",
      evidence: "awaiting-statements",
      nextExpectedAmountCents: 114_192,
      isHisPay: true,
      onEarnedVsBanked: true,
    });
    expect(seriesEndHeadline(pay)).toBe(
      "It America LLC (weekly pay) stops being expected: it leaves the forecast, the recurring calendar, the monthly " +
        "income your budgets and runway count on, and its line on Earned vs banked.",
    );
    expect(seriesEndHeadline({ ...pay, onEarnedVsBanked: false })).toBe(
      "It America LLC (weekly pay) stops being expected: it leaves the forecast, the recurring calendar, and the " +
        "monthly income your budgets and runway count on.",
    );
    // a transfer in, or the agent's income (`isAgentsIncomeSeries`): in neither
    const transferIn = subject({ name: "From savings", kind: "transfer", nextExpectedAmountCents: 50_000 });
    expect(seriesEndHeadline(transferIn)).toBe(
      "From savings stops being expected: it leaves the forecast and the recurring calendar.",
    );
    // ended, his pay is already out of the income too — the same list, as a bill's is the same in both
    expect(seriesEndHeadline({ ...pay, name: "Fordham Payroll", status: "ended", onEarnedVsBanked: false })).toBe(
      "Fordham Payroll is already out of the forecast, the recurring calendar and the monthly income your budgets " +
        "and runway count on, so ending it takes nothing out of them.",
    );
    // an `other` series of money in lapses (only pay never does) — already out of the two that held it
    const refund = subject({ name: "Refund", kind: "other", evidence: "lapsed", nextExpectedAmountCents: 500 });
    expect(seriesEndHeadline(refund)).toBe(
      "Refund is already out of the forecast and the recurring calendar, so ending it takes nothing out of them.",
    );
  });

  test("a lapsed series is already out of all three — ending it takes nothing out of them", () => {
    for (const status of ["confirmed", "detected"] as const) {
      const prime = subject({ name: "Amazon Prime", status, evidence: "lapsed", linkedTxns: linked(3) });
      const headline = seriesEndHeadline(prime);
      expect(headline, status).toBe(
        "Amazon Prime is already out of the forecast, the recurring calendar and every budget's expected tail, so " +
          "ending it takes nothing out of them.",
      );
      expect(headline, status).not.toContain("leaves the forecast");
    }
  });

  /*
   * 🔴 IT SAID ENDING A DISMISSED SERIES "TAKES NOTHING OUT" — and ending it puts things back. Ended draws as recurring
   * and dismissed does not (`seriesDrawsAsRecurring`): its rows are marked recurring in the ledger again, drawn on the
   * recurring calendar (`RECURRING_HISTORY_STATUSES`), and leave his recent pace (`seriesIdsNotDrawnAsRecurring`). On
   * his ledger copy 2026-10-12 STOCK LENDING (SPY) and (COKE) and the dismissed bills read "…is already out of the
   * forecast, the recurring calendar and every budget's expected tail, so ending it takes nothing out of them." —
   * and ending PURA VIDA BAY ROAD MIAMI BEACH moves October's projected spending by -$7.33.
   */
  test("ending a series he said is not recurring says what it puts back", () => {
    const coke = subject({
      name: "STOCK LENDING (COKE)",
      status: "dismissed",
      evidence: "running-late",
      kind: "income",
      nextExpectedAmountCents: 1,
      linkedTxns: linked(6),
    });
    expect(seriesEndHeadline(coke)).toBe(
      'Ending STOCK LENDING (COKE) takes back "not recurring": nothing is expected from it either way, but its ' +
        "deposits count as recurring — marked in your ledger, drawn on the recurring calendar and left out of your " +
        "recent pace.",
    );
    const puraVida = subject({ name: "PURA VIDA", status: "dismissed", evidence: "lapsed", linkedTxns: linked(10) });
    const bill = seriesEndHeadline(puraVida);
    expect(bill).toContain("its charges count as recurring");
    expect(bill).not.toContain("takes nothing out");
    expect(bill).not.toContain("leaves the forecast");
  });

  // ⛔ read off the page's own data, the headline and the kept line say it of the same series, or of neither
  test("the headline and the kept line ask one predicate", () => {
    const said = new Set<boolean>();
    for (const status of ["detected", "confirmed", "dismissed", "ended"] as const) {
      for (const n of [0, 2]) {
        const page = {
          ...subject({ status, evidence: "lapsed", linkedTxns: linked(n) }),
          annualizedCents: null,
          overdue: null,
          nextExpected: [],
          endsOn: null,
          linkedTxns: linked(n) as never[],
        };
        const headline = seriesEndHeadline(page).startsWith("Ending ");
        expect({ status, n, headline }).toEqual({
          status,
          n,
          headline: labels(seriesEndInput(page)).includes("Linked transactions kept, counted as recurring"),
        });
        said.add(headline);
      }
    }
    expect(said).toEqual(new Set([false, true]));
  });

  test("…with nothing linked, there is nothing to put back", () => {
    const zelle = subject({ name: "ZELLE", status: "dismissed", evidence: "never-billed" });
    expect(seriesEndHeadline(zelle)).toBe(
      "ZELLE is already out of the forecast, the recurring calendar and every budget's expected tail, so ending it " +
        "takes nothing out of them.",
    );
  });
});

/*
 * 🔴 Review of 49cc98f — item (4)'s sweep, the series page's End dialog: on a copy of his ledger (2026-10-12) asked
 * about 2026-11-12, his pay's (It America LLC, weekly) read "Upcoming charges off the calendar: every charge from Nov
 * 12, 2026 on" over "Nothing is deleted — the charges stay in your ledger". Its lines are worded by kind
 * (`seriesPostingWords`), as its page's "Nothing expected" card is; a bill's read as before.
 */
describe("seriesEndLines — worded by kind", () => {
  test("his pay loses deposits, a transfer transfers; a bill's lines read as they always have", () => {
    const pay: SeriesEndInput = { ...base, kind: "income", nextChargeOn: "2026-11-12" };
    expect(labels(pay)).toEqual(["Leaving the forecast", "Upcoming deposits off the calendar", "Linked transactions kept"]);
    expect(value(pay, "Upcoming deposits off the calendar")).toBe("every deposit from Nov 12, 2026 on");
    const moved: SeriesEndInput = { ...base, kind: "transfer", endsOn: "2027-06-01" };
    expect(value(moved, "Upcoming transfers off the calendar")).toBe("every transfer from Oct 1, 2026 to Jun 1, 2027");
    for (const kind of ["income", "transfer"] as const) {
      const late: SeriesEndInput = { ...unread(421_800), kind, overdueOn: "2026-09-01", overdueCount: 2 };
      const said = seriesEndLines(late, formatCents).map((l) => `${l.label} ${l.value}`);
      expect(said.join(" · "), kind).not.toMatch(/charge/);
      expect(seriesEndReassurance(kind), kind).not.toMatch(/charge/);
    }
    for (const kind of ["bill", "subscription"] as const) {
      expect(value({ ...base, kind }, "Upcoming charges off the calendar")).toBe("every charge from Oct 1, 2026 on");
    }
    // ⛔ an `other` series' are its payments — it may be money in (`seriesPostingWords`, merged 2026-10-13)
    expect(value({ ...base, kind: "other" }, "Upcoming payments off the calendar")).toBe("every payment from Oct 1, 2026 on");
  });

  test("Nothing is deleted — the deposits of his pay stay in the ledger, the charges of a bill", () => {
    expect(seriesEndReassurance("income")).toBe(
      "Nothing is deleted — the deposits stay in your ledger, and Confirm brings the series back if it starts again.",
    );
    expect(seriesEndReassurance(base.kind)).toBe(
      "Nothing is deleted — the charges stay in your ledger, and Confirm brings the series back if it starts again.",
    );
  });
});
