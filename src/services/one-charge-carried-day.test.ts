import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DbBundle } from "@/db/client";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { SubscriptionsCard } from "@/components/dashboard/SubscriptionsCard";
import { stalenessSentence } from "@/components/recurring/labels";
import { CategorySeriesList } from "@/components/spending/CategorySeriesList";
import { seriesInCategory } from "./category-detail";
import { createCategory } from "./category-edit";
import { checkedThrough } from "./checked-days-fixture";
import { carCard } from "./committed";
import { forecastForMonth } from "./forecast";
import { merchantIntelligence } from "./merchants";
import { closeLedger, openLedger, rentWith, seriesWith, UTIL } from "./nearer-due-day-fixture";
import { listSeries, upcomingOccurrences } from "./recurring";
import { subscriptionsCard } from "./subscriptions-card";

/**
 * ⚖️ (B) The day of a ONE charge billed inside another is the day it FALLS DUE (`oneChargeDueDays`) on every reader but
 * its page's sentence — the day its list, its badge, its End dialog and the calendar name — so "once · Nov 16" on the
 * subscriptions card, the category page and the attach picker (`oneChargePhrase`), the merchant page's "once, on Nov
 * 16," and the staleness sentence's "expected once on Nov 16, 2026". Its page's sentence names its own day, the one its
 * editor saves, with this one beside it: "charges once on Nov 1, due with the rent on Nov 16"
 * (SeriesDetail-carried-end.test.ts). Latent on his ledger: his one charge, the Nov 11 balance, is billed on its own.
 *
 * 🔴 Review of 78d64f6a (L77's what-if): the utilities as one charge on Nov 1 (next and end Nov 1), the rent retyped Nov
 * 16, Wells Fargo read through Nov 9 — from Oct 30 to Nov 16 their page read "Ends Nov 16, 2026" over "Next expected Nov
 * 16, 2026" and the calendar drew Nov 16 upcoming, while the subscriptions card listed "once · Nov 1" among what is still
 * to come — from Nov 2 a day gone by (his ledger copy 2026-11-05, the same what-if).
 */
let bundle: DbBundle;
let categoryId: string;
beforeEach(() => {
  ({ bundle, categoryId } = openLedger());
  rentWith(
    { rentOn: "2026-11-16", typed: true, utilOn: "2026-11-01", utilTyped: true, noneOfTwo: true },
    "2026-07-01",
    "2026-08-02",
    "2026-09-02",
    "2026-10-02",
  );
  bundle.db.update(recurringSeries).set({ userEndsOn: "2026-11-01" }).where(eq(recurringSeries.id, UTIL)).run();
  checkedThrough(bundle.db, "acct", "2026-11-09");
});
afterEach(closeLedger);

