import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { arrearsSentence } from "@/lib/committed";
import { arrearsThisMonth } from "./arrears";
import { billingCarriers, billPaymentsBySeries } from "./billing-carriers";
import { budgetOverdue, budgetTail } from "./budgets";
import { predictCategory } from "./category-forecast";
import { checkedThrough } from "./checked-days-fixture";
import { committedBook } from "./committed";
import { dashboardData } from "./dashboard";
import { forecastForMonth } from "./forecast";
import { nextStillToCome, stillToComeReader, type StillToCome } from "./payday-settlement";
import { listSeries, upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * ⚖️ His decision 76 (2026-10-14, his answer, refines 73): THE NEARER DUE DAY WINS — the option he chose, word for
 * word: "A payment between two due days pays the one it's nearer to (a tie goes to the earlier one), unless the nearer
 * one is already paid on time." What a payment LEFT OVER then pays, his answer does not say; three defaults built, not
 * asked (2026-10-21, below — `paymentFor`): (a) nearer the EARLIER day, paid on time by another, it pays nothing; (b)
 * nearer a day paid EARLY by another, nothing too; (c) nearer the LATER day, paid on time by another, it is the earlier
 * day's, late — or nothing, once that day is paid. On every grader of a bill's day: the arrears (the runway's "came
 * due … not posted", /budgets' "expected by now", the bill's "Already due"), the calendar, and every reader that looks
 * ahead (the forecast, Upcoming, the dashboard strip, "Next expected").
 *
 * 🔴 Measured on his ledger copy 2026-10-13: the Car lease, due the 15th (3 days' grace), posted Sep 2 −$695.04 — and
 * decision 73 read it as Aug 15's LATE payment (Aug 15 was unpaid, so it kept the payment), leaving Sep 15 unpaid; a
 * web pay around every 1st would read as the month before's, and the newest 15th "not posted" once Wells Fargo is read
 * past it. His lease is anchored on Oct 15 (his date), so no grader asks his Aug 15 or Sep 15 and nothing on his ledger
 * moves today; the fixtures anchor each bill where its days are graded. Jul 10 −$14.21 and Jul 28 −$56.22 are every
 * FPL posting on his ledger, on Chase Checking, read only through Aug 12 (his copy, 2026-10-29): every other FPL
 * payment below is a what-if.
 */

let dir: string;
let bundle: DbBundle;
let categoryId: string;
const LEASE = "lease";
const FPL = "fpl";
const RENT = "rent";
const UTIL = "util";
const MEAL = "meal";
const now = (): string => new Date().toISOString();

function pay(id: string, seriesId: string, postedOn: string, cents: number): void {
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: "acct",
      postedOn,
      amountCents: cents,
      rawDescription: id,
      normalizedDescription: id.toUpperCase(),
      categoryId,
      recurringSeriesId: seriesId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${id}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

const bill = (id: string, name: string, cents: number, nextOn: string) => ({
  id,
  name,
  kind: "bill" as const,
  cadence: "monthly" as const,
  intervalDaysAvg: 30,
  amountCentsAvg: cents,
  toleranceDays: 3,
  nextExpectedOn: nextOn,
  nextExpectedAmountCents: cents,
  userAmountCents: cents,
  anchorDay: Number(nextOn.slice(8)),
  accountId: "acct",
  status: "confirmed" as const,
  userCategoryId: categoryId,
  createdAt: now(),
  updatedAt: now(),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-nearer-due-day-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: "acct",
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Wells Fargo Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  categoryId = bundle.db.select().from(categories).all().find((c) => c.kind === "expense" && c.parentId === null)!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** one series and its own rows, as given — `[postedOn, cents]` */
function seriesWith(id: string, name: string, cents: number, anchor: string, ...rows: [string, number][]): void {
  bundle.db
    .insert(recurringSeries)
    .values({ ...bill(id, name, cents, anchor), lastMatchedOn: rows.at(-1)?.[0] ?? null })
    .run();
  for (const [postedOn, rowCents] of rows) pay(`t-${id}-${postedOn}`, id, postedOn, rowCents);
}

/** each series' marks on a day — `[series, state, paidWith]` */
const marks = (key: string, day: string, today: string) =>
  (recurringCalendar(bundle.db, key, today).entriesByDay[day] ?? []).map((e) => [e.seriesId, e.state, e.paidWith]);
/**
 * the series drawn UNPAID on a day — missed, or "?" where one or two postings prove no schedule yet
 * (`scheduleIsProven`): which state is the read's, not the payment's
 */
const unpaid = (key: string, day: string, today: string) =>
  (recurringCalendar(bundle.db, key, today).entriesByDay[day] ?? [])
    .filter((e) => e.paidWith === null && e.transactionId === null && (e.state === "missed" || e.state === "unsettled"))
    .map((e) => e.seriesId);
const owed = (today: string) =>
  arrearsThisMonth(bundle.db, new Set([LEASE, FPL, RENT, UTIL, MEAL]), today).series.map((s) => [
    s.id,
    s.nextDate,
    s.amountCents,
  ]);
const coming = (today: string, id: string) =>
  upcomingOccurrences(bundle.db, today, 60)
    .filter((o) => o.seriesId === id)
    .map((o) => o.date);

describe("the Car lease's Sep 2 −$695.04 pays Sep 15 — 13 days before it, 18 after Aug 15", () => {
  // anchored on Aug 15 so August and September are graded — his own date is Oct 15
  beforeEach(() => seriesWith(LEASE, "Car lease", -69504, "2026-08-15", ["2026-09-02", -69504]));

  test("September draws no Sep 15 mark — the Sep 2 row stands for it — and owes nothing in September", () => {
    checkedThrough(bundle.db, "acct", "2026-09-19");
    const september = recurringCalendar(bundle.db, "2026-09", "2026-09-20");
    expect(Object.keys(september.entriesByDay)).toEqual(["2026-09-02"]);
    expect(september.missedCount).toBe(0);
    expect(owed("2026-09-20")).toEqual([]);
  });

  test("…and Aug 15 is the month owed: August draws it ?, never paid by Sep 2", () => {
    checkedThrough(bundle.db, "acct", "2026-09-19");
    // "?", not ✕: one posting proves no schedule (`scheduleIsProven`) — the state is the read's, never the payment's
    expect(marks("2026-08", "2026-08-15", "2026-09-20")).toEqual([[LEASE, "unsettled", null]]);
    expect(owed("2026-08-25")).toEqual([[LEASE, "2026-08-15", 69504]]);
  });

  test("an Oct 1 web pay — 16 days after Sep 15, 14 before Oct 15 — pays Oct 15: on Oct 13, not still to come", () => {
    pay("t-lease-oct", LEASE, "2026-10-01", -69504);
    // sixty days from Oct 13: Nov 15 alone — Oct 15 is paid
    expect(coming("2026-10-13", LEASE)).toEqual(["2026-11-15"]);
    expect(Object.keys(recurringCalendar(bundle.db, "2026-10", "2026-10-13").entriesByDay)).toEqual(["2026-10-01"]);
  });

  test("a payment past Sep 15's own grace window is Sep 15's, late — never Aug 15's, a whole gap behind it", () => {
    pay("t-lease-sep19", LEASE, "2026-09-19", -69504);
    checkedThrough(bundle.db, "acct", "2026-09-25");
    // Sep 2 still pays Sep 15 early, so Sep 19 — four days past it, past its 3 — pays nothing more
    expect(unpaid("2026-08", "2026-08-15", "2026-09-26")).toEqual([LEASE]);
    expect(owed("2026-09-26")).toEqual([]);
  });
});

describe("a payment past the next day's grace window never reaches back to the day before it", () => {
  beforeEach(() => seriesWith(LEASE, "Car lease", -69504, "2026-08-15", ["2026-09-19", -69504]));

  test("Sep 19 — Sep 15 + 4 — is Sep 15's, late; Aug 15 stays owed, Oct 15 still to come", () => {
    checkedThrough(bundle.db, "acct", "2026-09-25");
    expect(unpaid("2026-08", "2026-08-15", "2026-09-26")).toEqual([LEASE]);
    expect(Object.keys(recurringCalendar(bundle.db, "2026-09", "2026-09-26").entriesByDay)).toEqual(["2026-09-19"]);
    expect(owed("2026-09-26")).toEqual([]);
    expect(coming("2026-09-26", LEASE)[0]).toBe("2026-10-15");
  });
});

describe("FPL, due the 8th — Jul 10 pays Jul 8 on time, Jul 28 (11 days before Aug 8) pays Aug 8 early", () => {
  beforeEach(() =>
    seriesWith(FPL, "FPL (electricity)", -5887, "2026-07-08", ["2026-07-10", -1421], ["2026-07-28", -5622]),
  );

  test("July draws its two rows and no Jul 8 mark; August draws Aug 8 paid early by Jul 28; nothing owed", () => {
    checkedThrough(bundle.db, "acct", "2026-08-19");
    expect(Object.keys(recurringCalendar(bundle.db, "2026-07", "2026-08-20").entriesByDay).sort()).toEqual([
      "2026-07-10",
      "2026-07-28",
    ]);
    expect(marks("2026-08", "2026-08-08", "2026-08-20")).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-07-28", early: true }],
    ]);
    expect(owed("2026-08-20")).toEqual([]);
  });
});

describe("FPL with ONLY Jul 28 — nearer Aug 8, it pays Aug 8 even with Jul 8 unpaid (the cost he accepted)", () => {
  beforeEach(() => seriesWith(FPL, "FPL (electricity)", -5887, "2026-07-08", ["2026-07-28", -5622]));

  test("July draws Jul 8 ? beside the Jul 28 row, and owes its $58.87", () => {
    checkedThrough(bundle.db, "acct", "2026-07-29");
    // "?", not ✕: one posting proves no schedule (`scheduleIsProven`)
    expect(marks("2026-07", "2026-07-08", "2026-07-30")).toEqual([[FPL, "unsettled", null]]);
    expect(owed("2026-07-30")).toEqual([[FPL, "2026-07-08", 5887]]);
  });

  test("August draws Aug 8 paid early by Jul 28, and owes nothing — one month owed either way", () => {
    checkedThrough(bundle.db, "acct", "2026-08-19");
    expect(marks("2026-08", "2026-08-08", "2026-08-20")).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-07-28", early: true }],
    ]);
    expect(owed("2026-08-20")).toEqual([]);
  });
});

/*
 * ⚖️ Default (c), built, not asked (2026-10-21 — he said no more questions): nearer the LATER day, which another
 * payment paid ON TIME, a payment is the EARLIER day's, late — the LATE default (2026-10-12) still reading it once his
 * "unless" rules the later day out, as 73 read it too — or pays nothing, once that day is paid. His answer says no
 * more; this came with the build (f8b5320), not with his words. It pays only a day behind the payment, so nothing
 * still to come moves. Measured on a what-if copy of his ledger 2026-10-21: his September rent moved from Sep 2 to Sep
 * 20 (−$2,291.21) pays Oct 1 early alone; beside an on-time Oct 1 rent it is Sep 1's, late, and September draws the
 * utilities paid with it, where paying nothing leaves Sep 1's rent and utilities missed. Paying nothing would flip
 * this block's first test and billing-carriers.test.ts' (c) pin, and leave (a)'s and (b)'s green.
 */
describe("⚖️ (c) nearer the LATER day, paid ON TIME by another: the earlier's, late (default built, not asked)", () => {
  test("FPL's Jul 28 with Aug 8 paid on Aug 8 — it pays Jul 8, late: July owes nothing", () => {
    seriesWith(FPL, "FPL (electricity)", -5887, "2026-07-08", ["2026-07-28", -5622], ["2026-08-08", -5887]);
    checkedThrough(bundle.db, "acct", "2026-08-19");
    expect(marks("2026-07", "2026-07-08", "2026-08-20")).toEqual([]);
    expect(owed("2026-07-30")).toEqual([]);
    expect(owed("2026-08-20")).toEqual([]);
  });

  test("…and with Jul 8 paid too (Jul 10), Jul 28 pays nothing: one payment, one due day", () => {
    seriesWith(
      FPL,
      "FPL (electricity)",
      -5887,
      "2026-07-08",
      ["2026-07-10", -1421],
      ["2026-07-28", -5622],
      ["2026-08-08", -5887],
    );
    checkedThrough(bundle.db, "acct", "2026-09-12");
    // Sep 8 is not paid early by it: Jul 28 is in no gap of Sep 8's
    expect(unpaid("2026-09", "2026-09-08", "2026-09-13")).toEqual([FPL]);
  });
});

/*
 * ⚖️ Two more defaults built, not asked (2026-10-21 — he said no more questions): what a payment LEFT OVER pays — one
 * nearer a day that another payment already pays — when (c), above, does not redirect it: NOTHING (`paymentFor`). The
 * option he chose for 76 says, word for word, "unless the nearer one is already paid on time", and no more: silent on
 * what that payment pays then. Two shapes: (a) nearer the EARLIER day, paid ON TIME — this block; (b) nearer a day
 * paid EARLY — the next block, which his words do not reach. Paying the other day instead would flip one shape's pins
 * (each names its default) and leave the other's, and (c)'s, green. Measured on what-if copies of his ledger
 * 2026-10-21: the split rent and the Oct 22 prepay below read as pinned. On the ledger itself no live bill's posting
 * is left over or redirected (9 with postings of their own) and no day moves; the lease, on Wells Fargo (read through
 * Sep 24), has posted once — Sep 2 −$695.04 — and owes Oct 15 $695.04, all unread.
 */
describe("⚖️ (a) nearer the EARLIER day, paid ON TIME by another: it pays nothing (default built, not asked)", () => {
  /*
   * ⚖️ The split October (measured on a what-if copy of his ledger with these two rows, read Oct 13, and again Oct 21
   * with that day's statements read — November keeps its −$2,109.00 rent and −$182.21 utilities): Oct 9 lies nearer
   * Oct 1, which Oct 1's $2,000.00 paid on time — so it pays NOTHING, and Nov 1 is still coming. 🔴 Under decision 73
   * Oct 9 paid Nov 1 early (Oct 1 was paid by then, and Oct 9 is more than 3 days before Nov 1): Nov 1 left Upcoming
   * and the November forecast lost its −$2,109.00 rent.
   */
  test("a rent split Oct 1 −$2,000.00 + Oct 9 −$291.21 leaves Nov 1 coming — the rent's and what it carries", () => {
    bundle.db
      .insert(recurringSeries)
      .values([
        { ...bill(RENT, "Flamingo South Beach (rent)", -210900, "2026-09-01"), lastMatchedOn: "2026-10-09" },
        { ...bill(UTIL, "Rent utilities & fees", -18221, "2026-09-01"), userBilledWithSeriesId: RENT },
      ])
      .run();
    pay("t-rent-sep", RENT, "2026-09-02", -229121);
    pay("t-rent-oct1", RENT, "2026-10-01", -200000);
    pay("t-rent-oct9", RENT, "2026-10-09", -29121);
    const TODAY = "2026-10-13";
    expect(coming(TODAY, RENT)).toEqual(["2026-11-01", "2026-12-01"]);
    expect(coming(TODAY, UTIL)).toEqual(["2026-11-01", "2026-12-01"]);
    expect(forecastForMonth(bundle.db, "2026-11", TODAY)!.components.map((c) => c.label)).toContain(
      "Flamingo South Beach (rent)",
    );
    expect(owed(TODAY)).toEqual([]);
  });

  /*
   * The same shape a week after an on-time 15th: Oct 22 lies nearer Oct 15 (7 days to 24), which Oct 15 paid on time.
   * Nov 15 is owed with nothing unread — the runway's and /budgets' "has not posted" — drawn "?" (not yet known: two
   * postings prove no schedule, `scheduleIsProven`; ✕ missed once three do), and from Oct 22 Upcoming still lists it:
   * the $695.04 that left that day is counted again in the forecast. 🔴 As built takes back
   * decision 73 here, which he approved: run against 7aca8e5's paymentFor, Oct 22 paid Nov 15 early (Oct 15 paid by
   * then) and coming("2026-10-23") was ["2026-12-15"]. The split rent above is the same rule: paying the other day
   * early would pay both.
   */
  test("a lease prepaid a week after an on-time Oct 15 (Oct 22) leaves Nov 15 owed, drawn ?, and still coming", () => {
    seriesWith(LEASE, "Car lease", -69504, "2026-10-15", ["2026-10-15", -69504], ["2026-10-22", -69504]);
    expect(coming("2026-10-23", LEASE)).toEqual(["2026-11-15", "2026-12-15"]);
    checkedThrough(bundle.db, "acct", "2026-11-19");
    const november = arrearsThisMonth(bundle.db, new Set([LEASE]), "2026-11-20").series;
    expect(november.map((s) => [s.nextDate, s.amountCents, s.unreadCents])).toEqual([["2026-11-15", 69504, 0]]);
    // "?", not ✕: two postings prove no schedule — the state is the read's, never the payment's (`unpaid`)
    expect(marks("2026-11", "2026-11-15", "2026-11-20")).toEqual([[LEASE, "unsettled", null]]);
  });
});

/*
 * ⚖️ Default (b), built, not asked (2026-10-21), apart from (a): nearer a day another payment paid EARLY. His words do
 * not reach it (that day is not paid on time), so changing (a) or (c) leaves this block green; only changing (b) flips
 * it — and with it billing-carriers.test.ts' known gap, where paying the other day would carry each late rent after a
 * stray early half to the month after its own. Measured on what-if copies of his ledger 2026-10-21: Sep 30 leaves Oct
 * 15 owed ($695.04, all unread there), and after Oct 1, Oct 30 leaves Nov 15 coming where Oct 31 pays it.
 */
describe("⚖️ (b) nearer a day another payment paid EARLY, a payment pays nothing (default built, not asked)", () => {
  /*
   * After a day paid EARLY: the lease paid "around the 1st" — Sep 2 pays Sep 15 (13 days to 18), and Sep 30 lies 15
   * days either side, the tie, Sep 15's: paid already, so Sep 30 pays nothing and Oct 15 is owed. 76 was asked so that
   * paying around the 1st would not read every 15th a month behind; which day of a month's turn the web pay lands on
   * decides it (below): for a bill due the 15th, a pay on the 30th — or Feb 28 or 29, or Mar 1 outside a leap year — is
   * the 15th before's, the tie or nearer it; one on the 31st or the 1st is the next's (billing-carriers.test.ts pins
   * February's). Not a regression: 73 owed Oct 15 for this shape too. Drawn "?" (not yet known), not ✕: two postings
   * prove no schedule (`scheduleIsProven`).
   */
  test("a lease paid Sep 2 then Sep 30 owes Oct 15 — nothing unread, drawn ?, still coming on Sep 30", () => {
    seriesWith(LEASE, "Car lease", -69504, "2026-09-15", ["2026-09-02", -69504], ["2026-09-30", -69504]);
    expect(coming("2026-09-30", LEASE)[0]).toBe("2026-10-15");
    checkedThrough(bundle.db, "acct", "2026-10-20");
    const october = arrearsThisMonth(bundle.db, new Set([LEASE]), "2026-10-21").series;
    expect(october.map((s) => [s.nextDate, s.amountCents, s.unreadCents])).toEqual([["2026-10-15", 69504, 0]]);
    expect(marks("2026-10", "2026-10-15", "2026-10-21")).toEqual([[LEASE, "unsettled", null]]);
  });

  test("…and the month's length decides: after Sep 2 + Oct 1, Oct 30 leaves Nov 15 owed where Oct 31 pays it", () => {
    seriesWith(LEASE, "Car lease", -69504, "2026-09-15", ["2026-09-02", -69504], ["2026-10-01", -69504]);
    pay("t-lease-oct30", LEASE, "2026-10-30", -69504);
    // Oct 30: 15 days after Oct 15 (paid early by Oct 1), 16 before Nov 15
    expect(coming("2026-10-30", LEASE)[0]).toBe("2026-11-15");
    bundle.db.update(transactions).set({ postedOn: "2026-10-31" }).where(eq(transactions.id, "t-lease-oct30")).run();
    // Oct 31: 16 days after Oct 15, 15 before Nov 15 — nearer it
    expect(coming("2026-10-31", LEASE)[0]).toBe("2026-12-15");
  });
});

/*
 * ⚖️ A tie is the earlier day's (decision 76). His rent posted Jun 16 — two rows, one payment (`occurrencesOf`) —
 * exactly 15 days after Jun 1 and 15 before Jul 1: June's, late.
 */
describe("an exact tie pays the earlier day — his Jun 16 rent, 15 days either side", () => {
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values([
        { ...bill(RENT, "Flamingo South Beach (rent)", -210900, "2026-06-01"), lastMatchedOn: "2026-06-16" },
        { ...bill(UTIL, "Rent utilities & fees", -18221, "2026-06-01"), userBilledWithSeriesId: RENT },
      ])
      .run();
  });

  test("Jun 16 pays Jun 1 (June draws no Jun 1 mark), and Jul 1 is owed — not paid early by it", () => {
    pay("t-rent-jun16a", RENT, "2026-06-16", -100000);
    pay("t-rent-jun16b", RENT, "2026-06-16", -129121);
    checkedThrough(bundle.db, "acct", "2026-07-19");
    expect(marks("2026-06", "2026-06-01", "2026-07-20")).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-06-16", early: false }],
    ]);
    expect(unpaid("2026-07", "2026-07-01", "2026-07-20")).toEqual([RENT, UTIL]);
    expect(owed("2026-07-20")).toEqual([
      [RENT, "2026-07-01", 210900],
      [UTIL, "2026-07-01", 18221],
    ]);
  });

  test("a day later is nearer Jul 1: Jun 17 pays Jul 1 early, and Jun 1 is the month owed", () => {
    pay("t-rent-jun17", RENT, "2026-06-17", -229121);
    checkedThrough(bundle.db, "acct", "2026-07-19");
    expect(marks("2026-07", "2026-07-01", "2026-07-20")).toEqual([
      [RENT, "paid", { carrier: null, postedOn: "2026-06-17", early: true }],
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-06-17", early: true }],
    ]);
    expect(owed("2026-07-20")).toEqual([]);
    expect(owed("2026-06-20")).toEqual([
      [RENT, "2026-06-01", 210900],
      [UTIL, "2026-06-01", 18221],
    ]);
  });
});

