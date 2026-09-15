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
  cancelledTransfers,
  detachTransferLegs,
  detachUndoRows,
  isCancelledTransfer,
  linkTransferPair,
  staleTransferLegs,
  transferCandidates,
  transferCategoryIdFor,
  transferCategoryResolver,
  transferKindCategoryIds,
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

function categoryPathOf(categoryId: string | null): string | null {
  if (!categoryId) return null;
  const cat = bundle.db.select().from(categories).where(eq(categories.id, categoryId)).get()!;
  if (!cat.parentId) return cat.name;
  const parent = bundle.db.select().from(categories).where(eq(categories.id, cat.parentId)).get()!;
  return `${parent.name} > ${cat.name}`;
}

describe("a cancelled transfer — one group, one account, netting to zero", () => {
  const shape = (accountId: string, amountCents: number) => ({ accountId, amountCents });

  test("two legs in one account whose amounts cancel — and nothing else — is a cancelled transfer", () => {
    expect(isCancelledTransfer([shape("a", -115_00), shape("a", 115_00)])).toBe(true);
    expect(isCancelledTransfer([shape("a", 115_00), shape("a", -115_00)])).toBe(true);
    // a real transfer: the money landed somewhere else
    expect(isCancelledTransfer([shape("a", -115_00), shape("b", 115_00)])).toBe(false);
    // one account, but something stayed out: a fee, a partial return
    expect(isCancelledTransfer([shape("a", -115_00), shape("a", 100_00)])).toBe(false);
    // the same sign twice is a doubling, not a cancellation
    expect(isCancelledTransfer([shape("a", -115_00), shape("a", -115_00)])).toBe(false);
    // two zeroes move nothing, and cancel nothing either
    expect(isCancelledTransfer([shape("a", 0), shape("a", 0)])).toBe(false);
    expect(isCancelledTransfer([shape("a", -115_00)])).toBe(false);
    expect(isCancelledTransfer([shape("a", -115_00), shape("a", 115_00), shape("a", 0)])).toBe(false);
  });

  test("cancelledTransfers reads the WHOLE live group, not the caller's window, and names what came back", () => {
    const setGroup = (id: string, groupId: string) =>
      bundle.db.update(transactions).set({ transferGroupId: groupId }).where(eq(transactions.id, id)).run();
    // a payment sent on the last day of a month and returned on the first of the next
    const sent = insertTxn(checkingId, "2026-03-31", -115_00, "PAYMENT TO CARD 03/31");
    const back = insertTxn(checkingId, "2026-04-01", 115_00, "PAYMENT TO CARD CANCELLED");
    setGroup(sent, sent);
    setGroup(back, sent);
    // a superseded row still naming the group never moved money and does not break it
    const retired = insertTxn(checkingId, "2026-04-01", 5_00, "RETIRED");
    setGroup(retired, sent);
    bundle.db.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, retired)).run();
    // a real transfer beside it
    const out = insertTxn(checkingId, "2026-03-04", -50_00, "TO SAVINGS");
    const inn = insertTxn(savingsId, "2026-03-04", 50_00, "FROM CHECKING");
    setGroup(out, out);
    setGroup(inn, out);

    expect(cancelledTransfers(bundle.db, [sent, out, "no-such-group"])).toEqual(new Map([[sent, 115_00]]));
    expect(cancelledTransfers(bundle.db, [])).toEqual(new Map());

    // a third live leg joins: it is no longer two legs that cancel
    const third = insertTxn(checkingId, "2026-04-02", 1_00, "THIRD");
    setGroup(third, sent);
    expect(cancelledTransfers(bundle.db, [sent])).toEqual(new Map());
  });

  test("a leg counts when it MOVED money — excluded does, quarantined does not (the statuses balance replay reads)", () => {
    const setGroup = (id: string, groupId: string) =>
      bundle.db.update(transactions).set({ transferGroupId: groupId }).where(eq(transactions.id, id)).run();
    const setStatus = (id: string, status: "excluded" | "quarantined") =>
      bundle.db.update(transactions).set({ status }).where(eq(transactions.id, id)).run();
    const sent = insertTxn(checkingId, "2026-03-02", -115_00, "PAYMENT TO CARD 03/02");
    const back = insertTxn(checkingId, "2026-03-02", 115_00, "PAYMENT TO CARD CANCELLED");
    setGroup(sent, sent);
    setGroup(back, sent);

    // hidden from analytics by the owner's switch, but the money still came back
    setStatus(back, "excluded");
    expect(cancelledTransfers(bundle.db, [sent])).toEqual(new Map([[sent, 115_00]]));

    // a duplicate held in quarantine never moved money, so it cannot be a third leg…
    const dup = insertTxn(checkingId, "2026-03-02", 115_00, "PAYMENT TO CARD CANCELLED DUP");
    setGroup(dup, sent);
    setStatus(dup, "quarantined");
    expect(cancelledTransfers(bundle.db, [sent])).toEqual(new Map([[sent, 115_00]]));

    // …nor stand in for a return
    setStatus(back, "quarantined");
    expect(cancelledTransfers(bundle.db, [sent])).toEqual(new Map());
  });
});

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

