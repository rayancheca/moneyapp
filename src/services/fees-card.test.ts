import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { feesCard } from "./fees-card";

/**
 * The card's job is to hold two windows and two SIGNS apart without letting
 * either flatter the other, so the tests that matter are about which rows land
 * on which side, what happens when a side is empty rather than absent, and
 * every place a total is divided by something that could be zero.
 */

let dir: string;
let bundle: DbBundle;
let accountId: string;

/** deliberately mid-month: the recent window must exclude the current month */
const TODAY = "2026-08-27";

function topId(name: string): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), isNull(categories.parentId)))
    .get()!.id;
}

function childId(parent: string, name: string): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.parentId, topId(parent))))
    .get()!.id;
}

let seq = 0;
function addTxn(day: string, cents: number, categoryId: string, description = `ROW ${seq + 1}`): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId,
      importFileId: null,
      postedOn: day,
      amountCents: cents,
      rawDescription: description,
      normalizedDescription: description,
      categoryId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

/** a fee charge, in the ledger's own sign: money out is negative */
function fee(day: string, cents: number, child = "Bank Fees", description?: string): void {
  addTxn(day, -cents, childId("Fees", child), description);
}

/** an interest credit, in the ledger's own sign: money in is positive */
function interest(day: string, cents: number): void {
  addTxn(day, cents, childId("Income", "Interest"));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-fees-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  accountId = "acct-1";
  bundle.db
    .insert(accounts)
    .values({
      id: accountId,
      institutionId,
      name: "Chase Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  seq = 0;
  /*
   * ⛔ THE LEDGER HAS TO OPEN ON A MONTH BOUNDARY, or the card's window is not
   * six months long. `baselineWindow` floors at the first month the ledger
   * covers IN FULL — a stub month is not a month — so without this row the
   * earliest charge in a test dates the ledger and the window collapses. It is
   * UNCATEGORISED, so it is neither a fee nor interest and no figure moves.
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("feesCard", () => {
  test("holds fees and interest apart and nets them from the reader's side", () => {
    fee("2026-07-02", 5000);
    fee("2026-07-03", 1000, "ATM Fees");
    interest("2026-07-31", 2000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.paidCents).toBe(6000);
    expect(card.recent.paidCharges).toBe(2);
    expect(card.recent.earnedCents).toBe(2000);
    expect(card.recent.earnedCredits).toBe(1);
    // ⛔ POSITIVE means the banks paid you MORE than you paid them
    expect(card.recent.netCents).toBe(-4000);
    expect(card.recent.direction).toBe("behind");
    expect(card.headline).toBe("$40.00");
    expect(card.headlineNoun).toContain("more in fees than interest");
    expect(card.lines.map((l) => l.name)).toEqual(["Bank Fees", "ATM Fees"]);
  });

  test("a window where the banks paid more reads the other direction", () => {
    fee("2026-07-02", 1000);
    interest("2026-07-31", 4000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.netCents).toBe(3000);
    expect(card.recent.direction).toBe("ahead");
    expect(card.headline).toBe("$30.00");
    expect(card.headlineNoun).toContain("more in interest than fees");
  });

  /**
   * 🔴 THE WINDOW HAS TWO ENDS AND THE ROWS MUST USE BOTH OF THEM.
   *
   * `windowOf` filters `postedOn >= from`; the loop that builds the per-category
   * breakdown filters separately, and nothing tested its FROM end. A one-
   * character slip there (`<` → `<=`) left all 37 tests green while the card
   * rendered lines summing to $218.45 directly beneath a $313.45 total it also
   * rendered — the $95.00 Card Annual Fee posted on the window's own first day
   * dropped out of the breakdown and stayed in the sum. Measured on the owner's
   * ledger, whose recent window opens on 2026-03-01 and holds exactly that fee.
   *
   * Both ends, and the reconciliation, in one test: a total that disagrees with
   * the rows under it is the failure worth naming.
   */
  test("a fee on the window's first day, and on its last, is in the rows AND the total", () => {
    fee("2026-02-01", 9500); // the first day the window covers
    fee("2026-07-31", 1500); // the last
    fee("2026-01-31", 7700); // the day BEFORE it opens — outside, and must stay out
    fee("2026-08-01", 6600); // the day after it closes — likewise

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.paidCents).toBe(9500 + 1500);
    expect(card.recent.paidCharges).toBe(2);
    // and the breakdown adds up to the headline it sits under
    expect(card.lines.reduce((sum, l) => sum + l.cents, 0)).toBe(card.recent.paidCents);
    expect(card.lines.reduce((sum, l) => sum + l.charges, 0)).toBe(card.recent.paidCharges);
  });

  /**
   * ⛔ THE trap on the fee side. `WHERE amount_cents < 0` is the obvious query
   * and it is wrong: an inflow inside an expense category is a silent NEGATIVE
   * expense, and this ledger was understated $487.50 by exactly that shape.
   */
  test("a refunded fee NETS against the charge instead of being ignored", () => {
    fee("2026-07-02", 5000);
    addTxn("2026-07-09", 2000, childId("Fees", "Bank Fees")); // the bank gave some back

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.paidCents).toBe(3000);
    // …and a reversal is not a second charge, so it must not inflate the count
    expect(card.recent.paidCharges).toBe(1);
    expect(card.lines[0]!.charges).toBe(1);
    expect(card.lines[0]!.cents).toBe(3000);
  });

  /**
   * ⛔ The mirror on the income side, and the reason this card does not reuse
   * `incomeByMonth`'s positive-only convention: a clawback is the bank taking
   * back interest it credited, so it reduces what they paid you.
   */
  test("an interest clawback NETS against the credit instead of being dropped", () => {
    interest("2026-07-31", 5000);
    addTxn("2026-07-31", -1500, childId("Income", "Interest")); // reversed in part

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.earnedCents).toBe(3500);
    expect(card.recent.earnedCredits).toBe(1);
  });

  /**
   * ⛔ `x / 0` is Infinity, which would render "$Infinity back for every $1".
   * A window with no fees has no ratio to publish.
   */
  test("no fees at all yields a null ratio rather than Infinity", () => {
    interest("2026-07-31", 4000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.earnedPerDollarCents).toBeNull();
    expect(card.allTime.earnedPerDollarCents).toBeNull();
    expect(card.ratioNote).toBeNull();
  });

  /**
   * ⛔ Worse than dividing by zero: a NEGATIVE denominator divides cleanly and
   * comes out with the wrong SIGN. A window whose fees were net refunded has no
   * "for every dollar you paid them" to report.
   */
  test("a window whose fees were net refunded yields a null ratio, not a negative one", () => {
    fee("2026-07-02", 1000);
    addTxn("2026-07-09", 3000, childId("Fees", "Bank Fees")); // more back than went out
    interest("2026-07-31", 500);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.paidCents).toBe(-2000);
    expect(card.recent.earnedPerDollarCents).toBeNull();
  });

  test("the ratio reports cents of interest per dollar of fees, both windows", () => {
    fee("2024-01-05", 10_000);
    interest("2024-01-31", 39_900);
    fee("2026-07-02", 10_000);
    interest("2026-07-31", 100);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.earnedPerDollarCents).toBe(1); // $0.01 back per $1
    expect(card.allTime.earnedPerDollarCents).toBe(200); // $2.00 back per $1
    expect(card.ratioNote).toContain("$0.01 back for every $1");
    expect(card.ratioNote).toContain("$2.00");
  });

  /**
   * ⛔ `Math.round(-0.4)` is `-0` and `formatCents(-0)` renders "-$0.00". It
   * hides, too: `-0 + 0 === 0` leaves every total correct while one cell prints
   * a minus sign it does not have. This shipped to this dashboard once.
   */
  test("a monthly rate that rounds to zero is +0, never -0", () => {
    fee("2026-07-02", 1000);
    addTxn("2026-07-09", 1001, childId("Fees", "Bank Fees")); // net −1 cent over 6 months
    interest("2026-07-31", 1);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.paidCents).toBe(-1);
    expect(card.paidMonthlyCents).toBe(0);
    expect(Object.is(card.paidMonthlyCents, -0)).toBe(false);
    expect(Object.is(card.earnedMonthlyCents, -0)).toBe(false);
  });

  test("a ratio that rounds to zero is +0, never -0", () => {
    fee("2026-07-02", 100_000);
    addTxn("2026-07-31", -1, childId("Income", "Interest")); // a lone one-cent clawback

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.earnedCents).toBe(-1);
    expect(card.recent.earnedPerDollarCents).toBe(0);
    expect(Object.is(card.recent.earnedPerDollarCents, -0)).toBe(false);
  });

  /**
   * The headline names the direction of the window it shows, and the sentence
   * names the other one. "The other way" is computed from two signs, never
   * templated — a card that asserted the reversal would keep asserting it after
   * the reversal unwound.
   */
  test("says the two windows run the other way only when they actually do", () => {
    fee("2024-01-05", 10_000);
    interest("2024-01-31", 50_000); // all time: the banks are ahead
    fee("2026-07-02", 10_000); // recently: he is behind

    const reversed = feesCard(bundle.db, TODAY)!;
    expect(reversed.recent.direction).toBe("behind");
    expect(reversed.allTime.direction).toBe("ahead");
    expect(reversed.summary).toContain("All time it runs the other way");
  });

  test("…and says it reads the same way when both windows agree", () => {
    fee("2024-01-05", 10_000);
    fee("2026-07-02", 10_000);
    interest("2026-07-31", 100);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.direction).toBe("behind");
    expect(card.allTime.direction).toBe("behind");
    expect(card.summary).toContain("All time it reads the same way");
    expect(card.summary).not.toContain("other way");
  });

  /**
   * ⛔ A window that came out exactly level runs neither the same way as the
   * other nor the other way. Both phrases would be the card asserting a
   * direction it has just measured the absence of.
   */
  test("a level all-time window claims neither direction", () => {
    interest("2024-01-31", 5000);
    fee("2026-07-02", 5000); // the two cancel across the whole ledger

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.direction).toBe("behind");
    expect(card.allTime.direction).toBe("level");
    expect(card.summary).toContain("All time:");
    expect(card.summary).not.toContain("other way");
    expect(card.summary).not.toContain("same way");
    expect(card.summary).toContain("the two sides matched exactly");
  });

  test("an exactly level window is neither ahead nor behind", () => {
    fee("2026-07-02", 2500);
    interest("2026-07-31", 2500);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.netCents).toBe(0);
    expect(card.recent.direction).toBe("level");
    expect(card.headline).toBe("Level");
    expect(card.summary).not.toContain("other way");
  });

  /**
   * The runway, eating-out and movers cards all publish "6 complete months" on
   * this screen. A fourth window would be a contradiction the reader has to
   * resolve, and a part month dragged in understates the rate.
   */
  test("the current, incomplete month is outside the recent window but inside all time", () => {
    fee("2026-08-10", 9999); // this month
    fee("2026-07-10", 1000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.months).toBe(6);
    expect(card.fromMonth).toBe("2026-02");
    expect(card.toMonth).toBe("2026-07");
    expect(card.recent.paidCents).toBe(1000);
    expect(card.allTime.paidCents).toBe(10_999);
  });

  test("a month older than the recent window is excluded from it and kept in all time", () => {
    fee("2026-01-15", 8888); // one month before the window opens
    fee("2026-02-15", 1000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.paidCents).toBe(1000);
    expect(card.allTime.paidCents).toBe(9888);
    expect(card.allTime.from).toBe("2026-01-15");
    expect(card.allTimeFromLabel).toBe("Jan 2026");
  });

  /**
   * ⛔ EMPTY IS NOT MISSING. A bucket that exists and holds nothing has been
   * checked and the answer is no; a ledger without the bucket has not been
   * checked at all. Neither gets the word "unchecked".
   */
  test("an interest bucket that exists and is empty says so, and never says unchecked", () => {
    fee("2026-07-02", 1000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.earnedNote).toBe("No bank has ever paid you interest — the bucket exists and it is empty.");
    expect(card.earnedNote).not.toMatch(/unchecked|missing/i);
    expect(card.interestHref).not.toBeNull();
  });

  test("a ledger with no interest bucket at all says that instead — and offers no drill-down", () => {
    // renamed rather than deleted: rows carry a FK to it, and the condition
    // under test is "no income child called Interest", not "no row"
    bundle.db
      .update(categories)
      .set({ name: "Yield" })
      .where(eq(categories.id, childId("Income", "Interest")))
      .run();
    fee("2026-07-02", 1000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.earnedNote).toBe(
      "This ledger has no interest bucket, so nothing here has looked for interest paid to you.",
    );
    expect(card.recent.earnedCents).toBe(0);
    // ⛔ a link to "every credit you ever received" is a different question
    // wearing this one's label
    expect(card.interestHref).toBeNull();
  });

  test("a ledger with interest rows says nothing about the interest side", () => {
    fee("2026-07-02", 1000);
    interest("2026-07-31", 100);

    expect(feesCard(bundle.db, TODAY)!.earnedNote).toBeNull();
  });

  /**
   * ⛔ Never a name match. `/fee/i` catches `Coffee`, and on the real ledger
   * that adds $571.64 of espresso to a $1,426.39 bank-fee total.
   */
  test("Coffee is not a fee", () => {
    addTxn("2026-07-02", -4000, childId("Food", "Coffee"));
    fee("2026-07-03", 1000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.paidCents).toBe(1000);
    expect(card.lines.map((l) => l.name)).toEqual(["Bank Fees"]);
  });

  /** Interest CHARGED is money you paid a bank; it belongs on the paid side. */
  test("interest charged to you counts as money paid, never as money earned", () => {
    addTxn("2026-07-02", -2500, childId("Fees", "Interest Charges"));
    interest("2026-07-31", 100);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.paidCents).toBe(2500);
    expect(card.recent.earnedCents).toBe(100);
    expect(card.lines.map((l) => l.name)).toEqual(["Interest Charges"]);
  });

  /**
   * 🔴 Rows filed on the `Fees` parent are SHOWN but NOT COUNTED, and this test
   * reverses an earlier decision to count them.
   *
   * The original reasoning — "they are real money and they stay in the total" —
   * is right about the money and wrong about the SENTENCE. This card's claim is
   * "what the BANKS charge you". Measured on the real ledger 2026-08-27 the
   * bucket held $309.00 of which **$0.15** was a bank fee: $302.00 is a New
   * York State income tax payment, $5.16 a Canadian immigration charge, $1.69
   * the processor's fee for paying the tax. Counting them took the recent total
   * from $313.45 to $617.14 and put a tax bill inside a sentence about banks.
   *
   * ⚠️ Still not a reclassification: the ledger has no `Taxes` category, which
   * is why that row is here at all. Show the money, say the ledger has not
   * identified it, and leave the total making only the claim it can support.
   */
  test("rows filed on Fees itself are shown but not counted, and the largest is named", () => {
    addTxn("2026-04-16", -30_200, topId("Fees"), "Direct Payment NYS DTF PIT Tax Paymnt");
    addTxn("2026-04-10", -169, topId("Fees"), "SERVICE FEE");
    fee("2026-07-02", 1000);

    const card = feesCard(bundle.db, TODAY)!;
    const unfiled = card.lines.find((l) => l.isUnfiled)!;
    expect(unfiled.name).toBe("Fees");
    expect(unfiled.note).toBe("not counted — no kind given");
    // SHOWN: the money is on the card, at its real amount
    expect(unfiled.cents).toBe(30_369);
    expect(card.unfiledNote).toContain("2 charges are filed on Fees itself");
    expect(card.unfiledNote).toContain("$302.00");
    expect(card.unfiledNote).toContain("Direct Payment NYS DTF PIT Tax Paymnt");
    // NOT COUNTED: only the $10.00 genuine fee reaches the bank-fee total
    expect(card.recent.paidCents).toBe(1_000);
    expect(card.recent.unclassifiedCents).toBe(30_369);
    expect(card.recent.unclassifiedRows).toBe(2);
  });

  test("no rows on the parent means no unfiled note at all", () => {
    fee("2026-07-02", 1000);
    expect(feesCard(bundle.db, TODAY)!.unfiledNote).toBeNull();
    expect(feesCard(bundle.db, TODAY)!.lines.every((l) => !l.isUnfiled)).toBe(true);
  });

  /*
   * 🔴 THE ALL-TIME HALF LEFT A ROW OUT AND SAID NOTHING. The unfiled note was
   * built from the RECENT window only, but the all-time figures exclude parent
   * rows too. Measured 2026-09-14 on the dashboard: "Paid to them 70 charges
   * $996.64" all time, while the Fees category holds $996.79 — the $0.15
   * "FOREIGN EXCHANGE RATE ADJUSTMENT FEE" filed on Fees itself, dated outside
   * the recent window, silently absent from a figure with no footnote. ⛔ Every
   * earlier unfiled test dated its rows INSIDE the recent window (Feb 1 – Jul 31
   * here), so none could express this — these sit at both ends and on today.
   */
  test.each(["2026-01-31", "2026-08-01", "2026-08-27"])(
    "an unfiled row outside the recent window (%s) is disclosed against the all-time figures",
    (day) => {
      fee("2026-07-02", 1000);
      addTxn(day, -15, topId("Fees"), "FOREIGN EXCHANGE RATE ADJUSTMENT FEE");

      const card = feesCard(bundle.db, TODAY)!;
      expect(card.allTime.paidCents).toBe(1000);
      expect(card.allTime.unclassifiedCents).toBe(15);
      expect(card.recent.unclassifiedCents).toBe(0);
      expect(card.unfiledNote).not.toBeNull();
      expect(card.unfiledNote).toContain("$0.15");
      expect(card.unfiledNote).toContain(card.allTimeFromLabel);
      expect(card.unfiledNote).toContain("not in the all-time figures");
    },
  );

  test.each(["2026-02-01", "2026-07-31"])(
    "an unfiled row ON the recent window's edge (%s) is told once, in the recent sentence, in the singular",
    (day) => {
      fee("2026-07-02", 1000);
      addTxn(day, -15, topId("Fees"), "FOREIGN EXCHANGE RATE ADJUSTMENT FEE");

      const note = feesCard(bundle.db, TODAY)!.unfiledNote!;
      expect(note).toContain("1 charge is filed on Fees itself");
      expect(note).toContain("what it is");
      expect(note).not.toContain("what they are");
      expect(note).not.toContain("all-time");
    },
  );

  test("rows inside AND outside the recent window are both accounted for", () => {
    fee("2026-07-02", 1000);
    addTxn("2026-04-10", -169, topId("Fees"), "SERVICE FEE");
    addTxn("2026-01-31", -15, topId("Fees"), "FOREIGN EXCHANGE RATE ADJUSTMENT FEE");

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.unfiledNote).toContain("1 charge is filed on Fees itself");
    expect(card.unfiledNote).toContain("$1.69");
    // …and the all-time half names its own window and its own total
    expect(card.unfiledNote).toContain(card.allTimeFromLabel);
    expect(card.unfiledNote).toContain("$1.84");
  });

  /*
   * 🔴 A REVERSAL ON FEES ITSELF MADE THE NOTE COUNT ONE SET AND TOTAL ANOTHER.
   * The total nets credits, the count was charges alone. Every earlier unfiled
   * test used charges only, so none could express a reversal.
   */
  test("a fee and its reversal are named apart, and their net is called a net", () => {
    fee("2026-07-02", 1000);
    addTxn("2026-03-10", -500, topId("Fees"), "WIRE FEE");
    addTxn("2025-06-10", 500, topId("Fees"), "WIRE FEE REVERSAL");

    const note = feesCard(bundle.db, TODAY)!.unfiledNote!;
    expect(note).toContain("1 charge and 1 credit netting to nothing are filed there");
    expect(note).not.toContain("totalling $0.00");
  });

  test("a lone reversal outside the window is a credit, never '0 charges'", () => {
    fee("2026-07-02", 1000);
    addTxn("2025-06-12", 1234, topId("Fees"), "FEE REVERSAL");

    const note = feesCard(bundle.db, TODAY)!.unfiledNote!;
    expect(note).toContain("1 credit is filed on Fees itself");
    expect(note).not.toMatch(/\b0 charges\b/);
  });

  test("a reversal outside the window never prints a negative charge total", () => {
    fee("2026-07-02", 1000);
    addTxn("2026-03-10", -700, topId("Fees"), "RECENT PARENT CHARGE");
    addTxn("2025-06-12", 1234, topId("Fees"), "OLD REVERSAL");

    const note = feesCard(bundle.db, TODAY)!.unfiledNote!;
    expect(note).toContain("1 charge and 1 credit netting $5.34 back are filed there");
    expect(note).not.toMatch(/-\$/);
  });

  test("a charge and its reversal inside the window are not '2 charges'", () => {
    fee("2026-07-02", 1000);
    addTxn("2026-03-10", -500, topId("Fees"), "WIRE FEE");
    addTxn("2026-04-10", 500, topId("Fees"), "WIRE FEE REVERSAL");

    const note = feesCard(bundle.db, TODAY)!.unfiledNote!;
    expect(note).toContain("1 charge and 1 credit are filed on Fees itself");
    expect(note).toContain("The largest charge is $5.00");
  });

  test("a bucket with nothing in it is an absence, not a row reading $0.00", () => {
    fee("2026-07-02", 1000, "ATM Fees");

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.lines.map((l) => l.name)).toEqual(["ATM Fees"]);
  });

  /**
   * ⛔ A bucket can hold a ROW and still hold no money — a bank posting a $0.00
   * fee. It reaches the map (a key only exists because a row exists) and then
   * prints "Bank Fees · 0 charges · $0.00", which is a line spent saying nothing
   * happened. Found by mutation: deleting the filter broke no test until this
   * one existed.
   */
  test("a bucket whose only row is $0.00 is dropped, not printed as a zero", () => {
    addTxn("2026-07-02", 0, childId("Fees", "Bank Fees"));
    fee("2026-07-03", 1000, "ATM Fees");

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.lines.map((l) => l.name)).toEqual(["ATM Fees"]);
  });

  /**
   * …but a charge that was refunded in FULL is not the same absence: money
   * really moved, twice, and the row says so with a count even though the
   * column reads zero.
   */
  test("a fully refunded charge keeps its row", () => {
    fee("2026-07-02", 1000);
    addTxn("2026-07-09", 1000, childId("Fees", "Bank Fees"));

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.lines.map((l) => l.name)).toEqual(["Bank Fees"]);
    expect(card.lines[0]!.cents).toBe(0);
    expect(card.lines[0]!.charges).toBe(1);
  });

  test("rows are ordered by what they cost, biggest first", () => {
    fee("2026-07-02", 500, "ATM Fees");
    fee("2026-07-03", 9000, "Bank Fees");
    fee("2026-07-04", 3000, "Card Annual Fees");

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.lines.map((l) => l.name)).toEqual(["Bank Fees", "Card Annual Fees", "ATM Fees"]);
  });

  /**
   * The note explains why the interest half shrank, so it must be withheld when
   * the peak is inside the window it claims to explain, or is not a fall.
   */
  test("names the best interest month when it is behind the window and above it", () => {
    interest("2025-05-31", 17_634);
    interest("2026-07-31", 100);
    fee("2026-07-02", 1000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.interestTrendNote).toContain("$176.34");
    expect(card.interestTrendNote).toContain("May 2025");
  });

  test("withholds the trend note when the best month is inside the window", () => {
    interest("2026-07-31", 17_634);
    fee("2026-07-02", 1000);

    expect(feesCard(bundle.db, TODAY)!.interestTrendNote).toBeNull();
  });

  test("withholds the trend note when the peak is not above the current rate", () => {
    interest("2025-05-31", 100);
    interest("2026-07-31", 60_000); // the recent rate is far higher
    fee("2026-07-02", 1000);

    expect(feesCard(bundle.db, TODAY)!.interestTrendNote).toBeNull();
  });

  /**
   * ⛔ A card of zeroes is worse than no card — but an empty RECENT window over
   * a ledger that has real history is not nothing, so the headline falls back to
   * the window that can be answered rather than publishing "Level $0.00".
   */
  test("an empty recent window falls back to the all-time figure and says so", () => {
    fee("2024-01-05", 10_000);
    interest("2024-01-31", 30_000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.basis).toBe("allTime");
    expect(card.recent.rowCount).toBe(0);
    expect(card.headline).toBe("$200.00");
    expect(card.direction).toBe("ahead");
    expect(card.summary).toContain("Nothing at all has been charged or paid in the last 6 complete months");
  });

  test("a ledger with fee and interest rows reports the recent window as the basis", () => {
    fee("2026-07-02", 1000);
    expect(feesCard(bundle.db, TODAY)!.basis).toBe("recent");
  });

  /* ── the null paths ──────────────────────────────────────────────────── */

  test("a ledger with no fee or interest rows at all returns null rather than a card of zeroes", () => {
    addTxn("2026-07-02", -4000, childId("Food", "Dining"));
    expect(feesCard(bundle.db, TODAY)).toBeNull();
  });

  test("a ledger with no Fees taxonomy returns null", () => {
    bundle.db
      .update(categories)
      .set({ name: "Charges" })
      .where(and(eq(categories.name, "Fees"), isNull(categories.parentId)))
      .run();
    interest("2026-07-31", 100);

    expect(feesCard(bundle.db, TODAY)).toBeNull();
  });

  test("interest alone, with no fee taxonomy missing, is still a card", () => {
    interest("2026-07-31", 100);
    const card = feesCard(bundle.db, TODAY)!;
    expect(card.recent.paidCents).toBe(0);
    expect(card.recent.earnedCents).toBe(100);
    expect(card.recent.direction).toBe("ahead");
  });

  /* ── the drill-downs ─────────────────────────────────────────────────── */

  test("every row links to exactly the rows it was added up from", () => {
    fee("2026-07-02", 1000, "ATM Fees");

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.lines[0]!.href).toBe(
      `/transactions?category=${childId("Fees", "ATM Fees")}&from=2026-02-01&to=2026-07-31`,
    );
    expect(card.interestHref).toBe(
      `/transactions?category=${childId("Income", "Interest")}&from=2026-02-01&to=2026-07-31`,
    );
  });

  /**
   * 🔴 THE HEADER LINK OPENED A MONTH THE CARD NEVER READ. "Spending →" was a
   * bare `/spending`, which `resolvePeriod` resolves to the RUNNING month — a
   * month neither window here reads as a whole. Measured on the owner's ledger
   * 2026-09-15: the headline read "more in fees than interest, over the 6 months
   * to Aug 2026" (Mar 1 – Aug 31, 2026), and the link opened September 2026,
   * where the page refuses any comparison.
   */
  test("the Spending link opens the window the headline measured, not the running month", () => {
    fee("2026-07-02", 1000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.basis).toBe("recent");
    expect(card.spendingHref).toBe("/spending?from=2026-02-01&to=2026-07-31");
  });

  /** An empty recent window hands the headline to all time; the link follows the headline. */
  test("over an all-time headline, the Spending link opens the all-time window", () => {
    fee("2024-01-05", 10_000);
    interest("2024-01-31", 30_000);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.basis).toBe("allTime");
    expect(card.spendingHref).toBe(`/spending?from=2024-01-05&to=${TODAY}`);
  });

  /** February is 28 days here; a hardcoded "-31" would be a bound, not a date. */
  test("the recent window ends on the real last day of the month", () => {
    fee("2026-02-10", 1000);
    const card = feesCard(bundle.db, "2026-03-15")!;
    expect(card.recent.from).toBe("2025-09-01");
    expect(card.recent.to).toBe("2026-02-28");
  });

  test("what the card carries is standing on something", () => {
    fee("2026-07-02", 1000);
    const card = feesCard(bundle.db, TODAY)!;
    expect(card.paidProvenance).not.toBeNull();
    expect(card.today).toBe(TODAY);
  });
});

