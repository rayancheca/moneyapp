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

  test("only the pace posts outside cash: both amounts, each under the reading it belongs to", () => {
    expect(words({ netCents: 1943, committedNetCents: 0, accountNames: ["Robinhood Cash"] })).toBe(
      "EOM cash leaves out what is projected to post to Robinhood Cash by month end, because that is money selling investments would add, not cash you can spend: " +
        "$0.00 in the headline and +$19.43 at your recent pace. EOM net worth keeps it.",
    );
  });

  test("the same amount in both readings is said once, and every account is named", () => {
    expect(words({ netCents: -980, committedNetCents: -980, accountNames: ["Robinhood Brokerage", "Robinhood Cash"] })).toBe(
      "EOM cash leaves out the -$9.80 projected to post to Robinhood Brokerage and Robinhood Cash by month end, because that is money selling investments would add, not cash you can spend. " +
        "EOM net worth keeps it.",
    );
  });
});
