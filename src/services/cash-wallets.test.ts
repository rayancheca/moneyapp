import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { balanceAnchors } from "@/db/schema/balances";
import { createAccount } from "./accounts";
import { addManualTransaction, isCashWallet } from "./manual-transactions";
import { latestBalances } from "./derivation";
import { createCashWallet, listCashWallets } from "./cash-wallets";

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-cash-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createCashWallet", () => {
  test("creates a cash wallet with a $0 opening anchor so the first txn derives a balance", () => {
    const id = createCashWallet(bundle.db, { name: "Wallet", openingOn: "2026-06-01" });

    // it IS a cash wallet, grouped under the find-or-created Cash institution
    expect(isCashWallet(bundle.db, id)).toBe(true);
    expect(bundle.db.select().from(institutions).where(eq(institutions.name, "Cash")).all()).toHaveLength(1);

    // the deferred bug: without the seeded $0 anchor the first manual txn would
    // derive no balance. With it, spending $20 leaves the wallet at -$20.
    addManualTransaction(bundle.db, {
      accountId: id,
      postedOn: "2026-06-05",
      amountCents: -2_000,
      description: "Coffee",
    });
    const balance = latestBalances(bundle.db).get(id);
    expect(balance).toBeDefined();
    expect(balance!.balanceCents).toBe(-2_000);
  });

  test("a first transaction dated ON the opening day still derives (default flow)", () => {
    // the critical bug: an anchor ON the opening day plus a same-day txn (both
    // default to today in the UI) derived $0 because derivation never adds the
    // anchor-day sum. The anchor now sits the day before, so same-day txns count.
    const id = createCashWallet(bundle.db, { name: "Same day", openingOn: "2026-06-01" });
    addManualTransaction(bundle.db, {
      accountId: id,
      postedOn: "2026-06-01", // SAME day as the opening date
      amountCents: -2_000,
      description: "Coffee",
    });
    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(-2_000);
  });

  test("an opening balance lands on the books, so creating a wallet moves net worth", () => {
    // the reported bug: a wallet could only ever open at $0, so adding a cash
    // account with $200 in it changed no balance anywhere
    const id = createCashWallet(bundle.db, {
      name: "Pocket",
      openingOn: "2026-06-01",
      openingBalanceCents: 20_000,
    });
    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(20_000);

    // and it composes with transactions rather than replacing them
    addManualTransaction(bundle.db, {
      accountId: id,
      postedOn: "2026-06-01", // same day as the opening date
      amountCents: -2_000,
      description: "Coffee",
    });
    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(18_000);
  });

  test("omitting the opening balance still opens the wallet empty", () => {
    const id = createCashWallet(bundle.db, { name: "Empty", openingOn: "2026-06-01" });
    expect(latestBalances(bundle.db).get(id)!.balanceCents).toBe(0);
  });

  test("reuses the single Cash institution across wallets; defaults opening to today", () => {
    const a = createCashWallet(bundle.db, { name: "Wallet A" });
    const b = createCashWallet(bundle.db, { name: "Wallet B" });
    expect(a).not.toBe(b);
    expect(bundle.db.select().from(institutions).where(eq(institutions.name, "Cash")).all()).toHaveLength(1);
  });

  test("rejects a blank name", () => {
    expect(() => createCashWallet(bundle.db, { name: "   " })).toThrow();
  });
});

describe("listCashWallets", () => {
  test("returns cash wallets and excludes import-fed accounts", () => {
    const walletId = createCashWallet(bundle.db, { name: "Cash", openingOn: "2026-06-01" });
    // a regular account made import-fed by a statement-sourced anchor
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: checkingId, anchoredOn: "2026-06-01", balanceCents: 5_000, source: "statement" })
      .run();

    const wallets = listCashWallets(bundle.db);
    expect(wallets.map((w) => w.id)).toContain(walletId);
    expect(wallets.map((w) => w.id)).not.toContain(checkingId);
  });
});
