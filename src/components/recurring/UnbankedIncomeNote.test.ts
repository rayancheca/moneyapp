import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { MonthForecast } from "@/services/forecast";
import { UnbankedIncomeNote } from "./ForecastCard";

const text = (unbanked: MonthForecast["unbankedIncome"]): { html: string; words: string } => {
  const html = renderToStaticMarkup(createElement(UnbankedIncomeNote, { unbanked }));
  const words = html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return { html, words };
};

const cashJob = { totalCents: 209_400, occurrenceCount: 2, names: ["Cash job (weekly pay)"] };

/**
 * 🔴 /recurring said, in warning tone, "2 paydays worth $2,094.00 already
 * passed this month with no deposit imported (Cash job (weekly pay)) … Cash pay
 * that never reaches a bank cannot be projected as arriving" of Sep 3 and Sep
 * 10, while the account that pay lands in had been checked through Aug 12
 * (measured 2026-09-15). (Its "Cash pay" is "Pay" since 2026-10-14: payroll too.)
 */
describe("UnbankedIncomeNote — /recurring names unchecked paydays as not looked for, not unbanked", () => {
  test("every payday after the frontier: no 'never reaches a bank', and no warning tone", () => {
    const { html, words } = text({
      ...cashJob,
      checkedOccurrenceCount: 0,
      pastGraceOccurrenceCount: 0,
      frontier: { kind: "day", through: "2026-08-12" },
    });
    expect(words).toBe(
      "2 paydays worth $2,094.00 already passed this month (Cash job (weekly pay)) — not counted above, and not in EOM cash. " +
        "Both fall after Wed, Aug 12, 2026, the last day every account that pay lands in has been checked through — so the ledger has not looked for their deposits. " +
        "Pay the ledger has not looked for cannot be projected as arriving; the month strip below counts it, because that line is the schedule.",
    );
    expect(words).not.toMatch(/no deposit imported|never reaches a bank/);
    expect(html).not.toContain("text-warning");
  });

  /*
   * ⚖️ "Pay", not "Cash pay": an app label, and since Aug 27 his pay is payroll by ACH into Wells Fargo (decision 55).
   * 🔴 The note called every checked payday with no deposit "Cash pay that never reaches a bank" — of a payroll too.
   */
  test("every payday checked through its days to land: 'Pay that never reaches a bank', in warning tone", () => {
    const { html, words } = text({
      ...cashJob,
      checkedOccurrenceCount: 2,
      pastGraceOccurrenceCount: 2,
      frontier: { kind: "day", through: "2026-09-14" },
    });
    expect(words).toBe(
      "2 paydays worth $2,094.00 already passed this month with no deposit imported (Cash job (weekly pay)) — not counted above, and not in EOM cash. " +
        "Pay that never reaches a bank cannot be projected as arriving; the month strip below counts it, because that line is the schedule.",
    );
    expect(words).not.toContain("Cash pay");
    expect(html).toContain("text-warning");
  });

  /*
   * ⚖️ A payday whose day is checked but not the days after it its deposit may still land on (its series' tolerance,
   * settlement's anchor clause) is no warning: a payroll a day late answers it. 🔴 The split ignored the tolerance, and
   * a Thursday checked through Friday read "Cash pay that never reaches a bank", in warning tone, of pay due Sunday.
   */
  test("checked on their days but inside their days to land: quiet, and never 'never reaches a bank'", () => {
    const { html, words } = text({
      ...cashJob,
      checkedOccurrenceCount: 2,
      pastGraceOccurrenceCount: 0,
      frontier: { kind: "day", through: "2026-09-11" },
    });
    expect(words).toBe(
      "2 paydays worth $2,094.00 already passed this month with no deposit imported (Cash job (weekly pay)) — not counted above, and not in EOM cash. " +
        "Pay not banked yet cannot be projected as arriving; the month strip below counts it, because that line is the schedule.",
    );
    expect(html).not.toContain("text-warning");
  });

  test("a window straddling the frontier keeps the warning for the checked payday and names the rest", () => {
    const { html, words } = text({
      totalCents: 314_100,
      occurrenceCount: 3,
      names: ["Cash job (weekly pay)"],
      checkedOccurrenceCount: 1,
      pastGraceOccurrenceCount: 1,
      frontier: { kind: "day", through: "2026-08-12" },
    });
    expect(words).toContain(
      "1 falls on a day already checked, with no deposit; the other 2 fall after Wed, Aug 12, 2026, the last day every account that pay lands in has been checked through. Pay that never reaches a bank",
    );
    expect(words).not.toContain("with no deposit imported");
    expect(html).toContain("text-warning");
  });

  /*
   * ⚖️ Default built, not asked (2026-10-21): the closing subject names the paydays nobody has looked for too, in the
   * forecast's own words for them. 🔴 It named only the checked ones — "Pay not banked yet cannot be projected as
   * arriving" of two paydays after the checked day beside one inside its days to land (review of the pay-words batch).
   */
  test("straddling the frontier, the closing subject covers the paydays nobody has looked for too", () => {
    const straddle = {
      totalCents: 314_100,
      occurrenceCount: 3,
      names: ["Cash job (weekly pay)"],
      checkedOccurrenceCount: 1,
      frontier: { kind: "day" as const, through: "2026-08-12" },
    };
    expect(text({ ...straddle, pastGraceOccurrenceCount: 1 }).words).toContain(
      "Pay that never reaches a bank, and pay the ledger has not looked for, cannot be projected as arriving;",
    );
    expect(text({ ...straddle, pastGraceOccurrenceCount: 0 }).words).toContain(
      "Pay not banked yet, and pay the ledger has not looked for, cannot be projected as arriving;",
    );
    // …and with every payday checked, or none, the one subject it always had
    expect(text({ ...straddle, checkedOccurrenceCount: 3, pastGraceOccurrenceCount: 0 }).words).toContain(
      "Pay not banked yet cannot be projected as arriving;",
    );
  });

  test("two schedules checked through different days: the note names no day for either", () => {
    const { words } = text({
      totalCents: 400_000,
      occurrenceCount: 4,
      names: ["Cash job (weekly pay)", "Tutoring"],
      checkedOccurrenceCount: 1,
      pastGraceOccurrenceCount: 1,
      frontier: { kind: "per-schedule" },
    });
    expect(words).toContain(
      "1 falls on a day already checked, with no deposit; the other 3 fall after the last day the accounts their pay lands in have been checked through, which differs by schedule.",
    );
    expect(words).not.toMatch(/\b(?:Aug|Sep) \d/);
  });
});