/** the days it is still to come — before its own day, on it, and after it while the rent's is ahead */
const TO_COME = ["2026-10-30", "2026-11-01", "2026-11-02", "2026-11-10", "2026-11-16"];
const words = (html: string): string =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("⚖️ (B) a carried one charge is dated by the day it falls due — every reader but its page's sentence", () => {
  test("the subscriptions card lists it once, on the rent's Nov 16 — never its own Nov 1", () => {
    for (const day of TO_COME) {
      const card = subscriptionsCard(bundle.db, day)!;
      const line = card.oneOffs.find((o) => o.seriesId === UTIL);
      expect([line?.on, line?.cadenceLabel], day).toEqual(["2026-11-16", "once · Nov 16"]);
      const said = words(renderToStaticMarkup(createElement(SubscriptionsCard, { data: card })));
      expect(said, day).toContain("once · Nov 16");
      expect(said, day).not.toContain("once · Nov 1 ");
    }
  });

  test("the category page and the attach picker read it off the All tab's row — once, on Nov 16", () => {
    for (const day of TO_COME) {
      expect(listSeries(bundle.db, day).find((s) => s.id === UTIL)!.oneChargeOn, day).toBe("2026-11-16");
      const rows = seriesInCategory(bundle.db, categoryId, day);
      const said = words(renderToStaticMarkup(createElement(CategorySeriesList, { rows, today: day })));
      expect(said, day).toContain("Rent utilities & fees once · Nov 16");
    }
  });

  test("its staleness says it is expected once on Nov 16 — in Upcoming and the month's forecast", () => {
    for (const day of TO_COME) {
      const coming = upcomingOccurrences(bundle.db, day, 60).find((o) => o.seriesId === UTIL)!;
      expect(coming.staleness?.oneChargeOn, day).toBe("2026-11-16");
      expect(stalenessSentence(coming.staleness!), day).toMatch(/^expected once on Nov 16, 2026/);
      const line = forecastForMonth(bundle.db, "2026-11", day)!.components.find((c) => c.label === "Rent utilities & fees")!;
      expect(line.staleness?.oneChargeOn, day).toBe("2026-11-16");
    }
    // …and once it has come due unposted, the came-due leg's line carries the same day
    for (const day of ["2026-11-17", "2026-11-20"]) {
      const late = forecastForMonth(bundle.db, "2026-11", day)!.components.find((c) => c.label === "Rent utilities & fees")!;
      expect([late.detail.includes("came due Nov 16"), late.staleness?.oneChargeOn], day).toEqual([true, "2026-11-16"]);
    }
  });

  /*
   * ⛔ …and the car card's "charges once on …" names that day too: the committed book holds each day by the day it
   * falls due (`scheduledOccurrences`), and the card's sentence dates a one charge by its last payment there
   * (`heaviestMonthEnding`'s `lastPaymentOn`). 🔴 Review of cd58b3d1 (L135): with the utilities filed under Car and Car
   * insurance ended, on Oct 30 and Nov 1 the car card read "Rent utilities & fees charges once on Nov 1, 2026 — the
   * monthly figure above is what November 2026 bills with that charge in it, …" beside the subscriptions card's "once ·
   * Nov 16", and from Nov 2 nothing of it (his ledger copy 2026-11-05, the same what-if). At 256e0f1f both read Nov 1.
   */
  test("the car card says it charges once on Nov 16 — the subscriptions card's day", () => {
    const car = createCategory(bundle.db, { name: "Car", kind: "expense" });
    bundle.db.update(recurringSeries).set({ userCategoryId: car.id }).where(eq(recurringSeries.id, UTIL)).run();
    for (const day of TO_COME) {
      const card = carCard(bundle.db, day)!;
      expect(card.evidenceCaption, day).toBe(
        "Rent utilities & fees charges once on Nov 16, 2026 — the monthly figure above is what November 2026 bills " +
          "with that charge in it, not what a month without it costs.",
      );
      const subs = subscriptionsCard(bundle.db, day)!.oneOffs.find((o) => o.seriesId === UTIL)!;
      expect([card.cost.evidencedThrough, subs.on], day).toEqual(["2026-11-16", "2026-11-16"]);
    }
    // past it, nothing of it is still to come — and the car book holds nothing owed
    expect(carCard(bundle.db, "2026-11-17")!.evidenceCaption).toBeNull();
  });

  test("the merchant page says it is billed once, on Nov 16", () => {
    const now = new Date().toISOString();
    bundle.db.insert(merchants).values({ id: "m-util", canonicalName: "Utilities", createdAt: now, updatedAt: now }).run();
    bundle.db.update(recurringSeries).set({ merchantId: "m-util" }).where(eq(recurringSeries.id, UTIL)).run();
    for (const day of TO_COME) {
      expect(merchantIntelligence(bundle.db, "m-util", day).cadence?.oneChargeLabel, day).toBe("Nov 16");
    }
  });

  // billed on its own, its one charge falls due on its own day — as every reader read it
  test("a one charge billed on its own keeps its own day everywhere", () => {
    seriesWith("own", "Car insurance — Nov 11 balance", -7_274, "2026-11-11");
    bundle.db.update(recurringSeries).set({ userEndsOn: "2026-11-11" }).where(eq(recurringSeries.id, "own")).run();
    const day = "2026-11-05";
    expect(subscriptionsCard(bundle.db, day)!.oneOffs.find((o) => o.seriesId === "own")?.cadenceLabel).toBe(
      "once · Nov 11",
    );
    expect(listSeries(bundle.db, day).find((s) => s.id === "own")!.oneChargeOn).toBe("2026-11-11");
    expect(upcomingOccurrences(bundle.db, day, 60).find((o) => o.seriesId === "own")!.staleness?.oneChargeOn).toBe(
      "2026-11-11",
    );
  });
});
