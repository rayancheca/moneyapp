import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type Cadence, type SeriesKind, type SeriesStatus } from "@/db/schema/recurring";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { upcomingOccurrences } from "./recurring";
import { subscriptionsCard } from "./subscriptions-card";

/**
 * The card's claim is a claim about the FORECAST — "these are still counted,
 * these are not" — so the tests that matter most are the ones that would catch
 * it disagreeing with the forecast, or quietly turning a refund into a saving.
 *
 * The real ledger measured 2026-08-26: five live money-out series at $991.59 a
 * month, six lapsed at $4,158.01, and the largest lapsed line is the rent, one
 * day past its own tolerance because August's statement has not landed. Every
 * shape below exists because getting it wrong would misreport that.
 */

let dir: string;
let bundle: DbBundle;
let accountId: string;
let categoryId: string;

/** Monthly tolerance is 30 × 1.5 + 3 = 48 days, so these sit either side of it. */
const TODAY = "2026-08-26";
const FRESH = "2026-08-10"; // 16 days — comfortably inside
const LAPSED = "2026-05-01"; // 117 days — 69 past

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-subs-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  accountId = "acct-1";
  bundle.db
    .insert(accounts)
    .values({
      id: accountId,
      institutionId,
      name: "Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  categoryId = bundle.db.select().from(categories).all()[0]!.id;
  /*
   * ⛔ THE LEDGER HAS TO OPEN ON A MONTH BOUNDARY, or the card's posted window
   * is not six months long. `baselineWindow` floors at the first month the
   * ledger covers IN FULL — a stub month is not a month — so without this row
   * the earliest charge in a test dates the ledger and the window collapses.
   * It carries no `recurringSeriesId`, so no series claims it.
   */
  bundle.db
    .insert(transactions)
    .values({
      id: "t-ledger-opens",
      accountId,
      postedOn: "2025-01-01",
      amountCents: -1,
      rawDescription: "LEDGER OPENS",
      normalizedDescription: "LEDGER OPENS",
      categoryId: null,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: "h-ledger-opens",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

let seriesSeq = 0;
function addSeries(opts: {
  name: string;
  kind?: SeriesKind;
  status?: SeriesStatus;
  cadence?: Cadence;
  /** net-worth signed: money out is negative, like the ledger stores it */
  amountCents?: number | null;
  userAmountCents?: number | null;
  lastMatchedOn?: string | null;
  nextExpectedOn?: string | null;
  userEndsOn?: string | null;
  intervalDaysAvg?: number | null;
}): string {
  seriesSeq += 1;
  const id = `series-${seriesSeq}`;
  const cadence = opts.cadence ?? "monthly";
  bundle.db
    .insert(recurringSeries)
    .values({
      id,
      name: opts.name,
      kind: opts.kind ?? "subscription",
      cadence,
      intervalDaysAvg: opts.intervalDaysAvg ?? (cadence === "weekly" ? 7 : 30),
      amountCentsAvg: opts.amountCents === undefined ? -1000 : opts.amountCents,
      toleranceDays: 3,
      nextExpectedOn: opts.nextExpectedOn === undefined ? "2026-09-10" : opts.nextExpectedOn,
      nextExpectedAmountCents: opts.amountCents === undefined ? -1000 : opts.amountCents,
      status: opts.status ?? "confirmed",
      lastMatchedOn: opts.lastMatchedOn === undefined ? FRESH : opts.lastMatchedOn,
      userAmountCents: opts.userAmountCents ?? null,
      userEndsOn: opts.userEndsOn ?? null,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

let txnSeq = 0;
function addTxn(opts: {
  seriesId: string | null;
  day: string;
  cents: number;
  splits?: { cents: number }[];
}): string {
  txnSeq += 1;
  const id = `txn-${txnSeq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId,
      postedOn: opts.day,
      amountCents: opts.cents,
      rawDescription: "CHARGE",
      normalizedDescription: "CHARGE",
      categoryId,
      recurringSeriesId: opts.seriesId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `hash-${txnSeq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  for (const [i, s] of (opts.splits ?? []).entries()) {
    bundle.db
      .insert(transactionSplits)
      .values({
        id: `${id}-split-${i}`,
        transactionId: id,
        categoryId,
        amountCents: s.cents,
        sortOrder: i,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }
  return id;
}

const card = () => subscriptionsCard(bundle.db, TODAY);

describe("subscriptionsCard — the happy path", () => {
  test("splits live from lapsed, levels both to a month, and names the loudest lapsed line", () => {
    // Arrange: one fresh bill, one that stopped charging months ago
    addSeries({ name: "Breezeline", kind: "bill", amountCents: -5000, lastMatchedOn: FRESH });
    addSeries({ name: "Old rent", kind: "bill", amountCents: -177949, lastMatchedOn: LAPSED });
    addSeries({ name: "Dead sub", amountCents: -799, lastMatchedOn: LAPSED });

    // Act
    const c = card()!;

    // Assert
    expect(c.live.map((l) => l.name)).toEqual(["Breezeline"]);
    expect(c.liveMonthlyCents).toBe(5000);
    expect(c.lapsedMonthlyCents).toBe(177949 + 799);
    // longest quiet first — both lapsed on the same day, so money breaks the tie
    expect(c.lapsed.map((l) => l.name)).toEqual(["Old rent", "Dead sub"]);
    // the caveat names the biggest by MONEY, which is the one the reader cares about
    expect(c.largestLapsed?.name).toBe("Old rent");
    /*
     * 🔴 "last seen 2026-08-10" — a raw ISO in a sentence, nine times on the
     * dashboard, while the card BESIDE it read "latest Sep 18, 2024 — 723 days
     * ago" and /recurring's shared rule said "last seen 68d ago" for the same
     * fact. Three spellings of one thing, two of them a click apart.
     */
    expect(c.live[0]!.lastMatchedLabel).toBe("Aug 10");
    expect(c.largestLapsed?.lastMatchedLabel).toBe("May 1");
    expect(c.lapsedSharePct).toBeCloseTo(((177949 + 799) / (5000 + 177949 + 799)) * 100, 6);
  });

  test("the list leads with the deadest line but the sentence names the dearest", () => {
    /*
     * Two different questions, and they must be answered by two different
     * orderings: sorting by money would bury a long-dead subscription under a
     * big one, and naming the oldest in the sentence would headline $24.20 while
     * ignoring an $1,779.49 bill.
     *
     * ⚠️ This test originally paired a 792-days-dead line with the RENT at one
     * day past tolerance, which was the real ledger's shape at the time. It is
     * no longer, and that is a fix rather than a drift: a bill one cycle quiet
     * is late, not cancelled (`LAPSED_MISS_LIMIT` in recurring.ts), so the rent
     * is live now and cannot serve as the dear-but-recent half. The old landlord
     * — 230 days quiet, genuinely gone — plays that part instead.
     */
    addSeries({ name: "Long dead", amountCents: -2420, lastMatchedOn: "2024-05-07" });
    addSeries({ name: "Old landlord", kind: "bill", amountCents: -177949, lastMatchedOn: "2026-01-08" });

    const c = card()!;
    // deadest first
    expect(c.lapsed.map((l) => l.name)).toEqual(["Long dead", "Old landlord"]);
    expect(c.lapsed[0]!.daysSinceLastMatch).toBeGreaterThan(c.lapsed[1]!.daysSinceLastMatch!);
    // …but the sentence names the one that costs the most
    expect(c.largestLapsed?.name).toBe("Old landlord");
  });

  /**
   * ⛔ The other half of that fix, pinned here because this card is where it
   * showed: a bill one cycle quiet must stay in the FORECAST. The rent's real
   * shape on 2026-08-26 — 49 days against a 48-day tolerance — dropped the
   * largest bill in the ledger out of the runway's committed book, which read
   * $782.41 a month against a true $3,068.11.
   */
  test("a bill one cycle quiet is still forecast, not filed as stopped", () => {
    addSeries({ name: "Rent, one day late", kind: "bill", amountCents: -228570, lastMatchedOn: "2026-07-08" });

    const c = card()!;
    expect(c.live.map((l) => l.name)).toContain("Rent, one day late");
    expect(c.lapsed).toHaveLength(0);
  });

  test("a lapsed line publishes how far past its OWN tolerance it is, not a fixed band", () => {
    // 117 days quiet against a 30 × 1.5 + 3 = 48-day tolerance
    addSeries({ name: "Dead sub", amountCents: -799, lastMatchedOn: LAPSED });
    const c = card()!;
    expect(c.lapsed[0]!.daysSinceLastMatch).toBe(117);
    expect(c.lapsed[0]!.daysPastTolerance).toBe(69);
  });

  test("a fractional tolerance is counted past the whole day the sentence prints", () => {
    // 27.7 × 1.5 + 3 = 44.55 days: the staleness sentence says "the 44-day
    // tolerance", so 117 days is 73 past it — rounding the gap said 72
    addSeries({ name: "Drifted sub", amountCents: -799, lastMatchedOn: LAPSED, intervalDaysAvg: 27.7 });
    expect(card()!.lapsed[0]!.daysPastTolerance).toBe(73);
  });

  test("the live set is exactly what upcomingOccurrences forecasts", () => {
    // the card's whole claim is a claim about the forecast, so the two must not
    // be able to disagree about which series are being projected
    addSeries({ name: "Fresh", kind: "bill", amountCents: -5000, lastMatchedOn: FRESH });
    addSeries({ name: "Quiet", kind: "bill", amountCents: -6000, lastMatchedOn: LAPSED });
    addSeries({ name: "New lease", kind: "bill", amountCents: -55989, lastMatchedOn: null });

    const forecast = new Set(upcomingOccurrences(bundle.db, TODAY, 365).map((o) => o.seriesId));
    const c = card()!;
    expect(new Set(c.live.map((l) => l.seriesId))).toEqual(forecast);
    for (const l of c.lapsed) expect(forecast.has(l.seriesId)).toBe(false);
  });

  test("a never-billed commitment is live, flagged, and counted into its own share", () => {
    // ⛔ isSeriesActive would call this dead. It is the opposite of dead — the
    // car lease was registered by hand and posts nothing until next month.
    addSeries({ name: "Car lease", kind: "bill", amountCents: -55989, lastMatchedOn: null });
    addSeries({ name: "Breezeline", kind: "bill", amountCents: -5000, lastMatchedOn: FRESH });

    const c = card()!;
    expect(c.live.map((l) => l.name)).toEqual(["Car lease", "Breezeline"]);
    expect(c.live.find((l) => l.name === "Car lease")!.neverBilled).toBe(true);
    expect(c.live.find((l) => l.name === "Breezeline")!.neverBilled).toBe(false);
    expect(c.neverBilledMonthlyCents).toBe(55989);
    expect(c.neverBilledSharePct).toBeCloseTo((55989 / (55989 + 5000)) * 100, 6);
  });

  test("a weekly series is levelled by 52 ÷ 12, not by four weeks in a month", () => {
    // × 4 is eleven months of a weekly bill a year — income-basis owns the table
    addSeries({ name: "Weekly", kind: "bill", cadence: "weekly", amountCents: -1000, lastMatchedOn: "2026-08-24" });
    const c = card()!;
    expect(c.live[0]!.monthlyCents).toBe(Math.round((1000 * 52) / 12));
    expect(c.live[0]!.perOccurrenceCents).toBe(1000);
  });

  test("a user amount override beats the detected one", () => {
    addSeries({ name: "Insurance", kind: "bill", amountCents: -1000, userAmountCents: -36149, lastMatchedOn: FRESH });
    expect(card()!.liveMonthlyCents).toBe(36149);
  });
});

describe("subscriptionsCard — what it refuses to answer", () => {
  test("no recurring series at all → null, never a card of zeroes", () => {
    expect(card()).toBeNull();
  });

  test("income and transfer series alone → null, because none of it is money owed", () => {
    // a transfer moves money between accounts he already holds; nothing leaves
    addSeries({ name: "Cash job", kind: "income", amountCents: 104600, lastMatchedOn: FRESH });
    addSeries({ name: "To savings", kind: "transfer", amountCents: -50000, lastMatchedOn: FRESH });
    addSeries({ name: "Unclassified", kind: "other", amountCents: -50000, lastMatchedOn: FRESH });
    expect(card()).toBeNull();
  });

  test("dismissed and ended series are not on the books at all", () => {
    addSeries({ name: "Dismissed", kind: "bill", status: "dismissed", amountCents: -5000 });
    addSeries({ name: "Ended", kind: "bill", status: "ended", amountCents: -5000 });
    expect(card()).toBeNull();
  });

  test("a series with no expected amount is counted, not silently levelled into a zero row", () => {
    addSeries({ name: "Unpriced", kind: "bill", amountCents: null, lastMatchedOn: FRESH });
    expect(card()).toBeNull();

    addSeries({ name: "Breezeline", kind: "bill", amountCents: -5000, lastMatchedOn: FRESH });
    const c = card()!;
    expect(c.unforecastableCount).toBe(1);
    expect(c.live.map((l) => l.name)).toEqual(["Breezeline"]);
  });

  test("a commitment whose end date has passed is over, and costs nothing going forward", () => {
    // mirrors projectOccurrences: it breaks the moment the stepped date passes
    // userEndsOn, so this series emits no occurrences and must not be levelled
    addSeries({
      name: "Finished lease",
      kind: "bill",
      amountCents: -55989,
      lastMatchedOn: FRESH,
      nextExpectedOn: "2026-09-10",
      userEndsOn: "2026-08-01",
    });
    expect(card()).toBeNull();
  });

  /*
   * 🔴 A DEFECT THIS SESSION'S OWN FIX CREATED, found by re-checking it.
   *
   * Moving the `userEndsOn` test into `rollForwardNextExpected` (8a7cef8) was
   * right, but it turned a bare `continue` here into a `null` that fell through
   * to the unforecastable bucket — and the card prints that bucket as
   * "N more have no expected amount or no expected date, so nothing could be
   * levelled from them."
   *
   * An ended lease has BOTH. What it lacks is a FUTURE date, which is a
   * different fact and deserves a different sentence: on the real ledger the
   * card would have said that about Car insurance ($361.49, monthly on the
   * 11th) and Car lease ($695.04, monthly on the 15th) — the two largest
   * commitments in the book.
   */
  test("an ended commitment is counted as ended, not as unpriced", () => {
    addSeries({ name: "Breezeline", kind: "bill", amountCents: -5000, lastMatchedOn: FRESH });
    addSeries({
      name: "Finished lease",
      kind: "bill",
      amountCents: -55989,
      lastMatchedOn: FRESH,
      nextExpectedOn: "2026-09-10",
      userEndsOn: "2026-08-01",
    });
    addSeries({ name: "Unpriced", kind: "bill", amountCents: null, lastMatchedOn: FRESH });

    const c = card()!;
    expect(c.endedCount).toBe(1);
    expect(c.unforecastableCount).toBe(1);
    expect(c.live.map((l) => l.name)).toEqual(["Breezeline"]);
  });

  test("a series with no expected DATE at all is unforecastable, not ended", () => {
    addSeries({ name: "Breezeline", kind: "bill", amountCents: -5000, lastMatchedOn: FRESH });
    addSeries({ name: "Dateless", kind: "bill", amountCents: -1000, lastMatchedOn: FRESH, nextExpectedOn: null });

    const c = card()!;
    expect(c.unforecastableCount).toBe(1);
    expect(c.endedCount).toBe(0);
  });
});

describe("subscriptionsCard — division guards", () => {
  test("everything lapsed → the never-billed share is withheld, never Infinity", () => {
    // liveMonthlyCents is zero and reachable: every series can go quiet at once
    addSeries({ name: "Dead sub", amountCents: -799, lastMatchedOn: LAPSED });
    const c = card()!;
    expect(c.liveMonthlyCents).toBe(0);
    expect(c.neverBilledSharePct).toBeNull();
    expect(Number.isFinite(c.lapsedSharePct)).toBe(true);
    expect(c.lapsedSharePct).toBe(100);
  });

  test("nothing lapsed → the lapsed share is a real zero and no line is named", () => {
    addSeries({ name: "Breezeline", kind: "bill", amountCents: -5000, lastMatchedOn: FRESH });
    const c = card()!;
    expect(c.lapsedSharePct).toBe(0);
    expect(c.largestLapsed).toBeNull();
    expect(c.lapsed).toEqual([]);
  });
});

describe("subscriptionsCard — refunds NET, they are never filtered", () => {
  test("a refund reduces what the series took and is not counted as a charge", () => {
    // ⛔ `WHERE amount_cents < 0` would report $30.00 across 3 charges. The
    // ledger was understated $487.50 by exactly this reading (pass 66).
    const id = addSeries({ name: "Sub", amountCents: -1000, lastMatchedOn: FRESH });
    addTxn({ seriesId: id, day: "2026-03-05", cents: -1000 });
    addTxn({ seriesId: id, day: "2026-04-05", cents: -1000 });
    addTxn({ seriesId: id, day: "2026-05-05", cents: -1000 });
    addTxn({ seriesId: id, day: "2026-05-20", cents: 1000 }); // refunded

    const c = card()!;
    expect(c.live[0]!.postedCents).toBe(2000);
    expect(c.live[0]!.postedCount).toBe(3);
    expect(c.postedCents).toBe(2000);
    expect(c.postedCount).toBe(3);
  });

  test("a fully refunded series posts nothing, and still is not deleted from the card", () => {
    const id = addSeries({ name: "Sub", amountCents: -1000, lastMatchedOn: FRESH });
    addTxn({ seriesId: id, day: "2026-03-05", cents: -1000 });
    addTxn({ seriesId: id, day: "2026-03-20", cents: 1000 });

    const c = card()!;
    expect(c.postedCents).toBe(0);
    expect(c.live).toHaveLength(1);
    expect(c.liveMonthlyCents).toBe(1000);
  });

  test("a SPLIT recurring row contributes its parts exactly once", () => {
    // activeTxnsInRange explodes a split into parts carrying the PARENT's id,
    // so summing the parts must recover the parent, not double it
    const id = addSeries({ name: "Rent", kind: "bill", amountCents: -228570, lastMatchedOn: FRESH });
    addTxn({
      seriesId: id,
      day: "2026-04-08",
      cents: -228570,
      splits: [{ cents: -200000 }, { cents: -28570 }],
    });
    const c = card()!;
    expect(c.live[0]!.postedCents).toBe(228570);
    expect(c.live[0]!.postedCount).toBe(2);
  });

  test("rows outside the window and rows tagged to nothing are left out", () => {
    const id = addSeries({ name: "Sub", amountCents: -1000, lastMatchedOn: FRESH });
    addTxn({ seriesId: id, day: "2026-04-05", cents: -1000 }); // inside 2026-02..2026-07
    addTxn({ seriesId: id, day: "2026-08-05", cents: -1000 }); // current month, excluded
    addTxn({ seriesId: id, day: "2025-12-05", cents: -1000 }); // before the window
    addTxn({ seriesId: null, day: "2026-04-06", cents: -9999 }); // not recurring at all

    const c = card()!;
    expect(c.fromMonth).toBe("2026-02");
    expect(c.toMonth).toBe("2026-07");
    expect(c.postedCents).toBe(1000);
    expect(c.postedCount).toBe(1);
  });

  test("an excluded row is not spend, even though it is tagged to the series", () => {
    const id = addSeries({ name: "Sub", amountCents: -1000, lastMatchedOn: FRESH });
    const txn = addTxn({ seriesId: id, day: "2026-04-05", cents: -1000 });
    bundle.db.run(`UPDATE transactions SET status = 'excluded' WHERE id = '${txn}'`);
    expect(card()!.postedCents).toBe(0);
  });
});
