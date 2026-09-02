import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import { rules } from "@/db/schema/rules";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import {
  deleteRuleCapturing,
  listRules,
  moveRule,
  previewRuleMatches,
  renderRuleSentence,
  restoreRule,
  setRuleEnabled,
} from "./rules-manager";
import { countRuleMatches, retroApplyRule } from "./rule-corrections";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let groceriesId: string;
let groceriesLabel: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rules-mgr-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db.delete(rules).run(); // clear seeded rules — tests own the rule set
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  const child = bundle.db
    .select()
    .from(categories)
    .where(isNotNull(categories.parentId))
    .all()
    .find((c) => /grocer/i.test(c.name))!;
  groceriesId = child.id;
  const parent = bundle.db.select({ name: categories.name }).from(categories).where(eq(categories.id, child.parentId!)).get()!;
  groceriesLabel = `${parent.name} > ${child.name}`;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function insertRule(overrides: {
  name?: string;
  priority?: number;
  isEnabled?: boolean;
  conditions?: object;
  actions?: object;
}): string {
  seq += 1;
  return bundle.db
    .insert(rules)
    .values({
      name: overrides.name ?? `Rule ${seq}`,
      priority: overrides.priority ?? 0,
      isEnabled: overrides.isEnabled ?? true,
      conditions: JSON.stringify(overrides.conditions ?? { descriptionContains: "STARBUCKS" }),
      actions: JSON.stringify(overrides.actions ?? { categoryId: groceriesId }),
    })
    .returning({ id: rules.id })
    .get().id;
}

