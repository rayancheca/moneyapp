import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { UnattachedMatch } from "@/lib/unattached-match";
import { PassedPaydaysLine, type PassedPaydaysLineProps } from "./PassedPaydaysLine";

/**
 * /budgets' line under its header naming the paydays that passed this month with no deposit against them — the third
 * leg, which "in so far" and "still expected" leave out.
 *
 * 🔴 No unit test read this sentence (review of 082a0ef5, B4, MEDIUM): IncomeSoFar.test.ts read page.tsx only as
 * source, and the two mutants the review named — `{"."}`, the claim always held back, and `{" — counted in neither
 * figure above."}`, the claim always said — passed every IncomeSoFar, budgets and income-card test (204/204). The line
 * is its own component now, so a test renders it.
 *
 * ⛔ "Counted in neither figure above" only of the paydays no row "in so far" holds answers (`leftOutOf`, over
 * `IncomeExpectation.passedUnpaidInSoFar`): measured on a copy of his pre-filing ledger with the five October payroll
 * rows filed Salary from the review queue, four attached to nothing, "$4,767.68 in so far" holds Oct 1, 8 and 22's
 * rows — and on Oct 30 nobody has looked for Oct 29, the payday no row answers.
 */

const PAYROLL = 114_192;
const matchOn = (date: string): UnattachedMatch => ({
  date,
  row: { id: `r-${date}`, postedOn: date, amountCents: PAYROLL },
});
const ROWS = ["2026-10-01", "2026-10-08", "2026-10-22"].map(matchOn);

/** Oct 1, 8 and 22 checked through their days to land, their rows matched to the cent and filed Salary (Oct 29) */
const OCT_29: PassedPaydaysLineProps["income"] = {
  passedUnpaidCents: 3 * PAYROLL,
  passedUnpaidOccurrences: 3,
  passedUnpaidCheckedOccurrences: 3,
  passedUnpaidFrontier: { kind: "day", through: "2026-10-26" },
  passedUnpaidUnattached: ROWS,
  passedUnpaidInSoFar: ROWS,
};
/** …and the day after: Oct 29 passed too, after Oct 26, with no row */
const OCT_30: PassedPaydaysLineProps["income"] = {
  ...OCT_29,
  passedUnpaidCents: 4 * PAYROLL,
  passedUnpaidOccurrences: 4,
};

const text = (income: PassedPaydaysLineProps["income"]): string =>
  renderToStaticMarkup(createElement(PassedPaydaysLine, { income }))
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const IMPORTS = "That is evidence about what has been imported, not about whether the money was earned.";
const NAMED =
  "matched to the cent by rows of $1,141.92 on Oct 1, Oct 8, and Oct 22 that are not attached to it";

describe("PassedPaydaysLine — /budgets' passed paydays, and the figures they are in neither of", () => {
  test("a payday no row answers is counted in neither figure above — the claim stands", () => {
    expect(
      text({
        ...OCT_29,
        passedUnpaidCents: PAYROLL,
        passedUnpaidOccurrences: 1,
        passedUnpaidCheckedOccurrences: 1,
        passedUnpaidUnattached: [],
        passedUnpaidInSoFar: [],
      }),
    ).toBe(`1 payday worth $1,141.92 already passed this month with no deposit against it — counted in neither figure above. ${IMPORTS}`);
  });

  test("rows 'in so far' holds for every payday: the paydays are named, never called counted in neither", () => {
    expect(text(OCT_29)).toBe(
      `3 paydays worth $3,425.76 already passed this month with no deposit attached to them, ${NAMED}. ${IMPORTS}`,
    );
  });

  test("…and for some: the money no row it holds answers keeps the claim, as part of the paydays' money", () => {
    expect(text(OCT_30)).toBe(
      "4 paydays worth $4,567.68 already passed this month — $1,141.92 of it counted in neither figure above. 3 fall " +
        "on days already checked, with no deposit attached to it — they are matched to the cent by rows of $1,141.92 " +
        "on Thu, Oct 1, 2026, Thu, Oct 8, 2026, and Thu, Oct 22, 2026 that are not attached to it; the other one " +
        "falls after Mon, Oct 26, 2026, the last day every account that pay lands in has been checked through.",
    );
  });

  // ⛔ the rows are named whatever "in so far" holds; only the rows it holds take a payday's claim back
  test("rows the one rule matched that 'in so far' does not hold — unfiled, as imported — take nothing back", () => {
    expect(text({ ...OCT_29, passedUnpaidInSoFar: [] })).toBe(
      `3 paydays worth $3,425.76 already passed this month with no deposit attached to them, ${NAMED} — counted in ` +
        `neither figure above. ${IMPORTS}`,
    );
  });

  test("no payday passed unpaid: no line", () => {
    expect(text({ ...OCT_29, passedUnpaidCents: 0, passedUnpaidOccurrences: 0 })).toBe("");
  });

  test("the page draws the line with this, and says none of it itself", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/budgets/page.tsx"), "utf8");
    expect(page).toMatch(/<PassedPaydaysLine\s/);
    expect(page).not.toContain("counted in neither figure above");
    expect(page).not.toContain("with no deposit against");
  });
});
