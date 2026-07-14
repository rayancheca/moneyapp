import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { applyUndoPatch } from "./bulk-edit";
import { createAccount, createInstitution } from "./accounts";
import {
  linkTransferPair,
  transferCandidates,
  transferCounterparts,
  unlinkTransferGroup,
} from "./transfer-links";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let savingsId: string;
let creditId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-translink-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const inst = createInstitution(bundle.db, "Testbank");
  checkingId = createAccount(bundle.db, { institutionId: inst, name: "Checking", type: "checking" });
  savingsId = createAccount(bundle.db, { institutionId: inst, name: "Savings", type: "savings" });
  creditId = createAccount(bundle.db, { institutionId: inst, name: "Card", type: "credit" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function insertTxn(accountId: string, postedOn: string, amountCents: number, desc: string): string {
  const row = bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription: desc,
      normalizedDescription: desc.toLowerCase(),
      occurrenceIndex: 0,
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: desc, occurrenceIndex: 0 }),
      needsReview: true,
    })
    .returning({ id: transactions.id })
    .get();
  return row.id;
}

function row(id: string) {
  return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
}

function categoryPathOf(categoryId: string | null): string | null {
  if (!categoryId) return null;
  const cat = bundle.db.select().from(categories).where(eq(categories.id, categoryId)).get()!;
  if (!cat.parentId) return cat.name;
  const parent = bundle.db.select().from(categories).where(eq(categories.id, cat.parentId)).get()!;
  return `${parent.name} > ${cat.name}`;
}

describe("linkTransferPair", () => {
  test("pairs an outflow with an inflow: outflow id keys the group, both leave review", () => {
    const out = insertTxn(checkingId, "2026-07-01", -20_000, "WIRE TO SAVINGS");
    const inn = insertTxn(savingsId, "2026-07-03", 19_500, "INCOMING WIRE"); // fee-shaved — detector can't pair this
    const result = linkTransferPair(bundle.db, inn.toString(), out.toString());
    expect(result.affected).toBe(2);
    expect(row(out).transferGroupId).toBe(out);
    expect(row(inn).transferGroupId).toBe(out);
    expect(row(out).needsReview).toBe(false);
    expect(row(out).categorizationSource).toBe("user");
    expect(categoryPathOf(row(out).categoryId)).toBe("Transfers > Internal Transfer");
  });

  test("category follows the account types (credit → card payment)", () => {
    const out = insertTxn(checkingId, "2026-07-01", -50_000, "EPAY");
    const inn = insertTxn(creditId, "2026-07-01", 50_000, "PAYMENT RECEIVED");
    linkTransferPair(bundle.db, out, inn);
    expect(categoryPathOf(row(out).categoryId)).toBe("Transfers > Credit Card Payment");
  });

  test("the undo patch restores category, source, review state, and the missing link", () => {
    const out = insertTxn(checkingId, "2026-07-01", -20_000, "WIRE");
    const inn = insertTxn(savingsId, "2026-07-01", 20_000, "WIRE IN");
    const result = linkTransferPair(bundle.db, out, inn);
    applyUndoPatch(bundle.db, result.undo);
    expect(row(out).transferGroupId).toBeNull();
    expect(row(out).categoryId).toBeNull();
    expect(row(out).needsReview).toBe(true);
    expect(row(inn).transferGroupId).toBeNull();
  });

  test("rejects same account, same sign, already-linked, inactive, and unknown rows", () => {
    const a = insertTxn(checkingId, "2026-07-01", -10_000, "A");
    const b = insertTxn(checkingId, "2026-07-01", 10_000, "B");
    expect(() => linkTransferPair(bundle.db, a, b)).toThrow(/two different accounts/);

    const c = insertTxn(savingsId, "2026-07-01", -10_000, "C");
    expect(() => linkTransferPair(bundle.db, a, c)).toThrow(/one outflow and one inflow/);

    const d = insertTxn(savingsId, "2026-07-01", 10_000, "D");
    linkTransferPair(bundle.db, a, d);
    const e = insertTxn(savingsId, "2026-07-02", 10_000, "E");
    expect(() => linkTransferPair(bundle.db, a, e)).toThrow(/already part of a transfer/);

    expect(() => linkTransferPair(bundle.db, a, a)).toThrow(/two different/);
    expect(() => linkTransferPair(bundle.db, b, "nope")).toThrow(/Unknown transaction/);
  });
});

