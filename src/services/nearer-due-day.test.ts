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
import { checkedThrough } from "./checked-days-fixture";
import { committedBook } from "./committed";
import { forecastForMonth } from "./forecast";
import { upcomingOccurrences } from "./recurring";
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
 * moves today; the fixtures anchor each bill where its days are graded.
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

  test("…and Aug 15 is the month owed: August draws it missed, never paid by Sep 2", () => {
    checkedThrough(bundle.db, "acct", "2026-09-19");
    expect(unpaid("2026-08", "2026-08-15", "2026-09-20")).toEqual([LEASE]);
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

  test("July draws Jul 8 missed beside the Jul 28 row, and owes its $58.87", () => {
    checkedThrough(bundle.db, "acct", "2026-07-29");
    expect(unpaid("2026-07", "2026-07-08", "2026-07-30")).toEqual([FPL]);
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
});
