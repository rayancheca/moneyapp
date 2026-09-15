import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "@/services/accounts";
import {
  REAL_IDS,
  ReversalRefusal,
  applyReversal,
  classifyReversal,
  compareReversal,
  loadFacts,
  parseReversalCli,
  rehearseReversal,
  type ReversalIds,
  type ReversalState,
} from "./checking-115-reversal";
import { DbTargetRefusal } from "./db-target";

/**
 * A seeded ledger shaped like Chase Checking on 2026-03-02 once answer (1) has
 * run: the −$115.00 that paid the card, linked to Sapphire; the −$115.00 that
 * was cancelled; the +$115.00 "…Cancelled". The ids are the tests' own — only
 * the SHAPE is the live ledger's.
 */

let dir: string;
let bundle: DbBundle;
let ids: ReversalIds;

interface Row {
  id: string;
  accountId: string;
  amountCents: number;
  raw: string;
  postedOn?: string;
  occurrence?: number;
  group?: string | null;
  categoryId?: string | null;
  source?: "claude" | "transfer_detect" | null;
}

function insert(row: Row): void {
  const postedOn = row.postedOn ?? ids.day;
  const occurrenceIndex = row.occurrence ?? 0;
  bundle.db
    .insert(transactions)
    .values({
      id: row.id,
      accountId: row.accountId,
      postedOn,
      amountCents: row.amountCents,
      rawDescription: row.raw,
      normalizedDescription: row.raw.toUpperCase(),
      categoryId: row.categoryId === undefined ? ids.creditCardPaymentId : row.categoryId,
      categorizationSource: row.source === undefined ? "claude" : row.source,
      transferGroupId: row.group ?? null,
      occurrenceIndex,
      status: "active",
      dedupeHash: dedupeHash({ accountId: row.accountId, postedOn, amountCents: row.amountCents, rawDescription: row.raw, occurrenceIndex }),
    })
    .run();
}

function setGroup(id: string, group: string | null): void {
  bundle.db.update(transactions).set({ transferGroupId: group }).where(eq(transactions.id, id)).run();
}

const verdict = () => classifyReversal(loadFacts(bundle, ids), ids);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-reversal-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const inst = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  const checking = createAccount(bundle.db, { institutionId: inst.id, name: "Chase Checking", type: "checking" });
  const sapphire = createAccount(bundle.db, { institutionId: inst.id, name: "Chase Sapphire", type: "credit" });
  const transfersTop = bundle.db.select().from(categories).where(and(eq(categories.name, "Transfers"), isNull(categories.parentId))).get()!;
  const cardPayment = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Credit Card Payment"), eq(categories.parentId, transfersTop.id)))
    .get()!;
  ids = {
    ...REAL_IDS,
    checkingAccountId: checking,
    creditCardPaymentId: cardPayment.id,
    sentId: "sent",
    cancelledId: "cancelled",
    paidId: "paid",
    paidSapphireId: "sapphire-paid",
  };
  // the card's window floors at the first month the ledger covers in full
  insert({ id: "opens", accountId: checking, postedOn: "2025-01-01", amountCents: -1, raw: "LEDGER OPENS", categoryId: null, source: null });
  insert({ id: "paid", accountId: checking, amountCents: -11_500, raw: REAL_IDS.sentDescription, occurrence: 1, group: "paid" });
  insert({ id: "sapphire-paid", accountId: sapphire, amountCents: 11_500, raw: "PAYMENT — Chase ····3522", group: "paid", source: "transfer_detect" });
  insert({ id: "sent", accountId: checking, amountCents: -11_500, raw: REAL_IDS.sentDescription });
  insert({ id: "cancelled", accountId: checking, amountCents: 11_500, raw: REAL_IDS.cancelledDescription });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the two answers never claim the same row", () => {
  test("answer (1)'s script pairs the OTHER −$115.00, and pins these two legs as the rows it leaves alone", () => {
    const link = fs.readFileSync(path.join(process.cwd(), "scripts", "link-sapphire-one-leg-groups-2026-09-15.ts"), "utf8");
    expect(link).toContain(`sapphireId: "${REAL_IDS.paidSapphireId}", checkingId: "${REAL_IDS.paidId}"`);
    expect(link).toContain(`UNTOUCHED_IDS = ["${REAL_IDS.sentId}", "${REAL_IDS.cancelledId}"]`);
    expect(new Set([REAL_IDS.sentId, REAL_IDS.cancelledId, REAL_IDS.paidId]).size).toBe(3);
  });
});

