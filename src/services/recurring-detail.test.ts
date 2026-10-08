import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { addDays } from "@/lib/dates";
import { isNull } from "drizzle-orm";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { detectRecurringSeries, listSeries } from "./recurring";
import {
  renameSeries,
  searchAttachCandidates,
  seriesDetail,
  setSeriesOverrides,
} from "./recurring-detail";
import { attachTransactions, mergeFilings, mergeSeries } from "./recurring-links";

const TODAY = "2026-07-08";
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] as const;

let dir: string;
let bundle: DbBundle;
let cardId: string;
let netflixId: string;
let subsCatId: string;
let seq = 0;

function insertTxn(opts: {
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  merchantId?: string | null;
  categoryId?: string | null;
  recurringSeriesId?: string | null;
}): string {
  seq += 1;
  return bundle.db
    .insert(transactions)
    .values({
      accountId: cardId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription: opts.rawDescription,
      normalizedDescription: normalizeDescription(opts.rawDescription),
      merchantId: opts.merchantId ?? null,
      categoryId: opts.categoryId ?? null,
      recurringSeriesId: opts.recurringSeriesId ?? null,
      dedupeHash: dedupeHash({
        accountId: cardId,
        postedOn: opts.postedOn,
        amountCents: opts.amountCents,
        rawDescription: `${opts.rawDescription}#${seq}`,
        occurrenceIndex: seq,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function buildMonthlyNetflix(): void {
  for (const m of MONTHS) {
    insertTxn({
      postedOn: `${m}-15`,
      amountCents: -1549,
      rawDescription: "NETFLIX.COM",
      merchantId: netflixId,
      categoryId: subsCatId,
    });
  }
}

function netflix() {
  return bundle.db.select().from(recurringSeries).where(eq(recurringSeries.merchantId, netflixId)).get()!;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-recdetail-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  netflixId = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Netflix")).get()!.id;
  subsCatId = bundle.db.select().from(categories).where(eq(categories.name, "Subscriptions")).get()!.id;
  seq = 0;
  buildMonthlyNetflix();
  detectRecurringSeries(bundle.db, TODAY);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("seriesDetail", () => {
  test("closes the chain: merchant, modal category, account, and linked history", () => {
    const d = seriesDetail(bundle.db, netflix().id, TODAY);
    expect(d.merchant).toMatchObject({ name: "Netflix" });
    expect(d.category).toMatchObject({ name: "Subscriptions" });
    expect(d.accountName).toBe("Card");
    expect(d.kind).toBe("subscription");
    expect(d.linkedTxns).toHaveLength(6);
    // newest first
    expect(d.linkedTxns[0]!.postedOn).toBe("2026-06-15");
    expect(d.linkedTxns.at(-1)!.postedOn).toBe("2026-01-15");
    // amount history is the same rows oldest → newest, for the drift chart
    expect(d.amountHistory[0]!.date).toBe("2026-01-15");
    expect(d.amountHistory.at(-1)!.date).toBe("2026-06-15");
    expect(d.linkedTxns.every((t) => t.linkSource === "detected")).toBe(true);
  });

  test("a commitment that has never charged names the category the owner put it in", () => {
    const fitness = bundle.db.select().from(categories).where(eq(categories.name, "Fitness")).get()!;
    const gym = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Gym",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        nextExpectedOn: "2026-07-22",
        nextExpectedAmountCents: -10000,
        status: "confirmed",
        toleranceDays: 3,
        userCategoryId: fitness.id,
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    expect(seriesDetail(bundle.db, gym, TODAY).category).toMatchObject({ id: fitness.id, name: "Fitness" });
  });

  test("the owner's category outranks the category the rows were filed in", () => {
    const fitness = bundle.db.select().from(categories).where(eq(categories.name, "Fitness")).get()!;
    bundle.db.update(recurringSeries).set({ userCategoryId: fitness.id }).where(eq(recurringSeries.id, netflix().id)).run();
    expect(seriesDetail(bundle.db, netflix().id, TODAY).category).toMatchObject({ name: "Fitness" });
  });

  test("reports the detected statistics and next 3 expected occurrences", () => {
    const d = seriesDetail(bundle.db, netflix().id, TODAY);
    expect(d.cadence).toBe("monthly");
    expect(d.annualizedCents).toBe(1549 * 12); // twelve billings inside the window
    expect(d.isActive).toBe(true);
    expect(d.nextExpected).toHaveLength(3);
    // the 15th, the day every one of the six linked charges landed on
    expect(d.nextExpected[0]!.date).toBe("2026-07-15");
    expect(d.nextExpected.every((o) => o.amountCents === -1549)).toBe(true);
  });

  /**
   * 🔴 A BOUNDED CONTRACT BILLED TWELVE TIMES. `annualizedCentsOf` was
   * `|amount| × occurrences-per-year` with no horizon term, so a series that
   * stops inside the twelve months was costed as if it did not. On the real
   * ledger 2026-09-11, `Car insurance` — a SIX-payment policy ending
   * 2027-01-11 with five payments left — read "$4,337.88 in a year" on
   * /recurring and set a rank ("3rd largest of your 13 scheduled commitments")
   * and a share ("9.6%") from it, while the dashboard's Runway card printed
   * $1,807.45 over the next twelve months. 5 × $361.49 = $1,807.45.
   *
   * ⛔ `endsInsideHorizon` — the rule the committed book states — was already
   * called twice to write PROSE about this ("this one stops on Jan 11, 2027,
   * inside them") and never once to compute the figure the prose qualified.
   */
  /**
   * 🔴 THE FAR END IS EXCLUSIVE. `projectOccurrences` includes its far day, so
   * a window of `[today, today + 12 months]` billed a monthly series thirteen
   * times whenever today fell on its billing day — the Netflix fixture's own
   * TODAY (the 8th, billed on the 15th) can never hit that, which is why the
   * two tests above could not see it.
   */
  test("a year from a billing day holds twelve billings, not thirteen", () => {
    const d = seriesDetail(bundle.db, netflix().id, "2026-07-15");
    expect(d.annualizedCents).toBe(1549 * 12);
  });

  /** ⛔ no next date is no figure — never a measured $0.00 */
  test("a series with no next expected date has no annualized figure", () => {
    bundle.db.run(sql`UPDATE recurring_series SET next_expected_on = NULL WHERE id = ${netflix().id}`);
    expect(seriesDetail(bundle.db, netflix().id, TODAY).annualizedCents).toBeNull();
  });

  test("a series that stops inside the year costs what it will actually bill", () => {
    const s = netflix();
    bundle.db.run(sql`UPDATE recurring_series SET user_ends_on = '2026-11-20' WHERE id = ${s.id}`);

    const d = seriesDetail(bundle.db, s.id, TODAY);
    // TODAY is 2026-07-08 and it bills on the 15th: Jul, Aug, Sep, Oct, Nov
    expect(d.endsOn).toBe("2026-11-20");
    expect(d.annualizedCents).toBe(1549 * 5);
    expect(d.annualizedCents).not.toBe(1549 * 12);
  });

  /*
   * 🔴 THE PAGE THAT OWNS THE SERIES WAS THE ONE PLACE ITS END WAS INVISIBLE.
   * Measured 2026-09-02 on `/recurring/<car insurance>`: "ANNUALIZED
   * ~$4,337.88/yr" over three upcoming charges, with no mention that the series
   * is evidenced only through 2027-01-11 — while the runway card and the car
   * card both named that date. The annualised figure it headlines is exactly
   * the number the end invalidates.
   */
  test("a series with an end day reports it, so the page can qualify its annual figure", () => {
    bundle.db
      .update(recurringSeries)
      .set({ userEndsOn: "2026-08-15" })
      .where(eq(recurringSeries.id, netflix().id))
      .run();

    const d = seriesDetail(bundle.db, netflix().id, TODAY);
    expect(d.endsOn).toBe("2026-08-15");
    // and the projection already stops there — the badge describes the same
    // fact the occurrence list is walking, not a second one
    expect(d.nextExpected.every((o) => o.date <= "2026-08-15")).toBe(true);
    // the walk stops at the end day: Jul 15 and Aug 15, and no September
    expect(d.nextExpected).toHaveLength(2);
  });

  test("a series that runs on reports no end day at all", () => {
    expect(seriesDetail(bundle.db, netflix().id, TODAY).endsOn).toBeNull();
  });

  test("throws on an unknown series", () => {
    expect(() => seriesDetail(bundle.db, "nope", TODAY)).toThrow(/Unknown recurring series/);
  });

  test("a long-interval annual series still returns 3 next-expected occurrences", () => {
    // 3 identical charges 378 days apart → annual, step 378. The old fixed
    // horizon (3*366+30=1128) dropped the 3rd (at +1134); size off step instead.
    for (const d of [addDays(TODAY, -756), addDays(TODAY, -378), TODAY]) {
      insertTxn({ postedOn: d, amountCents: -5000, rawDescription: "ANNUAL FEE" });
    }
    detectRecurringSeries(bundle.db, TODAY);
    const annual = bundle.db.select().from(recurringSeries).where(isNull(recurringSeries.merchantId)).get()!;
    expect(annual.cadence).toBe("annual");
    expect(seriesDetail(bundle.db, annual.id, TODAY).nextExpected).toHaveLength(3);
  });

  test("a commitment dated further out than the count itself is still listed", () => {
    /*
     * The window is `count + 1` steps, not `count`. Every anchor at or before
     * today needs only `count` — the first occurrence lands inside one step, so
     * three of them land inside three. The extra step is for the OTHER anchor: a
     * user-set date further out than the count. 2026-10-20 is three months and
     * twelve days past TODAY, so a three-month window would list nothing at all
     * for a commitment the user entered by hand — the car lease's exact shape,
     * signed in advance of its first charge.
     */
    const id = netflix().id;
    setSeriesOverrides(bundle.db, id, { userNextExpectedOn: "2026-10-20" });
    const d = seriesDetail(bundle.db, id, TODAY);
    expect(d.nextExpected.map((o) => o.date)).toEqual(["2026-10-20"]);
  });

  test("effective values follow user overrides; merge candidates exclude self", () => {
    const id = netflix().id;
    setSeriesOverrides(bundle.db, id, { userCadence: "weekly", userAmountCents: -2000 });
    const d = seriesDetail(bundle.db, id, TODAY);
    expect(d.cadence).toBe("weekly");
    expect(d.nextExpectedAmountCents).toBe(-2000);
    expect(d.userCadence).toBe("weekly");
    expect(d.detectedCadence).toBe("monthly"); // detection column untouched
    expect(d.mergeCandidates.every((c) => c.id !== id)).toBe(true);
  });

  /*
   * ⚖️ Owner decision 2026-10-08 (§6A 54): the merge confirmation names how many of the candidate's rows are not filed
   * yet and the category they will be filed under — BEFORE he presses, from the same reading the merge writes by.
   */
  test("each merge candidate carries what merging it would file — and the merge files exactly that", () => {
    const id = netflix().id;
    const series = (name: string) =>
      bundle.db
        .insert(recurringSeries)
        .values({ name, kind: "subscription", cadence: "monthly", status: "detected" })
        .returning({ id: recurringSeries.id })
        .get().id;
    const hulu = series("HULU");
    for (const m of ["2026-04", "2026-05", "2026-06"]) {
      insertTxn({ postedOn: `${m}-20`, amountCents: -799, rawDescription: "HULU", recurringSeriesId: hulu });
    }
    const filedAlready = series("DISNEY");
    insertTxn({
      postedOn: "2026-06-21",
      amountCents: -1399,
      rawDescription: "DISNEY PLUS",
      categoryId: subsCatId,
      recurringSeriesId: filedAlready,
    });

    const candidates = seriesDetail(bundle.db, id, TODAY).mergeCandidates;
    const huluFiling = candidates.find((c) => c.id === hulu)!.filing;
    expect(huluFiling).toEqual({ categoryId: subsCatId, categoryPath: "Subscriptions", count: 3 });
    expect(huluFiling).toEqual(mergeFilings(bundle.db, id, [hulu]).get(hulu));
    // nothing to file → no filing, and the confirmation reads as it always has
    expect(candidates.find((c) => c.id === filedAlready)!.filing).toBeNull();

    expect(mergeSeries(bundle.db, hulu, id, TODAY).filed).toEqual(huluFiling);
  });

  /*
   * 🔴 THE BACKWARD HALF. `/recurring/<Flamingo South Beach (rent)>` on
   * 2026-09-04 read "Next expected — Oct 1, 2026" and nothing else, for a rent
   * charge that came due on 2026-09-01 and never posted. The forecast counted
   * it, /budgets counted it, the runway named it and the calendar marked it —
   * only the page about that bill skipped to October.
   *
   * ⛔ `overdueForSeries` over the CALENDAR MONTH, closing the day before today,
   * so this page cannot disagree with the forecast about the same bill. Arrears
   * are scoped to the calendar month by the owner's decision of 2026-09-02.
   */
  test("a charge that came due this month and never posted is stated, not skipped", () => {
    const id = netflix().id;
    // TODAY is 2026-07-08 and the series charges on the 15th, so July's is
    // still ahead. Move it to the 1st: due, past, and unpaid.
    bundle.db
      .update(recurringSeries)
      .set({ userNextExpectedOn: "2026-07-01" })
      .where(eq(recurringSeries.id, id))
      .run();

    const d = seriesDetail(bundle.db, id, TODAY);
    expect(d.overdue).toEqual({ date: "2026-07-01", amountCents: -1549, occurrenceCount: 1 });
    // and the forward list still opens after today, never restating it
    expect(d.nextExpected.every((o) => o.date >= TODAY)).toBe(true);
  });

  /*
   * 🔴 `/recurring/<Hoffman LL>` on 2026-09-04 carried the badge "Ended · Bill"
   * over "Next expected — Sep 8, 2026 -$1,786.46 · Oct 8 · Nov 8", of a series
   * whose one linked charge is dated 2025-06-02. `/recurring/<YA-FIT Smoothie
   * Bar>` read "Dismissed · Bill" over three more.
   *
   * `listSeries` refuses exactly this and says why in its own comment —
   * "rolling a dismissed/ended series forward would invent a future charge" —
   * and the page ABOUT the series was the one place that did it anyway. Same
   * shape as `seriesRowLabel`: the vocabulary chooses by STATUS first.
   */
  /*
   * 🔴 A DISPERSION BAND WITH NOTHING UNDER IT. `Per charge` printed
   * `recurring_series.amount_cents_stddev` — the detector's seed — as "±5.48"
   * on `/recurring/<ZELLE PAYMENT TO ENRIQUE RODRIGUEZ>` beside a badge reading
   * "no basis yet" and a linked count of 0, and as "±18.45" on
   * `/recurring/<Hoffman LL>` beside "seen once", around a mean that excludes
   * the one charge the page lists below it.
   *
   * A spread over the postings has to be measured from the postings, and it
   * needs at least two of them to mean anything.
   */
  test("the per-charge spread is measured from the linked rows", () => {
    const d = seriesDetail(bundle.db, netflix().id, TODAY);
    expect(d.linkedTxns.length).toBeGreaterThan(1);
    expect(d.postedStddevCents).not.toBeNull();
  });

  test("one linked charge has no spread, whatever the detector's seed says", () => {
    const id = netflix().id;
    const keep = seriesDetail(bundle.db, id, TODAY).linkedTxns[0]!.id;
    bundle.db
      .update(transactions)
      .set({ recurringSeriesId: null })
      .where(and(eq(transactions.recurringSeriesId, id), ne(transactions.id, keep)))
      .run();
    bundle.db.update(recurringSeries).set({ amountCentsStddev: 1_845 }).where(eq(recurringSeries.id, id)).run();

    const d = seriesDetail(bundle.db, id, TODAY);
    expect(d.linkedTxns).toHaveLength(1);
    expect(d.postedStddevCents).toBeNull();
  });

  test("no linked charges, no spread", () => {
    const id = netflix().id;
    bundle.db.update(transactions).set({ recurringSeriesId: null }).where(eq(transactions.recurringSeriesId, id)).run();
    bundle.db.update(recurringSeries).set({ amountCentsStddev: 548 }).where(eq(recurringSeries.id, id)).run();
    expect(seriesDetail(bundle.db, id, TODAY).postedStddevCents).toBeNull();
  });

  test("a series the owner ENDED projects nothing", () => {
    const id = netflix().id;
    bundle.db.update(recurringSeries).set({ status: "ended" }).where(eq(recurringSeries.id, id)).run();
    const d = seriesDetail(bundle.db, id, TODAY);
    expect(d.nextExpected).toEqual([]);
    expect(d.overdue).toBeNull();
  });

  test("a series the owner DISMISSED projects nothing", () => {
    const id = netflix().id;
    bundle.db.update(recurringSeries).set({ status: "dismissed" }).where(eq(recurringSeries.id, id)).run();
    const d = seriesDetail(bundle.db, id, TODAY);
    expect(d.nextExpected).toEqual([]);
    expect(d.overdue).toBeNull();
  });

  test("a CONFIRMED series still projects — the test above is about status, not about silence", () => {
    expect(seriesDetail(bundle.db, netflix().id, TODAY).nextExpected.length).toBeGreaterThan(0);
  });

  /*
   * 🔴 …and it carries no year ahead of it either. c9458a6 closed only the
   * series with NO next date; one that still stores a date — rolled forward
   * from a stale anchor like Hoffman's 2026-02-08 — printed "Annualized
   * ~$21,437.52/yr" directly above "Nothing expected — nothing more is expected
   * from it". Measured 2026-09-14: 25 of the 27 ended/dismissed series pages.
   */
  for (const status of ["ended", "dismissed"] as const) {
    test(`an ${status.toUpperCase()} series that still stores a next date carries no annualized figure`, () => {
      const id = netflix().id;
      bundle.db
        .update(recurringSeries)
        .set({ status, nextExpectedOn: "2026-02-15" })
        .where(eq(recurringSeries.id, id))
        .run();
      const d = seriesDetail(bundle.db, id, TODAY);
      expect(d.nextExpected).toEqual([]); // the precondition the page already honoured
      expect(d.annualizedCents).toBeNull();
      expect(listSeries(bundle.db, TODAY).find((s) => s.id === id)?.annualizedCents).toBeNull();
    });
  }

  test("a live series with the same stale stored date still annualizes — the rule is status, not the date", () => {
    const id = netflix().id;
    bundle.db.update(recurringSeries).set({ nextExpectedOn: "2026-02-15" }).where(eq(recurringSeries.id, id)).run();
    expect(seriesDetail(bundle.db, id, TODAY).annualizedCents).toBe(1549 * 12);
    expect(listSeries(bundle.db, TODAY).find((s) => s.id === id)?.annualizedCents).toBe(1549 * 12);
  });

  test("a charge due TODAY is due, not overdue — the two legs abut", () => {
    const id = netflix().id;
    bundle.db
      .update(recurringSeries)
      .set({ userNextExpectedOn: TODAY })
      .where(eq(recurringSeries.id, id))
      .run();

    const d = seriesDetail(bundle.db, id, TODAY);
    expect(d.overdue).toBeNull();
    expect(d.nextExpected[0]!.date).toBe(TODAY);
  });

  test("a charge that came due and POSTED is not overdue", () => {
    const id = netflix().id;
    bundle.db
      .update(recurringSeries)
      .set({ userNextExpectedOn: "2026-07-01" })
      .where(eq(recurringSeries.id, id))
      .run();
    insertTxn({
      postedOn: "2026-07-01",
      amountCents: -1549,
      rawDescription: "NETFLIX.COM",
      merchantId: netflixId,
      categoryId: subsCatId,
      recurringSeriesId: id,
    });

    expect(seriesDetail(bundle.db, id, TODAY).overdue).toBeNull();
  });

  /* ⛔ Scoped to the CALENDAR MONTH: a charge missed in June is June's business,
     and widening the leg here would disagree with every other surface. The
     anchor moves to the 20th, so June's occurrence has no posting (the fixture
     charges on the 15th) and July's is still ahead of TODAY. */
  test("a charge missed in a PREVIOUS month is not this month's arrears", () => {
    const id = netflix().id;
    bundle.db
      .update(recurringSeries)
      .set({ userNextExpectedOn: "2026-06-20" })
      .where(eq(recurringSeries.id, id))
      .run();

    const d = seriesDetail(bundle.db, id, TODAY);
    expect(d.overdue).toBeNull();
    expect(d.nextExpected[0]!.date).toBe("2026-07-20");
  });
});

describe("setSeriesOverrides / renameSeries", () => {
  test("clears an override with null", () => {
    const id = netflix().id;
    setSeriesOverrides(bundle.db, id, { userCadence: "weekly" });
    expect(seriesDetail(bundle.db, id, TODAY).cadence).toBe("weekly");
    setSeriesOverrides(bundle.db, id, { userCadence: null });
    expect(seriesDetail(bundle.db, id, TODAY).cadence).toBe("monthly");
  });

  test("a no-op patch and unknown-id are handled", () => {
    const id = netflix().id;
    expect(() => setSeriesOverrides(bundle.db, id, {})).not.toThrow();
    expect(() => setSeriesOverrides(bundle.db, "nope", { userAmountCents: 1 })).toThrow(
      /Unknown recurring series/,
    );
  });

  test("rejects a calendar-invalid next-expected date (would poison every projection)", () => {
    const id = netflix().id;
    expect(() => setSeriesOverrides(bundle.db, id, { userNextExpectedOn: "2026-02-31" })).toThrow(
      /Invalid next-expected date/,
    );
    // and the poison never landed — the series still projects fine
    expect(() => seriesDetail(bundle.db, id, TODAY)).not.toThrow();
    expect(seriesDetail(bundle.db, id, TODAY).nextExpectedOn).not.toBe("2026-02-31");
  });

  test("renames, trimming; rejects empty and unknown", () => {
    const id = netflix().id;
    expect(renameSeries(bundle.db, id, "  Netflix Premium  ")).toBe("Netflix Premium");
    expect(seriesDetail(bundle.db, id, TODAY).name).toBe("Netflix Premium");
    expect(() => renameSeries(bundle.db, id, "   ")).toThrow(/cannot be empty/);
    expect(() => renameSeries(bundle.db, "nope", "X")).toThrow(/Unknown recurring series/);
  });
});

describe("searchAttachCandidates", () => {
  test("a text query matches unlinked, non-future rows by description", () => {
    const rented = insertTxn({ postedOn: "2026-05-20", amountCents: -1549, rawDescription: "NETFLIX RENTAL" });
    insertTxn({ postedOn: "2026-08-01", amountCents: -1549, rawDescription: "NETFLIX FUTURE" }); // future → excluded
    const results = searchAttachCandidates(bundle.db, netflix().id, "NETFLIX", TODAY);
    const ids = results.map((r) => r.id);
    expect(ids).toContain(rented);
    // the six linked charges are already tagged → never candidates
    expect(results.every((r) => r.description.includes("NETFLIX") || r.description.includes("Netflix"))).toBe(true);
    expect(results.some((r) => r.postedOn > TODAY)).toBe(false);
  });

  test("an empty query falls back to an amount window around the expected charge", () => {
    const near = insertTxn({ postedOn: "2026-05-21", amountCents: -1500, rawDescription: "SOME SUB" });
    const far = insertTxn({ postedOn: "2026-05-22", amountCents: -9999, rawDescription: "BIG SPEND" });
    const results = searchAttachCandidates(bundle.db, netflix().id, "", TODAY);
    const ids = results.map((r) => r.id);
    expect(ids).toContain(near);
    expect(ids).not.toContain(far);
  });

  test("throws on an unknown series", () => {
    expect(() => searchAttachCandidates(bundle.db, "nope", "x", TODAY)).toThrow(/Unknown recurring series/);
  });

  test("rows already linked to a series are never candidates", () => {
    const loose = insertTxn({ postedOn: "2026-05-23", amountCents: -1549, rawDescription: "NETFLIX EXTRA" });
    attachTransactions(bundle.db, netflix().id, [loose], TODAY);
    const results = searchAttachCandidates(bundle.db, netflix().id, "NETFLIX", TODAY);
    expect(results.map((r) => r.id)).not.toContain(loose);
  });
});

describe("next-expected agrees between the list and the detail page", () => {
  // Regression guard: listSeries rolls a stale stored nextExpectedOn forward so
  // the read path never shows a past date as "next". seriesDetail must apply the
  // SAME rule, or /recurring and /recurring/[id] state two different dates for
  // one series — which is exactly the cross-surface disagreement this pass exists
  // to remove.
  function setStale(status: "confirmed" | "dismissed", nextExpectedOn: string): string {
    const id = netflix().id;
    bundle.db
      .update(recurringSeries)
      .set({ status, nextExpectedOn })
      .where(eq(recurringSeries.id, id))
      .run();
    return id;
  }

  test("a confirmed series with a stale stored date shows the same rolled date on both surfaces", () => {
    const id = setStale("confirmed", "2026-04-15"); // ~3 months before TODAY
    const detail = seriesDetail(bundle.db, id, TODAY);
    const listed = listSeries(bundle.db, TODAY).find((s) => s.id === id)!;

    expect(detail.nextExpectedOn).toBe(listed.nextExpectedOn);
    expect(detail.nextExpectedOn! >= TODAY).toBe(true);
    // the un-rolled value stays available so the UI can tell shown from saved
    expect(detail.storedNextExpectedOn).toBe("2026-04-15");
  });

  test("a dismissed series is never rolled forward — that would invent a future charge", () => {
    const id = setStale("dismissed", "2026-04-15");
    const detail = seriesDetail(bundle.db, id, TODAY);
    const listed = listSeries(bundle.db, TODAY).find((s) => s.id === id)!;

    expect(detail.nextExpectedOn).toBe("2026-04-15");
    expect(listed.nextExpectedOn).toBe("2026-04-15");
  });
});
