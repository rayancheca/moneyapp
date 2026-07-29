import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase, type DbBundle } from "@/db/client";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { transferFlow } from "./transfer-flow";

const RANGE = { from: "2020-01-01", to: "2030-12-31" };

let dir: string;
let bundle: DbBundle;
let A: string;
let B: string;
let C: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-transfer-flow-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const inst = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  A = createAccount(bundle.db, { institutionId: inst.id, name: "Alpha Checking", type: "checking" });
  B = createAccount(bundle.db, { institutionId: inst.id, name: "Bravo Savings", type: "savings" });
  C = createAccount(bundle.db, { institutionId: inst.id, name: "Charlie Card", type: "credit" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function leg(accountId: string, postedOn: string, amountCents: number, groupId: string | null): void {
  seq += 1;
  const raw = `LEG ${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription: raw,
      normalizedDescription: raw,
      transferGroupId: groupId,
      status: "active",
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: seq }),
    })
    .run();
}

/** one clean paired transfer: `cents` leaves `from` and arrives at `to` */
function transfer(from: string, to: string, postedOn: string, cents: number, groupId: string): void {
  leg(from, postedOn, -cents, groupId);
  leg(to, postedOn, cents, groupId);
}

const flow = () => transferFlow(bundle.db, RANGE);

describe("edges", () => {
  test("a paired group becomes one directed edge keyed by the outflow leg", () => {
    transfer(A, B, "2026-03-04", 25_00, "g1");
    const data = flow();

    expect(data.edges).toHaveLength(1);
    expect(data.edges[0]).toMatchObject({
      id: `${A}>${B}`,
      fromAccountId: A,
      toAccountId: B,
      cents: 25_00,
      count: 1,
    });
    expect(data.totals.pairedGroupCount).toBe(1);
    expect(data.totals.unattributedGroupCount).toBe(0);
  });

  test("the OUTFLOW magnitude sets the edge, so a receiving-side fee cannot inflate it", () => {
    // $100 leaves A; only $97 lands in B (a $3 wire fee taken by the bank).
    leg(A, "2026-03-04", -100_00, "g1");
    leg(B, "2026-03-04", 97_00, "g1");

    expect(flow().edges[0]!.cents).toBe(100_00);
  });

  test("edges sort by cents DESC, ties broken by id", () => {
    transfer(A, B, "2026-03-04", 10_00, "g1");
    transfer(A, C, "2026-03-05", 90_00, "g2");
    transfer(B, C, "2026-03-06", 90_00, "g3");

    const ids = flow().edges.map((e) => e.id);
    expect(ids[0]).toBe([`${A}>${C}`, `${B}>${C}`].sort()[0]);
    expect(flow().edges.map((e) => e.cents)).toEqual([90_00, 90_00, 10_00]);
  });
});

describe("reconciliation — nothing is ever silently dropped", () => {
  test("a single-leg group is unattributed, not discarded", () => {
    leg(A, "2026-03-04", 42_00, "orphan");
    const t = flow().totals;

    expect(t.groupCount).toBe(1);
    expect(t.pairedGroupCount).toBe(0);
    expect(t.unattributedGroupCount).toBe(1);
    expect(t.unattributedCents).toBe(42_00);
    expect(t.unattributedByReason["single-leg"]).toBe(1);
  });

  test("a three-leg group is unattributed as multi-leg", () => {
    leg(A, "2026-03-04", -50_00, "g1");
    leg(B, "2026-03-04", 25_00, "g1");
    leg(C, "2026-03-04", 25_00, "g1");

    const data = flow();
    expect(data.totals.unattributedByReason["multi-leg"]).toBe(1);
    expect(data.totals.unattributedCents).toBe(100_00);
    // a 1→2 fan-out must not become two half-edges
    expect(data.edges).toHaveLength(0);
  });

  test("a group whose legs sit in ONE account is unattributed, never a self-edge", () => {
    leg(A, "2026-03-04", -50_00, "g1");
    leg(A, "2026-03-04", 50_00, "g1");

    const data = flow();
    expect(data.edges).toHaveLength(0);
    expect(data.totals.unattributedByReason["same-account"]).toBe(1);
  });

  test("paired + unattributed always accounts for EVERY group in range", () => {
    transfer(A, B, "2026-03-04", 25_00, "g1");
    transfer(B, C, "2026-04-04", 15_00, "g2");
    leg(A, "2026-05-04", 9_00, "orphan1");
    leg(C, "2026-06-04", -4_00, "orphan2");

    const t = flow().totals;
    expect(t.pairedGroupCount + t.unattributedGroupCount).toBe(t.groupCount);
    expect(t.groupCount).toBe(4);
  });

  test("rows with no transfer_group_id are ignored entirely", () => {
    leg(A, "2026-03-04", -500_00, null);
    transfer(A, B, "2026-03-04", 25_00, "g1");

    expect(flow().totals.grossCents).toBe(25_00);
    expect(flow().totals.groupCount).toBe(1);
  });
});

describe("net, gross and churn", () => {
  test("net keeps the winning direction and folds the pair", () => {
    transfer(A, B, "2026-03-04", 100_00, "g1");
    transfer(B, A, "2026-03-10", 40_00, "g2");

    const data = flow();
    expect(data.edges).toHaveLength(2);
    expect(data.netEdges).toHaveLength(1);
    expect(data.netEdges[0]).toMatchObject({
      fromAccountId: A,
      toAccountId: B,
      cents: 60_00,
      returnedCents: 40_00,
    });
  });

  test("netting money does NOT net away the events — count is the sum of both directions", () => {
    transfer(A, B, "2026-03-04", 100_00, "g1");
    transfer(B, A, "2026-03-10", 40_00, "g2");
    transfer(B, A, "2026-03-11", 10_00, "g3");

    expect(flow().netEdges[0]!.count).toBe(3);
  });

  test("churn is gross − net AND 2 × Σ min(A→B, B→A) — the two agree", () => {
    transfer(A, B, "2026-03-04", 100_00, "g1");
    transfer(B, A, "2026-03-10", 40_00, "g2");
    transfer(A, C, "2026-03-11", 7_00, "g3"); // unidirectional: contributes no churn

    const t = flow().totals;
    expect(t.grossCents).toBe(147_00);
    expect(t.netCents).toBe(67_00); // 60 + 7
    expect(t.churnCents).toBe(80_00); // 2 × min(100, 40)
    expect(t.churnCents).toBe(t.grossCents - t.netCents);
  });

  test("a perfectly balanced pair leaves the net view but still counts as churn", () => {
    transfer(A, B, "2026-03-04", 50_00, "g1");
    transfer(B, A, "2026-03-10", 50_00, "g2");

    const data = flow();
    expect(data.netEdges).toHaveLength(0);
    expect(data.totals.netCents).toBe(0);
    expect(data.totals.churnCents).toBe(100_00);
    expect(data.totals.grossCents).toBe(100_00);
  });

  test("all-unidirectional means net === gross and zero churn", () => {
    transfer(A, B, "2026-03-04", 30_00, "g1");
    transfer(B, C, "2026-03-05", 20_00, "g2");

    const t = flow().totals;
    expect(t.churnCents).toBe(0);
    expect(t.netCents).toBe(t.grossCents);
  });
});

describe("accounts", () => {
  test("net positions ALWAYS sum to zero", () => {
    transfer(A, B, "2026-03-04", 100_00, "g1");
    transfer(B, C, "2026-03-05", 30_00, "g2");
    transfer(C, A, "2026-03-06", 11_00, "g3");

    const sum = flow().accounts.reduce((s, a) => s + a.netCents, 0);
    expect(sum).toBe(0);
  });

  test("ordered source → sink by net position", () => {
    transfer(A, B, "2026-03-04", 100_00, "g1"); // A is the source, B the sink
    const accounts = flow().accounts;
    const first = accounts[0]!;
    const last = accounts[accounts.length - 1]!;

    expect(first.id).toBe(A);
    expect(first.netCents).toBe(-100_00);
    expect(last.id).toBe(B);
    expect(last.netCents).toBe(100_00);
  });

  test("in/out per account match the edges", () => {
    transfer(A, B, "2026-03-04", 100_00, "g1");
    transfer(C, B, "2026-03-05", 25_00, "g2");

    const b = flow().accounts.find((a) => a.id === B)!;
    expect(b.inCents).toBe(125_00);
    expect(b.outCents).toBe(0);
  });

  test("only accounts that actually transferred appear", () => {
    transfer(A, B, "2026-03-04", 100_00, "g1");
    expect(flow().accounts.map((a) => a.id).sort()).toEqual([A, B].sort());
  });

  test("an account keeps its colour when the date window narrows", () => {
    transfer(A, B, "2026-03-04", 100_00, "g1");
    transfer(A, B, "2026-09-04", 100_00, "g2");

    const wide = transferFlow(bundle.db, RANGE).accounts.find((a) => a.id === A)!;
    const narrow = transferFlow(bundle.db, { from: "2026-09-01", to: "2026-09-30" }).accounts.find(
      (a) => a.id === A,
    )!;
    expect(narrow.color).toBe(wide.color);
  });
});

describe("months", () => {
  test("the span is gap-free even when a middle month has no transfers", () => {
    transfer(A, B, "2026-01-15", 10_00, "g1");
    transfer(A, B, "2026-04-15", 10_00, "g2");

    expect(flow().months).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
  });

  test("the span crosses a year boundary correctly", () => {
    transfer(A, B, "2025-11-15", 10_00, "g1");
    transfer(A, B, "2026-02-15", 10_00, "g2");

    expect(flow().months).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  test("per-month buckets are index-aligned and sum back to the edge totals", () => {
    transfer(A, B, "2026-01-15", 10_00, "g1");
    transfer(A, B, "2026-01-20", 5_00, "g2");
    transfer(A, B, "2026-03-15", 7_00, "g3");

    const data = flow();
    const e = data.edges[0]!;
    expect(e.monthCents).toHaveLength(data.months.length);
    expect(e.monthCents.reduce((s, v) => s + v, 0)).toBe(e.cents);
    expect(e.monthCounts.reduce((s, v) => s + v, 0)).toBe(e.count);
    expect(e.monthCents[0]).toBe(15_00);
    expect(e.monthCents[2]).toBe(7_00);
  });

  test("the range clips what is counted", () => {
    transfer(A, B, "2026-01-15", 10_00, "g1");
    transfer(A, B, "2026-06-15", 99_00, "g2");

    const clipped = transferFlow(bundle.db, { from: "2026-06-01", to: "2026-06-30" });
    expect(clipped.totals.grossCents).toBe(99_00);
    expect(clipped.months).toEqual(["2026-06"]);
  });
});

describe("degenerate states", () => {
  test("no transfers at all yields an empty, still-conserving shape", () => {
    const data = flow();
    expect(data.edges).toEqual([]);
    expect(data.netEdges).toEqual([]);
    expect(data.accounts).toEqual([]);
    expect(data.months).toEqual([]);
    expect(data.totals.grossCents).toBe(0);
    expect(data.totals.churnCents).toBe(0);
    expect(data.totals.groupCount).toBe(0);
  });

  test("a single edge: net equals gross and churn is zero, not hidden", () => {
    transfer(A, B, "2026-03-04", 100_00, "g1");
    const t = flow().totals;
    expect(t.netCents).toBe(t.grossCents);
    expect(t.churnCents).toBe(0);
  });
});
