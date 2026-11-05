import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { resolveViewState } from "@/lib/view-state";
import { checkedThrough } from "@/services/checked-days-fixture";
import { closeLedger, openLedger, rentWith, UTIL } from "@/services/nearer-due-day-fixture";
import { listSeries } from "@/services/recurring";
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
  confirmSeriesAction: vi.fn(),
  dismissSeriesAction: vi.fn(),
}));
vi.mock("@/app/settings/actions", () => ({ saveViewPreferenceAction: vi.fn() }));

const { SeriesDetail } = await import("./SeriesDetail");
const { AllSeriesView } = await import("./AllSeriesView");

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** an HTML fragment as its words, one space apart */
const words = (html: string): string => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

/**
 * ⛔ The end badge of what the rent carries says ONE TENSE FOR ONE FACT as every reader dates its days: by the day each
 * FALLS DUE (`SeriesOccurrence.date`) — billed inside another on its carrier's step, the later of its own day and the
 * carrier's day it pairs with (⚖️ default (B), built, not asked, 2026-10-30) — and only on days its schedule holds,
 * from where its carrier opens it (`openingOf`); and ONE DAY with every other reader that names where it stops — the
 * Annualized qualifier on its page and the All tab's short form (`seriesStopsOn`). Its page and its row as the owner
 * reads them (`seriesEndBadge` in `SeriesDetail`, `annualizedEndNote` in `AllSeriesView`), on the temp ledger decision
 * 76's pins grade on (`nearer-due-day-fixture`), the what-ifs below laid on it: latent on his ledger, where nothing
 * billed inside another has an end (his ledger copy 2026-11-04).
 */
let bundle: DbBundle;
beforeEach(() => {
  ({ bundle } = openLedger());
});
afterEach(closeLedger);

/** the utilities' page as the owner reads it on `today`, in words */
const pageOn = (today: string): string =>
  words(
    renderToStaticMarkup(
      createElement(SeriesDetail, {
        data: seriesDetail(bundle.db, UTIL, today)!,
        today,
        viewState: resolveViewState(RECURRING_SERIES_VIEW_SPEC, {}, undefined),
        basePath: `/recurring/${UTIL}`,
      }),
    ),
  );
/** every "Ends …"/"Ended …" the utilities' page prints on `today` — the badge, alone */
const badgeOn = (today: string): string[] =>
  pageOn(today).match(/\b(?:Ends|Ended(?: before)?) [A-Z][a-z]{2} \d{1,2}, \d{4}/g) ?? [];
const endOn = (day: string) =>
  bundle.db.update(recurringSeries).set({ userEndsOn: day }).where(eq(recurringSeries.id, UTIL)).run();