function insertTxn(desc: string, opts: { categorizationSource?: "user" | "rule" } = {}): string {
  seq += 1;
  return bundle.db
    .insert(transactions)
    .values({
      accountId: checkingId,
      postedOn: "2026-06-15",
      amountCents: -1_000,
      rawDescription: desc,
      normalizedDescription: normalizeDescription(desc),
      status: "active",
      categorizationSource: opts.categorizationSource ?? null,
      dedupeHash: dedupeHash({ accountId: checkingId, postedOn: "2026-06-15", amountCents: -1_000, rawDescription: `${desc}#${seq}`, occurrenceIndex: 0 }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

describe("renderRuleSentence", () => {
  const ctx = {
    categoryLabel: () => "Food > Groceries",
    merchantName: () => "Trader Joe's",
    accountName: () => "Chase Checking",
  };

  test("renders conditions + actions as a readable sentence", () => {
    expect(
      renderRuleSentence({ descriptionContains: "STARBUCKS" }, { categoryId: "c1" }, ctx),
    ).toBe('When a transaction contains "STARBUCKS", categorize it as Food > Groceries.');
  });

  test("joins multiple conditions and actions with 'and'", () => {
    const s = renderRuleSentence(
      { accountIds: ["a1"], direction: "out", amountMinCents: 5_000 },
      { categoryId: "c1", exclude: true },
      ctx,
    );
    expect(s).toBe(
      "When a transaction is from Chase Checking and is money out and is at least $50, categorize it as Food > Groceries and exclude it.",
    );
  });

  test("degrades to 'matches anything' / 'do nothing' at the empty extremes", () => {
    expect(renderRuleSentence({}, {}, ctx)).toBe("When a transaction matches anything, do nothing.");
  });

  test("renders an amount range and a rename action", () => {
    const s = renderRuleSentence(
      { amountMinCents: 1_000, amountMaxCents: 6_000 },
      { renameTo: "Corner Deli" },
      ctx,
    );
    expect(s).toBe('When a transaction is between $10 and $60, rename the merchant to "Corner Deli".');
  });

  test("renders a name-key condition with its humanized subject", () => {
    expect(
      renderRuleSentence({ descriptionKey: "ticker:COKE:DIV" }, { categoryId: "c1" }, ctx),
    ).toBe('When a transaction is named "COKE dividends", categorize it as Food > Groceries.');
  });
});

describe("previewRuleMatches (fixes the row-less over-report)", () => {
  test("a category rule counts matching non-user active rows", () => {
    insertTxn("STARBUCKS STORE 123");
    insertTxn("STARBUCKS AIRPORT");
    insertTxn("STARBUCKS DECAF", { categorizationSource: "user" }); // user rows excluded
    insertTxn("TRADER JOES"); // no match
    expect(
      previewRuleMatches(bundle.db, { descriptionContains: "STARBUCKS" }, { categoryId: groceriesId }),
    ).toBe(2);
  });

  test("a rename-only rule matches descriptions but changes ZERO rows → 0", () => {
    insertTxn("STARBUCKS STORE 123");
    insertTxn("STARBUCKS AIRPORT");
    // renameTo acts on the merchant entity, not rows — the over-report the plan flags
    expect(
      previewRuleMatches(bundle.db, { descriptionContains: "STARBUCKS" }, { renameTo: "Starbucks" }),
    ).toBe(0);
  });

  test("exclude / merchant / recurring actions do change rows and are counted", () => {
    insertTxn("STARBUCKS STORE 123");
    expect(previewRuleMatches(bundle.db, { descriptionContains: "STARBUCKS" }, { exclude: true })).toBe(1);
  });
});

describe("listRules", () => {
  test("orders by priority, renders sentences, flags first/last, counts matches", () => {
    insertRule({ name: "B rule", priority: 10, conditions: { descriptionContains: "STARBUCKS" }, actions: { categoryId: groceriesId } });
    insertRule({ name: "A rule", priority: -10, conditions: { descriptionContains: "UBER" }, actions: { markTransfer: true } });
    insertTxn("STARBUCKS STORE");

    const list = listRules(bundle.db);
    expect(list.map((r) => r.name)).toEqual(["A rule", "B rule"]); // priority asc
    expect(list[0]!.isFirst).toBe(true);
    expect(list[1]!.isLast).toBe(true);
    expect(list[1]!.sentence).toContain(groceriesLabel);
    expect(list[1]!.matchCount).toBe(1); // the STARBUCKS category rule matches 1 txn
    expect(list[0]!.matchCount).toBe(0); // markTransfer-only rule changes no rows
  });

  test("markTransfer-only rules preview 0 changes (only row actions count)", () => {
    // markTransfer is not in hasRowAction (transfer grouping is a later stage),
    // so a markTransfer-only rule previews 0 changes
    insertRule({ conditions: { descriptionContains: "UBER" }, actions: { markTransfer: true } });
    insertTxn("UBER TRIP");
    expect(listRules(bundle.db)[0]!.matchCount).toBe(0);
  });
});

/*
 * 🔴 THE BADGE SAID "would change 19" OVER A RULE THAT HAD ALREADY CHANGED THEM.
 *
 * Measured on the owner's /settings, 2026-09-02: "LA PISCINE MIAMI BEACH …
 * would change 19 · applied 11×", and "CPI*CANTEEN … would change 38 ·
 * applied 15×". `matchCount` was `countRuleMatches`, which counts CONDITION
 * matches — while `retroApplyRule` guards every field on a real change and
 * skips a row that already carries the rule's outcome. So the badge counted
 * rows the button would not touch, and `RuleView.matchCount` documented itself
 * as "rows a retro-apply would actually CHANGE now".
 *
 * ⚠️ This module's own header already names the same over-report for the
 * rename-only case — "countRuleMatches counts condition matches, not row
 * changes" — and fixed it with `hasRowAction`. The settled-row case was the
 * other half of it.
 */
describe("the preview counts rows that would MOVE, not rows that match", () => {
  test("a rule already applied to every match advertises nothing to do", () => {
    const id = insertRule({
      conditions: { descriptionContains: "STARBUCKS" },
      actions: { categoryId: groceriesId },
    });
    insertTxn("STARBUCKS STORE");
    insertTxn("STARBUCKS RESERVE");
    expect(listRules(bundle.db).find((r) => r.id === id)!.matchCount).toBe(2);

    retroApplyRule(bundle.db, id);

    // the rows still MATCH the condition; not one of them would move again
    expect(countRuleMatches(bundle.db, { descriptionContains: "STARBUCKS" }, { excludeUserSet: true })).toBe(2);
    expect(listRules(bundle.db).find((r) => r.id === id)!.matchCount).toBe(0);
  });

  test("a new row arriving after the apply is the only one counted", () => {
    const id = insertRule({
      conditions: { descriptionContains: "STARBUCKS" },
      actions: { categoryId: groceriesId },
    });
    insertTxn("STARBUCKS STORE");
    retroApplyRule(bundle.db, id);
    insertTxn("STARBUCKS AIRPORT"); // imported since

    expect(listRules(bundle.db).find((r) => r.id === id)!.matchCount).toBe(1);
  });

  /* ⛔ A row can sit in the right category and still have something to settle —
     a weaker source, a review flag. Those ARE changes, and the apply guards
     each field separately; the preview must agree field for field. */
  test("a row already in the right category but flagged for review still counts", () => {
    const id = insertRule({
      conditions: { descriptionContains: "STARBUCKS" },
      actions: { categoryId: groceriesId },
    });
    const txnId = insertTxn("STARBUCKS STORE");
    bundle.db
      .update(transactions)
      .set({ categoryId: groceriesId, categorizationSource: "claude", needsReview: true })
      .where(eq(transactions.id, txnId))
      .run();

    expect(listRules(bundle.db).find((r) => r.id === id)!.matchCount).toBe(1);
  });

  /* The number the badge shows IS the number the button reports moving. */
  test("the preview equals what a re-apply actually affects", () => {
    const id = insertRule({
      conditions: { descriptionContains: "STARBUCKS" },
      actions: { categoryId: groceriesId },
    });
    insertTxn("STARBUCKS STORE");
    insertTxn("STARBUCKS RESERVE");
    retroApplyRule(bundle.db, id);
    insertTxn("STARBUCKS AIRPORT");

    const previewed = listRules(bundle.db).find((r) => r.id === id)!.matchCount;
    expect(retroApplyRule(bundle.db, id).affected).toBe(previewed);
  });
});

describe("setRuleEnabled", () => {
  test("toggles isEnabled and reports the change", () => {
    const id = insertRule({ isEnabled: true });
    expect(setRuleEnabled(bundle.db, id, false)).toBe(true);
    expect(bundle.db.select().from(rules).where(eq(rules.id, id)).get()!.isEnabled).toBe(false);
    expect(setRuleEnabled(bundle.db, "nope", false)).toBe(false);
  });
});

describe("disabled rules advertise no pending changes", () => {
  test("matchCount is 0 for a disabled rule even though its conditions match", () => {
    const id = insertRule({ isEnabled: false, conditions: { descriptionContains: "STARBUCKS" }, actions: { categoryId: groceriesId } });
    insertTxn("STARBUCKS STORE");
    expect(listRules(bundle.db).find((r) => r.id === id)!.matchCount).toBe(0);

    setRuleEnabled(bundle.db, id, true);
    expect(listRules(bundle.db).find((r) => r.id === id)!.matchCount).toBe(1);
  });
});

describe("deleteRuleCapturing / restoreRule (the delete Undo)", () => {
  test("captures a lossless snapshot, deletes, and restores it", () => {
    const id = insertRule({ name: "My rule", priority: -30, conditions: { descriptionContains: "UBER" }, actions: { categoryId: groceriesId } });
    const snap = deleteRuleCapturing(bundle.db, id);

    expect(snap).toMatchObject({ name: "My rule", priority: -30, isEnabled: true, timesApplied: 0 });
    expect(bundle.db.select().from(rules).all()).toHaveLength(0); // gone

    expect(restoreRule(bundle.db, snap!)).toBe(true);
    const restored = bundle.db.select().from(rules).where(eq(rules.name, "My rule")).get()!;
    expect(restored.priority).toBe(-30);
    expect(JSON.parse(restored.conditions)).toEqual({ descriptionContains: "UBER" });
  });

  test("unknown id yields null; a name clash restore is a no-op", () => {
    expect(deleteRuleCapturing(bundle.db, "nope")).toBeNull();
    insertRule({ name: "Existing" });
    expect(
      restoreRule(bundle.db, { name: "Existing", priority: 0, isEnabled: true, conditions: "{}", actions: "{}", timesApplied: 0 }),
    ).toBe(false);
  });
});

describe("moveRule", () => {
  test("swaps priority with the adjacent rule; ends are no-ops", () => {
    const top = insertRule({ name: "Top", priority: -10 });
    const mid = insertRule({ name: "Mid", priority: 0 });
    const bot = insertRule({ name: "Bot", priority: 10 });

    // move Mid up → it swaps priority with Top
    expect(moveRule(bundle.db, mid, "up")).toBe(true);
    expect(listRules(bundle.db).map((r) => r.name)).toEqual(["Mid", "Top", "Bot"]);

    // move Bot down at the end → false, order unchanged
    expect(moveRule(bundle.db, bot, "down")).toBe(false);
    expect(listRules(bundle.db).map((r) => r.name)).toEqual(["Mid", "Top", "Bot"]);
    void top;
  });

  test("equal priorities are nudged into a strict order", () => {
    const a = insertRule({ name: "Alpha", priority: 5 });
    const b = insertRule({ name: "Beta", priority: 5 });
    // by (priority, name) Alpha is first; move Beta up so it leads
    expect(moveRule(bundle.db, b, "up")).toBe(true);
    expect(listRules(bundle.db).map((r) => r.name)).toEqual(["Beta", "Alpha"]);
    void a;
  });

  test("unknown id returns false", () => {
    expect(moveRule(bundle.db, "nope", "up")).toBe(false);
  });
});
