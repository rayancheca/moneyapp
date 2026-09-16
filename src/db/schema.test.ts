import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "./client";
import { seedDatabase, TAXONOMY } from "./seed";
import { accounts } from "./schema/accounts";
import { balanceAnchors } from "./schema/balances";
import { categories } from "./schema/categories";
import { institutions } from "./schema/institutions";
import { transactions } from "./schema/transactions";

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-schema-"));
  bundle = createDatabase(path.join(dir, "test.db"));
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("migrations from zero", () => {
  test("all 29 tables exist", () => {
    const rows = bundle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      [
        "account_numbers",
        "accounts",
        "ai_calls",
        "app_settings",
        "balance_anchors",
        "budgets",
        "categories",
        "daily_balances",
        "duplicate_candidates",
        "holding_events",
        "holdings",
        "import_files",
        "insight_selections",
        "ledger_witness_marks",
        "institutions",
        "merchant_aliases",
        "merchants",
        "price_cache",
        "price_intraday",
        "recurring_series",
        "rules",
        "printed_lines",
        "statement_copies",
        "statement_periods",
        "transaction_splits",
        "transactions",
        "transfer_ambiguities",
        "unimported_row_attributes",
        "unimported_transfer_legs",
      ].sort(),
    );
  });

  test("WAL and foreign keys are on", () => {
    expect(bundle.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(bundle.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("seed", () => {
  test("is idempotent", () => {
    const first = seedDatabase(bundle.db);
    expect(first.institutions).toBe(5);
    expect(first.merchants).toBeGreaterThan(30); // Employer (cash) + starter map
    expect(first.rules).toBe(2);
    const expectedCategories = TAXONOMY.length + TAXONOMY.reduce((n, t) => n + t.subs.length, 0);
    expect(first.categories).toBe(expectedCategories);

    const second = seedDatabase(bundle.db);
    expect(second).toEqual({ institutions: 0, categories: 0, merchants: 0, rules: 0, settings: 0 });
  });

  test("seeded taxonomy matches the approved master-plan §2 exactly (independent oracle)", () => {
    // Transcribed from docs/master-plan.md §2 — deliberately NOT derived from
    // the TAXONOMY constant, so drift in seed.ts fails this test.
    const expected: [name: string, kind: string, parent: string | null][] = [
      ["Income", "income", null], ["Salary", "income", "Income"], ["Interest", "income", "Income"],
      ["Dividends", "income", "Income"], ["Refunds & Reimbursements", "income", "Income"], ["Other Income", "income", "Income"],
      ["Housing", "expense", null], ["Rent", "expense", "Housing"], ["Home Supplies", "expense", "Housing"], ["Furniture", "expense", "Housing"],
      ["Utilities", "expense", null], ["Electricity", "expense", "Utilities"], ["Water/Gas", "expense", "Utilities"], ["Internet", "expense", "Utilities"], ["Mobile", "expense", "Utilities"],
      ["Food", "expense", null], ["Groceries", "expense", "Food"], ["Dining", "expense", "Food"], ["Coffee", "expense", "Food"], ["Delivery", "expense", "Food"],
      ["Transport", "expense", null], ["Gas", "expense", "Transport"], ["Rideshare", "expense", "Transport"], ["Public Transit", "expense", "Transport"], ["Parking & Tolls", "expense", "Transport"], ["Auto Maintenance", "expense", "Transport"],
      ["Travel", "expense", null], ["Flights", "expense", "Travel"], ["Hotels", "expense", "Travel"], ["Other Travel", "expense", "Travel"],
      ["Shopping", "expense", null], ["Clothing", "expense", "Shopping"], ["Electronics", "expense", "Shopping"], ["General", "expense", "Shopping"],
      ["Subscriptions", "expense", null], ["Streaming", "expense", "Subscriptions"], ["Software", "expense", "Subscriptions"], ["Memberships", "expense", "Subscriptions"],
      ["Health", "expense", null], ["Medical", "expense", "Health"], ["Pharmacy", "expense", "Health"], ["Fitness", "expense", "Health"],
      ["Entertainment", "expense", null], ["Events", "expense", "Entertainment"], ["Hobbies", "expense", "Entertainment"], ["Games", "expense", "Entertainment"],
      ["Personal Care", "expense", null], ["Education", "expense", null], ["Gifts & Donations", "expense", null],
      ["Cash & ATM", "expense", null], ["ATM Withdrawals", "expense", "Cash & ATM"],
      ["Fees", "expense", null], ["Bank Fees", "expense", "Fees"], ["Card Annual Fees", "expense", "Fees"], ["Interest Charges", "expense", "Fees"], ["ATM Fees", "expense", "Fees"],
      ["Rewards", "rewards", null], ["Cash Back", "rewards", "Rewards"], ["Statement Credits", "rewards", "Rewards"],
      ["Transfers", "transfer", null], ["Credit Card Payment", "transfer", "Transfers"], ["Internal Transfer", "transfer", "Transfers"], ["Investment Contribution", "transfer", "Transfers"],
      ["Investments", "investment", null], ["Buys", "investment", "Investments"], ["Sells", "investment", "Investments"],
      ["Uncategorized", "system", null],
    ];

    seedDatabase(bundle.db);
    const rows = bundle.db.select().from(categories).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const actual = rows
      .map((r): [string, string, string | null] => [
        r.name,
        r.kind,
        r.parentId ? (byId.get(r.parentId)?.name ?? "<missing>") : null,
      ])
      .sort((a, b) => a[0].localeCompare(b[0]) || (a[2] ?? "").localeCompare(b[2] ?? ""));
    const expectedSorted = [...expected].sort(
      (a, b) => a[0].localeCompare(b[0]) || (a[2] ?? "").localeCompare(b[2] ?? ""),
    );
    expect(actual).toEqual(expectedSorted);
  });

  test("taxonomy tree has correct kinds and parents", () => {
    seedDatabase(bundle.db);
    const dining = bundle.db
      .select()
      .from(categories)
      .where(eq(categories.name, "Dining"))
      .get();
    expect(dining?.kind).toBe("expense");
    const food = bundle.db
      .select()
      .from(categories)
      .where(and(eq(categories.name, "Food"), isNull(categories.parentId)))
      .get();
    expect(dining?.parentId).toBe(food?.id);

    const rewards = bundle.db
      .select()
      .from(categories)
      .where(and(eq(categories.name, "Rewards"), isNull(categories.parentId)))
      .get();
    expect(rewards?.kind).toBe("rewards");
  });
});

describe("schema invariant enforcement", () => {
  function insertAccount(): string {
    seedDatabase(bundle.db);
    const chase = bundle.db
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.name, "Chase"))
      .get();
    if (!chase) throw new Error("missing institution");
    const account = bundle.db
      .insert(accounts)
      .values({ institutionId: chase.id, name: "Chase Checking", type: "checking" })
      .returning({ id: accounts.id })
      .get();
    return account.id;
  }

  const txn = (accountId: string, dedupeHash: string, status: "active" | "superseded" = "active") => ({
    accountId,
    postedOn: "2026-07-01",
    amountCents: -1_000,
    rawDescription: "COFFEE",
    normalizedDescription: "COFFEE",
    dedupeHash,
    status,
  });

  test("duplicate dedupe_hash is rejected among non-superseded rows", () => {
    const accountId = insertAccount();
    bundle.db.insert(transactions).values(txn(accountId, "hash-1")).run();
    expect(() => bundle.db.insert(transactions).values(txn(accountId, "hash-1")).run()).toThrow(
      /UNIQUE/,
    );
  });

  test("superseded rows do not block re-insertion (re-parse lifecycle)", () => {
    const accountId = insertAccount();
    bundle.db.insert(transactions).values(txn(accountId, "hash-1", "superseded")).run();
    expect(() => bundle.db.insert(transactions).values(txn(accountId, "hash-1")).run()).not.toThrow();
  });

  test("balance anchors are unique per (account, date, source)", () => {
    const accountId = insertAccount();
    const anchor = {
      accountId,
      anchoredOn: "2026-06-30",
      balanceCents: 500_000,
      source: "manual" as const,
    };
    bundle.db.insert(balanceAnchors).values(anchor).run();
    expect(() => bundle.db.insert(balanceAnchors).values(anchor).run()).toThrow(/UNIQUE/);
    // same date, different source is allowed (precedence resolves at read time)
    expect(() =>
      bundle.db.insert(balanceAnchors).values({ ...anchor, source: "statement" }).run(),
    ).not.toThrow();
  });

  test("foreign keys are enforced", () => {
    insertAccount();
    expect(() =>
      bundle.db
        .insert(transactions)
        .values(txn("nonexistent-account", "hash-x"))
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});
