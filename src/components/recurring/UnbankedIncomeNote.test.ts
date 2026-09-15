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
 * 10, while the account that pay lands in had been read through Aug 12
 * (measured 2026-09-15).
 */
describe("UnbankedIncomeNote — /recurring names unread paydays as unimported, not unbanked", () => {
  test("every payday after the frontier: no 'never reaches a bank', and no warning tone", () => {
    const { html, words } = text({ ...cashJob, checkedOccurrenceCount: 0, checkedThrough: "2026-08-12" });
    expect(words).toBe(
      "2 paydays worth $2,094.00 already passed this month (Cash job (weekly pay)) — not counted above, and not in EOM cash. " +
        "They all fall after Wed, Aug 12, 2026, which nothing has imported yet — so the ledger has not looked for their deposits. " +
        "Pay the ledger has not looked for cannot be projected as arriving; the month strip below counts it, because that line is the schedule.",
    );
    expect(words).not.toMatch(/no deposit imported|never reaches a bank/);
    expect(html).not.toContain("text-warning");
  });

  test("every payday on a read day: the sentence it always printed, in warning tone", () => {
    const { html, words } = text({ ...cashJob, checkedOccurrenceCount: 2, checkedThrough: "2026-09-14" });
    expect(words).toBe(
      "2 paydays worth $2,094.00 already passed this month with no deposit imported (Cash job (weekly pay)) — not counted above, and not in EOM cash. " +
        "Cash pay that never reaches a bank cannot be projected as arriving; the month strip below counts it, because that line is the schedule.",
    );
    expect(html).toContain("text-warning");
  });

  test("a window straddling the frontier keeps the warning for the read payday and names the rest", () => {
    const { html, words } = text({ totalCents: 314_100, occurrenceCount: 3, names: ["Cash job (weekly pay)"], checkedOccurrenceCount: 1, checkedThrough: "2026-08-12" });
    expect(words).toContain(
      "1 falls on a day already read, with no deposit; the other 2 fall after Wed, Aug 12, 2026, which nothing has imported yet. Cash pay that never reaches a bank",
    );
    expect(words).not.toContain("with no deposit imported");
    expect(html).toContain("text-warning");
  });
});
