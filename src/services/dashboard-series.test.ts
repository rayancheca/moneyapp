import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
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

  function basisOn(accountId: string, day: string): string | undefined {
    return bundle.db
      .select({ basis: dailyBalances.basis })
      .from(dailyBalances)
      .where(and(eq(dailyBalances.accountId, accountId), eq(dailyBalances.day, day)))
      .get()?.basis;
  }

  /**
   * 🔴 A stored `carried` day on a cash or credit account means nothing posted
   * since its recorded balance — `basisIsChecked` calls it checked, and so do
   * provenance and the trust card. This service kept `{anchored, derived}` and
   * drew every such day broken: on the owner's ledger (2026-09-15) the Owed line
   * went dashed Sep 3 – 15 over Chase Sapphire's untouched Sep 2 statement
   * balance, and the terrain counted 118 broken spans where 76 are.
   */
  test("a carried day on a cash or credit account draws solid, in a rollup and on its own line", () => {
    const { a, card } = fixture();
    // not green for the wrong reason: these days really are stored `carried`
    expect(basisOn(card, "2026-07-03")).toBe("carried");
    expect(basisOn(a, "2026-07-07")).toBe("carried");

    const owed = dashboardChartData(bundle.db, "liabilities").series[0]!;
    expect(owed.points.filter((p) => p.day >= "2026-07-01").every((p) => p.complete)).toBe(true);

    const [aLine, cardLine] = dashboardChartData(bundle.db, "accounts", [a, card]).series;
    expect(aLine!.points.find((p) => p.day === "2026-07-07")?.complete).toBe(true);
    expect(cardLine!.points.find((p) => p.day === "2026-07-03")?.complete).toBe(true);
  });

  test("a replay nobody checks still draws dashed", () => {
    const { a } = fixture();
    txn(a, "2026-07-06", -500, null);
    rebuildAccount(bundle.db, a, TODAY);
    expect(basisOn(a, "2026-07-06")).toBe("derived_unverified");

    const aLine = dashboardChartData(bundle.db, "accounts", [a]).series[0]!;
    expect(aLine.points.find((p) => p.day === "2026-07-06")?.complete).toBe(false);
  });

  /**
   * ⛔ An investment account's `carried` is a carried PRICE (or a recorded value
   * held flat across a moving market), not a balance nothing moved.
   */
  test("an investment account's carried day stays dashed", () => {
    const inv = createAccount(bundle.db, { institutionId: institutionId("Robinhood"), name: "Brokerage", type: "investment" });
    anchor(inv, "2026-07-01", 500_000);
    rebuildAccount(bundle.db, inv, TODAY);
    expect(basisOn(inv, "2026-07-01")).toBe("anchored");
    expect(basisOn(inv, "2026-07-03")).toBe("carried");

    const line = dashboardChartData(bundle.db, "accounts", [inv]).series[0]!;
    expect(line.points.find((p) => p.day === "2026-07-01")?.complete).toBe(true);
    expect(line.points.find((p) => p.day === "2026-07-03")?.complete).toBe(false);
    const assets = dashboardChartData(bundle.db, "assets").series[0]!;
    expect(assets.points.find((p) => p.day === "2026-07-03")?.complete).toBe(false);
  });
});