/*
 * ⚖️ What is billed inside the rent is paid by the rent's payments, by the rent's own test (§6A 59) — unaffected: his
 * rent posted Jul 8, Aug 4 and Sep 2, each its own month's (Jul 8 a week late, nearer Jul 1 than Aug 1).
 */
describe("the utilities carried by the rent are paid with each month's rent payment, as before", () => {
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values([
        { ...bill(RENT, "Flamingo South Beach (rent)", -210900, "2026-07-01"), lastMatchedOn: "2026-09-02" },
        { ...bill(UTIL, "Rent utilities & fees", -18221, "2026-07-01"), userBilledWithSeriesId: RENT },
      ])
      .run();
    pay("t-rent-jul", RENT, "2026-07-08", -228570);
    pay("t-rent-aug", RENT, "2026-08-04", -223711);
    pay("t-rent-sep", RENT, "2026-09-02", -229121);
  });

  test("Jul 1 late by Jul 8, Aug 1 by Aug 4, Sep 1 by Sep 2 — none early, nothing owed, Oct 1 still to come", () => {
    const TODAY = "2026-09-20";
    checkedThrough(bundle.db, "acct", "2026-09-19");
    expect(marks("2026-07", "2026-07-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-07-08", early: false }],
    ]);
    expect(marks("2026-08", "2026-08-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-08-04", early: false }],
    ]);
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-02", early: false }],
    ]);
    expect(owed(TODAY)).toEqual([]);
    expect(coming(TODAY, RENT)[0]).toBe("2026-10-01");
    expect(coming(TODAY, UTIL)[0]).toBe("2026-10-01");
  });
});

/*
 * ⚖️ default built, not asked (2026-10-23) — …and a carrier's payment of TWO pays two of what it carries, as it pays
 * two of its own (`paymentFor`'s catch-up): a carried series' payments are the carrier's, each covering more than one
 * charge where the carrier's posted average names it (`BillPayment.coveredMore`, `carrierPaymentsBySeries`). 🔴 Nothing
 * pinned it (review of b6e11a76): read with every carried payment as one charge, the whole suite passed. ⚠️ His rent
 * cannot reach it — its payments carry the utilities, each above its -$2,109.00 and none at it, so its average names
 * none (a known gap, posted-average.test.ts): a what-if rent here, its rate what each month posts, utilities and all.
 */
describe("⚖️ a carrier's payment of two pays two days of what it carries, as two of its own", () => {
  const TODAY = "2026-10-23";
  beforeEach(() => {
    bundle.db
      .insert(recurringSeries)
      .values([
        { ...bill(RENT, "What-if (rent)", -229121, "2026-07-01"), lastMatchedOn: "2026-09-20" },
        { ...bill(UTIL, "Rent utilities & fees", -18221, "2026-07-01"), userBilledWithSeriesId: RENT },
      ])
      .run();
    // Jul 1 and Aug 1 paid on time, Sep 1 missed, then two months at once
    pay("t-rent-jul", RENT, "2026-07-01", -229121);
    pay("t-rent-aug", RENT, "2026-08-02", -229121);
    pay("t-rent-sep20", RENT, "2026-09-20", -458242);
    checkedThrough(bundle.db, "acct", "2026-10-22");
  });

  test("Sep 20's -$4,582.42 pays the utilities' Sep 1 late and Oct 1 early, as the rent's: nothing owed", () => {
    expect(seriesDetail(bundle.db, RENT, TODAY)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-09-20"]);
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-20", early: false }],
    ]);
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-20", early: true }],
      [RENT, "paid", { carrier: null, postedOn: "2026-09-20", early: true }],
    ]);
    expect(owed("2026-09-30")).toEqual([]);
    expect(owed(TODAY)).toEqual([]);
    // …and on Sep 25 neither is coming on Oct 1: the readers that look ahead read Sep 20 as its payment
    expect(coming("2026-09-25", RENT)[0]).toBe("2026-11-01");
    expect(coming("2026-09-25", UTIL)[0]).toBe("2026-11-01");
  });
});

/*
 * ⛔ …and where a carried series' schedule OPENS is its carrier's — on the day of its own the carrier's date falls due
 * with: the carrier's date he typed, or the earlier of detection's and its own (`openingOf`; the days apart, below): a
 * day before the rent's date is no charge of the rent's, so no payment of the
 * rent's catches one up for what it carries either, none is projected (below), and one payment pays the same days of
 * the rent and of what it carries. ⚖️ default built, not asked (2026-10-29), read off §6A 59's "by the rent's own
 * test". 🔴 At 4d6ec2ac the his-date guard read the carried series' own row (review of 4d6ec2ac): a what-if rent at
 * -$2,291.21 typed Oct 1, the utilities carried on
 * detection's Oct 1 — his ledger's shape, the rent typed Sep 1 and the utilities detected Sep 1 — Jul 1 and Aug 2 paid,
 * then Sep 10 -$4,582.42: October drew the rent's Oct 1 missed beside "Rent utilities & fees paid … with the rent's
 * payment of Sep 10 (early)", the arrears owed the rent $2,291.21 and not the utilities, the runway read "A further
 * $2,291.21 came due earlier this month and has not posted.", and on Sep 25 Upcoming listed the rent's Oct 1 and Nov 1
 * but the utilities' Nov 1 alone, October's forecast the rent without them. And through `couldHaveCharged`, at 32aeb3a9
 * too: Oct 10's two months, late for his Oct 1 itself, drew the rent's Nov 1 "paid early by Oct 10" while the
 * utilities' Nov 1 stayed upcoming. Latent: his rent names no payment of two (the known gap above).
 */
