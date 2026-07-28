import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { rules, ruleActionsSchema } from "@/db/schema/rules";
import { transactions, type CategorizationSource } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { applyUndoPatch } from "./bulk-edit";
import { categorizeAll } from "./categorize";
import {
  conditionsForCorrection,
  countRuleMatches,
  deleteRule,
  retroApplyRule,
  ruleFromCorrection,
} from "./rule-corrections";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let netflixId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rules-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  netflixId = bundle.db
    .select()
    .from(merchants)
    .where(eq(merchants.canonicalName, "Netflix"))
    .get()!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function catId(pathStr: string): string {
  const [parentName, subName] = pathStr.split(" > ");
  const parent = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get()!;
  if (!subName) return parent.id;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get()!.id;
}

let seq = 0;
function insertTxn(overrides: {
  rawDescription?: string;
  amountCents?: number;
  categoryId?: string | null;
  categorizationSource?: CategorizationSource | null;
  status?: "active" | "excluded";
}): string {
  seq += 1;
  const rawDescription = overrides.rawDescription ?? `TXN ${seq}`;
  const amountCents = overrides.amountCents ?? -1_549;
  const postedOn = "2026-06-15";
  return bundle.db
    .insert(transactions)
    .values({
      accountId: checkingId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: rawDescription.toUpperCase(),
      categoryId: overrides.categoryId ?? null,
      categorizationSource: overrides.categorizationSource ?? null,
      status: overrides.status ?? "active",
      dedupeHash: dedupeHash({
        accountId: checkingId,
        postedOn,
        amountCents,
        rawDescription: `${rawDescription}#${seq}`,
        occurrenceIndex: 0,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function txn(id: string) {
  return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
}

describe("ruleActionsSchema extension", () => {
  test("accepts renameTo and markRecurringSeriesId; stays strict", () => {
    const parsed = ruleActionsSchema.parse({
      categoryId: "c1",
      renameTo: "Corner Deli",
      markRecurringSeriesId: "series-1",
    });
    expect(parsed.renameTo).toBe("Corner Deli");
    expect(parsed.markRecurringSeriesId).toBe("series-1");
    expect(() => ruleActionsSchema.parse({ unknownKey: true })).toThrow();
    expect(() => ruleActionsSchema.parse({ renameTo: "" })).toThrow();
  });
});

describe("conditionsForCorrection", () => {
  test("merchant corrections bridge through the broadest alias", () => {
    expect(conditionsForCorrection(bundle.db, { merchantId: netflixId })).toEqual({
      descriptionContains: "NETFLIX",
    });
  });

  test("falls back to the uppercased canonical name when no alias exists", () => {
    const id = bundle.db
      .insert(merchants)
      .values({ canonicalName: "Corner Deli" })
      .returning({ id: merchants.id })
      .get().id;
    expect(conditionsForCorrection(bundle.db, { merchantId: id })).toEqual({
      descriptionContains: "CORNER DELI",
    });
  });

  test("explicit description fragments are uppercased; empty input throws", () => {
    expect(conditionsForCorrection(bundle.db, { descriptionContains: "trader joe" })).toEqual({
      descriptionContains: "TRADER JOE",
    });
    expect(() => conditionsForCorrection(bundle.db, {})).toThrow(/required/);
    expect(() => conditionsForCorrection(bundle.db, { merchantId: "nope" })).toThrow(
      /Unknown merchant/,
    );
  });

  test("a name key becomes a descriptionKey condition verbatim", () => {
    expect(conditionsForCorrection(bundle.db, { descriptionKey: "ticker:COKE:DIV" })).toEqual({
      descriptionKey: "ticker:COKE:DIV",
    });
  });
});

describe("name-key corrections (merchantless 'apply to this exact name')", () => {
  test("ruleFromCorrection names the rule from the humanized subject, with no merchant action", () => {
    const streaming = catId("Subscriptions > Streaming");
    const created = ruleFromCorrection(bundle.db, {
      descriptionKey: "ticker:COKE:DIV",
      categoryId: streaming,
    });
    const row = bundle.db.select().from(rules).where(eq(rules.id, created.id)).get()!;
    expect(created.name).toBe("Always: COKE dividends → Streaming");
    expect(JSON.parse(row.conditions)).toEqual({ descriptionKey: "ticker:COKE:DIV" });
    // no merchantId — a merchantless correction sets only the category
    expect(JSON.parse(row.actions)).toEqual({ categoryId: streaming });
  });

  test("retro-applies to every row sharing the stripped key; count agrees; user rows spared", () => {
    // Arrange: three COKE dividends (different dates → same ticker key) + one MSFT
    const streaming = catId("Subscriptions > Streaming");
    const dining = catId("Food > Dining");
    const uncategorized = insertTxn({
      rawDescription: "CASH DIV: R/D 2026-04-24 - 32. SHARES AT 0.25 (COKE)",
    });
    const claudeSet = insertTxn({
      rawDescription: "CASH DIV: R/D 2026-01-16 - 30. SHARES AT 0.24 (COKE)",
      categoryId: dining,
      categorizationSource: "claude",
    });
    const userSet = insertTxn({
      rawDescription: "CASH DIV: R/D 2025-11-10 - 28. SHARES AT 0.23 (COKE)",
      categoryId: dining,
      categorizationSource: "user",
    });
    insertTxn({ rawDescription: "CASH DIV: R/D 2026-05-21 - 24. SHARES AT 0.91 (MSFT)" });
    const created = ruleFromCorrection(bundle.db, {
      descriptionKey: "ticker:COKE:DIV",
      categoryId: streaming,
    });

    // Act
    const count = countRuleMatches(bundle.db, created.conditions, { excludeUserSet: true });
    const { affected, undo } = retroApplyRule(bundle.db, created.id);

    // Assert: the MSFT row (different key) and the user row are both untouched
    expect(count).toBe(2);
    expect(affected).toBe(2);
    expect(txn(uncategorized).categoryId).toBe(streaming);
    expect(txn(uncategorized).categorizationSource).toBe("rule");
    expect(txn(claudeSet).categoryId).toBe(streaming);
    expect(txn(userSet).categoryId).toBe(dining);

    // Undo restores both changed rows exactly
    applyUndoPatch(bundle.db, undo);
    expect(txn(uncategorized).categoryId).toBeNull();
    expect(txn(claudeSet).categoryId).toBe(dining);
    expect(txn(claudeSet).categorizationSource).toBe("claude");
  });

  test("future imports matching the name key auto-categorize through the engine", () => {
    // this exercises ruleMatches' descriptionKey branch via the real pipeline
    const streaming = catId("Subscriptions > Streaming");
    ruleFromCorrection(bundle.db, { descriptionKey: "ticker:COKE:DIV", categoryId: streaming });
    const future = insertTxn({
      rawDescription: "CASH DIV: R/D 2026-08-01 - 41. SHARES AT 0.26 (COKE)",
    });
    const otherTicker = insertTxn({
      rawDescription: "CASH DIV: R/D 2026-08-01 - 12. SHARES AT 0.30 (AAPL)",
    });

    categorizeAll(bundle.db);

    expect(txn(future).categoryId).toBe(streaming);
    expect(txn(future).categorizationSource).toBe("rule");
    // a different ticker never matches this rule
    expect(txn(otherTicker).categoryId).not.toBe(streaming);
  });
});

describe("ruleFromCorrection", () => {
  test("creates an enabled rule ABOVE every existing priority (engine runs ascending)", () => {
    // Arrange: seed rules sit at priorities 10 and 20
    const streaming = catId("Subscriptions > Streaming");

    // Act
    const created = ruleFromCorrection(bundle.db, {
      merchantId: netflixId,
      categoryId: streaming,
    });

    // Assert
    const row = bundle.db.select().from(rules).where(eq(rules.id, created.id)).get()!;
    expect(row.isEnabled).toBe(true);
    expect(created.name).toBe("Always: Netflix → Streaming");
    const others = bundle.db
      .select({ p: rules.priority })
      .from(rules)
      .all()
      .filter((r) => r.p !== created.priority);
    expect(Math.min(...others.map((o) => o.p))).toBeGreaterThan(created.priority);
    expect(JSON.parse(row.conditions)).toEqual({ descriptionContains: "NETFLIX" });
    expect(JSON.parse(row.actions)).toEqual({ categoryId: streaming, merchantId: netflixId });
  });

  test("new uncategorized rows hit the created rule first (newest wins end-to-end)", () => {
    // Arrange
    const dining = catId("Food > Dining");
    ruleFromCorrection(bundle.db, { merchantId: netflixId, categoryId: dining });
    const id = insertTxn({ rawDescription: "NETFLIX.COM NETFLIX.COM CA" });

    // Act: without the rule this txn would be categorized by the merchant map
    categorizeAll(bundle.db);

    // Assert
    expect(txn(id).categoryId).toBe(dining);
    expect(txn(id).categorizationSource).toBe("rule");
  });

  test("name collisions get a numeric suffix; unknown categories throw", () => {
    const streaming = catId("Subscriptions > Streaming");
    const first = ruleFromCorrection(bundle.db, { merchantId: netflixId, categoryId: streaming });
    const second = ruleFromCorrection(bundle.db, { merchantId: netflixId, categoryId: streaming });
    expect(first.name).toBe("Always: Netflix → Streaming");
    expect(second.name).toBe("Always: Netflix → Streaming (2)");
    expect(() => ruleFromCorrection(bundle.db, { merchantId: netflixId, categoryId: "nope" })).toThrow(
      /Unknown category/,
    );
  });
});

describe("countRuleMatches + retroApplyRule share one predicate", () => {
  test("retro-applies to non-user matches regardless of current category; count agrees", () => {
    // Arrange: matching rows in three states + one non-match
    const dining = catId("Food > Dining");
    const streaming = catId("Subscriptions > Streaming");
    const uncategorized = insertTxn({ rawDescription: "NETFLIX.COM 1" });
    const claudeSet = insertTxn({
      rawDescription: "NETFLIX.COM 2",
      categoryId: dining,
      categorizationSource: "claude",
    });
    const userSet = insertTxn({
      rawDescription: "NETFLIX.COM 3",
      categoryId: dining,
      categorizationSource: "user",
    });
    insertTxn({ rawDescription: "SHELL GAS" });
    const created = ruleFromCorrection(bundle.db, {
      merchantId: netflixId,
      categoryId: streaming,
    });

    // Act
    const promptCount = countRuleMatches(bundle.db, created.conditions, { excludeUserSet: true });
    const includingUser = countRuleMatches(bundle.db, created.conditions, {
      excludeUserSet: false,
    });
    const { affected, undo } = retroApplyRule(bundle.db, created.id);

    // Assert: the toast number IS the retro-apply blast radius
    expect(promptCount).toBe(2);
    expect(includingUser).toBe(3);
    expect(affected).toBe(2);
    expect(txn(uncategorized).categoryId).toBe(streaming);
    expect(txn(uncategorized).categorizationSource).toBe("rule");
    expect(txn(uncategorized).merchantId).toBe(netflixId);
    expect(txn(claudeSet).categoryId).toBe(streaming); // recategorized despite having one
    expect(txn(userSet).categoryId).toBe(dining); // user decision never overwritten
    const rule = bundle.db.select().from(rules).where(eq(rules.id, created.id)).get()!;
    expect(rule.timesApplied).toBe(2);

    // Assert: undo restores both rows exactly
    applyUndoPatch(bundle.db, undo);
    expect(txn(uncategorized).categoryId).toBeNull();
    expect(txn(uncategorized).merchantId).toBeNull();
    expect(txn(claudeSet).categoryId).toBe(dining);
    expect(txn(claudeSet).categorizationSource).toBe("claude");
  });

  test("excluded rows never match; exclude-action rules move rows out honestly", () => {
    // Arrange
    insertTxn({ rawDescription: "NETFLIX.COM EXCLUDED", status: "excluded" });
    const active = insertTxn({ rawDescription: "NETFLIX.COM ACTIVE" });
    const excludeRule = bundle.db
      .insert(rules)
      .values({
        name: "Exclude Netflix",
        priority: -100,
        conditions: JSON.stringify({ descriptionContains: "NETFLIX" }),
        actions: JSON.stringify({ exclude: true }),
      })
      .returning({ id: rules.id })
      .get().id;

    // Act
    const count = countRuleMatches(
      bundle.db,
      { descriptionContains: "NETFLIX" },
      { excludeUserSet: true },
    );
    const { affected, undo } = retroApplyRule(bundle.db, excludeRule);

    // Assert
    expect(count).toBe(1);
    expect(affected).toBe(1);
    expect(txn(active).status).toBe("excluded");
    applyUndoPatch(bundle.db, undo);
    expect(txn(active).status).toBe("active");
  });

  test("re-applying a rule to rows that already carry its outcome changes nothing", () => {
    // Arrange
    const streaming = catId("Subscriptions > Streaming");
    insertTxn({ rawDescription: "NETFLIX.COM A" });
    insertTxn({ rawDescription: "NETFLIX.COM B" });
    const created = ruleFromCorrection(bundle.db, {
      merchantId: netflixId,
      categoryId: streaming,
    });

    // Act: the second pass matches the same rows, but they already sit where
    // the rule wants them
    const first = retroApplyRule(bundle.db, created.id);
    const second = retroApplyRule(bundle.db, created.id);

    // Assert: no write, no undo rows, and the badge does not inflate
    expect(first.affected).toBe(2);
    expect(second.affected).toBe(0);
    expect(second.undo.rows).toEqual([]);
    const rule = bundle.db.select().from(rules).where(eq(rules.id, created.id)).get()!;
    expect(rule.timesApplied).toBe(2);
  });

  test("a row already in the rule's category but flagged for review still counts", () => {
    // Arrange: right category, weaker stamp, still in the review queue
    const streaming = catId("Subscriptions > Streaming");
    const flagged = insertTxn({
      rawDescription: "NETFLIX.COM FLAGGED",
      categoryId: streaming,
      categorizationSource: "claude",
    });
    bundle.db
      .update(transactions)
      .set({ needsReview: true, categorizationConfidence: 0.4 })
      .where(eq(transactions.id, flagged))
      .run();
    const created = ruleFromCorrection(bundle.db, {
      merchantId: netflixId,
      categoryId: streaming,
    });

    // Act
    const { affected, undo } = retroApplyRule(bundle.db, created.id);

    // Assert: settling the stamp and the review flag IS a change
    expect(affected).toBe(1);
    expect(txn(flagged).needsReview).toBe(false);
    expect(txn(flagged).categorizationSource).toBe("rule");
    expect(txn(flagged).categorizationConfidence).toBe(1);

    // Undo restores only what moved; the category was never touched
    applyUndoPatch(bundle.db, undo);
    expect(txn(flagged).needsReview).toBe(true);
    expect(txn(flagged).categorizationConfidence).toBe(0.4);
    expect(txn(flagged).categorizationSource).toBe("claude");
    expect(txn(flagged).categoryId).toBe(streaming);
  });

  test("a retro-apply that rewrites rows snapshots first; one that matches nothing does not", () => {
    // the archive lives beside the database it protects (.db only — reading a
    // snapshot back leaves -wal/-shm siblings behind)
    const snapshots = () => {
      const backups = path.join(dir, "backups");
      if (!fs.existsSync(backups)) return [];
      return fs.readdirSync(backups).filter((f) => f.startsWith("pre-") && f.endsWith(".db"));
    };

    const streaming = catId("Subscriptions > Streaming");
    const unmatched = ruleFromCorrection(bundle.db, {
      merchantId: netflixId,
      categoryId: streaming,
    });
    expect(retroApplyRule(bundle.db, unmatched.id).affected).toBe(0);
    expect(snapshots()).toEqual([]); // nothing matched, nothing to lose

    const id = insertTxn({ rawDescription: "NETFLIX.COM A" });
    retroApplyRule(bundle.db, unmatched.id);

    const name = snapshots()[0]!;
    expect(name).toMatch(/-retro-apply-rule\.db$/);
    const before = createDatabase(path.join(dir, "backups", name));
    const row = before.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
    expect(row.categoryId).not.toBe(streaming); // pre-rewrite state preserved
    before.sqlite.close();
    expect(txn(id).categoryId).toBe(streaming);
  });

  test("unknown rules throw; deleteRule reports whether anything was removed", () => {
    expect(() => retroApplyRule(bundle.db, "nope")).toThrow(/Unknown rule/);
    const streaming = catId("Subscriptions > Streaming");
    const created = ruleFromCorrection(bundle.db, {
      merchantId: netflixId,
      categoryId: streaming,
    });
    expect(deleteRule(bundle.db, created.id)).toBe(true);
    expect(deleteRule(bundle.db, created.id)).toBe(false);
  });
});