/*
 * 🔴 THE CALLER THE SWEEP MISSED (review of 082a0ef5, B1, MEDIUM): EOM cash is spendable cash today plus the committed
 * net, so it holds every posted deposit on a spendable account, attached or not. On a copy of his pre-filing ledger with
 * the five October payroll rows filed Salary from the review queue (four attached to nothing), read Oct 29, the note
 * said "3 paydays worth $3,425.76 already passed this month … — not counted above, and not in EOM cash" over an EOM
 * cash of $6,442.78 — the same $6,442.78 as with the rows attached, the $3,425.76 in it through Wells Fargo's balance.
 *
 * ⛔ "Not in EOM cash" only of the paydays no row EOM cash holds answers (`MonthForecast.unbankedIncome.inEomCash`,
 * `leftOutOf`); "not counted above" stays, of all of them: no line of the forecast projects a passed payday.
 */
describe("UnbankedIncomeNote — 'not in EOM cash' only of the paydays no row EOM cash holds answers", () => {
  const PAYROLL = 114_192;
  const matchOn = (date: string) => ({ date, row: { id: `r-${date}`, postedOn: date, amountCents: PAYROLL } });
  const ROWS = ["2026-10-01", "2026-10-08", "2026-10-22"].map(matchOn);
  const october = {
    totalCents: 3 * PAYROLL,
    occurrenceCount: 3,
    names: ["It America LLC (weekly pay)"],
    checkedOccurrenceCount: 3,
    pastGraceOccurrenceCount: 3,
    frontier: { kind: "day" as const, through: "2026-10-26" },
    unattached: ROWS,
  };
  const PAY_MATCHED =
    "Pay matched to the cent by rows of $1,141.92 on Thu, Oct 1, 2026, Thu, Oct 8, 2026, and Thu, Oct 22, 2026 that " +
    "are not attached to it cannot be projected as arriving; the month strip below counts it, because that line is " +
    "the schedule.";

  // ⛔ …and "not counted above" — the forecast's lines — never read of the EOM cash that holds them
  test("rows EOM cash holds for every payday: not counted above, though EOM cash holds those rows", () => {
    expect(text({ ...october, inEomCash: ROWS }).words).toBe(
      "3 paydays worth $3,425.76 already passed this month with no deposit attached to it (It America LLC (weekly " +
        `pay)) — not counted above, though EOM cash holds the rows that match them. ${PAY_MATCHED}`,
    );
    const one = { ...october, totalCents: PAYROLL, occurrenceCount: 1, checkedOccurrenceCount: 1 };
    expect(text({ ...one, pastGraceOccurrenceCount: 1, unattached: ROWS.slice(0, 1), inEomCash: ROWS.slice(0, 1) }).words)
      .toContain("— not counted above, though EOM cash holds the row that matches it. Pay matched to the cent by a row");
  });

  test("…for some: the money no row it holds answers is the part not in EOM cash — Oct 29, read Oct 30", () => {
    const { words } = text({
      ...october,
      totalCents: 4 * PAYROLL,
      occurrenceCount: 4,
      inEomCash: ROWS,
    });
    expect(words).toContain(
      "4 paydays worth $4,567.68 already passed this month (It America LLC (weekly pay)) — not counted above, and " +
        "$1,141.92 of it not in EOM cash. 3 fall on days already checked,",
    );
  });

  test("rows it does not hold — on an account outside cash, or after its balance's day — take nothing back", () => {
    expect(text({ ...october, inEomCash: [] }).words).toBe(
      "3 paydays worth $3,425.76 already passed this month with no deposit attached to it (It America LLC (weekly " +
        `pay)) — not counted above, and not in EOM cash. ${PAY_MATCHED}`,
    );
  });
});