/**
 * The two pieces every other transfer path reuses. They are exported so a bulk
 * mark, a sheet checkbox, or a row deletion all mean the same thing by
 * "transfer" instead of each inventing its own half of it.
 */
describe("transferCategoryResolver — one definition of a transfer's category", () => {
  test("credit wins, then the investment side, else an internal transfer", () => {
    const resolve = transferCategoryResolver(bundle.db);
    expect(categoryPathOf(resolve([checkingId, creditId]))).toBe("Transfers > Credit Card Payment");
    expect(categoryPathOf(resolve([creditId]))).toBe("Transfers > Credit Card Payment");
    expect(categoryPathOf(resolve([checkingId, savingsId]))).toBe("Transfers > Internal Transfer");
    // one known leg is enough — a self-group has no counterparty to consult
    expect(categoryPathOf(resolve([checkingId]))).toBe("Transfers > Internal Transfer");
  });

  test("an investment leg is a contribution, by SIDE not just type", () => {
    const brokerage = createAccount(bundle.db, {
      institutionId: createInstitution(bundle.db, "Robinhood"),
      name: "Robinhood Brokerage",
      type: "investment",
      subtype: "brokerage",
    });
    expect(categoryPathOf(transferCategoryIdFor(bundle.db, [checkingId, brokerage]))).toBe(
      "Transfers > Investment Contribution",
    );
  });

  test("transferKindCategoryIds covers every Transfers leaf and nothing else", () => {
    const ids = transferKindCategoryIds(bundle.db);
    for (const path of [
      "Transfers",
      "Transfers > Credit Card Payment",
      "Transfers > Internal Transfer",
      "Transfers > Investment Contribution",
    ]) {
      expect(ids.has(catId(path))).toBe(true);
    }
    // investment BUYS are not transfers — they must keep counting as investment
    expect(ids.has(catId("Investments > Buys"))).toBe(false);
    expect(ids.has(catId("Food"))).toBe(false);
  });

  test("the resolver a manual link uses is the resolver everything else uses", () => {
    // the pair-linker's own stamp must equal the shared resolver's answer
    const out = insertTxn(checkingId, "2026-07-01", -20_000, "WIRE");
    const inn = insertTxn(savingsId, "2026-07-01", 20_000, "WIRE IN");
    linkTransferPair(bundle.db, out, inn);
    expect(row(out).categoryId).toBe(transferCategoryIdFor(bundle.db, [checkingId, savingsId]));
  });
});

describe("staleTransferLegs / detachTransferLegs", () => {
  test("reads the legs a group no longer holds and detaches them losslessly", () => {
    const out = insertTxn(checkingId, "2026-07-01", -50_000, "WIRE");
    const inn = insertTxn(savingsId, "2026-07-01", 50_000, "WIRE IN");
    linkTransferPair(bundle.db, out, inn);

    // keeping the outflow: the counterpart is the leg that would be stranded
    const stale = staleTransferLegs(bundle.db, out, [out]);
    expect(stale).toEqual([{ id: inn, transferGroupId: out }]);

    const undo = { rows: detachUndoRows(stale) };
    detachTransferLegs(bundle.db, stale);
    expect(row(inn).transferGroupId).toBeNull();
    expect(row(out).transferGroupId).toBe(out); // the kept leg is untouched
    expect(row(inn).categoryId).not.toBeNull(); // link-only: the category stays

    applyUndoPatch(bundle.db, undo);
    expect(row(inn).transferGroupId).toBe(out);
  });

  test("with no keepIds it returns the whole group — the shape a deleted leg needs", () => {
    const out = insertTxn(checkingId, "2026-07-01", -50_000, "WIRE");
    const inn = insertTxn(savingsId, "2026-07-01", 50_000, "WIRE IN");
    linkTransferPair(bundle.db, out, inn);
    expect(staleTransferLegs(bundle.db, out).map((l) => l.id).sort()).toEqual([out, inn].sort());
  });

  test("a superseded row is never detached, and an unknown group yields nothing", () => {
    const out = insertTxn(checkingId, "2026-07-01", -50_000, "WIRE");
    const inn = insertTxn(savingsId, "2026-07-01", 50_000, "WIRE IN");
    linkTransferPair(bundle.db, out, inn);
    // a retired duplicate pointing at the same group must stay out of the read
    bundle.db.update(transactions).set({ status: "superseded" }).where(eq(transactions.id, inn)).run();
    expect(staleTransferLegs(bundle.db, out, [out])).toEqual([]);
    expect(staleTransferLegs(bundle.db, "no-such-group")).toEqual([]);
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