describe("⛔ …and what a carrier carries opens where the carrier's schedule opens — his date on the rent", () => {
  const TODAY = "2026-10-23";
  /**
   * a what-if rent at what a month posts, its date `rentOn` (his when `typed`), the utilities carried on `utilOn`; its
   * last row two months at once, unless `noneOfTwo`
   */
  type Dates = { rentOn: string; typed: boolean; utilOn: string; utilTyped?: boolean; noneOfTwo?: boolean };
  const rentWith = (dates: Dates, ...rows: string[]) => {
    const { rentOn, typed, utilOn, utilTyped = false, noneOfTwo = false } = dates;
    bundle.db
      .insert(recurringSeries)
      .values([
        {
          ...bill(RENT, "What-if (rent)", -229121, rentOn),
          userNextExpectedOn: typed ? rentOn : null,
          lastMatchedOn: rows.at(-1)!,
        },
        {
          ...bill(UTIL, "Rent utilities & fees", -18221, utilOn),
          userNextExpectedOn: utilTyped ? utilOn : null,
          userBilledWithSeriesId: RENT,
        },
      ])
      .run();
    // Jul 1 and Aug 2 at the rate, then the last row two months at once
    const twoAt = noneOfTwo ? -1 : rows.length - 1;
    for (const [i, on] of rows.entries()) pay(`t-rent-${on}`, RENT, on, i === twoAt ? -458242 : -229121);
    checkedThrough(bundle.db, "acct", "2026-10-22");
  };
  const labelsIn = (month: string, today: string) =>
    forecastForMonth(bundle.db, month, today)!.components.map((c) => c.label);
  /** neither Oct 1 paid by Sep 10: both still to come on Sep 25, and both owed on Oct 23, never posted */
  const bothOct1sComeThenAreOwed = (): void => {
    // on Sep 25 both Oct 1s are still to come: Upcoming and October's forecast count the rent AND what it carries
    expect(coming("2026-09-25", RENT)).toEqual(["2026-10-01", "2026-11-01"]);
    expect(coming("2026-09-25", UTIL)).toEqual(["2026-10-01", "2026-11-01"]);
    expect(labelsIn("2026-10", "2026-09-25")).toEqual(
      expect.arrayContaining(["What-if (rent)", "Rent utilities & fees"]),
    );
    // …and on Oct 23, never posted, both are owed: the calendar, the arrears and the runway
    expect(unpaid("2026-10", "2026-10-01", TODAY).sort()).toEqual([RENT, UTIL]);
    expect(owed(TODAY)).toEqual([
      [UTIL, "2026-10-01", 18221],
      [RENT, "2026-10-01", 229121],
    ]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBe(
      "A further $2,473.42 came due earlier this month and has not posted.",
    );
  };

  test("he typed Oct 1, Sep 10 two months late for Sep 1: neither Oct 1 is paid — both coming, then both owed", () => {
    rentWith({ rentOn: "2026-10-01", typed: true, utilOn: "2026-10-01" }, "2026-07-01", "2026-08-02", "2026-09-10");
    expect(seriesDetail(bundle.db, RENT, TODAY)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-09-10"]);
    bothOct1sComeThenAreOwed();
  });

  /*
   * ⛔ …and the carrier's opening is its DAY, not only whether that day is his. 🔴 Nothing pinned it (review of
   * d7a5485c): every pin here put the rent and what it carries on one date, so a builder keeping the utilities' own
   * opening, taking only "his" from the rent, passed the whole suite (449 files, 9,784 tests, the review's run). On his
   * ledger copy 2026-10-29 with this what-if added on Wells Fargo (read through Sep 24) — the rent typed Oct 1, the
   * utilities still on detection's Sep 1, his ledger's shape should he retype only the rent (it is typed Sep 1, they
   * are detected Sep 1) — October drew their Oct 1 "paid … with the rent's payment of Sep 10 (early)" beside the rent's
   * Oct 1 "?"; on Sep 25 Upcoming listed their Nov 1 alone and October's forecast held the rent without them; on Oct 29
   * the arrears owed the rent alone and the runway read "A further $5,811.19 came due earlier this month and no
   * statement has covered it yet." Now both Oct 1s are drawn "?" there, and it reads "A further $5,993.40 …".
   */
  test("…and what it carries still on detection's Sep 1 opens at his Oct 1 too: Sep 10 pays neither Oct 1", () => {
    rentWith({ rentOn: "2026-10-01", typed: true, utilOn: "2026-09-01" }, "2026-07-01", "2026-08-02", "2026-09-10");
    // no day of the rent's lies before Oct 1, nor of what it carries: their own Sep 1 is drawn nowhere (below)
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([]);
    bothOct1sComeThenAreOwed();
  });

  /*
   * ⚖️ …and no day of what it carries is PROJECTED before the rent's date either: where a carried series' schedule opens
   * is where every reader's projection of it starts (`DueDays.opensOn`, `projectOccurrences`) — default built, not
   * asked (2026-10-29), read off the default above: a day no payment of the rent's can catch up is a day no reader
   * draws, owes or lists. 🔴 At 68c837ce their own detected Sep 1 still opened their projection (review of 68c837ce):
   * projected, so graded as a charge, and no charge to the catch-up. A payment of two on time for his Oct 1 — Oct 2
   * -$4,582.42, which the rent's page names as covering more than one month — paid their Oct 1, and September drew
   * their Sep 1 "missed", owed $182.21. On his ledger copy 2026-10-29 with this what-if added on Wells Fargo (read
   * through Oct 26), the runway on Sep 25 read "A further $347.08 came due earlier this month: $182.21 has not posted,
   * and no statement has covered the other $164.87 yet." Now September draws nothing of theirs, and it reads "A
   * further $164.87 came due earlier this month and no statement has covered it yet." — his own bills, as with the
   * rent on detection's Oct 1 (the review's first control, below). The rent's own reading of Oct 2 is unchanged: its
   * Oct 1, and no day before his date.
   */
  test("…and Oct 2's two months, on time for his Oct 1: what it carries draws no Sep 1, missed or owed", () => {
    rentWith({ rentOn: "2026-10-01", typed: true, utilOn: "2026-09-01" }, "2026-07-01", "2026-08-02", "2026-10-02");
    expect(seriesDetail(bundle.db, RENT, TODAY)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-10-02"]);
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([]);
    expect(owed("2026-09-25")).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, "2026-09-25"))).toBeNull();
    // …and Oct 2 pays both Oct 1s on time: nothing owed on Oct 23, Nov 1 next for both
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-02", early: false }],
    ]);
    expect(owed(TODAY)).toEqual([]);
    expect(coming(TODAY, RENT)[0]).toBe("2026-11-01");
    expect(coming(TODAY, UTIL)[0]).toBe("2026-11-01");
  });

  /*
   * …and the review's two controls, the same rows. The rent on detection's Oct 1: a day before a date detection gave
   * is a charge once a payment has posted — Jul 1 here — so their own Sep 1 is one, where their projection starts, and
   * Oct 2's two months pay it, late, beside their Oct 1 on time.
   */
  test("…and the rent on detection's Oct 1: their own Sep 1 is a charge, paid with Oct 1 by Oct 2's two", () => {
    rentWith({ rentOn: "2026-10-01", typed: false, utilOn: "2026-09-01" }, "2026-07-01", "2026-08-02", "2026-10-02");
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-02", early: false }],
    ]);
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-02", early: false }],
    ]);
    expect(owed("2026-09-25")).toEqual([]);
    expect(owed(TODAY)).toEqual([]);
  });

  /*
   * …and their own row read as the rent's (the second control, the carried series read off its own row as at
   * 4d6ec2ac): the rent typed on their own Sep 1 — his ledger's shape, the rent typed Sep 1 and the utilities detected
   * Sep 1 — so the two open on one day, and Oct 2's two months pay Sep 1, late, and Oct 1 of both.
   */
  test("…and the rent typed on their own Sep 1, his ledger's shape: Oct 2's two months pay Sep 1 of both", () => {
    rentWith({ rentOn: "2026-09-01", typed: true, utilOn: "2026-09-01" }, "2026-07-01", "2026-08-02", "2026-10-02");
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-02", early: false }],
      [RENT, "paid", { carrier: null, postedOn: "2026-10-02", early: false }],
    ]);
    expect(owed("2026-09-25")).toEqual([]);
    expect(owed(TODAY)).toEqual([]);
  });

  /*
   * …and with no payment of two at all the same: what it carries opens at his Oct 1 on every reader, as the rent does.
   * 🔴 At 68c837ce their own Sep 1 opened them (review of 68c837ce). On his ledger copy 2026-10-29 with these rows added
   * on Wells Fargo, on Aug 25 Upcoming listed their Sep 1 without the rent, September's forecast held them at -$182.21
   * and the rent not at all, and their page and the All tab named Sep 1 next; on Sep 25 September drew it "?" and the
   * runway read "A further $347.08 came due earlier this month: $182.21 has not posted, and no statement has covered
   * the other $164.87 yet." Now every one opens at Oct 1 with the rent, and the runway reads "A further $164.87 …".
   */
  test("…and with no payment of two, what it carries on detection's Sep 1 opens at his Oct 1 on every reader", () => {
    rentWith({ rentOn: "2026-10-01", typed: true, utilOn: "2026-09-01", noneOfTwo: true }, "2026-07-01", "2026-08-02");
    // on Aug 25 the readers that look ahead list Oct 1 first for both — Upcoming, September's forecast, their page's
    // list and its sentence, and the All tab's Next
    expect(coming("2026-08-25", RENT)).toEqual(["2026-10-01"]);
    expect(coming("2026-08-25", UTIL)).toEqual(["2026-10-01"]);
    expect(labelsIn("2026-09", "2026-08-25")).not.toContain("Rent utilities & fees");
    const page = seriesDetail(bundle.db, UTIL, "2026-08-25")!;
    expect([page.nextExpected[0]!.date, page.nextExpectedOn]).toEqual(["2026-10-01", "2026-10-01"]);
    expect(listSeries(bundle.db, "2026-08-25").find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2026-10-01");
    // …and read past Sep 1, September draws nothing of theirs and owes nothing
    expect(marks("2026-09", "2026-09-01", TODAY)).toEqual([]);
    expect(owed("2026-09-25")).toEqual([]);
  });

  test("…and the rent typed further on, Dec 1: their page lists three dates from Dec 1, as the rent's does", () => {
    rentWith({ rentOn: "2026-12-01", typed: true, utilOn: "2026-09-01", noneOfTwo: true }, "2026-07-01", "2026-08-02");
    const next = (id: string) => seriesDetail(bundle.db, id, "2026-08-25")!.nextExpected.map((o) => o.date);
    expect(next(UTIL)).toEqual(["2026-12-01", "2027-01-01", "2027-02-01"]);
    expect(next(UTIL)).toEqual(next(RENT));
  });

  test("…and Oct 10's two months, late for his Oct 1 itself, pay both Nov 1s early as they pay the rent's", () => {
    rentWith({ rentOn: "2026-10-01", typed: true, utilOn: "2026-10-01" }, "2026-07-01", "2026-08-02", "2026-10-10");
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-10", early: false }],
    ]);
    expect(marks("2026-11", "2026-11-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-10-10", early: true }],
      [RENT, "paid", { carrier: null, postedOn: "2026-10-10", early: true }],
    ]);
    expect(owed(TODAY)).toEqual([]);
    expect(coming(TODAY, RENT)[0]).toBe("2026-12-01");
    expect(coming(TODAY, UTIL)[0]).toBe("2026-12-01");
  });

  test("…and HIS date on what it carries alone opens nothing of the rent's: Sep 10 pays both Oct 1s early", () => {
    // the rent on detection's Oct 1, Sep 1 a charge of its (Jul 1 and Aug 2 posted before it), the utilities typed
    rentWith(
      { rentOn: "2026-10-01", typed: false, utilOn: "2026-10-01", utilTyped: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-10",
    );
    expect(marks("2026-10", "2026-10-01", TODAY)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-09-10", early: true }],
      [RENT, "paid", { carrier: null, postedOn: "2026-09-10", early: true }],
    ]);
    expect(owed(TODAY)).toEqual([]);
    expect(coming("2026-09-25", RENT)[0]).toBe("2026-11-01");
    expect(coming("2026-09-25", UTIL)[0]).toBe("2026-11-01");
  });

  /*
   * ⚖️ …and where it opens is a day of its OWN, the one that falls due with the rent's date: while no payment of that
   * date has posted — none has here, November unpaid — its due day nearest the date, a tie the earlier, as his decision
   * 76 reads a payment between two due days; once one has, the day that payment pays (below; `openingOf`, default
   * built, not asked, 2026-10-29) — so the rent's first month carries its first charge, whichever day of the month each
   * is on. 🔴 At 0ac5d059 the floor cut by DATE, not by period (review of 0ac5d059): the rent typed Nov 2, the day his
   * posts (Sep 2, Oct 2), the utilities on detection's Sep 1 — their Nov 1, the charge the rent's Nov 2 carries, lay
   * before Nov 2 and was drawn, owed and listed nowhere: on Oct 29 Upcoming listed their Dec 1 first beside the rent's
   * Nov 2, November's forecast left them out and their page and the All tab named Dec 1; on Nov 20 the arrears owed the
   * rent alone, "A further $2,291.21 came due earlier this month and has not posted." The forbidden direction: an owed
   * charge hidden. Pinned with the two on different days of the month; every pin before put them on one.
   */
  test("…and the rent typed Nov 2, what it carries on the 1st opens on Nov 1: listed, forecast, then owed", () => {
    rentWith(
      { rentOn: "2026-11-02", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    const OCT29 = "2026-10-29";
    // on Oct 29 the readers that look ahead name their Nov 1 with the rent's Nov 2 — the day it falls due (default (B),
    // 2026-10-30; their own Nov 1 until the review of aa05a56d): Upcoming, November's forecast, their page's list, the
    // All tab's Next — its sentence's editor their own Nov 1 — and a year of twelve charges, not eleven
    expect(coming(OCT29, UTIL)).toEqual(["2026-11-02", "2026-12-02"]);
    expect(coming(OCT29, RENT)).toEqual(["2026-11-02", "2026-12-02"]);
    expect(labelsIn("2026-11", OCT29)).toEqual(expect.arrayContaining(["What-if (rent)", "Rent utilities & fees"]));
    const page = seriesDetail(bundle.db, UTIL, OCT29)!;
    expect([page.nextExpectedOn, page.nextExpected.map((o) => o.date)]).toEqual([
      "2026-11-01",
      ["2026-11-02", "2026-12-02", "2027-01-02"],
    ]);
    expect(page.annualizedCents).toBe(12 * 18221);
    expect(listSeries(bundle.db, OCT29).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2026-11-02");
    // …and on Nov 20, read through Nov 19 with neither posted, both are owed: the calendar, the arrears, the runway
    checkedThrough(bundle.db, "acct", "2026-11-19");
    const NOV20 = "2026-11-20";
    expect(unpaid("2026-11", "2026-11-02", NOV20).sort()).toEqual([RENT, UTIL]);
    expect(owed(NOV20)).toEqual([
      [UTIL, "2026-11-02", 18221],
      [RENT, "2026-11-02", 229121],
    ]);
    expect(arrearsSentence(committedBook(bundle.db, NOV20))).toBe(
      "A further $2,473.42 came due earlier this month and has not posted.",
    );
  });

  /*
   * …and the same root through the catch-up (`liesBeforeHisDate`), already at ae29cda4: November missed, Dec 10 two
   * months. 🔴 Their Nov 1 lay before the rent's Nov 2, so it was no charge and the day behind their Dec 1 read as
   * settled: Dec 10 paid their Dec 1 late and their Jan 1 early, beside the rent's Nov 2 and Dec 2 — on Dec 20 January
   * drew their Jan 1 "paid early by Dec 10" while the rent's Jan 2 stayed to come, Upcoming listed their Feb 1 next and
   * the All tab named it (ae29cda4 still drew their Nov 1 unpaid beside it, 0ac5d059 nowhere). Now Dec 10 pays the two
   * months it pays the rent: their Nov 1 and Dec 1, and their Jan 1 is still to come with the rent's Jan 2.
   */
  test("…and November missed, Dec 10's two months pay their Nov 1 and Dec 1 as the rent's: no Jan 1 early", () => {
    rentWith(
      { rentOn: "2026-11-02", typed: true, utilOn: "2026-09-01" },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-12-10",
    );
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    expect(seriesDetail(bundle.db, RENT, DEC20)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-12-10"]);
    // each drawn and named on the rent's day it falls due with (default (B); its own 1st until the review of aa05a56d)
    const theirs = (key: string, day: string) => marks(key, day, DEC20).filter(([id]) => id === UTIL);
    expect(theirs("2026-11", "2026-11-02")).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-10", early: false }],
    ]);
    expect(theirs("2026-12", "2026-12-02")).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-10", early: false }],
    ]);
    expect(theirs("2027-01", "2027-01-02")).toEqual([[UTIL, "upcoming", null]]);
    expect(owed(DEC20)).toEqual([]);
    expect(coming(DEC20, UTIL)[0]).toBe("2027-01-02");
    expect(coming(DEC20, RENT)[0]).toBe("2027-01-02");
    expect(listSeries(bundle.db, DEC20).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2027-01-02");
  });

  /*
   * ⚖️ …and the day of their own that falls due with the rent's date is the one the rent's PAYMENT of that date pays —
   * their due day nearest that payment, as his decision 76 reads one between two due days; only while none has posted,
   * the one nearest the date itself, a tie the earlier (`openingOf`, default built, not asked, 2026-10-29). 🔴 At
   * ec7fd198 it was read off the date alone (review of ec7fd198): the rent posts a day or more after its date (Sep 2,
   * Oct 2, Jul 8, Aug 4 on his ledger), and one a day past a date on the 15th or 16th lies nearer the NEXT 1st — the
   * rent typed Nov 16 (the tie) or Nov 15 (nearer Nov 1), paid Nov 17 on time, opened the utilities on Nov 1, which no
   * payment of the rent's pays: on Nov 20 November drew their Nov 1 missed, the arrears owed [util, Nov 1, $182.21] and
   * the runway read "A further $182.21 came due earlier this month and has not posted." beside a rent paid in full,
   * while December drew their Dec 1 paid early by Nov 17 — a month shown owed for good. 0ac5d059 read this shape so.
   */
  test.each([
    ["2026-11-16", "the tie"],
    ["2026-11-15", "nearer Nov 1"],
  ])("…and the rent typed %s (%s), paid Nov 17: what it carries opens on Dec 1, which Nov 17 pays", (rentOn) => {
    rentWith(
      { rentOn, typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-17",
    );
    checkedThrough(bundle.db, "acct", "2026-11-19");
    const NOV20 = "2026-11-20";
    // Nov 17 paid the rent's first day, on time: its own day, that one
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: "2026-11-17", dueDaysPast: 0 });
    // November draws nothing of theirs and owes nothing: their Nov 1 lies before the day Nov 17 opens them on
    expect(marks("2026-11", "2026-11-01", NOV20)).toEqual([]);
    expect(owed(NOV20)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, NOV20))).toBeNull();
    // …and Nov 17 pays their Dec 1 early, as the rent's own first month: Jan 1 next, beside the rent's December day
    expect(marks("2026-12", "2026-12-01", NOV20)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-11-17", early: true }],
    ]);
    expect(coming(NOV20, UTIL)[0]).toBe("2027-01-01");
    expect(listSeries(bundle.db, NOV20).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2027-01-01");
  });

  /*
   * …and the review's control, the same rows: paid ON Nov 16, the tie's own day — 15 days after their Nov 1, 15
   * before Dec 1 — the payment pays Nov 1, late, so Nov 1 opens them, and Dec 1 still comes.
   */
  test("…and paid ON Nov 16: Nov 16 pays their Nov 1, late — they open there, Dec 1 still to come", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
    );
    checkedThrough(bundle.db, "acct", "2026-11-19");
    const NOV20 = "2026-11-20";
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: "2026-11-16", dueDaysPast: 0 });
    // drawn on the rent's Nov 16 their Nov 1 falls due with, and Dec 1 next with its Dec 16 (default (B); their own
    // 1st until the review of aa05a56d)
    expect(marks("2026-11", "2026-11-01", NOV20)).toEqual([]);
    expect(marks("2026-11", "2026-11-16", NOV20).filter(([id]) => id === UTIL)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-11-16", early: false }],
    ]);
    expect(owed(NOV20)).toEqual([]);
    expect(coming(NOV20, UTIL)[0]).toBe("2026-12-16");
  });

  /*
   * ⛔ …and while no payment of the rent's Nov 16 has posted, their day nearest it opens them — the tie, the earlier
   * (ec7fd198's reading, kept): owed with the rent once read past, the safe side. The payment then says which day was
   * theirs. ⛔ Money back is no payment of it (`PaymentDays.paid`): +$2,291.21 back on Nov 17, a day past the tie, read
   * as one would open them on Dec 1 and take their Nov 1 out of what is owed beside the rent's.
   */
  test.each([
    ["nothing posted", null],
    ["+$2,291.21 back on Nov 17", 229121],
  ])("…and the rent's Nov 16 not yet paid (%s): the tie opens them on Nov 1, owed with it", (_, backCents) => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    if (backCents !== null) pay("t-rent-back", RENT, "2026-11-17", backCents);
    checkedThrough(bundle.db, "acct", "2026-11-22");
    const NOV23 = "2026-11-23";
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toBeNull();
    // owed, drawn and named on the rent's Nov 16 their Nov 1 falls due with (default (B); their own Nov 1 until the
    // review of aa05a56d)
    expect(unpaid("2026-11", "2026-11-01", NOV23)).toEqual([]);
    expect(unpaid("2026-11", "2026-11-16", NOV23).sort()).toEqual([RENT, UTIL]);
    expect(owed(NOV23)).toEqual([
      [UTIL, "2026-11-16", 18221],
      [RENT, "2026-11-16", 229121],
    ]);
    expect(arrearsSentence(committedBook(bundle.db, NOV23))).toBe(
      "A further $2,473.42 came due earlier this month and has not posted.",
    );
  });

  /*
   * ⛔ …and what paid the rent's first day is read by the rent's own test, HIS date included: Oct 20's two months, late
   * for its Oct 16 — a day before his Nov 16, no charge, nothing a payment of two catches up from (`liesBeforeHisDate`)
   * — paid no day of his, so his Nov 16 is owed on Nov 23 and nothing is read off Oct 20 for what it carries. Read
   * without his date, Oct 20 would pay Nov 16 as its second charge, the day after its own Oct 16.
   */
  test("…and Oct 20's two months before his Nov 16 paid no day of his: nothing opens them off it", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01" },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-20",
    );
    checkedThrough(bundle.db, "acct", "2026-11-22");
    const NOV23 = "2026-11-23";
    expect(seriesDetail(bundle.db, RENT, NOV23)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-10-20"]);
    expect(owed(NOV23)).toContainEqual([RENT, "2026-11-16", 229121]);
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toBeNull();
  });

  /*
   * ⚖️ …and a payment of two that caught the rent's first day up from its next pairs their days the same way: Dec 20,
   * late for the rent's Dec 16 (nearer it), pays its Nov 16 too; nearer their Jan 1, it pays Jan 1 early and the day
   * behind it, Dec 1 — so Dec 1, the day behind the one nearest it, opens them, and their Nov 1 is no charge (default
   * built, not asked, 2026-10-29). 🔴 At ec7fd198 Nov 1 opened them, and November drew it missed beside the two months
   * Dec 20 paid; read off the payment's nearest day alone (Jan 1), their Dec 1 — the charge the rent's Nov 16 carries —
   * would be drawn, owed and listed nowhere.
   */
  test("…and November missed, Dec 20's two months open them on Dec 1: paid with Jan 1, no Nov 1 drawn", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01" },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-12-20",
    );
    checkedThrough(bundle.db, "acct", "2026-12-26");
    const DEC27 = "2026-12-27";
    expect(seriesDetail(bundle.db, RENT, DEC27)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-12-20"]);
    // Dec 20 paid the rent's Nov 16 as the day behind its own, Dec 16 — one of the rent's days past it
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: "2026-12-20", dueDaysPast: 1 });
    expect(marks("2026-11", "2026-11-01", DEC27)).toEqual([]);
    expect(marks("2026-12", "2026-12-01", DEC27)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-20", early: false }],
    ]);
    expect(marks("2027-01", "2027-01-01", DEC27)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-20", early: true }],
    ]);
    expect(owed(DEC27)).toEqual([]);
    expect(coming(DEC27, UTIL)[0]).toBe("2027-02-01");
    expect(coming(DEC27, RENT)[0]).toBe("2027-01-16");
  });

  /*
   * ⛔ …and the rent's date BEFORE their own still opens them there: every day of theirs from it on is a charge. 🔴
   * Nothing pinned it (review of 0ac5d059): every pin put the rent's date on or after theirs, so reading the LATER of
   * the two — their own Nov 1 — passed every test (430 files, 9,551 tests, the review's run), and a payment of two
   * caught nothing up and paid a day still to come: the rent typed Sep 1, their own Nov 1 — what a Save of their date
   * editor with nothing changed types, as it opens on Nov 1 (his ledger copy 2026-10-29) — Jul 1, Aug 2 and Sep 2 at
   * the rate, Oct 1 missed, Nov 10 two months: their Dec 1 read as paid early by Nov 10, and Upcoming listed their
   * Jan 1 first beside the rent's Dec 1. Their Oct 1 is a charge, as the rent's is, so Nov 10 pays it and their Nov 1,
   * and Dec 1 still comes for both.
   */
  test.each([
    ["he typed", true],
    ["detection's", false],
  ])("…and the rent typed Sep 1, what it carries on %s Nov 1: Nov 10's two months pay no Dec 1", (_, utilTyped) => {
    rentWith(
      { rentOn: "2026-09-01", typed: true, utilOn: "2026-11-01", utilTyped },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-11-10",
    );
    checkedThrough(bundle.db, "acct", "2026-11-19");
    const NOV20 = "2026-11-20";
    expect(seriesDetail(bundle.db, RENT, NOV20)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-11-10"]);
    expect(marks("2026-11", "2026-11-01", NOV20)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-11-10", early: false }],
    ]);
    expect(marks("2026-12", "2026-12-01", NOV20)).toEqual([
      [UTIL, "upcoming", null],
      [RENT, "upcoming", null],
    ]);
    expect(owed(NOV20)).toEqual([]);
    expect(coming(NOV20, UTIL)).toEqual(["2026-12-01", "2027-01-01"]);
    expect(coming(NOV20, RENT)).toEqual(["2026-12-01", "2027-01-01"]);
  });

  const detailsIn = (month: string, today: string) =>
    forecastForMonth(bundle.db, month, today)!.components.map((c) => c.detail ?? "");

  /*
   * 🔴 …and what paid the rent's first day was read off its NEAREST rent day, not the branch of `paymentFor` that
   * found it (review of 46f19f15): a payment of ONE month, late for the rent's first day by default (c) — nearer its
   * next day, which another payment paid on time — read as one day past it, so the utilities opened a day of theirs
   * BEHIND the one it pays, on a day no payment pays. The rent typed Nov 25, Dec 12 then Dec 25 (rows of Jun 25 to Aug
   * 25 before his date): `opensPaidBy` read {Dec 12, 1}, and on Dec 27 November drew their Nov 1 missed beside the
   * rent's Nov 25 paid by Dec 12 — a ✕ that moved from the rent to the utilities once Dec 25 posted (ec7fd198 drew
   * nothing there). So too the rent typed Nov 18, Dec 4 then Dec 18, and the 16th, Dec 3 then Dec 16 — a month owed
   * for good beside a rent paid. With the rent's row before his date on Oct 26, their extra Nov 1 was drawn "paid …
   * Oct 26 (early)", a posting that paid no day of his. Now each opens them on their Dec 1, the day that payment pays,
   * and each rent payment pays one month of theirs (default (B), below).
   */
  // the rent's date, its rows before it, its late payment of that date, and its on-time payment of the next
  test.each([
    {
      rentOn: "2026-11-25",
      rows: "Jun 25 to Aug 25",
      before: ["2026-06-25", "2026-07-25", "2026-08-25"],
      late: "2026-12-12",
      next: "2026-12-25",
    },
    {
      rentOn: "2026-11-25",
      rows: "Jun 25, Jul 25 and Oct 26",
      before: ["2026-06-25", "2026-07-25", "2026-10-26"],
      late: "2026-12-12",
      next: "2026-12-25",
    },
    {
      rentOn: "2026-11-18",
      rows: "Jun 18 to Aug 18",
      before: ["2026-06-18", "2026-07-18", "2026-08-18"],
      late: "2026-12-04",
      next: "2026-12-18",
    },
    {
      rentOn: "2026-11-16",
      rows: "Jul 1 to Oct 2",
      before: ["2026-07-01", "2026-08-02", "2026-09-02", "2026-10-02"],
      late: "2026-12-03",
      next: "2026-12-16",
    },
  ])("…and the rent typed $rentOn ($rows before it), paid late by (c): their Dec 1 opens them", (shape) => {
    const { rentOn, before, late, next } = shape;
    rentWith({ rentOn, typed: true, utilOn: "2026-09-01", noneOfTwo: true }, ...before, late, next);
    checkedThrough(bundle.db, "acct", "2026-12-26");
    const DEC27 = "2026-12-27";
    // November draws nothing of theirs: no ✕ beside the rent paid late, no row before his date paying a day of theirs
    expect(marks("2026-11", "2026-11-01", DEC27)).toEqual([]);
    expect(recurringCalendar(bundle.db, "2026-11", DEC27).missedCount).toBe(0);
    // …the late payment was the rent's first day's own: its own day is that one
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: late, dueDaysPast: 0 });
    // …and each rent payment pays one month of theirs: the late one their Dec 1, the next their Jan 1, early
    expect(marks("2026-12", "2026-12-01", DEC27)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: late, early: false }],
    ]);
    expect(marks("2027-01", "2027-01-01", DEC27)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: next, early: true }],
    ]);
    expect(owed(DEC27)).toEqual([]);
    expect(coming(DEC27, UTIL)[0]).toBe("2027-02-01");
  });

  /*
   * ⚖️ default (B), built, not asked (2026-10-30) — each day of what the rent carries PAIRS with the rent's own day of
   * that period (`pairingOf`): the day of theirs that falls due with the rent's first day pairs with it, each later one
   * with the rent's day the same number of steps on, and a day of theirs is paid by whatever pays the rent's day it
   * pairs with, by the rent's own test (decision 76, the catch-up). The owner question 46f19f15 left (latent: on his
   * ledger both fall due on the 1st): with the rent typed about half a month from their 1st, each LATER day of theirs
   * was graded by the rent payment nearest it — the rent typed Nov 16, paid Nov 16 then Dec 17, a day past the
   * midpoint: on Dec 20 December drew their Dec 1 missed, owed $182.21 beside a rent paid on time ("came due Dec 1 and
   * has not posted" in December's forecast, "Already due" on their page), and January their Jan 1 "paid early by Dec
   * 17". On his ledger copy 2026-10-29b with that what-if (Wells Fargo read through Dec 26) the runway read "A further
   * $1,349.70 came due earlier this month: $877.25 has not posted, and no statement has covered the other $472.45 yet."
   * Now Dec 17 pays the rent's Dec 16 and so their Dec 1, and their Jan 1 comes with the rent's Jan 16.
   */
  test("⚖️ (B) the rent typed Nov 16, paid Nov 16 then Dec 17: Dec 17 pays their Dec 1 — Jan 1 still comes", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
      "2026-12-17",
    );
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    // each drawn on the rent's day it falls due with — their Nov 1 on its Nov 16, Dec 1 on Dec 16, Jan 1 on Jan 16
    // (their own 1st until the review of aa05a56d)
    const theirs = (key: string, day: string) => marks(key, day, DEC20).filter(([id]) => id === UTIL);
    expect(theirs("2026-11", "2026-11-16")).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-11-16", early: false }],
    ]);
    expect(theirs("2026-12", "2026-12-16")).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-17", early: false }],
    ]);
    expect(theirs("2027-01", "2027-01-16")).toEqual([[UTIL, "upcoming", null]]);
    // nothing owed: the arrears, the runway's "A further …", /budgets' row, their page, December's forecast
    expect(owed(DEC20)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, DEC20))).toBeNull();
    expect(budgetOverdue(bundle.db, categoryId, "2026-12-01", DEC20).series).toEqual([]);
    expect(seriesDetail(bundle.db, UTIL, DEC20)!.overdue).toBeNull();
    expect(detailsIn("2026-12", DEC20).filter((d) => d.includes("came due"))).toEqual([]);
    // …and their Jan 1 comes with the rent's Jan 16: Upcoming, January's forecast, their page's list, the All tab's
    // Next — the sentence's editor on their own Jan 1
    expect(coming(DEC20, UTIL)[0]).toBe("2027-01-16");
    expect(coming(DEC20, RENT)[0]).toBe("2027-01-16");
    expect(labelsIn("2027-01", DEC20)).toEqual(expect.arrayContaining(["What-if (rent)", "Rent utilities & fees"]));
    const page = seriesDetail(bundle.db, UTIL, DEC20)!;
    expect([page.nextExpectedOn, page.nextExpected.map((o) => o.date)]).toEqual([
      "2027-01-01",
      ["2027-01-16", "2027-02-16", "2027-03-16"],
    ]);
    expect(listSeries(bundle.db, DEC20).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2027-01-16");
  });

  /*
   * ⚖️ (B) …and a day of theirs falls due on the later of its own day and the rent's day it pairs with: owed, or drawn
   * missed, only once that rent day is — never before — and until then still to come, on every reader that looks
   * ahead (default built, not asked, 2026-10-30). 46f19f15's own known gap: the rent typed Nov 16, nothing of November
   * posted, read through Nov 9 — on Nov 10 November drew their Nov 1 missed and the runway read "A further $182.21 came
   * due earlier this month and has not posted." six days before the rent's Nov 16 came. Now their Nov 1 comes with the
   * rent's Nov 16 — Upcoming, November's forecast, /budgets' tail, their page and the All tab hold it, and no reader
   * leaves its $182.21 out — and from Nov 17 it is owed with it (above, "…not yet paid").
   */
  test("⚖️ (B) …nothing of November posted: on Nov 10 their Nov 1 still comes with the rent's Nov 16", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    checkedThrough(bundle.db, "acct", "2026-11-09");
    const NOV10 = "2026-11-10";
    // drawn upcoming on the day it falls due, the rent's Nov 16 — never on its own Nov 1, a day already past
    expect(marks("2026-11", "2026-11-01", NOV10)).toEqual([]);
    expect(marks("2026-11", "2026-11-16", NOV10)).toEqual([
      [UTIL, "upcoming", null],
      [RENT, "upcoming", null],
    ]);
    expect(owed(NOV10)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, NOV10))).toBeNull();
    expect(budgetOverdue(bundle.db, categoryId, "2026-11-01", NOV10).series).toEqual([]);
    // …still to come with the rent's Nov 16 — and their Dec 1 with its Dec 16 — and named by those days: Upcoming,
    // November's forecast, /budgets' tail, their page's list and the All tab's Next
    expect(coming(NOV10, UTIL)).toEqual(["2026-11-16", "2026-12-16"]);
    expect(coming(NOV10, RENT)).toEqual(["2026-11-16", "2026-12-16"]);
    expect(labelsIn("2026-11", NOV10)).toEqual(expect.arrayContaining(["What-if (rent)", "Rent utilities & fees"]));
    expect(detailsIn("2026-11", NOV10)).toContain("1 × -$182.21 (monthly), next Nov 16");
    expect(budgetTail(bundle.db, categoryId, "2026-11-30", NOV10).series.map((s) => [s.id, s.nextDate])).toEqual([
      [UTIL, "2026-11-16"],
      [RENT, "2026-11-16"],
    ]);
    const page = seriesDetail(bundle.db, UTIL, NOV10)!;
    expect([page.nextExpected.map((o) => o.date), page.overdue]).toEqual([
      ["2026-11-16", "2026-12-16", "2027-01-16"],
      null,
    ]);
    expect(listSeries(bundle.db, NOV10).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2026-11-16");
    // ⛔ …and the sentence's editor opens on their OWN Nov 1, still to come: what its Save writes as their date. On
    // the rent's Nov 16 a Save with nothing changed would retype them onto the 16th.
    expect(page.nextExpectedOn).toBe("2026-11-01");
  });

  /*
   * ⚖️ (B) …and the readers that look ahead ask the rent's day a day of theirs pairs with in full, late payments too:
   * the rent typed Nov 16 and paid Nov 21, five days late, opens them on their Dec 1, the rent's Nov 16 — so on Nov 25
   * their Dec 1, still ahead by its own day, is paid, and Upcoming and the All tab name their Jan 1. Asked with nothing
   * late (`nothingLateFrom`'s day from today on, read for the rent's past Nov 16), Nov 21 would pay no day of theirs.
   */
  test("⚖️ (B) …the rent paid Nov 21, late: on Nov 25 their Dec 1 is paid — Upcoming names their Jan 1", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-21",
    );
    checkedThrough(bundle.db, "acct", "2026-11-24");
    const NOV25 = "2026-11-25";
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: "2026-11-21", dueDaysPast: 0 });
    expect(marks("2026-12", "2026-12-01", NOV25)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-11-21", early: true }],
    ]);
    expect(coming(NOV25, UTIL)[0]).toBe("2027-01-01");
    expect(listSeries(bundle.db, NOV25).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2027-01-01");
  });

  /**
   * The All tab's Next for a series — `nextStillToCome` over the predicate `listSeries` builds (`stillToComeReader`) —
   * and each own day its walk asked, stopped should it ask one twice: a walk that does never ends.
   */
  const walkOf = (id: string, today: string): [string | null, string[]] => {
    const row = bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get()!;
    const series = { ...row, billedWith: billingCarriers(bundle.db).get(id) ?? null };
    const reader = stillToComeReader(bundle.db, [series], today);
    const asked: string[] = [];
    const toCome: StillToCome = (seriesId, ownDate) => {
      if (asked.includes(ownDate)) throw new Error(`the walk asked ${ownDate} again, after ${asked.join(", ")}`);
      asked.push(ownDate);
      return reader(seriesId, ownDate);
    };
    return [nextStillToCome(toCome, series, today), asked];
  };

  /*
   * ⛔ …and the All tab's Next steps past a day of theirs already paid to the walk's NEXT own day (`walkDayAfter`) —
   * never back to the day it just asked. A day of theirs falls due with the rent's day it pairs with, so the first day
   * falling due from the day after a paid one (`rollForwardNextExpected`'s `firstStepFallingDue`) can be that same
   * paid day: the rent typed Nov 16 and paid early on Nov 5 opens them on their Nov 1, the rent's Nov 16, paid by it —
   * and on Nov 10, asked from Nov 2, their Nov 1 still falls due on or after it (Nov 16). 🔴 Nothing pinned it (review
   * of a456a6fc): stepped as before aa05a56d, `rollForwardNextExpected(eff, addDays(next, 1))`, the walk asked Nov 1
   * again for good — 4,585 tests passed (the review's run) while `listSeries`, and so the /recurring render, would
   * hang. The walk here is bounded by the predicate it asks (`walkOf`); the same shape later in the year below.
   */
  test("⛔ …the rent paid early Nov 5 pays their Nov 1: on Nov 10 the All tab steps past it once, to Dec 16", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-05",
    );
    checkedThrough(bundle.db, "acct", "2026-11-09");
    const NOV10 = "2026-11-10";
    // Nov 5 pays the rent's Nov 16 early, its own day's payment: their Nov 1, nearest it, opens them, paired with it
    expect(billingCarriers(bundle.db).get(UTIL)!.opensPaidBy).toEqual({ postedOn: "2026-11-05", dueDaysPast: 0 });
    // each own day asked once — their Nov 1, paid, then Dec 1 — named by the day Dec 1 falls due, the rent's Dec 16
    expect(walkOf(UTIL, NOV10)).toEqual(["2026-12-16", ["2026-11-01", "2026-12-01"]]);
    expect(walkOf(RENT, NOV10)).toEqual(["2026-12-16", ["2026-11-16", "2026-12-16"]]);
    // …the day every reader that looks ahead names: the All tab, Upcoming, their page's list — nothing owed
    const next = listSeries(bundle.db, NOV10);
    expect([UTIL, RENT].map((id) => next.find((s) => s.id === id)!.nextExpectedOn)).toEqual([
      "2026-12-16",
      "2026-12-16",
    ]);
    expect(coming(NOV10, UTIL)).toEqual(["2026-12-16"]);
    expect(coming(NOV10, RENT)).toEqual(["2026-12-16"]);
    expect(seriesDetail(bundle.db, UTIL, NOV10)!.nextExpected.map((o) => o.date)).toEqual([
      "2026-12-16",
      "2027-01-16",
      "2027-02-16",
    ]);
    expect(owed(NOV10)).toEqual([]);
  });

  /*
   * ⚖️ (B) …and the calendar names the payment the rent's day was paid by, on time for THAT day (`dayPaidAs`): what it
   * carries on the 5th, the rent typed Nov 2 — their Dec 5 is the rent's Dec 2 — and two rows on time for Dec 5, Dec 2
   * and Dec 5. Dec 2 pays the rent's Dec 2 and so their Dec 5; Dec 5, a day already paid on time, pays nothing (default
   * (a)) — named on time for their own Dec 5, it would be the row that paid no day.
   */
  test("⚖️ (B) …the calendar names the rent's payment of the day theirs pairs with — never one that paid none", () => {
    rentWith(
      { rentOn: "2026-11-02", typed: true, utilOn: "2026-09-05", noneOfTwo: true },
      "2026-07-02",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-02",
      "2026-12-02",
      "2026-12-05",
    );
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    expect(marks("2026-12", "2026-12-05", DEC20).filter(([id]) => id === UTIL)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-02", early: false }],
    ]);
    expect(owed(DEC20)).toEqual([]);
  });

  /*
   * ⚖️ (B) …only for what falls due on the rent's own step: a series carried on another cadence keeps the payment
   * nearest each day of its own (A), on the safe side — never an annual day paired with a monthly one, which would
   * hand next year's day to next month's rent payment.
   */
  test("⚖️ (B) …on the rent's step only: an annual item it carries owes next year's day to no rent payment", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
      "2026-12-17",
    );
    bundle.db
      .insert(recurringSeries)
      .values({
        ...bill("ins", "Renter's insurance", -12000, "2026-11-01"),
        cadence: "annual",
        intervalDaysAvg: 365,
        userBilledWithSeriesId: RENT,
      })
      .run();
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    const insurance = upcomingOccurrences(bundle.db, DEC20, 400).filter((o) => o.seriesId === "ins");
    expect(insurance.map((o) => o.date)).toEqual(["2027-11-01"]);
  });

  /*
   * ⚖️ (B) …and a row of their OWN is read by their own days, as a bill on its own is — never as the rent's payment of
   * the day theirs pairs with: their own -$182.21 on Dec 18, nearer their Jan 1, pays Jan 1 early; their Dec 1 is the
   * rent's Dec 16, which nothing paid, and owed with it.
   */
  test("⚖️ (B) …a row of their own pays by their own days, never the rent's: their Dec 1 owed with its Dec 16", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
    );
    pay("t-util-dec18", UTIL, "2026-12-18", -18221);
    checkedThrough(bundle.db, "acct", "2026-12-26");
    const DEC27 = "2026-12-27";
    // owed, and drawn, on the rent's day each falls due with (their own 1st until the review of aa05a56d)
    expect(owed(DEC27)).toEqual([
      [UTIL, "2026-12-16", 18221],
      [RENT, "2026-12-16", 229121],
    ]);
    expect(marks("2027-01", "2027-01-16", DEC27).filter(([id]) => id === UTIL)).toEqual([
      [UTIL, "paid", { carrier: null, postedOn: "2026-12-18", early: true }],
    ]);
  });

  /*
   * ⚖️ (B) …and a day of theirs is HELD, NAMED AND DRAWN on the day it falls due — the later of its own day and the
   * rent's day it pairs with (`fallsDueOn`) — by every reader: an occurrence's `date` IS that day (`projectOccurrences`),
   * and its own day (`ownDate`) is only what a grader asks paid (`paymentFor`). 🔴 At aa05a56d the windows held it by
   * that day while `date` stayed its own (review of aa05a56d), so every reader that re-read `date` read another day:
   * the category forecast re-filtered it out of the month it fell due in and never counted it, the dashboard counted
   * it due before a paycheck that comes first, and every sentence, list and grid named or drew its own day.
   */
  test("⚖️ (B) …on the 25th, the rent typed Nov 1: November's category forecast counts their Oct 25 with it", () => {
    rentWith(
      { rentOn: "2026-11-01", typed: true, utilOn: "2026-09-25", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    checkedThrough(bundle.db, "acct", "2026-10-29");
    const OCT30 = "2026-10-30";
    // 🔴 at aa05a56d $2,291.21, "1 expected recurring charge": their Oct 25, held in November, re-filtered out by day
    const predicted = predictCategory(bundle.db, categoryId, "Housing", OCT30).forecast;
    expect([predicted.recurringCents, predicted.parts[0]!.basis]).toEqual([
      229121 + 18221,
      "2 expected recurring charges",
    ]);
    // …the month /recurring's forecast holds it in, named by the day it falls due — never "next Oct 25"
    expect(detailsIn("2026-11", OCT30)).toContain("1 × -$182.21 (monthly), next Nov 1");
  });

  test("⚖️ (B) …the rent typed Nov 16: due by the Nov 12 paycheck leaves out their Nov 1, due with its Nov 16", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    bundle.db
      .insert(recurringSeries)
      .values({
        ...bill("pay", "Weekly pay", 114192, "2026-11-12"),
        kind: "income",
        cadence: "weekly",
        intervalDaysAvg: 7,
        anchorDay: null,
      })
      .run();
    checkedThrough(bundle.db, "acct", "2026-11-09");
    const NOV10 = "2026-11-10";
    const { upcoming } = dashboardData(bundle.db, NOV10);
    // 🔴 at aa05a56d -$182.21: their Nov 1 compared by its own day, before a paycheck their Nov 16 comes after
    expect(upcoming.beforePaycheck).toEqual({ date: "2026-11-12", cents: 0 });
    // …and the strip lists it on the rent's Nov 16, beside the rent — never "Rent utilities & fees Nov 1" first
    expect(
      upcoming.items.filter((i) => i.seriesId === UTIL || i.seriesId === RENT).map((i) => [i.seriesId, i.date]),
    ).toEqual([
      [UTIL, "2026-11-16"],
      [RENT, "2026-11-16"],
    ]);
  });

  test("⚖️ (B) …paid Nov 16, December unpaid: on Dec 10 their Dec 1 is next Dec 16, on Dec 20 it came due Dec 16", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
    );
    checkedThrough(bundle.db, "acct", "2026-12-09");
    // 🔴 at aa05a56d "next Dec 1" on Dec 10 — a day already past — and "came due Dec 1 and has not posted" on Dec 20
    expect(detailsIn("2026-12", "2026-12-10")).toContain("1 × -$182.21 (monthly), next Dec 16");
    checkedThrough(bundle.db, "acct", "2026-12-19");
    const DEC20 = "2026-12-20";
    expect(detailsIn("2026-12", DEC20)).toContain("1 × -$182.21 (monthly), came due Dec 16 and has not posted");
    expect(owed(DEC20)).toEqual([
      [UTIL, "2026-12-16", 18221],
      [RENT, "2026-12-16", 229121],
    ]);
    expect(seriesDetail(bundle.db, UTIL, DEC20)!.overdue!.date).toBe("2026-12-16");
    // …and the calendar draws it missed on that day, beside the rent — nothing of theirs on their own Dec 1
    expect(marks("2026-12", "2026-12-01", DEC20)).toEqual([]);
    expect(unpaid("2026-12", "2026-12-16", DEC20).sort()).toEqual([RENT, UTIL]);
  });

  /*
   * ⚖️ (B) …and "paid early" is measured against the day the grid draws it on, the day it falls due: the rent typed Nov
   * 16 and paid Nov 16, then Dec 5 — nearer its Dec 16 (decision 76), so early for it — pays their Dec 1, which falls
   * due with that Dec 16: drawn there "paid early with the rent's payment of Dec 5". Measured against their own Dec 1 it
   * would read as paid on its day, four days after it. ⛔ …and the All tab steps past that paid Dec 1 once, to their
   * Jan 1 — on Dec 10, asked from Dec 2, it still falls due on or after it (the rent's Dec 16): a day of theirs paid
   * early past the first period, where the walk's step back (above, "…paid early Nov 5") reaches it again too.
   */
  test("⚖️ (B) …the rent's Dec 5, early for its Dec 16: their Dec 1 is drawn on Dec 16, paid early by it", () => {
    rentWith(
      { rentOn: "2026-11-16", typed: true, utilOn: "2026-09-01", noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
      "2026-11-16",
      "2026-12-05",
    );
    checkedThrough(bundle.db, "acct", "2026-12-09");
    const DEC10 = "2026-12-10";
    expect(marks("2026-12", "2026-12-16", DEC10)).toEqual([
      [UTIL, "paid", { carrier: "the rent", postedOn: "2026-12-05", early: true }],
    ]);
    expect(owed(DEC10)).toEqual([]);
    expect(coming(DEC10, UTIL)[0]).toBe("2027-01-16");
    expect(walkOf(UTIL, DEC10)).toEqual(["2027-01-16", ["2026-12-01", "2027-01-01"]]);
    expect(listSeries(bundle.db, DEC10).find((s) => s.id === UTIL)!.nextExpectedOn).toBe("2027-01-16");
  });

  test("⚖️ (B) …on the 25th, the rent typed Sep 1: each day of theirs is drawn, forecast and owed on the rent's 1st", () => {
    rentWith(
      { rentOn: "2026-09-01", typed: true, utilOn: "2026-10-25", utilTyped: true, noneOfTwo: true },
      "2026-07-01",
      "2026-08-02",
      "2026-09-02",
      "2026-10-02",
    );
    checkedThrough(bundle.db, "acct", "2026-10-28");
    const OCT29 = "2026-10-29";
    // 🔴 at aa05a56d October drew their Oct 25 "upcoming" and counted it in its Expected, beside a card holding none —
    // their Oct 25 falls due with the rent's Nov 1, and nothing of theirs before it is projected (their date opens them)
    const october = recurringCalendar(bundle.db, "2026-10", OCT29);
    expect(Object.values(october.entriesByDay).flat().filter((e) => e.seriesId === UTIL)).toEqual([]);
    expect(october.upcomingNetCents).toBe(0);
    expect(labelsIn("2026-10", OCT29)).not.toContain("Rent utilities & fees");
    // …and November draws, forecasts and names their Oct 25 on the rent's Nov 1
    expect(marks("2026-11", "2026-11-01", OCT29)).toEqual([
      [UTIL, "upcoming", null],
      [RENT, "upcoming", null],
    ]);
    expect(detailsIn("2026-11", OCT29)).toContain("1 × -$182.21 (monthly), next Nov 1");
    // …and, nothing of November posted, it came due Nov 1 with the rent — never "came due Oct 25"
    checkedThrough(bundle.db, "acct", "2026-11-04");
    const NOV5 = "2026-11-05";
    expect(owed(NOV5)).toEqual([
      [UTIL, "2026-11-01", 18221],
      [RENT, "2026-11-01", 229121],
    ]);
    expect(detailsIn("2026-11", NOV5)).toContain("1 × -$182.21 (monthly), came due Nov 1 and has not posted");
  });
});

