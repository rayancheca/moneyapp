import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { resolvePeriod, withPeriod } from "@/lib/period";
import type { EatingOutCard as EatingOutCardData } from "@/services/eating-out";
import type { SubscriptionsCard as SubscriptionsCardData } from "@/services/subscriptions-card";
import { EatingOutCard } from "./EatingOutCard";
import { SubscriptionsCard } from "./SubscriptionsCard";

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/**
 * 🔴 Two captions beside the runway card spelled `baselineWindow` themselves.
 * Replayed on the owner's ledger they read "Averaged over 1 complete months,
 * Sep 2022" (today 2022-10-15) beside the runway's "1 complete month", and the
 * subscriptions card "over 0 complete months, Sep 2022" (today 2022-09-10) —
 * a range made of the month the same sentence says it did not count.
 */
describe("the window captions beside the runway card", () => {
  const eatingOut = (months: number): EatingOutCardData => ({
    monthlyCents: 24057,
    groceriesMonthlyCents: 1772,
    multipleOfGroceries: 13.6,
    eatingOut: [{ name: "Dining", unit: "visit", spentCents: 24057, count: 21, averageTicketCents: 1146 }],
    groceries: { name: "Groceries", unit: "trip", spentCents: 1772, count: 2, averageTicketCents: 886 },
    totalSpentCents: 24057,
    totalCount: 21,
    averageTicketCents: 1146,
    purchasesPerDay: 0.7,
    months,
    fromMonth: "2022-09",
    toMonth: "2022-09",
    // the rule `eatingOutCard` builds its link with, over this fixture's window
    spendingHref: withPeriod(
      "/spending",
      resolvePeriod({ period: null, from: "2022-09-01", to: "2022-09-30" }, "2022-10-15"),
    ),
    isEmpty: false,
  });

  const subscriptions = (months: number): SubscriptionsCardData =>
    ({
      liveMonthlyCents: 10000,
      lapsedMonthlyCents: 0,
      live: [],
      lapsed: [],
      lapsedSharePct: 0,
      neverBilledMonthlyCents: 0,
      neverBilledSharePct: null,
      largestLapsed: null,
      postedCents: 4500,
      postedCount: 3,
      unforecastableCount: 0,
      endedCount: 0,
      months,
      fromMonth: "2022-09",
      toMonth: "2022-09",
      today: "2022-10-15",
    }) as unknown as SubscriptionsCardData;

  test("one month is one complete month, on both cards", () => {
    const eat = text(renderToStaticMarkup(createElement(EatingOutCard, { data: eatingOut(1) })));
    expect(eat).toContain("Averaged over 1 complete month, Sep 2022.");
    expect(eat).not.toContain("1 complete months");

    const subs = text(renderToStaticMarkup(createElement(SubscriptionsCard, { data: subscriptions(1) })));
    expect(subs).toContain("over 1 complete month, Sep 2022, refunds netted off");
    expect(subs).not.toContain("1 complete months");
  });

  test("zero months names no range", () => {
    const subs = text(renderToStaticMarkup(createElement(SubscriptionsCard, { data: subscriptions(0) })));
    expect(subs).not.toContain("0 complete months");
    expect(subs).not.toContain("Sep 2022");
    expect(subs).toContain("No complete month has been imported yet");
  });

  /*
   * 🔴 The fixture's link read `/spending?period=2022-09` — Sep 2022, but in a
   * spelling `eatingOutCard` never builds. For a complete-month window it builds
   * `withPeriod("/spending", resolvePeriod({ period: null, from, to }, today))`,
   * the from/to form `spending-links.test.ts` pins on the rendered card. No
   * assertion read it, so nothing failed; an href assertion copied from this
   * fixture would have pinned the wrong string.
   */
  test("the Spending link opens the month the caption names, as the service spells it", () => {
    const eat = renderToStaticMarkup(createElement(EatingOutCard, { data: eatingOut(1) }));
    expect(eat).toContain('href="/spending?from=2022-09-01&amp;to=2022-09-30"');
  });

  /**
   * 🔴 "Together these took $2,150.00 out across 1 charges over 6 complete
   * months" — the e2e fixture holds exactly ONE posted subscription charge
   * (measured on a freshly seeded copy at its today, 2026-07-08), and the
   * dashboard-grid baseline carries the sentence. The numeral stays, as every
   * other count on the card keeps its numeral; only the noun agrees with it.
   */
  test("one charge is one charge, and the numeral stays", () => {
    const one = text(
      renderToStaticMarkup(createElement(SubscriptionsCard, { data: { ...subscriptions(6), postedCount: 1 } })),
    );
    expect(one).toContain("out across 1 charge over 6 complete months");
    expect(one).not.toContain("1 charges");

    const three = text(renderToStaticMarkup(createElement(SubscriptionsCard, { data: subscriptions(6) })));
    expect(three).toContain("out across 3 charges over 6 complete months");
  });

  test("a full window reads exactly as it did", () => {
    const eat = text(
      renderToStaticMarkup(
        createElement(EatingOutCard, { data: { ...eatingOut(6), fromMonth: "2026-03", toMonth: "2026-08" } }),
      ),
    );
    expect(eat).toContain(
      "Averaged over 6 complete months, Mar 2026 to Aug 2026. This month is still running and is not counted.",
    );
  });
});
