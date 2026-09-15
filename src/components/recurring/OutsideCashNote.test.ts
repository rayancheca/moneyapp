import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { MonthForecast } from "@/services/forecast";
import { OutsideCashNote } from "./ForecastCard";

const words = (outside: MonthForecast["outsideCash"]): string =>
  renderToStaticMarkup(createElement(OutsideCashNote, { outside }))
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * ⚖️ Owner decision 2026-09-15 (3): Robinhood Cash and Robinhood Agentic are
 * what selling investments would add, not month-end cash — and so is what posts
 * to them. The card's two EOM cash figures leave that out while its nets and
 * its EOM net worth keep it, so without this line the headline's EOM cash minus
 * the pace row's no longer equals the headline's net minus the pace row's, and
 * nothing on the card says why.
 */
describe("OutsideCashNote — the forecast card names what its EOM cash leaves out", () => {
  test("nothing posts outside cash: no note", () => {
    expect(words({ netCents: 0, committedNetCents: 0, accountNames: [] })).toBe("");
  });

  /**
   * 🔴 A half that is $0.00 says nothing. Measured on the owner's ledger
   * 2026-09-15, every month the calendar pages to printed "$0.00 in the
   * headline and +$19.43 at your recent pace" (October +$55.88, November
   * +$92.33, December +$128.78): no commitment posts to Robinhood Cash, so the
   * headline's EOM cash leaves out nothing, and the sentence said so as money.
   * The e2e fixture printed "$0.00 in the headline and -$3.87 at your recent pace".
   */
  test("only the pace posts outside cash: one amount, under the reading it belongs to", () => {
    expect(words({ netCents: 1943, committedNetCents: 0, accountNames: ["Robinhood Cash"] })).toBe(
      "EOM cash at your recent pace leaves out the +$19.43 projected to post to Robinhood Cash by month end, because that is money selling investments would add, not cash you can spend. " +
        "EOM net worth keeps it.",
    );
  });

  test("only the headline posts outside cash (the pace nets it to zero): one amount, under the headline", () => {
    expect(words({ netCents: 0, committedNetCents: -1200, accountNames: ["Robinhood Brokerage"] })).toBe(
      "EOM cash in the headline leaves out the -$12.00 projected to post to Robinhood Brokerage by month end, because that is money selling investments would add, not cash you can spend. " +
        "EOM net worth keeps it.",
    );
  });

  test("both readings leave out a different amount: both, each under the reading it belongs to", () => {
    expect(words({ netCents: -387, committedNetCents: -500, accountNames: ["Robinhood Brokerage"] })).toBe(
      "EOM cash leaves out what is projected to post to Robinhood Brokerage by month end, because that is money selling investments would add, not cash you can spend: " +
        "-$5.00 in the headline and -$3.87 at your recent pace. EOM net worth keeps it.",
    );
  });

  test("the same amount in both readings is said once, and every account is named", () => {
    expect(words({ netCents: -980, committedNetCents: -980, accountNames: ["Robinhood Brokerage", "Robinhood Cash"] })).toBe(
      "EOM cash leaves out the -$9.80 projected to post to Robinhood Brokerage and Robinhood Cash by month end, because that is money selling investments would add, not cash you can spend. " +
        "EOM net worth keeps it.",
    );
  });

  /**
   * The invariant, over every shape a half can take — zero, `-0`, and a
   * non-zero amount of either sign: the note prints nothing exactly when both
   * halves are zero, and otherwise never prints a zero amount, in any spelling.
   */
  test("no shape of the two halves prints a zero amount, and only two zeros print no note", () => {
    const halves = [0, -0, 1943, -387];
    for (const netCents of halves) {
      for (const committedNetCents of halves) {
        const note = words({ netCents, committedNetCents, accountNames: ["Robinhood Cash"] });
        const shape = JSON.stringify({ netCents: Object.is(netCents, -0) ? "-0" : netCents, committedNetCents: Object.is(committedNetCents, -0) ? "-0" : committedNetCents });
        expect(note === "", shape).toBe(netCents === 0 && committedNetCents === 0);
        expect(note, shape).not.toMatch(/\$0\.00/);
      }
    }
  });
});