/** the rent typed Nov 16 and paid Nov 16, the utilities on their own Sep 1 — as 23e9c5d1's review laid it on */
const rentPaidNov16 = () =>
  rentWith(
    { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
    "2026-07-01",
    "2026-08-02",
    "2026-09-02",
    "2026-10-02",
    "2026-11-16",
  );

describe("⛔ the end badge of what the rent carries — the day each falls due, never a day it does not hold", () => {
  /*
   * 🔴 Review of 23e9c5d1: the rent typed Nov 16 and paid Nov 16, their end typed Dec 10, read through Dec 19 — from
   * Dec 11 to Dec 16 their page read "Ended Dec 10, 2026" (the end day's tense, off the end alone) beside a list naming
   * Dec 16 (their own Dec 1), "~$182.21/yr" and an End dialog "Leaving the forecast: ~$182.21 / yr ;; Upcoming charges
   * off the calendar: every charge from Dec 16, 2026 to Dec 16, 2026"; from Dec 17 "Ended Dec 1, 2026"
   * (`scheduleRanOutOn` stepping their own days alone) beside an Already-due card for Dec 16 (his ledger copy
   * 2026-11-04, the same what-if, the Nov 16 row on Wells Fargo). At 95cdf198 it read "Ended Dec 1, 2026" and nothing
   * expected from Dec 2. 🔴 Review of 99bd525a: from Nov 20 to Dec 10 it still read the end he typed, "Ends Dec 10,
   * 2026", above "Next expected Dec 16, 2026" and an End dialog "every charge from Dec 16, 2026 to Dec 16, 2026" — and
   * on Dec 11, nothing new posted, "Ends Dec 16, 2026": a day still to come moved overnight (his ledger copy
   * 2026-11-04, the same what-if).
   */
  test("⛔ ending Dec 10, their Dec 1 due with the rent's Dec 16: 'Ends Dec 16', then 'Ended Dec 16'", () => {
    rentPaidNov16();
    endOn("2026-12-10");
    checkedThrough(bundle.db, "acct", "2026-12-19");
    // ONE day, the one their list names, from before the end he typed to the day it falls due
    const toCome = ["2026-11-20", "2026-12-02", "2026-12-05", "2026-12-10", "2026-12-11", "2026-12-12", "2026-12-16"];
    for (const day of toCome) {
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

  /*
   * ⛔ …and the day is its schedule's, as its end is — not the forecast's: a carrier gone quiet past the point a bill
   * stops lets them go (`seriesIsForecast`), and their last charge still falls due with its later day. 🔴 Read only
   * while the forecast carried them (the fix of 99bd525a's review, measured before it was built): the rent typed Nov
   * 16, its last row Oct 2, read through Jan 19, their end typed Jan 10 — "Ends Jan 16, 2027" to Jan 3, "Ends Jan 10,
   * 2027" from Jan 4, the day the rent lapsed, "Ended Jan 10, 2027" from Jan 11 and "Ended Jan 16, 2027" from Jan 17
   * (his ledger copy 2026-11-04, the same what-if): one end, three days. At 99bd525a: "Ends Jan 10, 2027" to Jan 10,
   * "Ended Jan 10, 2027" from Jan 11, "Ended Jan 16, 2027" from Jan 17.
   */
  test("⛔ the rent lapsed, their end Jan 10: 'Ends Jan 16' to that day, then 'Ended Jan 16'", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    endOn("2027-01-10");
    checkedThrough(bundle.db, "acct", "2027-01-19");
    // the rent's third charge after Oct 2 read missing, grace and all: it lapses, and so do they
    expect(seriesDetail(bundle.db, UTIL, "2027-01-03")!.evidence).toBe("running-late");
    expect(seriesDetail(bundle.db, UTIL, "2027-01-04")!.evidence).toBe("lapsed");
    for (const day of ["2026-12-20", "2027-01-03", "2027-01-04", "2027-01-10", "2027-01-11", "2027-01-16"]) {
      expect(badgeOn(day), day).toEqual(["Ends Jan 16, 2027"]);
    }
    for (const day of ["2027-01-17", "2027-01-20"]) expect(badgeOn(day), day).toEqual(["Ended Jan 16, 2027"]);
  });
});

/*
 * ⛔ …and every qualifier of its year names that day too (`seriesStopsOn`): the Annualized line on its page and its
 * short form on the All tab. 🔴 Review of 99bd525a: the rent typed Nov 16 and paid Nov 16, their end typed Dec 10 —
 * on Dec 5 and Dec 10 their page read "~$182.21/yr the twelve months from today — this one stops on Dec 10, 2026,
 * inside them" above "Next expected Dec 16, 2026", and the All tab "Monthly -$182.21 Dec 16 ~$182.21/yr ends Dec 10,
 * 2026", a Next after the row's own end; on Dec 11 and Dec 16 both qualifiers were gone, "~$182.21/yr" under a
 * monthly -$182.21 bill with nothing saying why (his ledger copy 2026-11-04, the same what-if).
 */
describe("⛔ the year of what the rent carries — it stops on the day its last charge falls due", () => {
  /** the qualifier under the utilities' Annualized figure on their page — null when it says none */
  const caveatOn = (today: string): string | null => {
    const said = pageOn(today).match(/the twelve months from today — this one stops on [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    return said?.[0] ?? null;
  };
  /** the utilities' row on the All tab, in words */
  const rowOn = (today: string): string => {
    const html = renderToStaticMarkup(
      createElement(AllSeriesView, { series: listSeries(bundle.db, today), overdueBySeries: new Map(), today }),
    );
    const at = html.indexOf(`href="/recurring/${UTIL}"`);
    return words(html.slice(at, html.indexOf("</tr>", at)));
  };

  test("⛔ ending Dec 10, due with the rent's Dec 16: 'stops on Dec 16' and 'ends Dec 16' until that day", () => {
    rentPaidNov16();
    endOn("2026-12-10");
    checkedThrough(bundle.db, "acct", "2026-12-19");
    for (const day of ["2026-11-20", "2026-12-05", "2026-12-10", "2026-12-11", "2026-12-16"]) {
      expect(caveatOn(day), day).toBe("the twelve months from today — this one stops on Dec 16, 2026");
      // the Next, the year it is a year of, and when it stops inside it — one day
      expect(rowOn(day), day).toContain("Dec 16 ~ $182.21 /yr ends Dec 16, 2026");
      expect(rowOn(day), day).not.toContain("Dec 10");
    }
    // …and once it has fallen due there is no year left to qualify, nor a figure
    expect(caveatOn("2026-12-17")).toBeNull();
    expect(rowOn("2026-12-17")).not.toContain("ends ");
  });

  // ⛔ …and one he ended or dismissed has no charge left to fall due — nothing more is expected of it (`seriesIsOver`)
  test("ended or dismissed, it has no day its last charge falls due on — on its page or its row", () => {
    rentPaidNov16();
    endOn("2026-12-10");
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC5 = "2026-12-05";
    expect(seriesDetail(bundle.db, UTIL, DEC5)!.lastFallsDueOn).toBe("2026-12-16");
    for (const status of ["ended", "dismissed"] as const) {
      bundle.db.update(recurringSeries).set({ status }).where(eq(recurringSeries.id, UTIL)).run();
      expect(seriesDetail(bundle.db, UTIL, DEC5)!.lastFallsDueOn, status).toBeNull();
      expect(listSeries(bundle.db, DEC5).find((s) => s.id === UTIL)!.lastFallsDueOn, status).toBeNull();
    }
  });
});