describe("the plan", () => {
  test("the measured state plans the write, and the written state is ALREADY APPLIED", () => {
    expect(verdict()).toEqual({ kind: "plan" });
    applyReversal(bundle, ids);
    expect(verdict()).toEqual({ kind: "applied" });
  });

  test("refuses until answer (1) has linked the other −$115.00 to Sapphire", () => {
    setGroup("paid", null);
    const v = verdict();
    expect(v.kind).toBe("refuse");
    expect(JSON.stringify(v)).toContain("run scripts/link-sapphire-one-leg-groups-2026-09-15.ts first");
  });

  test.each([
    ["the sent leg's amount", "sent", { amountCents: -11_400 }],
    ["the sent leg's day", "sent", { postedOn: "2026-03-03" }],
    ["the sent leg's status", "sent", { status: "excluded" as const }],
    ["the Cancelled leg's category", "cancelled", { categoryId: null }],
    ["the Cancelled leg's source — someone re-filed it by hand", "cancelled", { categorizationSource: "user" as const }],
    ["the Cancelled leg's text", "cancelled", { rawDescription: "Payment to Chase card ending in 9805 03/02" }],
  ])("refuses when %s is not as measured", (_name, id, patch) => {
    bundle.db.update(transactions).set(patch).where(eq(transactions.id, id)).run();
    expect(verdict().kind).toBe("refuse");
  });

  test("refuses a half-written group, and a group that picked up a third row", () => {
    setGroup("sent", "sent");
    expect(verdict().kind).toBe("refuse");
    setGroup("cancelled", "sent");
    expect(verdict().kind).toBe("applied");
    insert({ id: "stray", accountId: ids.checkingAccountId, postedOn: "2026-03-05", amountCents: 1, raw: "STRAY", group: "sent" });
    expect(verdict().kind).toBe("refuse");
  });

  test("refuses the same pair keyed by the Cancelled leg — the outflow keys a group", () => {
    setGroup("sent", "cancelled");
    setGroup("cancelled", "cancelled");
    expect(verdict().kind).toBe("refuse");
  });
});