describe("unlinkTransferGroup", () => {
  test("clears the link on every leg but keeps the category; undo relinks", () => {
    const out = insertTxn(checkingId, "2026-07-01", -20_000, "WIRE");
    const inn = insertTxn(savingsId, "2026-07-01", 20_000, "WIRE IN");
    linkTransferPair(bundle.db, out, inn);
    const catBefore = row(out).categoryId;

    const result = unlinkTransferGroup(bundle.db, out);
    expect(result.affected).toBe(2);
    expect(row(out).transferGroupId).toBeNull();
    expect(row(out).categoryId).toBe(catBefore); // no fabricated uncategorized hole

    applyUndoPatch(bundle.db, result.undo);
    expect(row(out).transferGroupId).toBe(out);
    expect(row(inn).transferGroupId).toBe(out);
  });

  test("throws on an unknown group", () => {
    expect(() => unlinkTransferGroup(bundle.db, "nope")).toThrow(/Unknown transfer group/);
  });
});

describe("transferCandidates", () => {
  test("offers opposite-signed unlinked rows from other accounts, nearest amount first", () => {
    const out = insertTxn(checkingId, "2026-07-10", -20_000, "WIRE OUT");
    insertTxn(savingsId, "2026-07-11", 19_500, "NEAR MIRROR");
    insertTxn(savingsId, "2026-07-12", 20_000, "PERFECT MIRROR");
    insertTxn(savingsId, "2026-07-11", -20_000, "SAME SIGN — excluded");
    insertTxn(checkingId, "2026-07-11", 20_000, "SAME ACCOUNT — excluded");
    insertTxn(savingsId, "2026-06-01", 20_000, "OUT OF WINDOW — excluded");

    const candidates = transferCandidates(bundle.db, out);
    expect(candidates.map((c) => c.description)).toEqual(["perfect mirror", "near mirror"]);
    expect(candidates[0]!.amountDeltaCents).toBe(0);
  });

  test("counterparts reports the other leg after linking", () => {
    const out = insertTxn(checkingId, "2026-07-01", -20_000, "WIRE");
    const inn = insertTxn(savingsId, "2026-07-02", 20_000, "WIRE IN");
    expect(transferCounterparts(bundle.db, out)).toBeNull();
    linkTransferPair(bundle.db, out, inn);
    const result = transferCounterparts(bundle.db, out)!;
    expect(result.groupId).toBe(out);
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]!.id).toBe(inn);
  });
});

describe("review-hardening regressions", () => {
  test("a zero-amount leg can never pass the sign guard", () => {
    const zero = insertTxn(checkingId, "2026-07-01", 0, "ZERO");
    const out = insertTxn(savingsId, "2026-07-01", -10_000, "OUT");
    expect(() => linkTransferPair(bundle.db, zero, out)).toThrow(/one outflow and one inflow/);
  });

  test("re-minting a group key detaches a stale counterpart left by a single-row clear", () => {
    const out = insertTxn(checkingId, "2026-07-01", -50_000, "WIRE");
    const staleIn = insertTxn(savingsId, "2026-07-01", 50_000, "OLD LEG");
    linkTransferPair(bundle.db, out, staleIn);
    // simulate the sheet's single-row Transfer-checkbox clear on the outflow
    bundle.db.update(transactions).set({ transferGroupId: null }).where(eq(transactions.id, out)).run();
    expect(row(staleIn).transferGroupId).toBe(out); // dangling

    const freshIn = insertTxn(creditId, "2026-07-02", 50_000, "NEW LEG");
    const result = linkTransferPair(bundle.db, out, freshIn);
    expect(result.affected).toBe(3); // two legs + the stale detach, all visible
    expect(row(staleIn).transferGroupId).toBeNull(); // no phantom third leg
    expect(transferCounterparts(bundle.db, out)!.legs.map((l) => l.id)).toEqual([freshIn]);

    // undo restores the stale leg's link too — lossless
    applyUndoPatch(bundle.db, result.undo);
    expect(row(staleIn).transferGroupId).toBe(out);
    expect(row(freshIn).transferGroupId).toBeNull();
  });

  test("undoing an unlink does not clobber a category edit made in between", () => {
    const out = insertTxn(checkingId, "2026-07-01", -20_000, "WIRE");
    const inn = insertTxn(savingsId, "2026-07-01", 20_000, "WIRE IN");
    linkTransferPair(bundle.db, out, inn);
    const unlink = unlinkTransferGroup(bundle.db, out);

    // the user recategorizes one leg AFTER unlinking
    const food = bundle.db.select().from(categories).where(eq(categories.name, "Food")).all()[0]!;
    bundle.db
      .update(transactions)
      .set({ categoryId: food.id, categorizationSource: "user" })
      .where(eq(transactions.id, out))
      .run();

    applyUndoPatch(bundle.db, unlink.undo);
    expect(row(out).transferGroupId).toBe(out); // link restored
    expect(row(out).categoryId).toBe(food.id); // interleaved edit intact
  });
});