/*
 * The e2e fixture's Meal Kit: $125.00 due the 5th on Chase Freedom Unlimited, nothing ever posted under it — the
 * fixture's real miss. Nothing near it may pay it.
 */
describe("the e2e Meal Kit's real miss is still a miss", () => {
  test("no payment: Jul 5 owes its $125.00, and once read through its grace it is drawn missed", () => {
    seriesWith(MEAL, "Meal Kit", -12500, "2026-07-05");
    checkedThrough(bundle.db, "acct", "2026-07-08");
    expect(owed("2026-07-09")).toEqual([[MEAL, "2026-07-05", 12500]]);
    expect(marks("2026-07", "2026-07-05", "2026-07-09")).toEqual([[MEAL, "missed", null]]);
  });

  // ⚖️ Jun 12 is default (a), built, not asked (above) — nearer Jun 5, paid on time: paying the other day would pay
  // Jul 5 early with its $19.99 and flip this test. The e2e fixture's Meal Kit has no row, so no e2e screen moves
  // either way.
  test("…and June's on-time payment and a second June row nearer Jun 5 pay no Jul 5 — still a miss", () => {
    seriesWith(MEAL, "Meal Kit", -12500, "2026-06-05", ["2026-06-05", -12500], ["2026-06-12", -1999]);
    checkedThrough(bundle.db, "acct", "2026-07-08");
    expect(owed("2026-07-09")).toEqual([[MEAL, "2026-07-05", 12500]]);
    expect(unpaid("2026-07", "2026-07-05", "2026-07-09")).toEqual([MEAL]);
  });
});

