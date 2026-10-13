import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { formatDayLong } from "@/lib/format-date";
import { IMPORTS_NOT_EARNINGS, unbankedIncomeFrontierClause } from "@/lib/unbanked-income";
import type { SeriesDetail } from "@/services/recurring-detail";
import { PassedPaydaysCard } from "./PassedPaydaysCard";

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

type Passed = NonNullable<SeriesDetail["unbankedPaydays"]>;

function render(passed: Passed): { heading: string; headingClass: string; body: string; rows: string[] } {
  const html = decode(renderToStaticMarkup(createElement(PassedPaydaysCard, { passed })));
  const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const h2 = /<h2 class="([^"]*)">([\s\S]*?)<\/h2>/.exec(html);
  return {
    headingClass: h2?.[1] ?? "",
    heading: strip(h2?.[2] ?? ""),
    body: strip(/<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ""),
    rows: [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => strip(m[1]!)),
  };
}

/** His October, on a copy of his ledger 2026-10-12: Wells Fargo, where the payroll lands, checked through Sep 24. */
const october: Passed = {
  totalCents: 228_384,
  occurrenceCount: 2,
  checkedOccurrenceCount: 0,
  frontier: { kind: "day", through: "2026-09-24" },
  paydays: [
    { date: "2026-10-01", amountCents: 114_192 },
    { date: "2026-10-08", amountCents: 114_192 },
  ],
};

/**
 * 🔴 `/recurring/<It America LLC (weekly pay)>` on a copy of his ledger 2026-10-12 read "Awaiting statements" and
 * "Next expected Oct 15" and said nothing of Oct 1 or Oct 8, while the forecast on /recurring said "2 paydays worth
 * $2,283.84 already passed this month … so the ledger has not looked for their deposits". The pay page now says it
 * in the forecast's words (`passedPaydaysWords`), laid out as a bill's page lays out what came due.
 */
describe("PassedPaydaysCard — the pay page names what the forecast names, in its words", () => {
  test("his October: both paydays after the frontier, quiet, each listed at +$1,141.92", () => {
    const r = render(october);
    expect(r.heading).toBe("2 paydays worth $2,283.84 already passed this month");
    expect(r.headingClass).not.toContain("text-warning");
    expect(r.body).toBe(
      "They all fall after Thu, Sep 24, 2026, the last day every account that pay lands in has been checked through " +
        "— so the ledger has not looked for their deposits.",
    );
    // the forecast's own clause, not a copy of it
    expect(r.body).toBe(unbankedIncomeFrontierClause(october, formatDayLong));
    expect(r.rows).toEqual(["Oct 1, 2026 +$1,141.92", "Oct 8, 2026 +$1,141.92"]);
  });

  test("every payday on a checked day: the forecast's 'with no deposit imported', in its warning tone", () => {
    const r = render({ ...october, checkedOccurrenceCount: 2, frontier: { kind: "day", through: "2026-10-11" } });
    expect(r.heading).toBe("2 paydays worth $2,283.84 already passed this month with no deposit imported");
    expect(r.headingClass).toContain("text-warning");
    expect(r.body).toBe(IMPORTS_NOT_EARNINGS);
  });

  test("a month straddling the frontier: the clause splits them, and the checked one keeps the warning", () => {
    const r = render({ ...october, checkedOccurrenceCount: 1, frontier: { kind: "day", through: "2026-10-01" } });
    expect(r.heading).toBe("2 paydays worth $2,283.84 already passed this month");
    expect(r.headingClass).toContain("text-warning");
    expect(r.body).toBe(
      "1 falls on a day already checked, with no deposit; the other one falls after Thu, Oct 1, 2026, the last day " +
        "every account that pay lands in has been checked through.",
    );
  });

  test("one payday, an account with no checked record", () => {
    const r = render({
      totalCents: 114_192,
      occurrenceCount: 1,
      checkedOccurrenceCount: 0,
      frontier: { kind: "unchecked" },
      paydays: [{ date: "2026-10-01", amountCents: 114_192 }],
    });
    expect(r.heading).toBe("1 payday worth $1,141.92 already passed this month");
    expect(r.body).toBe(
      "The ledger has not checked every account that pay could land in, so it cannot say whether any of it arrived.",
    );
    expect(r.rows).toEqual(["Oct 1, 2026 +$1,141.92"]);
  });
});
