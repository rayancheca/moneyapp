import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { balanceAnchors } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { rebuildAccount } from "./derivation";
import { dashboardChartData } from "./dashboard-series";

const TODAY = "2026-07-08";

describe("dashboardChartData", () => {
  let dir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-dashseries-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function institutionId(name: string): string {
    const row = bundle.db.select().from(institutions).where(eq(institutions.name, name)).get();
    if (!row) throw new Error(`missing institution ${name}`);
    return row.id;
  }

  function anchor(accountId: string, anchoredOn: string, balanceCents: number): void {
    bundle.db.insert(balanceAnchors).values({ accountId, anchoredOn, balanceCents, source: "statement" }).run();
  }

  function txn(accountId: string, postedOn: string, amountCents: number, gid: string | null): void {
    const raw = `T-${accountId.slice(0, 4)}-${postedOn}-${amountCents}`;
    bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription: raw,
        normalizedDescription: raw,
        status: "active",
        transferGroupId: gid,
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: 0 }),
      })
      .run();
  }

  /** checking + savings with a different-day $100 transfer pair, plus a card */
  function fixture() {
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
    const card = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "Card", type: "credit" });
    anchor(a, "2026-07-01", 100_000);
    anchor(a, "2026-07-05", 90_000);
    anchor(b, "2026-07-01", 50_000);
    anchor(b, "2026-07-05", 60_000);
    anchor(card, "2026-07-01", -20_000);
    txn(a, "2026-07-02", -10_000, "g1");
    txn(b, "2026-07-04", 10_000, "g1");
    for (const id of [a, b, card]) rebuildAccount(bundle.db, id, TODAY);
    return { a, b, card };
  }

  test("assets mode bridges the transfer float; the dip disappears", () => {
    fixture();
    const data = dashboardChartData(bundle.db, "assets");
    expect(data.series).toHaveLength(1);
    const at = new Map(data.series[0]!.points.map((p) => [p.day, p] as const));
    // raw assets would dip to 140_000 on 07-02..03; bridged holds 150_000
    expect(at.get("2026-07-02")?.valueCents).toBe(150_000);
    expect(at.get("2026-07-02")?.inTransitCents).toBe(10_000);
    expect(at.get("2026-07-04")?.valueCents).toBe(150_000);
    expect(at.get("2026-07-04")?.inTransitCents).toBe(0);
  });

  test("liabilities mode is the positive owed frame and never bridges", () => {
    fixture();
    const data = dashboardChartData(bundle.db, "liabilities");
    expect(data.series).toHaveLength(1);
    const s = data.series[0]!;
    expect(s.owedFrame).toBe(true);
    const at = new Map(s.points.map((p) => [p.day, p] as const));
    expect(at.get("2026-07-02")?.valueCents).toBe(20_000);
    expect(s.points.every((p) => p.inTransitCents === 0)).toBe(true);
  });

  test("split mode returns assets (bridged) + owed (untouched)", () => {
    fixture();
    const data = dashboardChartData(bundle.db, "split");
    expect(data.series.map((s) => s.key)).toEqual(["assets", "liabilities"]);
    const assets = new Map(data.series[0]!.points.map((p) => [p.day, p] as const));
    expect(assets.get("2026-07-02")?.inTransitCents).toBe(10_000);
    expect(data.series[1]!.points.every((p) => p.inTransitCents === 0)).toBe(true);
  });

  test("accounts mode draws each selected account raw (its ledger honestly dipped)", () => {
    const { a, b } = fixture();
    const data = dashboardChartData(bundle.db, "accounts", [a, b]);
    expect(data.selectedAccountIds).toEqual([a, b]);
    expect(data.series.map((s) => s.key)).toEqual([a, b]);
    const aAt = new Map(data.series[0]!.points.map((p) => [p.day, p] as const));
    expect(aAt.get("2026-07-02")?.valueCents).toBe(90_000); // the real ledger dip stays
    expect(data.series[0]!.points.every((p) => p.inTransitCents === 0)).toBe(true);
  });

  test("accounts mode with an empty/stale selection falls back to every active account", () => {
    fixture();
    const data = dashboardChartData(bundle.db, "accounts", ["nonexistent-id"]);
    expect(data.selectedAccountIds).toEqual(data.accounts.map((o) => o.id));
    expect(data.series.length).toBe(data.accounts.length);
  });
});