/*
 * ⚖️ default built, not asked (2026-10-23) — A LATE CATCH-UP PAYS BOTH DUE DAYS IT COVERED: a premium of -$357.58 due
 * the 11th, paid Jun 11, Jul 11 and Aug 11, Sep 11 missed, then ONE -$715.16 that holds Sep 11's and Oct 11's — the
 * payment its posted average names, "covered more than one month" (`paidAheadDays`) — pays the day it lies nearer
 * (⚖️ his decision 76) and the unpaid day on its other side (`paymentFor`'s catch-up), on every grader: the calendar,
 * the arrears (the runway, the bill's "Already due"), and the readers that look ahead (Upcoming, the forecast). 🔴 At
 * 66daebd one payment paid one due day, and wherever it posted one day it paid was drawn unpaid (review of 66daebd).
 * Measured on his ledger copy 2026-10-23 with this premium added on Venture X (read through Oct 14): Sep 19 left Oct 11
 * missed, the runway reading "A further $3,877.56 came due earlier this month: $357.58 has not posted, and no
 * statement has covered the other $3,519.98 yet." and the series page "Already due, and not posted" beside "posted avg
 * -$446.98 · Sep 19's -$715.16 covered more than one month"; Sep 28 drew Sep 11 missed and owed it $357.58 on Sep 30,
 * two days after it was paid; Oct 12 drew Sep 11 missed. Latent: no bill of his has a catch-up — Car insurance's Sep 3
 * -$1,000.00 posted before Sep 11 was due, and his own date starts its schedule at Dec 11.
 */
