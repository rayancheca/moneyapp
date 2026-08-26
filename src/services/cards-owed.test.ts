import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { formatCents } from "@/lib/money";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { transactions } from "@/db/schema/transactions";
import { runwayCard } from "./committed";
import { cardsOwedCard } from "./cards-owed";

/**
 * The failure modes this card exists to prevent, pinned one at a time.
 *
 * Three of them are the reason it was written at all: a debt total assembled
 * from statements that closed on different days and printed as if it were one
 * moment; a refunded fee counted as a fee that happened; and a card with no
 * recorded balance folded into the total as a zero. The fourth is arithmetic —
 * a share divided by a debt of nothing is `Infinity`, and `Infinity%` has
 * shipped in worse apps than this one.
 */

let dir: string;
let bundle: DbBundle;
let institutionId: string;

/** Late enough that every fixture date below is in the past. */
const TODAY = "2026-08-10";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-cards-owed-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  institutionId = bundle.db.select().from(institutions).all()[0]!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

function addAccount(
  id: string,
  name: string,
  type: string,
  opts: { last4?: string; isActive?: boolean; order?: number } = {},
): string {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type: type as never,
      last4: opts.last4 ?? null,
      currency: "USD",
      isActive: opts.isActive ?? true,
      displayOrder: opts.order ?? 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

/** `basis` matters: only `anchored`/`derived` days count as checked. */
function addBalances(accountId: string, rows: { day: string; cents: number; basis: string }[]): void {
  for (const r of rows) {
    bundle.db
      .insert(dailyBalances)
      .values({ accountId, day: r.day, balanceCents: r.cents, basis: r.basis as never })
      .run();
  }
}

function addAnchor(accountId: string, day: string, cents: number, source = "manual"): void {
  bundle.db
    .insert(balanceAnchors)
    .values({
      accountId,
      anchoredOn: day,
      balanceCents: cents,
      source: source as never,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

let txnSeq = 0;
function addTxn(accountId: string, day: string, cents: number, categoryId?: string): string {
  txnSeq += 1;
  const id = `txn-${txnSeq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId,
      postedOn: day,
      amountCents: cents,
      rawDescription: "A CHARGE",
      normalizedDescription: "a charge",
      categoryId: categoryId ?? null,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `hash-${txnSeq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

function addSplit(transactionId: string, categoryId: string, cents: number, sortOrder: number): void {
  bundle.db
    .insert(transactionSplits)
    .values({ transactionId, categoryId, amountCents: cents, sortOrder, createdAt: now(), updatedAt: now() })
    .run();
}

/** The seeded taxonomy's own ids — never invented, always looked up by name. */
function catId(name: string): string {
  return bundle.db.select().from(categories).where(eq(categories.name, name)).all()[0]!.id;
}

/**
 * Two cards, both checked, closing on DIFFERENT days — the shape the real
 * ledger is in and the one the card was written for.
 */
function twoCards(): void {
  addAccount("acct-alpha", "Alpha", "credit", { last4: "1111" });
  addAccount("acct-beta", "Beta", "credit", { last4: "2222", order: 1 });
  addBalances("acct-alpha", [
    { day: "2026-08-01", cents: -20_000, basis: "derived" },
    { day: "2026-08-05", cents: -20_000, basis: "anchored" },
    { day: "2026-08-07", cents: -20_000, basis: "carried" },
  ]);
  addBalances("acct-beta", [
    { day: "2026-07-20", cents: -5_000, basis: "anchored" },
    { day: "2026-07-25", cents: -5_000, basis: "carried" },
  ]);
  // accountCoverage grades an account with no transactions `manual` and reports
  // no verifiedThrough at all, so a checked card needs at least one row
  addTxn("acct-alpha", "2026-08-01", -1_000);
  addTxn("acct-beta", "2026-07-20", -1_000);
}

describe("what is owed", () => {
  test("sums the cards and presents a stored liability as a positive debt", () => {
    twoCards();
    const card = cardsOwedCard(bundle.db, TODAY)!;

    expect(card.owedCents).toBe(25_000);
    expect(card.headline).toBe("$250.00");
    expect(card.nothingOwed).toBe(false);
    // largest debt first
    expect(card.cards.map((c) => c.name)).toEqual(["Alpha", "Beta"]);
    expect(card.cards[0]!.owedCents).toBe(20_000);
    expect(card.cards[1]!.owedCents).toBe(5_000);
    // and the card says which way the sign runs
    expect(card.convention).toMatch(/stored .*as a negative/i);
  });

  test("a credit balance reduces the total instead of being clamped away", () => {
    twoCards();
    // the bank owes HIM on Beta: a liability stored POSITIVE
    bundle.db.delete(dailyBalances).where(eq(dailyBalances.accountId, "acct-beta")).run();
    addBalances("acct-beta", [{ day: "2026-07-20", cents: 3_000, basis: "anchored" }]);

    const card = cardsOwedCard(bundle.db, TODAY)!;
    expect(card.cards.find((c) => c.name === "Beta")!.owedCents).toBe(-3_000);
    expect(card.owedCents).toBe(17_000);
  });

  /**
   * ⛔ JavaScript has a negative zero, and `-0` formats as "-$0.00". A paid-off
   * Chase Sapphire rendered exactly that on the real dashboard: it reads as a
   * tiny debt rounded down, or as a bug — never as "you owe nothing". Every
   * total stayed correct throughout, because `-0 + 0 === 0`, which is why only
   * looking at the card found it.
   */
  test("a card paid off to zero owes $0.00, never negative zero", () => {
    twoCards();
    bundle.db.delete(dailyBalances).where(eq(dailyBalances.accountId, "acct-beta")).run();
    addBalances("acct-beta", [{ day: "2026-07-20", cents: 0, basis: "anchored" }]);

    const beta = cardsOwedCard(bundle.db, TODAY)!.cards.find((c) => c.name === "Beta")!;
    expect(beta.owedCents).toBe(0);
    // Object.is is the only comparison that can see the difference — 0 === -0
    expect(Object.is(beta.owedCents, -0)).toBe(false);
    expect(formatCents(beta.owedCents!)).toBe("$0.00");
  });

  test("agrees with the runway card about what is owed on cards", () => {
    twoCards();
    const mine = cardsOwedCard(bundle.db, TODAY)!;
    const runway = runwayCard(bundle.db, TODAY);
    const assumption = runway.runway.assumptions.find((a) => a.id === "cards")!;

    // two cards on one screen disagreeing about card debt is a shipped
    // contradiction; both are assembled from listAccounts for that reason
    expect(mine.owedCents).toBe(assumption.cents);
  });
});

describe("how fresh the number is", () => {
  test("each card carries its own date when the statements close on different days", () => {
    twoCards();
    const card = cardsOwedCard(bundle.db, TODAY)!;

    expect(card.sharedCheckedThrough).toBeNull();
    expect(card.cards.map((c) => c.checkedThrough)).toEqual(["2026-08-05", "2026-07-20"]);
    expect(card.cards.map((c) => c.daysSinceChecked)).toEqual([5, 21]);
    expect(card.cards[0]!.asOfLabel).toBe("Aug 5 — 5 days ago");
    expect(card.cards[1]!.asOfLabel).toBe("Jul 20 — 21 days ago");
    // the OLDEST evidence bounds the whole figure
    expect(card.oldestCheckedThrough).toBe("2026-07-20");
    expect(card.daysSinceOldest).toBe(21);
    expect(card.explanation).toContain("each as of its own last statement");
  });

  test("⛔ the date is the day the money was CHECKED, not the last cached day", () => {
    twoCards();
    const card = cardsOwedCard(bundle.db, TODAY)!;
    const alpha = card.cards.find((c) => c.name === "Alpha")!;

    // Alpha's newest daily_balances row is 2026-08-07 (carried). Printing that
    // would claim the figure is two days fresher than the statement behind it.
    expect(alpha.checkedThrough).toBe("2026-08-05");
    expect(alpha.asOfLabel).not.toContain("Aug 7");
  });

  test("one date that describes every card is said once, not on every row", () => {
    twoCards();
    // move Beta's evidence onto Alpha's day
    bundle.db.delete(dailyBalances).where(eq(dailyBalances.accountId, "acct-beta")).run();
    addBalances("acct-beta", [{ day: "2026-08-05", cents: -5_000, basis: "anchored" }]);

    const card = cardsOwedCard(bundle.db, TODAY)!;
    expect(card.sharedCheckedThrough).toBe("2026-08-05");
    expect(card.cards.every((c) => c.asOfLabel === null)).toBe(true);
    expect(card.explanation).toContain("all as of Aug 5");
  });

  test("a card whose chain broke says so beside its date, and drags the total's verdict down", () => {
    twoCards();
    addBalances("acct-alpha", [{ day: "2026-08-02", cents: -20_000, basis: "gap" }]);

    const card = cardsOwedCard(bundle.db, TODAY)!;
    const alpha = card.cards.find((c) => c.name === "Alpha")!;

    expect(alpha.grade).toBe("broken");
    expect(alpha.caveat).toContain("stopped adding up on Aug 2");
    // ⛔ the newest day is still `anchored`, so asking only about it would badge
    // the total "adds up" beside a row that says it does not
    expect(alpha.verdict).toBe("broken");
    expect(card.provenance.verdict).toBe("broken");
  });

  test("a clean card carries no caveat", () => {
    twoCards();
    const card = cardsOwedCard(bundle.db, TODAY)!;
    expect(card.cards.every((c) => c.caveat === null)).toBe(true);
    expect(card.provenance.verdict).toBe("derived");
    expect(card.provenance.badgeWord).toBe("2 of 2 add up");
    expect(card.provenance.checkedThrough).toBe("2026-07-20");
  });
});

describe("what the ledger cannot answer", () => {
  test("returns null when there is no active credit account", () => {
    addAccount("acct-cash", "Checking", "checking");
    addBalances("acct-cash", [{ day: "2026-08-01", cents: 100_000, basis: "anchored" }]);
    expect(cardsOwedCard(bundle.db, TODAY)).toBeNull();
  });

  test("returns null when a deactivated card is the only card", () => {
    addAccount("acct-old", "Closed", "credit", { isActive: false });
    addBalances("acct-old", [{ day: "2026-08-01", cents: -10_000, basis: "anchored" }]);
    expect(cardsOwedCard(bundle.db, TODAY)).toBeNull();
  });

  test("⛔ returns null rather than a $0.00 headline when no card has a balance", () => {
    addAccount("acct-alpha", "Alpha", "credit");
    addAccount("acct-beta", "Beta", "credit");
    // rows exist, balances do not — the app refuses to derive one
    addTxn("acct-alpha", "2026-08-01", -1_000);
    expect(cardsOwedCard(bundle.db, TODAY)).toBeNull();
  });

  test("a card with no recorded balance is not a card you owe nothing on", () => {
    twoCards();
    bundle.db.delete(dailyBalances).where(eq(dailyBalances.accountId, "acct-beta")).run();

    const card = cardsOwedCard(bundle.db, TODAY)!;
    const beta = card.cards.find((c) => c.name === "Beta")!;

    expect(beta.owedCents).toBeNull();
    expect(card.unpricedCards).toBe(1);
    // ⛔ null must not be summed as zero and must not be sorted as a debt
    expect(card.owedCents).toBe(20_000);
    expect(card.cards.map((c) => c.name)).toEqual(["Alpha", "Beta"]);
    expect(card.explanation).toContain("floor");
  });

  test("a closed card still carrying a balance is disclosed, not silently dropped", () => {
    twoCards();
    addAccount("acct-old", "Closed", "credit", { isActive: false, order: 9 });
    addBalances("acct-old", [{ day: "2026-08-01", cents: -10_000, basis: "anchored" }]);

    const card = cardsOwedCard(bundle.db, TODAY)!;
    expect(card.cards.map((c) => c.name)).not.toContain("Closed");
    expect(card.closedOwedCents).toBe(10_000);
    expect(card.explanation).toContain("A closed card still carries $100.00");
  });
});

describe("nothing owed", () => {
  test("is said in words, and hands out no share of a debt of nothing", () => {
    addAccount("acct-alpha", "Alpha", "credit");
    addAccount("acct-beta", "Beta", "credit");
    addBalances("acct-alpha", [{ day: "2026-08-01", cents: 0, basis: "anchored" }]);
    addBalances("acct-beta", [{ day: "2026-08-01", cents: 0, basis: "anchored" }]);
    addTxn("acct-alpha", "2026-08-01", -1_000);
    addTxn("acct-beta", "2026-08-01", -1_000);

    const card = cardsOwedCard(bundle.db, TODAY)!;
    expect(card.nothingOwed).toBe(true);
    expect(card.headline).toBe("Nothing owed");
    expect(card.explanation).toContain("Nothing is outstanding on 2 cards");
    // ⛔ `x / 0` is Infinity and renders as "Infinity%"
    for (const c of card.cards) {
      expect(c.sharePct).toBeNull();
      expect(Number.isFinite(c.sharePct ?? 0)).toBe(true);
    }
  });

  test("shares are only handed out where there is a debt to divide", () => {
    twoCards();
    const card = cardsOwedCard(bundle.db, TODAY)!;
    expect(card.cards[0]!.sharePct).toBeCloseTo(80, 6);
    expect(card.cards[1]!.sharePct).toBeCloseTo(20, 6);
  });
});

describe("what the cards cost", () => {
  test("⛔ a refund NETS against its charge instead of being filtered out", () => {
    twoCards();
    const annual = catId("Card Annual Fees");
    addTxn("acct-alpha", "2026-03-01", -9_500, annual);
    addTxn("acct-alpha", "2026-03-05", 2_000, annual);

    const card = cardsOwedCard(bundle.db, TODAY)!;
    const alpha = card.cards.find((c) => c.name === "Alpha")!;

    // filtering on `amount_cents < 0` would say $95.00
    expect(alpha.fees!.totalCents).toBe(7_500);
    expect(card.fees!.totalCents).toBe(7_500);
    // a reversal is not a second fee
    expect(alpha.fees!.charges).toBe(1);
    // …and it is not the date the fee happened, either
    expect(alpha.fees!.summary).toBe("1 annual fee, Mar 1 — 162 days ago");
  });

  test("a fee reversed in full nets to nothing rather than vanishing", () => {
    twoCards();
    const bank = catId("Bank Fees");
    addTxn("acct-alpha", "2026-03-01", -3_000, bank);
    addTxn("acct-alpha", "2026-03-05", 3_000, bank);

    const alpha = cardsOwedCard(bundle.db, TODAY)!.cards.find((c) => c.name === "Alpha")!;
    expect(alpha.fees!.totalCents).toBe(0);
    expect(alpha.fees!.charges).toBe(1);
  });

  test("a split fee lands in every part it was split across", () => {
    twoCards();
    const bank = catId("Bank Fees");
    const groceries = catId("Groceries");
    const id = addTxn("acct-alpha", "2026-04-01", -10_000, bank);
    addSplit(id, bank, -4_000, 0);
    addSplit(id, groceries, -6_000, 1);

    // only the fee part is a fee — reusing activeTxnsInRange is what makes the
    // other part land somewhere else instead of dragging the whole charge in
    const alpha = cardsOwedCard(bundle.db, TODAY)!.cards.find((c) => c.name === "Alpha")!;
    expect(alpha.fees!.totalCents).toBe(4_000);
  });

  test("interest is its own bucket and never folded into the fee total", () => {
    twoCards();
    addTxn("acct-alpha", "2026-05-01", -1_000, catId("Bank Fees"));
    addTxn("acct-alpha", "2026-05-02", -2_500, catId("Interest Charges"));

    const card = cardsOwedCard(bundle.db, TODAY)!;
    expect(card.fees!.totalCents).toBe(1_000);
    expect(card.interestCents).toBe(2_500);
    expect(card.interestNote).toBe("Interest has cost $25.00 on top of that.");
  });

  test("a measured zero of interest is worth saying", () => {
    twoCards();
    addTxn("acct-alpha", "2026-05-01", -1_000, catId("Bank Fees"));

    const card = cardsOwedCard(bundle.db, TODAY)!;
    expect(card.interestCents).toBe(0);
    expect(card.interestNote).toBe("No interest has ever been charged to them.");
  });

  test("⛔ 'annual fee' is said only where the ledger files the charge as one", () => {
    twoCards();
    // the shape the real ledger is in: a $395 membership fee sitting in Bank Fees
    addTxn("acct-alpha", "2026-01-16", -39_500, catId("Bank Fees"));
    addTxn("acct-beta", "2025-03-02", -9_500, catId("Card Annual Fees"));
    addTxn("acct-beta", "2026-03-01", -9_500, catId("Card Annual Fees"));

    const card = cardsOwedCard(bundle.db, TODAY)!;
    const alpha = card.cards.find((c) => c.name === "Alpha")!;
    const beta = card.cards.find((c) => c.name === "Beta")!;

    expect(alpha.fees!.totalCents).toBe(39_500);
    expect(alpha.fees!.annualCents).toBe(0);
    expect(alpha.fees!.summary).toBe("1 charge, Jan 16 — 206 days ago");

    expect(beta.fees!.annualCents).toBe(19_000);
    expect(beta.fees!.summary).toBe("2 annual fees, latest Mar 1 — 162 days ago");
    // two charges is below MIN_OCCURRENCES, so the card never publishes a rate
    expect(beta.fees!.annualRepeats).toBe(false);
    expect(card.fees!.annualCents).toBe(19_000);
  });

  test("a card that has never been charged a fee gets no fee row at all", () => {
    twoCards();
    addTxn("acct-alpha", "2026-05-01", -1_000, catId("Bank Fees"));

    const card = cardsOwedCard(bundle.db, TODAY)!;
    expect(card.cards.find((c) => c.name === "Beta")!.fees).toBeNull();
    expect(card.fees!.charges).toBe(1);
    expect(card.fees!.firstOn).toBe("2026-05-01");
  });

  test("no fee anywhere means no cost block, not a block of zeroes", () => {
    twoCards();
    const card = cardsOwedCard(bundle.db, TODAY)!;
    expect(card.fees).toBeNull();
    expect(card.cards.every((c) => c.fees === null)).toBe(true);
  });
});

describe("a card the owner counts himself", () => {
  test("says he is the statement rather than claiming a check that never happened", () => {
    addAccount("acct-alpha", "Alpha", "credit");
    addBalances("acct-alpha", [{ day: "2026-08-01", cents: -20_000, basis: "anchored" }]);
    addAnchor("acct-alpha", "2026-08-01", -20_000);
    // no transactions at all — accountCoverage grades this `manual`

    const card = cardsOwedCard(bundle.db, TODAY)!;
    const alpha = card.cards[0]!;
    expect(alpha.grade).toBe("manual");
    expect(alpha.checkedThrough).toBeNull();
    expect(alpha.asOfLabel).toBeNull();
    expect(alpha.caveat).toBe("you last counted it on Aug 1 — 9 days ago");
    expect(card.owedCents).toBe(20_000);
  });
});

describe("a figure newer than its evidence", () => {
  test("says since when nothing has checked it, rather than dating it as checked", () => {
    twoCards();
    // Alpha is replayed past its last anchor: a real, later balance that
    // nothing confirms
    addBalances("acct-alpha", [
      { day: "2026-08-08", cents: -24_000, basis: "derived_unverified" },
      { day: "2026-08-09", cents: -24_000, basis: "derived_unverified" },
    ]);

    const card = cardsOwedCard(bundle.db, TODAY)!;
    const alpha = card.cards.find((c) => c.name === "Alpha")!;

    // the newest FIGURE is the unverified one …
    expect(alpha.owedCents).toBe(24_000);
    // … and the DATE beside it is still the last day anything checked
    expect(alpha.checkedThrough).toBe("2026-08-05");
    expect(alpha.grade).toBe("unverified");
    expect(alpha.caveat).toBe("nothing has checked it since Aug 8 — 2 days ago");
    // the total is only as proven as its weakest part
    expect(alpha.verdict).toBe("unverified");
    expect(card.provenance.verdict).toBe("unverified");
    expect(card.provenance.badgeWord).toBe("1 of 2 add up");
  });
});

describe("a statement that closed today", () => {
  test("is dated, not aged — `isStaleClose` decides, and it is not stale", () => {
    addAccount("acct-alpha", "Alpha", "credit");
    addBalances("acct-alpha", [{ day: TODAY, cents: -20_000, basis: "anchored" }]);
    addTxn("acct-alpha", TODAY, -1_000);

    const card = cardsOwedCard(bundle.db, TODAY)!;
    // one card, so the shared-date rule puts the date in the sentence
    expect(card.sharedCheckedThrough).toBe(TODAY);
    expect(card.explanation).toContain("all as of Aug 10.");
    expect(card.explanation).not.toContain("ago");
    expect(card.daysSinceOldest).toBe(0);
  });
});
