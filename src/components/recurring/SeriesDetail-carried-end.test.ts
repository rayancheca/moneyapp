import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { resolveViewState } from "@/lib/view-state";
import { checkedThrough } from "@/services/checked-days-fixture";
import { closeLedger, openLedger, rentWith, UTIL } from "@/services/nearer-due-day-fixture";
import { seriesDetail } from "@/services/recurring-detail";
import { RECURRING_SERIES_VIEW_SPEC } from "./recurring-view-spec";

// rendering never navigates or submits; the page and its controls only need these to exist
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/recurring/s",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/recurring/actions", () => ({
  renameSeriesAction: vi.fn(),
  setSeriesStatusAction: vi.fn(),
  setSeriesOverridesAction: vi.fn(),
  attachToSeriesAction: vi.fn(),
  detachFromSeriesAction: vi.fn(),
  mergeIntoSeriesAction: vi.fn(),
  searchAttachCandidatesAction: vi.fn(),
}));
vi.mock("@/app/settings/actions", () => ({ saveViewPreferenceAction: vi.fn() }));

const { SeriesDetail } = await import("./SeriesDetail");

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * ⛔ The end badge of what the rent carries says ONE TENSE FOR ONE FACT as every reader dates its days: by the day each
 * FALLS DUE (`SeriesOccurrence.date`) — billed inside another on its carrier's step, the later of its own day and the
 * carrier's day it pairs with (⚖️ default (B), built, not asked, 2026-10-30) — and only on days its schedule holds,
 * from where its carrier opens it (`openingOf`). Its page as the owner reads it (`seriesEndBadge` in `SeriesDetail`),
 * on the temp ledger decision 76's pins grade on (`nearer-due-day-fixture`), the what-ifs below laid on it: latent on
 * his ledger, where nothing billed inside another has an end (his ledger copy 2026-11-04).
 */
let bundle: DbBundle;
beforeEach(() => {
  ({ bundle } = openLedger());
});
afterEach(closeLedger);

describe("⛔ the end badge of what the rent carries — the day each falls due, never a day it does not hold", () => {
  /** every "Ends …"/"Ended …" the utilities' page prints on `today` — the badge, alone */
  const badgeOn = (today: string): string[] => {
    const html = renderToStaticMarkup(
      createElement(SeriesDetail, {
        data: seriesDetail(bundle.db, UTIL, today)!,
        today,
        viewState: resolveViewState(RECURRING_SERIES_VIEW_SPEC, {}, undefined),
        basePath: `/recurring/${UTIL}`,
      }),
    );
    const text = decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    return text.match(/\b(?:Ends|Ended(?: before)?) [A-Z][a-z]{2} \d{1,2}, \d{4}/g) ?? [];
  };
  const endOn = (day: string) =>
    bundle.db.update(recurringSeries).set({ userEndsOn: day }).where(eq(recurringSeries.id, UTIL)).run();

  /*
   * 🔴 Review of 23e9c5d1: the rent typed Nov 16 and paid Nov 16, their end typed Dec 10, read through Dec 19 — from
   * Dec 11 to Dec 16 their page read "Ended Dec 10, 2026" (the end day's tense, off the end alone) beside a list naming
   * Dec 16 (their own Dec 1), "~$182.21/yr" and an End dialog "Leaving the forecast: ~$182.21 / yr ;; Upcoming charges
   * off the calendar: every charge from Dec 16, 2026 to Dec 16, 2026"; from Dec 17 "Ended Dec 1, 2026"
   * (`scheduleRanOutOn` stepping their own days alone) beside an Already-due card for Dec 16 (his ledger copy
   * 2026-11-04, the same what-if, the Nov 16 row on Wells Fargo). At 95cdf198 it read "Ended Dec 1, 2026" and nothing
   * expected from Dec 2.
   */
  test("⛔ ending Dec 10, their Dec 1 due with the rent's Dec 16: 'Ends Dec 16', then 'Ended Dec 16'", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
    );
    endOn("2026-12-10");
    checkedThrough(bundle.db, "acct", "2026-12-19");
    // the end he typed, while it is ahead
    for (const day of ["2026-12-02", "2026-12-10"]) expect(badgeOn(day), day).toEqual(["Ends Dec 10, 2026"]);
    // …gone by, with their Dec 1 still listed on the rent's Dec 16: that day, still to come
    for (const day of ["2026-12-11", "2026-12-12", "2026-12-16"]) {
      expect(badgeOn(day), day).toEqual(["Ends Dec 16, 2026"]);
      expect(seriesDetail(bundle.db, UTIL, day)!.nextExpected.map((o) => o.date), day).toEqual(["2026-12-16"]);
    }
    // …and once it has fallen due, the day it ran out is that day — the Already-due card's, never their own Dec 1
    for (const day of ["2026-12-17", "2026-12-20", "2027-01-05"]) {
      expect(badgeOn(day), day).toEqual(["Ended Dec 16, 2026"]);
    }
    expect(seriesDetail(bundle.db, UTIL, "2026-12-17")!.overdue?.date).toBe("2026-12-16");
    // ⛔ …and a charge of their own posted after it is that day's, as one settled after an end is the end's — never
    // the end itself, a day before the one their last charge fell due on
    bundle.db.update(recurringSeries).set({ lastMatchedOn: "2026-12-18" }).where(eq(recurringSeries.id, UTIL)).run();
    expect(badgeOn("2026-12-20")).toEqual(["Ended Dec 16, 2026"]);
  });

  /*
   * 🔴 Review of 23e9c5d1: the rent typed Nov 1 opens them on their Nov 1, past an end typed Oct 15 — their schedule
   * holds no day — yet from Oct 1 their page read "Ended Oct 1, 2026", a day that was never a charge of theirs (his
   * ledger copy 2026-11-04, the same what-if; 95cdf198 the same). It ended before the end it names, every day.
   */
  test("⛔ ending Oct 15, before the rent's Nov 1 opens them: 'Ended before Oct 15, 2026' — never their Oct 1", () => {
    rentWith({ rentOn: "2026-11-01", typed: true, utilOn: "2026-09-01", noneOfTwo: true }, "2026-07-01", "2026-08-02");
    endOn("2026-10-15");
    for (const day of ["2026-09-20", "2026-10-01", "2026-10-16", "2026-11-04"]) {
      expect(badgeOn(day), day).toEqual(["Ended before Oct 15, 2026"]);
    }
  });
});