/**
 * 🔴 The fees card read `baselineWindow` for its rows and printed the CONSTANT
 * for its count. Replayed on the owner's ledger at today = 2023-01-15 (window
 * Sep–Dec 2022, `card.months` 4): "$0.62 went out in fees over the 6 complete
 * months Sep 2022 to Dec 2022", headline "over the 6 months to Dec 2022", and
 * $0.10 a month where the four months named make it $0.16.
 */
describe("a window the ledger has shortened", () => {
  const ledgerOpensOn = (day: string): void => {
    bundle.db.update(transactions).set({ postedOn: day }).where(eq(transactions.id, "t-ledger-opens")).run();
  };

  test("names and divides by the months it read", () => {
    ledgerOpensOn("2026-04-01"); // today 2026-08-27: Apr, May, Jun, Jul
    fee("2026-05-10", 1200);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.months).toBe(4);
    expect(card.paidMonthlyCents).toBe(300);
    expect(card.summary).toContain("over the 4 complete months Apr 2026 to Jul 2026");
    expect(card.summary).not.toContain("6 complete months");
    expect(card.headlineNoun).toContain("over the 4 months to Jul 2026");
  });

  test("one month is one month", () => {
    ledgerOpensOn("2026-07-01");
    fee("2026-07-10", 1200);
    interest("2026-07-11", 100);

    const card = feesCard(bundle.db, TODAY)!;
    expect(card.summary).toContain("over the 1 complete month Jul 2026");
    expect(card.headlineNoun).toContain("over the 1 month to Jul 2026");
    expect(card.ratioNote).toContain("over that 1 month");
  });

  test("nothing in a shortened window says the months it looked at", () => {
    ledgerOpensOn("2026-06-01");
    fee("2026-08-10", 1200); // this month — outside the window

    expect(feesCard(bundle.db, TODAY)!.summary).toContain("in the last 2 complete months");
  });

  /* ⛔ ZERO MONTHS IS NOT A WINDOW: the "recent" half would be this month's
     running rows under a sentence about complete months. */
  test("no complete month is no card", () => {
    ledgerOpensOn("2026-08-01");
    fee("2026-08-10", 1200);

    expect(feesCard(bundle.db, TODAY)).toBeNull();
  });
});
