import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { createAccount } from "./accounts";
import { commandEntityGroups } from "./command-index";
import { holdingDetail } from "./holding-detail";
import { upsertHolding } from "./holdings";

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-cmd-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("commandEntityGroups", () => {
  test("indexes accounts, categories, and merchants with navigating hrefs", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const accountId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
    const netflix = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Netflix")).get()!;

    const groups = commandEntityGroups(bundle.db);
    const byLabel = new Map(groups.map((g) => [g.label, g]));

    const account = byLabel.get("Accounts")!.items.find((i) => i.id === `account-${accountId}`)!;
    expect(account.label).toBe("Checking");
    expect(account.href).toBe(`/accounts/${accountId}`);
    expect(account.hint).toBe("Chase");

    const merchant = byLabel.get("Merchants")!.items.find((i) => i.id === `merchant-${netflix.id}`)!;
    expect(merchant.href).toBe(`/merchants/${netflix.id}`);
    expect(merchant.hint).toBe("Merchant");

    // categories navigate to their filtered ledger (until /categories/[id], Stage 3)
    const categoriesGroup = byLabel.get("Categories")!;
    expect(categoriesGroup.items.length).toBeGreaterThan(0);
    expect(categoriesGroup.items.every((i) => i.href!.startsWith("/transactions?category="))).toBe(true);
    // a child category renders "Parent > Child"
    const child = categoriesGroup.items.find((i) => i.label.includes(" > "));
    expect(child).toBeDefined();
  });

  test("omits the Accounts group when there are no active accounts", () => {
    const groups = commandEntityGroups(bundle.db);
    expect(groups.find((g) => g.label === "Accounts")).toBeUndefined();
    // categories + merchants are seeded, so those groups are present
    expect(groups.find((g) => g.label === "Merchants")).toBeDefined();
  });
});

/**
 * ⚖️ Owner decisions 2026-09-14/15: what Claude's agent buys sits in a brokerage book paired with Robinhood Agentic,
 * kept out of his own returns. A holding page is HIS holding (`holdingDetail` reads his legs only).
 *
 * 🔴 The palette's Holdings group read every active holding, so a symbol only the agent's book held opened a 404
 * (measured 2026-09-16 on the branch).
 */
describe("commandEntityGroups — Holdings open his holding pages", () => {
  function agentsBook(): { brokerage: string; book: string } {
    const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const brokerage = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Brokerage", type: "investment", subtype: "brokerage" });
    const agentic = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
    const book = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
    return { brokerage, book };
  }
  const holdingsGroup = () => commandEntityGroups(bundle.db).find((g) => g.label === "Holdings");

  test("a symbol only the agent's book holds is not offered, and one both hold is offered once — every link opens his page", () => {
    const { brokerage, book } = agentsBook();
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 100_000_000, occurredOn: "2026-07-01" });
    upsertHolding(bundle.db, { accountId: book, symbol: "AAPL", assetType: "stock", quantityE8: 50_000_000, occurredOn: "2026-08-20" });
    upsertHolding(bundle.db, { accountId: book, symbol: "WMT", assetType: "stock", quantityE8: 25_000_000, occurredOn: "2026-08-20" });

    const items = holdingsGroup()!.items;

    expect(items.map((i) => [i.label, i.href])).toEqual([["AAPL", "/investments/stock/AAPL"]]);
    expect(holdingDetail(bundle.db, "stock", "AAPL", "2026-09-16").quantityE8).toBe(100_000_000);
    // the book itself is still found, as an account
    expect(commandEntityGroups(bundle.db).find((g) => g.label === "Accounts")!.items.map((i) => i.href)).toContain(`/accounts/${book}`);
  });

  test("with only the agent's book holding anything, there is no Holdings group at all", () => {
    const { book } = agentsBook();
    upsertHolding(bundle.db, { accountId: book, symbol: "WMT", assetType: "stock", quantityE8: 25_000_000, occurredOn: "2026-08-20" });

    expect(holdingsGroup()).toBeUndefined();
  });
});