describe("the write and its guards", () => {
  test("rehearsed: every guard holds, and the card and /flow move exactly as the owner asked", () => {
    const { failures, before, after } = rehearseReversal(bundle, ids);
    expect(failures).toEqual([]);
    expect(after.figures.arrivalCount).toBe(before.figures.arrivalCount - 1);
    expect(after.figures.arrivalCents).toBe(before.figures.arrivalCents - 11_500);
    expect(after.figures.movedCents).toBe(before.figures.movedCents - 11_500);
    expect(after.figures.unpairedCount).toBe(before.figures.unpairedCount - 1);
    expect(after.figures.linkedCents).toBe(before.figures.linkedCents);
    expect(after.figures.strandedCents).toBe(before.figures.strandedCents);
    expect(after.figures.cancelledCount).toBe(before.figures.cancelledCount + 1);
    expect(after.figures.flowReasons.cancelled).toBe(1);
    expect(after.figures.flowReasons["same-account"]).toBe(0);
    expect([after.groups.get("sent"), after.groups.get("cancelled")]).toEqual(["sent", "sent"]);
    expect(after.oneAccountGroups).toBe(before.oneAccountGroups + 1);
  });

  test("links only rows that are still unlinked, and rolls back whole when it cannot link both", () => {
    setGroup("cancelled", "elsewhere");
    expect(() => applyReversal(bundle, ids)).toThrow(/linked 1/);
    const sent = bundle.db.select().from(transactions).where(eq(transactions.id, "sent")).get()!;
    expect(sent.transferGroupId).toBeNull();
  });

  describe("each guard can fail", () => {
    let before: ReversalState;
    let after: ReversalState;
    beforeEach(() => {
      ({ before, after } = rehearseReversal(bundle, ids));
    });

    const tampered: [string, (s: ReversalState) => ReversalState, RegExp][] = [
      ["a balance day moved", (s) => ({ ...s, balances: "moved" }), /daily_balances moved/],
      ["net worth moved", (s) => ({ ...s, netWorth: "moved" }), /net worth on every day moved/],
      ["the active sum moved", (s) => ({ ...s, active: { ...s.active, cents: s.active.cents + 1 } }), /active rows \(count and sum\) moved/],
      ["an account's active rows moved", (s) => ({ ...s, activeByAccount: "moved" }), /active rows per account moved/],
      ["a status count moved", (s) => ({ ...s, statusCounts: "moved" }), /status counts moved/],
      ["a statement period moved", (s) => ({ ...s, statementPeriods: "moved" }), /statement periods moved/],
      ["a column beside the group changed", (s) => ({ ...s, besideGroup: new Map([...s.besideGroup, ["sent", "re-filed"]]) }), /other than the group/],
      ["a third row joined the group", (s) => ({ ...s, groups: new Map([...s.groups, ["opens", "sent"]]) }), /the group moved on/],
      ["a one-leg group appeared", (s) => ({ ...s, oneLegGroups: s.oneLegGroups + 1 }), /one-leg groups moved/],
      ["no one-account group appeared", (s) => ({ ...s, oneAccountGroups: s.oneAccountGroups - 1 }), /one-account groups/],
      ["the arrival did not clear", (s) => ({ ...s, figures: { ...s.figures, arrivalCount: s.figures.arrivalCount + 1 } }), /transfers arrivalCount/],
      ["the card read the link as stranded", (s) => ({ ...s, figures: { ...s.figures, strandedCents: s.figures.strandedCents + 11_500 } }), /transfers strandedCents/],
      ["the card counted it as linked", (s) => ({ ...s, figures: { ...s.figures, linkedCount: s.figures.linkedCount + 1 } }), /transfers linkedCount/],
      [
        "/flow called it a pairing gap",
        (s) => ({ ...s, figures: { ...s.figures, flowReasons: { ...s.figures.flowReasons, cancelled: 0, "same-account": 1 } } }),
        /transfers flowReasons/,
      ],
    ];

    test.each(tampered)("%s", (_name, tamper, message) => {
      expect(compareReversal(before, after, ids)).toEqual([]);
      expect(compareReversal(before, tamper(after), ids).join("\n")).toMatch(message);
    });
  });
});

describe("the command line", () => {
  const env = {
    cwd: "/repo",
    exists: (p: string) => p === "/repo/copy.db" || p === "/scratch" || p === os.tmpdir(),
  };

  test("requires --db and never guesses a database", () => {
    expect(() => parseReversalCli([], env)).toThrow(DbTargetRefusal);
    expect(() => parseReversalCli(["--db=missing.db"], env)).toThrow(DbTargetRefusal);
  });

  test("refuses a flag it does not know, and a bare argument", () => {
    expect(() => parseReversalCli(["--db=copy.db", "--dry-run"], env)).toThrow(ReversalRefusal);
    expect(() => parseReversalCli(["--db=copy.db", "copy.db"], env)).toThrow(ReversalRefusal);
  });

  test("reads --db, --confirm and --scratch; a dry run is the default", () => {
    expect(parseReversalCli(["--db=copy.db", "--confirm", "--scratch=/scratch"], env)).toEqual({
      dbPath: "/repo/copy.db",
      confirm: true,
      scratch: "/scratch",
    });
    expect(parseReversalCli(["--db=copy.db"], env)).toEqual({ dbPath: "/repo/copy.db", confirm: false, scratch: os.tmpdir() });
  });

  test("refuses a scratch directory that is not there", () => {
    expect(() => parseReversalCli(["--db=copy.db", "--scratch=/nope"], env)).toThrow(/no scratch directory/);
  });
});