describe("⚖️ a late catch-up — two premiums in one payment after a missed month — pays both due days", () => {
  const PREMIUM = "premium";
  const TODAY = "2026-10-23";
  const owedPremium = (today: string) =>
    arrearsThisMonth(bundle.db, new Set([PREMIUM]), today).series.map((s) => [
      s.nextDate,
      s.amountCents,
      s.unreadCents,
    ]);
  /** paid Jun 11, Jul 11 and Aug 11, Sep 11 missed — its account read through Oct 22 */
  const missedSep11 = (): void => {
    const paid: [string, number][] = ["2026-06-11", "2026-07-11", "2026-08-11"].map((d) => [d, -35758]);
    seriesWith(PREMIUM, "Premium (what-if)", -35758, "2026-09-11", ...paid);
    checkedThrough(bundle.db, "acct", "2026-10-22");
  };
  /** …then -$715.16 on `on` */
  const catchUpOn = (on: string): void => {
    missedSep11();
    pay(`t-${PREMIUM}-${on}`, PREMIUM, on, -71516);
  };

  test("Sep 28, nearer Oct 11: it pays Oct 11 early AND Sep 11 late — nothing owed on Sep 30", () => {
    catchUpOn("2026-09-28");
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-09-28", early: true }],
    ]);
    // the Sep 28 row stands for Sep 11 in September, a different amount
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([]);
    expect(marks("2026-09", "2026-09-28", TODAY)).toEqual([[PREMIUM, "paid_different", null]]);
    expect(owedPremium("2026-09-30")).toEqual([]);
    expect(owedPremium(TODAY)).toEqual([]);
  });

  test("Sep 19, nearer Sep 11: it pays Sep 11 late AND Oct 11 early — no runway sentence, nothing already due", () => {
    catchUpOn("2026-09-19");
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([]);
    expect(marks("2026-09", "2026-09-19", TODAY)).toEqual([[PREMIUM, "paid_different", null]]);
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-09-19", early: true }],
    ]);
    expect(owedPremium(TODAY)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBeNull();
    // …on the page that says it covered more than one month
    const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
    expect(page.overdue).toBeNull();
    expect(page.paidAhead.map((o) => [o.postedOn, o.amountCents])).toEqual([["2026-09-19", -71516]]);
    // …and on Sep 25 Oct 11 is no longer coming: Upcoming and October's forecast read Sep 19 as its payment
    expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-11-11"]);
    expect(forecastForMonth(bundle.db, "2026-10", "2026-09-25")!.components.map((c) => c.label)).not.toContain(
      "Premium (what-if)",
    );
  });

  /*
   * ⚖️ default built, not asked (2026-10-29) — …and two premiums of which an instalment plan rounded one down a cent are
   * two (`paidAhead`, to `AT_THE_RATE_CENTS`): -$715.15 pays both days, as -$715.16 does. 🔴 At fc4444b2 it was one
   * premium (review of b6e11a76; his ledger copy 2026-10-29, this premium on Venture X): nothing was named, October drew
   * Oct 11 ✕, the arrears owed $357.58, the runway read "A further $3,877.56 came due earlier this month: $357.58 has
   * not posted, and no statement has covered the other $3,519.98 yet." and the page showed Oct 11 Already due.
   */
  test("Sep 19's -$715.15, two premiums one rounded down a cent: it pays Sep 11 and Oct 11 as -$715.16 does", () => {
    missedSep11();
    pay(`t-${PREMIUM}-sep19`, PREMIUM, "2026-09-19", -71515);
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-09-19", early: true }],
    ]);
    expect(owedPremium(TODAY)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBeNull();
    const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
    expect(page.overdue).toBeNull();
    expect(page.paidAhead.map((o) => [o.postedOn, o.amountCents])).toEqual([["2026-09-19", -71515]]);
    expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-11-11"]);
    // …but two cents short it is one premium: nothing named, and Oct 11 owed once it is past
    bundle.db.update(transactions).set({ amountCents: -71514 }).where(eq(transactions.id, `t-${PREMIUM}-sep19`)).run();
    expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.paidAhead).toEqual([]);
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
  });

  /*
   * ⚖️ default built, not asked (2026-10-29) — …and money back after it is what it RETURNED: a payment of two that got
   * one premium back covered one, and pays one day (`paidAhead`). 🔴 At fc4444b2 any money back after it was what it
   * left (review of 2f827fc): his Car insurance with Sep 3's -$1,000.00 returned on Sep 8 still read "Sep 3's
   * -$1,000.00 covered more than one month" beside "posted avg -$119.19" (his ledger copy 2026-10-29) — and every
   * grader paid two days with it.
   */
  test("…and +$357.58 back on Sep 25 returns one of Sep 19's two: Oct 11 is still to come, then owed", () => {
    catchUpOn("2026-09-19");
    pay(`t-${PREMIUM}-back`, PREMIUM, "2026-09-25", 35758);
    expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.paidAhead).toEqual([]);
    expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-10-11", "2026-11-11"]);
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
  });

  /*
   * ⛔ …and money back is no PAYMENT: a day whose rows net the other way, or to nothing, pays no due day — on time,
   * early or late (`daysThatPaid`, his decision 75's unit, the day, read onto a bill's days; ⚖️ default built, not
   * asked, 2026-10-29). 🔴 At 4d6ec2ac every active row was a payment to every grader, credits and all (review of
   * 4d6ec2ac): the test above holds only because Sep 25 lies nearer Sep 11, paid already. On his ledger copy 2026-10-29
   * with this premium on Venture X, +$357.58 back on Sep 28 — nearer Oct 11 — drew Oct 11 "paid early by its payment
   * of Sep 28", the credit; on Oct 1 Upcoming listed Nov 11 alone and October's forecast left the premium out; on Oct
   * 29 nothing was owed, the runway reading "A further $3,519.98 came due earlier this month and no statement has
   * covered it yet." — one premium paid, net, and Oct 11 hidden. Sep 19 returned in full on Sep 28 drew the same Oct
   * 11; a +$12.50 credit on Oct 2 after it stood for Oct 11; a +$357.58 credit on Sep 9 stood for Sep 11, on time.
   */
  test("…and +$357.58 back on Sep 28, nearer Oct 11, pays no Oct 11: still to come on Oct 1, then owed", () => {
    catchUpOn("2026-09-19");
    pay(`t-${PREMIUM}-back`, PREMIUM, "2026-09-28", 35758);
    expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.paidAhead).toEqual([]);
    expect(coming("2026-10-01", PREMIUM)).toEqual(["2026-10-11", "2026-11-11"]);
    expect(premiumIn("2026-10", "2026-10-01")).toEqual([-35758]);
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBe(
      "A further $357.58 came due earlier this month and has not posted.",
    );
    // …and returned in FULL on Sep 28 the same: the refund pays no Oct 11. ⚠️ Sep 19 still pays Sep 11 — money back
    // on a day of its own is never taken off a day its payment paid, as his decision 75 reads a payroll returned later
    bundle.db.update(transactions).set({ amountCents: 71516 }).where(eq(transactions.id, `t-${PREMIUM}-back`)).run();
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([]);
  });

  test("…a +$12.50 credit on Oct 2 after Sep 19's two exactly unnames it and pays no Oct 11: Oct 11 owed", () => {
    catchUpOn("2026-09-19");
    pay(`t-${PREMIUM}-credit`, PREMIUM, "2026-10-02", 1250);
    expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.paidAhead).toEqual([]);
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
  });

  test("…and money back inside a day's grace is not its payment: +$357.58 on Sep 9 leaves Sep 11 owed", () => {
    missedSep11();
    pay(`t-${PREMIUM}-sep9`, PREMIUM, "2026-09-09", 35758);
    expect(unpaid("2026-09", "2026-09-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium("2026-09-30")).toEqual([["2026-09-11", 35758, 0]]);
    // …nor is a charge and its same-day reversal, a day that netted to nothing (`occurrencesOf`)
    pay(`t-${PREMIUM}-sep11`, PREMIUM, "2026-09-11", -35758);
    pay(`t-${PREMIUM}-sep11r`, PREMIUM, "2026-09-11", 35758);
    expect(owedPremium("2026-09-30")).toEqual([["2026-09-11", 35758, 0]]);
  });

  test("Oct 12, inside Oct 11's grace: it pays Oct 11 on time AND Sep 11 late — owed on Sep 30, before it came", () => {
    missedSep11();
    expect(owedPremium("2026-09-30")).toEqual([["2026-09-11", 35758, 0]]);
    pay(`t-${PREMIUM}-oct12`, PREMIUM, "2026-10-12", -71516);
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([]);
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([]);
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-10-12", early: false }],
    ]);
    expect(owedPremium(TODAY)).toEqual([]);
    // …and Nov 11, a day still to come, is no day it paid
    expect(coming(TODAY, PREMIUM)[0]).toBe("2026-11-11");
  });

  /*
   * ⚖️ default built, not asked (2026-10-23) — …and after TWO missed charges IN A ROW a late one pays both of them,
   * never a day still to come: late for its own day, its second charge pays the unpaid day behind it first
   * (`paymentFor`'s catch-up). ⚠️ Not with a paid one between them — a known gap (billing-carriers.test.ts; his ledger
   * copy 2026-10-29, this premium): Aug 11 missed, Sep 11 paid, Oct 11 missed, then Oct 20 draws Nov 11 "paid early by
   * its payment of Oct 20", Upcoming lists Dec 11 alone and November's forecast leaves it out, beside August's ✕.
   * 🔴 At 67b3b79 it paid the day after, early, whatever lay behind (review of 67b3b79; his ledger copy
   * 2026-10-23 with this premium added on Venture X, read through Oct 14): Aug 11 and Sep 11 missed, then Sep 19 — on
   * Sep 25 Upcoming listed Nov 11 alone and October's forecast left Oct 11 out, on Oct 23 the runway read only "A
   * further $3,519.98 came due earlier this month and no statement has covered it yet." (his own bills), and August
   * stayed ✕; Sep 11 and Oct 11 missed, then Oct 20 — November drew Nov 11 "paid early by its payment of Oct 20, 2026",
   * Upcoming listed Dec 11 alone, November's forecast left the premium out, the All tab and the page named Dec 11
   * next, and September stayed ✕ beside "Oct 20's -$715.16 covered more than one month".
   */
  const premiumIn = (month: string, today: string) =>
    forecastForMonth(bundle.db, month, today)!
      .components.filter((c) => c.label === "Premium (what-if)")
      .map((c) => c.cents);

  test("Aug 11 and Sep 11 missed, then Sep 19: it pays both, late — Oct 11 still comes, and is owed unposted", () => {
    const paid: [string, number][] = ["2026-06-11", "2026-07-11"].map((d) => [d, -35758]);
    seriesWith(PREMIUM, "Premium (what-if)", -35758, "2026-08-11", ...paid, ["2026-09-19", -71516]);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    expect(marks("2026-08", "2026-08-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-09-19", early: false }],
    ]);
    // the Sep 19 row stands for Sep 11, a different amount
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([]);
    expect(marks("2026-09", "2026-09-19", TODAY)).toEqual([[PREMIUM, "paid_different", null]]);
    // on Sep 25 Oct 11 is still to come: Upcoming and October's forecast count it
    expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-10-11", "2026-11-11"]);
    expect(premiumIn("2026-10", "2026-09-25")).toEqual([-35758]);
    // …and on Oct 23, never posted, it is owed: the calendar, the arrears, the runway and the page
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBe(
      "A further $357.58 came due earlier this month and has not posted.",
    );
    const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
    expect([page.overdue?.date, page.overdue?.amountCents]).toEqual(["2026-10-11", -35758]);
    expect(page.paidAhead.map((o) => o.postedOn)).toEqual(["2026-09-19"]);
  });

  test("Sep 11 and Oct 11 missed, then Oct 20: it pays both, late — Nov 11 is still to come, and next", () => {
    catchUpOn("2026-10-20");
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-10-20", early: false }],
    ]);
    // the Oct 20 row stands for Oct 11, a different amount
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([]);
    expect(marks("2026-10", "2026-10-20", TODAY)).toEqual([[PREMIUM, "paid_different", null]]);
    expect(marks("2026-11", "2026-11-11", TODAY)).toEqual([[PREMIUM, "upcoming", null]]);
    expect(owedPremium(TODAY)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBeNull();
    // Upcoming, November's forecast, the All tab's Next and the page's next charges all count Nov 11
    expect(coming(TODAY, PREMIUM)).toEqual(["2026-11-11", "2026-12-11"]);
    expect(premiumIn("2026-11", TODAY)).toEqual([-35758]);
    expect(listSeries(bundle.db, TODAY).find((s) => s.id === PREMIUM)?.nextExpectedOn).toBe("2026-11-11");
    expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.nextExpected.map((o) => o.date)[0]).toBe("2026-11-11");
  });

  /*
   * ⚖️ default built, not asked (2026-10-23) — …and of two late payments of two in a row, two due days apart, each pays
   * its own day and the next: a day the one before paid early is paid (adjacent ones do not — the known gap, below).
   * 🔴 At 8348349 the second paid its own day alone (review of 8348349; his ledger copy 2026-10-23 with this premium
   * added on Venture X, read through Oct 14, anchored Oct 11 — the step detection lays down after Sep 20 — or Jul 11,
   * both reading the same): on Sep 25 Upcoming listed Oct 11 and October's forecast held -$357.58; on Oct 23 October
   * drew Oct 11 missed, the arrears owed $357.58, the runway read "A further $3,877.56 came due earlier this month:
   * $357.58 has not posted, and no statement has covered the other $3,519.98 yet." and the series page showed Oct 11
   * overdue beside "Jul 20's -$715.16 and Sep 20's -$715.16 each covered more than one month" — five charges paid,
   * four days.
   */
  test("Jul 20 and Sep 20, each late with two premiums: Sep 20 pays Oct 11 early — nothing owed, none coming", () => {
    const rows: [string, number][] = [
      ["2026-06-11", -35758],
      ["2026-07-20", -71516],
      ["2026-09-20", -71516],
    ];
    seriesWith(PREMIUM, "Premium (what-if)", -35758, "2026-10-11", ...rows);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    for (const anchor of ["2026-10-11", "2026-07-11"]) {
      bundle.db.update(recurringSeries).set({ nextExpectedOn: anchor }).where(eq(recurringSeries.id, PREMIUM)).run();
      expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([
        [PREMIUM, "paid", { carrier: null, postedOn: "2026-09-20", early: true }],
      ]);
      expect(owedPremium(TODAY)).toEqual([]);
      expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBeNull();
      const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
      expect(page.overdue).toBeNull();
      expect(page.paidAhead.map((o) => o.postedOn)).toEqual(["2026-07-20", "2026-09-20"]);
      // on Sep 25, Oct 11 is no longer coming: Upcoming and October's forecast read Sep 20 as its payment
      expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-11-11"]);
      expect(premiumIn("2026-10", "2026-09-25")).toEqual([]);
    }
    // …anchored Jul 11, August draws its Aug 11 paid early by Jul 20, the first one's second day
    expect(marks("2026-08", "2026-08-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-07-20", early: true }],
    ]);
  });

  /*
   * ⚖️ default built, not asked (2026-10-23) — …and a schedule that opens on a late payment of two spends its second
   * charge on the day after: a day before the schedule opens — before his date, or before detection's anchor and every
   * payment of it — is no charge. 🔴 At 8348349 it paid the day before it, Jul 11, which no surface shows (review of
   * 8348349; his ledger copy 2026-10-23, this premium on Venture X started Aug 11 by his date, Aug 20 -$715.16 then Oct
   * 11 -$357.58): September drew Sep 11 unsettled; on Sep 25 the arrears owed it $357.58, the runway read "A further
   * $522.45 came due earlier this month: $357.58 has not posted, and no statement has covered the other $164.87 yet.",
   * September's forecast held -$357.58, and the page showed it overdue beside "Aug 20's -$715.16 covered more than one
   * month" — and so with Jun 11 -$357.58 paid before his date too.
   */
  test("started Aug 11 by his date, Aug 20's two premiums pay Aug 11 and Sep 11 — Sep 25 owes nothing", () => {
    const started = { ...bill(PREMIUM, "Premium (what-if)", -35758, "2026-11-11"), userNextExpectedOn: "2026-08-11" };
    bundle.db.insert(recurringSeries).values({ ...started, lastMatchedOn: "2026-10-11" }).run();
    // Oct 11's row, at the rate, is what names Aug 20 as covering more than one month (`paidAhead`) — read on Sep 25
    // as the review read it
    pay(`t-${PREMIUM}-aug20`, PREMIUM, "2026-08-20", -71516);
    pay(`t-${PREMIUM}-oct11`, PREMIUM, "2026-10-11", -35758);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    const SEP25 = "2026-09-25";
    expect(marks("2026-09", "2026-09-11", SEP25)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-08-20", early: true }],
    ]);
    expect(owedPremium(SEP25)).toEqual([]);
    expect(arrearsSentence(committedBook(bundle.db, SEP25))).toBeNull();
    expect(premiumIn("2026-09", SEP25)).toEqual([]);
    const page = seriesDetail(bundle.db, PREMIUM, SEP25)!;
    expect(page.overdue).toBeNull();
    expect(page.paidAhead.map((o) => o.postedOn)).toEqual(["2026-08-20"]);
    // …and July draws nothing: no surface asks a day before his date
    expect(marks("2026-07", "2026-07-11", TODAY)).toEqual([]);
    // on Oct 23, September still draws Sep 11 paid by Aug 20; Oct 11 posted on its day, nothing is owed, Nov 11 next
    expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-08-20", early: true }],
    ]);
    expect(owedPremium(TODAY)).toEqual([]);
    expect(coming(TODAY, PREMIUM)).toEqual(["2026-11-11", "2026-12-11"]);
    // …and with Jun 11 paid before his date it reads the same: his date is the schedule, July no charge of it
    pay(`t-${PREMIUM}-jun11`, PREMIUM, "2026-06-11", -35758);
    expect(marks("2026-09", "2026-09-11", SEP25)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-08-20", early: true }],
    ]);
    expect(owedPremium(SEP25)).toEqual([]);
    expect(seriesDetail(bundle.db, PREMIUM, SEP25)!.overdue).toBeNull();
  });

  /*
   * ⛔ …and every reader that looks ahead reads his date as his (`stillToComeReader`, `dueDaysOf`'s series), as the
   * calendar and the arrears do. 🔴 Nothing pinned it (review of b6e11a76): read there with `userNextExpectedOn: null`,
   * every grader test passed, and on his ledger copy 2026-10-29 with this premium on Venture X — started Aug 11 by his
   * date, Jun 11 paid before it, Aug 20 -$715.16 — on Sep 1 the calendar drew Sep 11 "paid early by its payment of Aug
   * 20, 2026" while Upcoming listed Sep 11 and Oct 11, September's forecast held -$357.58, the All tab and the page
   * named Sep 11 next, and /budgets' Car tail held Sep 11's $357.58: read as detection's, Jul 11 was a charge (Jun 11
   * posted before it), unpaid, and Aug 20 paid it.
   */
  test("started Aug 11 by his date, Jun 11 paid before it: on Sep 1 no reader that looks ahead lists Sep 11", () => {
    const started = { ...bill(PREMIUM, "Premium (what-if)", -35758, "2026-09-11"), userNextExpectedOn: "2026-08-11" };
    bundle.db.insert(recurringSeries).values({ ...started, lastMatchedOn: "2026-08-20" }).run();
    // Jun 11's row, at the rate, is what names Aug 20 as covering more than one month (`paidAhead`)
    pay(`t-${PREMIUM}-jun11`, PREMIUM, "2026-06-11", -35758);
    pay(`t-${PREMIUM}-aug20`, PREMIUM, "2026-08-20", -71516);
    const SEP1 = "2026-09-01";
    expect(marks("2026-09", "2026-09-11", SEP1)).toEqual([
      [PREMIUM, "paid", { carrier: null, postedOn: "2026-08-20", early: true }],
    ]);
    expect(seriesDetail(bundle.db, PREMIUM, SEP1)!.paidAhead.map((o) => o.postedOn)).toEqual(["2026-08-20"]);
    // Upcoming, September's forecast, the All tab's Next, the page's next charges and the budget's tail
    expect(coming(SEP1, PREMIUM)).toEqual(["2026-10-11"]);
    expect(premiumIn("2026-09", SEP1)).toEqual([]);
    expect(listSeries(bundle.db, SEP1).find((s) => s.id === PREMIUM)?.nextExpectedOn).toBe("2026-10-11");
    expect(seriesDetail(bundle.db, PREMIUM, SEP1)!.nextExpected.map((o) => o.date)[0]).toBe("2026-10-11");
    expect(budgetTail(bundle.db, categoryId, "2026-09-30", SEP1).series.map((s) => [s.id, s.nextDate])).toEqual([]);
  });

  /*
   * ⚖️ default built, not asked (2026-10-29) — …and a payment of two LATE FOR A DAY BEFORE HIS DATE pays nothing on his
   * schedule: that day is no charge, so it catches nothing up and pays no day of his early (`paidAheadFromTheDayBefore`
   * in billing-carriers). 🔴 At b6e11a76 it paid his date early (review of b6e11a76; his ledger copy 2026-10-29, this
   * premium added on Venture X, read through Oct 14): Jun 11 and Jul 11 paid, Aug 11 and Sep 11 missed, Sep 19
   * -$715.16, then he typed Oct 11 (the toast read "Next expected Oct 11") — October drew Oct 11 "paid early by its
   * payment of Sep 19, 2026"; on Sep 25 Upcoming listed Nov 11 alone, October's forecast left it out, and the All tab
   * and the page named Nov 11 next; on Oct 29 nothing was owed, /budgets' Car pace had no overdue line, and the runway
   * read "A further $3,519.98 came due earlier this month and no statement has covered it yet." — his own bills, round
   * 2's two-missed defect back for his own date. At 8348349 Oct 11 was still to come on Sep 25 and owed on Oct 23, as
   * detection's own Oct 11 reads it.
   */
  test("he typed Oct 11 after Sep 19's two premiums, late for Sep 11: Oct 11 still comes, and is owed unposted", () => {
    const typed = { ...bill(PREMIUM, "Premium (what-if)", -35758, "2026-10-11"), userNextExpectedOn: "2026-10-11" };
    bundle.db.insert(recurringSeries).values({ ...typed, lastMatchedOn: "2026-09-19" }).run();
    pay(`t-${PREMIUM}-jun11`, PREMIUM, "2026-06-11", -35758);
    pay(`t-${PREMIUM}-jul11`, PREMIUM, "2026-07-11", -35758);
    pay(`t-${PREMIUM}-sep19`, PREMIUM, "2026-09-19", -71516);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    // on Sep 25 Oct 11 is still to come: Upcoming, October's forecast, the All tab's Next and the page's next charges
    const SEP25 = "2026-09-25";
    expect(coming(SEP25, PREMIUM)).toEqual(["2026-10-11", "2026-11-11"]);
    expect(premiumIn("2026-10", SEP25)).toEqual([-35758]);
    expect(listSeries(bundle.db, SEP25).find((s) => s.id === PREMIUM)?.nextExpectedOn).toBe("2026-10-11");
    expect(seriesDetail(bundle.db, PREMIUM, SEP25)!.nextExpected.map((o) => o.date)[0]).toBe("2026-10-11");
    // …and on Oct 23, never posted, it is owed: the calendar, the arrears, the runway and the page
    expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([[PREMIUM, "missed", null]]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
    expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBe(
      "A further $357.58 came due earlier this month and has not posted.",
    );
    const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
    expect([page.overdue?.date, page.overdue?.amountCents]).toEqual(["2026-10-11", -35758]);
    expect(page.paidAhead.map((o) => o.postedOn)).toEqual(["2026-09-19"]);
  });

  /*
   * ⛔ …and none settles the day behind from a day before his date either (`dayBehindIsSettled`, the same his-date test
   * `paidAheadFromTheDayBefore` asks): a payment of two late for a day before his date pays nothing of his, so the day
   * behind a later one's own stays unpaid and its second charge pays that day, never the day after it. 🔴 Nothing
   * pinned it (review of 4d6ec2ac): with the test asked only where the catch-up asks for itself, the whole suite passed
   * (449 files, 9,774 tests), and on his ledger copy 2026-10-29 with this premium on Venture X — started Sep 11 by his
   * date, Jun 11 at the rate, Aug 20 and Oct 20 each -$715.16 — Oct 20 paid Sep 11, Oct 11 AND Nov 11: November drew
   * Nov 11 "paid early by its payment of Oct 20", Upcoming listed Dec 11 alone, November's forecast left the premium
   * out, and the All tab and the page named Dec 11 next. 🔴 …but with Jul 11 unpaid here, the day two before his date,
   * a run read without his date stopped there too — a charge to it, Jun 11 having posted, and unpaid — so with the day
   * behind read without it the whole suite passed again (review of d7a5485c; 449 files, 9,784 tests, the review's run).
   * With Jul 11 at the rate too, on the same copy on Oct 23 and Oct 29, Aug 20 read as settling Sep 11 and Oct 20 paid
   * three days, as above.
   */
  test("started Sep 11 by his date, Aug 20 and Oct 20 each two premiums: Oct 20 pays two — Nov 11 still comes", () => {
    const started = { ...bill(PREMIUM, "Premium (what-if)", -35758, "2026-09-11"), userNextExpectedOn: "2026-09-11" };
    bundle.db.insert(recurringSeries).values({ ...started, lastMatchedOn: "2026-10-20" }).run();
    // Jun 11's row, at the rate, is what names Aug 20 and Oct 20 as covering more than one month (`paidAhead`)
    pay(`t-${PREMIUM}-jun11`, PREMIUM, "2026-06-11", -35758);
    pay(`t-${PREMIUM}-aug20`, PREMIUM, "2026-08-20", -71516);
    pay(`t-${PREMIUM}-oct20`, PREMIUM, "2026-10-20", -71516);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    const paysTwoNov11StillComes = (): void => {
      expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.paidAhead.map((o) => o.postedOn)).toEqual([
        "2026-08-20",
        "2026-10-20",
      ]);
      // Sep 11 late by Oct 20's second charge, Oct 11 late by its first — the Oct 20 row stands for it
      expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([
        [PREMIUM, "paid", { carrier: null, postedOn: "2026-10-20", early: false }],
      ]);
      expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([]);
      expect(owedPremium(TODAY)).toEqual([]);
      // …and Nov 11 is still to come: the calendar, Upcoming, November's forecast, the All tab's Next and the page's
      expect(marks("2026-11", "2026-11-11", TODAY)).toEqual([[PREMIUM, "upcoming", null]]);
      expect(coming(TODAY, PREMIUM)).toEqual(["2026-11-11", "2026-12-11"]);
      expect(premiumIn("2026-11", TODAY)).toEqual([-35758]);
      expect(listSeries(bundle.db, TODAY).find((s) => s.id === PREMIUM)?.nextExpectedOn).toBe("2026-11-11");
      expect(seriesDetail(bundle.db, PREMIUM, TODAY)!.nextExpected.map((o) => o.date)[0]).toBe("2026-11-11");
    };
    paysTwoNov11StillComes();
    // …and with Jul 11 paid too, the day two before his date, the same: Aug 20 is late for Aug 11, no charge of his,
    // so it settles no day behind Oct 20's own
    pay(`t-${PREMIUM}-jul11`, PREMIUM, "2026-07-11", -35758);
    paysTwoNov11StillComes();
  });

  /*
   * ⚠️ …but only two due days apart — THE KNOWN GAP (review of b6e11a76; his ledger copy 2026-10-29 with this premium
   * added on Venture X, read through Oct 14, anchored Sep 11 — detection's step — or Jul 11, both reading the same):
   * of two ADJACENT late payments of two, the later is asked first for its own late day, the day the earlier one's
   * second charge paid ahead, so that charge pays no day. Jun 11, then Jul 20 and Aug 20 each -$715.16: Jul 11 is Jul
   * 20's, Aug 11 and Sep 11 Aug 20's, and on Oct 29 October draws Oct 11 missed, the arrears owe $357.58, the runway
   * reads "A further $3,877.56 came due earlier this month: $357.58 has not posted, and no statement has covered the
   * other $3,519.98 yet." and the page shows Oct 11 overdue beside "Jul 20's -$715.16 and Aug 20's -$715.16 each
   * covered more than one month" — five charges, four days. Not built (an owner's call, 2026-10-29): it shows a paid
   * day owed, the safe direction. Paying it reads the run as one allocation, each payment pushing the next a day ahead.
   */
  test("⚠️ known gap: Jul 20 and Aug 20, adjacent, each two premiums — Oct 11 is owed beside both named", () => {
    const rows: [string, number][] = [
      ["2026-06-11", -35758],
      ["2026-07-20", -71516],
      ["2026-08-20", -71516],
    ];
    seriesWith(PREMIUM, "Premium (what-if)", -35758, "2026-09-11", ...rows);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    for (const anchor of ["2026-09-11", "2026-07-11"]) {
      bundle.db.update(recurringSeries).set({ nextExpectedOn: anchor }).where(eq(recurringSeries.id, PREMIUM)).run();
      expect(marks("2026-09", "2026-09-11", TODAY)).toEqual([
        [PREMIUM, "paid", { carrier: null, postedOn: "2026-08-20", early: true }],
      ]);
      expect(marks("2026-10", "2026-10-11", TODAY)).toEqual([[PREMIUM, "missed", null]]);
      expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
      expect(arrearsSentence(committedBook(bundle.db, TODAY))).toBe(
        "A further $357.58 came due earlier this month and has not posted.",
      );
      const page = seriesDetail(bundle.db, PREMIUM, TODAY)!;
      expect([page.overdue?.date, page.overdue?.amountCents]).toEqual(["2026-10-11", -35758]);
      expect(page.paidAhead.map((o) => o.postedOn)).toEqual(["2026-07-20", "2026-08-20"]);
    }
  });

  /*
   * ⚖️ default built, not asked (2026-10-23) — …and ON TIME for its own day, the day behind paid, a payment of two pays
   * no day after it: it is not read ahead, so nothing still to come leaves Upcoming or the forecast. 🔴 Nothing pinned
   * it (review of 8348349): read as "late or on time", every test passed, and Aug 11 paid, then -$715.16 on Sep 12
   * drew Oct 11 "paid early by Sep 12" and took it out of Upcoming and October's forecast on Sep 25.
   */
  test("Sep 12, on time with two premiums after a paid Aug 11: it pays no Oct 11 — still to come, then owed", () => {
    const paid: [string, number][] = ["2026-06-11", "2026-07-11", "2026-08-11"].map((d) => [d, -35758]);
    seriesWith(PREMIUM, "Premium (what-if)", -35758, "2026-10-11", ...paid, ["2026-09-12", -71516]);
    checkedThrough(bundle.db, "acct", "2026-10-22");
    // on Sep 25 Oct 11 is still to come: Upcoming and October's forecast count it
    expect(coming("2026-09-25", PREMIUM)).toEqual(["2026-10-11", "2026-11-11"]);
    expect(premiumIn("2026-10", "2026-09-25")).toEqual([-35758]);
    // …and on Oct 23, never posted, it is owed — drawn unpaid, on the arrears
    expect(unpaid("2026-10", "2026-10-11", TODAY)).toEqual([PREMIUM]);
    expect(owedPremium(TODAY)).toEqual([["2026-10-11", 35758, 0]]);
  });
});

