import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { accountInsights } from "./account-insights";

/**
 * Where an account sits, and what this module refuses to say about it.
 *
 * The balance itself is not tested here — `derivation` owns it and does so at
 * 100%. What is new is the RANKING, which has two ways to be wrong that no
 * balance test can see: mixing debts with holdings, and treating an account
 * that has never been imported as one holding zero.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-08-26";

function addAccount(id: string, name: string, type: "checking" | "credit"): void {
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type,
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

function setBalance(accountId: string, cents: number, day = "2026-08-20"): void {
  bundle.db
    .insert(dailyBalances)
    .values({ accountId, day, balanceCents: cents, basis: "derived" })
    .run();
}

let seq = 0;
function addTxn(accountId: string, cents: number, day = "2026-08-10"): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId,
      importFileId: null,
      postedOn: day,
      amountCents: cents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-ainsights-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("where an account sits", () => {
  test("ranks it among accounts of its own side, and says which side", () => {
    addAccount("a-1", "Big Savings", "checking");
    addAccount("a-2", "Small Checking", "checking");
    setBalance("a-1", 90_000);
    setBalance("a-2", 10_000);
    addTxn("a-2", -500);

    const out = accountInsights(bundle.db, "a-2", TODAY)!;
    expect(out.insights.map((i) => i.text)).toEqual([
      "Small Checking is the 2nd largest of your 2 accounts holding money, at $100.00.",
      "Small Checking is 10.0% of everything you hold.",
      "1 transaction landed in Small Checking since it opened.",
    ]);
  });

  test("⛔ a card is never ranked against a savings account", () => {
    /*
     * A liability's balance is stored NEGATIVE. One ranking over both sides
     * would sort a $5,000 debt below a $0 chequing account and call the debt
     * "the smallest" — two different questions sharing one ordering.
     */
    addAccount("a-1", "Savings", "checking");
    addAccount("a-2", "Card A", "credit");
    addAccount("a-3", "Card B", "credit");
    setBalance("a-1", 500_000);
    setBalance("a-2", -30_000);
    setBalance("a-3", -10_000);

    const card = accountInsights(bundle.db, "a-2", TODAY)!;
    expect(card.insights[0]!.text).toBe("Card A is the largest of your 2 cards and loans, at $300.00.");
    expect(card.insights[1]!.text).toBe("Card A is 75.0% of everything you owe.");
    // and the savings account is ranked alone, so it gets no ranking at all
    const savings = accountInsights(bundle.db, "a-1", TODAY)!;
    expect(savings.insights.some((i) => i.text.includes("largest"))).toBe(false);
  });

  test("a debt is ranked by how big it is, not by how negative", () => {
    addAccount("a-1", "Card A", "credit");
    addAccount("a-2", "Card B", "credit");
    setBalance("a-1", -10_000);
    setBalance("a-2", -30_000);
    // B owes more, so B is first — a signed sort would have put it last
    expect(accountInsights(bundle.db, "a-2", TODAY)!.insights[0]!.text).toContain("is the largest");
    expect(accountInsights(bundle.db, "a-1", TODAY)!.insights[0]!.text).toContain("2nd largest");
  });
});

describe("a card in credit", () => {
  /*
   * 🔴 /accounts/<Discover> read "55.3% of everything you owe" the day Chase
   * Sapphire closed $82.72 in credit: the side total took absolute values, so
   * a credit counted as a debt. Killed by mutation: restoring Math.abs makes
   * Discover 55.3% again and hands the credit card a rank.
   */
  test("counts nothing toward what is owed, and the other cards share the real debt", () => {
    addAccount("disc", "Discover", "credit");
    addAccount("vx", "Venture X", "credit");
    addAccount("sapphire", "Chase Sapphire", "credit");
    setBalance("disc", -55_762);
    setBalance("vx", -36_799);
    setBalance("sapphire", 8_272); // the bank owes HIM
    for (const id of ["disc", "vx", "sapphire"]) addTxn(id, -1_000);

    const discover = accountInsights(bundle.db, "disc", TODAY)!;
    expect(discover.insights.map((i) => i.text)).toEqual([
      "Discover is the largest of your 3 cards and loans, at $557.62.",
      // 557.62 of the 925.61 actually owed — never of 1,008.33
      "Discover is 60.2% of everything you owe.",
      "1 transaction landed in Discover since it opened.",
    ]);

    const sapphire = accountInsights(bundle.db, "sapphire", TODAY)!;
    expect(sapphire.insights.map((i) => i.text)).toEqual([
      "1 transaction landed in Chase Sapphire since it opened.",
    ]);
  });
});

describe("what it refuses to say", () => {
  test("⛔ an account that has never been imported is not an account holding zero", () => {
    /*
     * `Capital One 360 Checking` on the real ledger is exactly this: an account
     * with ZERO `daily_balances` rows, which `listAccounts` reports as
     * `balance: null`. Reading that as $0 would rank it last among his accounts
     * and state a figure nobody measured, and it would inflate every other
     * account's denominator by one. Empty is not zero — the distinction that has
     * now bitten four services in this codebase.
     */
    addAccount("a-1", "Funded", "checking");
    addAccount("a-2", "Never Imported", "checking");
    addAccount("a-3", "Also Funded", "checking");
    setBalance("a-1", 90_000);
    setBalance("a-3", 10_000);

    expect(accountInsights(bundle.db, "a-2", TODAY)).toBeNull();
    // and the set the others are ranked in is TWO, not three
    expect(accountInsights(bundle.db, "a-1", TODAY)!.insights[0]!.text).toContain(
      "of your 2 accounts holding money",
    );
  });

  test("a zero balance gets no rank and no share, but still counts its rows", () => {
    // a paid-off card really is $0.00; ranking it and giving it a 0.0% share
    // would be two sentences about nothing
    addAccount("a-1", "Paid Off", "credit");
    addAccount("a-2", "Owing", "credit");
    setBalance("a-1", 0);
    setBalance("a-2", -10_000);
    addTxn("a-1", -100);

    const out = accountInsights(bundle.db, "a-1", TODAY)!;
    expect(out.insights.map((i) => i.claimId)).toEqual(["count_in_subject"]);
  });

  test("an account with no balance at all says nothing", () => {
    addAccount("a-1", "Fresh", "checking");
    expect(accountInsights(bundle.db, "a-1", TODAY)).toBeNull();
  });

  test("an unknown account is not an error, it is silence", () => {
    expect(accountInsights(bundle.db, "no-such-account", TODAY)).toBeNull();
  });
});

/**
 * ⛔ A subject the app cannot NAME.
 *
 * `insight-facts` refuses `< > { } \\` in a label BY THROWING, so a surface that
 * builds a fact from a ledger name without checking renders its route's error
 * boundary instead of a page. That is not hypothetical: `claude-categorize`
 * wrote a merchant literally called `<UNKNOWN>` and `/merchants/019f4ccc…`
 * was broken by it. Every surface that names a ledger entity carries the same
 * guard now, and this is what proves each one still does.
 */
describe("an account the app cannot name", () => {
  test("declines rather than throwing", () => {
    addAccount("a-1", "Big Savings", "checking");
    addAccount("a-2", "<UNKNOWN>", "checking");
    setBalance("a-1", 90_000);
    setBalance("a-2", 10_000);
    addTxn("a-2", -500);

    expect(accountInsights(bundle.db, "a-2", TODAY)).toBeNull();
    // its neighbour is unaffected: one unprintable name silences one page
    expect(accountInsights(bundle.db, "a-1", TODAY)).not.toBeNull();
  });
});
