import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { createAccount } from "./accounts";
import { commandEntityGroups } from "./command-index";

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