/*
 * ⛔ ONE RULE: a grader pays a second due day only with a payment the series' posted average NAMES as covering more
 * than one charge (`paidAheadDays`, read onto every grader's payments as `BillPayment.coveredMore`) — never with the
 * bare multiple of the rate. 🔴 Nothing pinned it (review of 67b3b79): with `PaymentDays.coveredMore` (then
 * `coveredMoreDays`) reading |amount| ≥ 2 × |rate| instead, every unit test still passed, and on his ledger copy
 * 2026-10-23 a what-if FPL on Venture X — the
 * -$58.87 he set, Jul 10 -$14.21, Jul 28 -$56.22, then one -$125.00 bill Sep 28 (2.12×) — drew Sep 8 paid by Sep 28
 * beside an All tab, a series page and a popover that name nothing. Sep 28 pays Oct 8 early, its own, and only that.
 */
describe("⛔ a second due day is paid only by a payment its posted average names (`paidAheadDays`)", () => {
  const TODAY = "2026-10-23";
  const P = -35758;
  const fplWith125 = (): void => {
    const july: [string, number][] = [
      ["2026-07-10", -1421],
      ["2026-07-28", -5622],
    ];
    seriesWith(FPL, "FPL (electricity)", -5887, "2026-07-08", ...july, ["2026-09-28", -12500]);
  };

  test("FPL's one high bill, Sep 28 -$125.00, names nothing and pays one day: Sep 8 stays owed", () => {
    fplWith125();
    checkedThrough(bundle.db, "acct", "2026-10-22");
    // the average names nothing: the series page, and the All tab
    expect(seriesDetail(bundle.db, FPL, TODAY)!.paidAhead).toEqual([]);
    expect(listSeries(bundle.db, TODAY).find((s) => s.id === FPL)!.paidAhead).toEqual([]);
    // …so Sep 28 pays Oct 8 early, its own, and nothing behind it: September draws Sep 8 unpaid, owed on Sep 30
    expect(marks("2026-10", "2026-10-08", TODAY)).toEqual([
      [FPL, "paid", { carrier: null, postedOn: "2026-09-28", early: true }],
    ]);
    expect(unpaid("2026-09", "2026-09-08", TODAY)).toEqual([FPL]);
    expect(owed("2026-09-30")).toEqual([[FPL, "2026-09-08", 5887]]);
  });

  test("the payments every grader reads as covering two charges are the ones the average names, and no other", () => {
    // FPL's -$125.00, and a bill varying after its one high month, name nothing; a catch-up, and Car insurance's
    // Sep 3 with Nov 11's $72.74 remainder after it, are named
    fplWith125();
    const varying: [string, number][] = [
      ["2026-06-08", -6000],
      ["2026-07-08", -13000],
      ["2026-08-08", -5500],
      ["2026-09-08", -4000],
      ["2026-10-08", -5800],
    ];
    seriesWith("varying", "Varying (what-if)", -6000, "2026-06-08", ...varying);
    const premiums: [string, number][] = ["2026-06-11", "2026-07-11", "2026-08-11"].map((d) => [d, P]);
    seriesWith("premium", "Premium (what-if)", P, "2026-09-11", ...premiums, ["2026-09-19", 2 * P]);
    const car: [string, number][] = [
      ["2026-08-12", P],
      ["2026-09-03", -100000],
      ["2026-11-11", -7274],
    ];
    seriesWith("car", "Car insurance", P, "2026-12-11", ...car);
    const ids = [FPL, "varying", "premium", "car"];
    const payments = billPaymentsBySeries(
      bundle.db,
      bundle.db
        .select()
        .from(recurringSeries)
        .all()
        .map((s) => ({ id: s.id, toleranceDays: s.toleranceDays, billedWith: null })),
    );
    const read = ids.map((id) => [
      id,
      (payments.get(id) ?? []).filter((p) => p.coveredMore).map((p) => p.postedOn),
      seriesDetail(bundle.db, id, TODAY)!.paidAhead.map((o) => o.postedOn),
    ]);
    expect(read).toEqual([
      [FPL, [], []],
      ["varying", [], []],
      ["premium", ["2026-09-19"], ["2026-09-19"]],
      ["car", ["2026-09-03"], ["2026-09-03"]],
    ]);
  });
});
