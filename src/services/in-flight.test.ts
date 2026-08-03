import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { transactions, type TransactionStatus } from "@/db/schema/transactions";
import { compareDates } from "@/lib/dates";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { rebuildAccount, netWorthSeries } from "./derivation";
import { bridgedNetWorthSeries, latestBridgedNetWorthCents, transferFloats } from "./in-flight";

const TODAY = "2026-07-08";

describe("transferFloats + bridgedNetWorthSeries", () => {
  let dir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-inflight-"));
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

  function txn(
    accountId: string,
    postedOn: string,
    amountCents: number,
    transferGroupId: string | null,
    status: TransactionStatus = "active",
  ): void {
    const rawDescription = `T-${accountId.slice(0, 4)}-${postedOn}-${amountCents}`;
    bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription,
        normalizedDescription: rawDescription,
        status,
        transferGroupId,
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription, occurrenceIndex: 0 }),
      })
      .run();
  }

  /** Two checking accounts with statement-closed curves around a paired transfer. */
  function pairFixture(opts: { outPostedOn: string; inPostedOn: string; gid?: string }) {
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
    anchor(a, "2026-07-01", 100_000);
    anchor(a, "2026-07-05", 90_000);
    anchor(b, "2026-07-01", 50_000);
    anchor(b, "2026-07-05", 60_000);
    txn(a, opts.outPostedOn, -10_000, opts.gid ?? "g1");
    txn(b, opts.inPostedOn, 10_000, opts.gid ?? "g1");
    rebuildAccount(bundle.db, a, TODAY);
    rebuildAccount(bundle.db, b, TODAY);
    return { a, b };
  }

  test("same-day pair -> no float (both ledgers restate together)", () => {
    pairFixture({ outPostedOn: "2026-07-03", inPostedOn: "2026-07-03" });
    expect(transferFloats(bundle.db)).toEqual([]);
  });

  test("out posts before in -> a 'missing' float bridges the dip", () => {
    const { a, b } = pairFixture({ outPostedOn: "2026-07-02", inPostedOn: "2026-07-04" });

    const floats = transferFloats(bundle.db);
    expect(floats).toHaveLength(1);
    expect(floats[0]).toMatchObject({
      kind: "missing",
      outAccountId: a,
      inAccountId: b,
      amountCents: 10_000,
      startDay: "2026-07-02",
      endDay: "2026-07-04",
      deltaCents: 10_000,
    });

    // raw series dips on the float days; the bridged series holds flat
    const raw = netWorthSeries(bundle.db);
    expect(raw.find((p) => p.day === "2026-07-02")?.totalCents).toBe(140_000);
    const bridged = bridgedNetWorthSeries(bundle.db);
    for (const day of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]) {
      expect(bridged.find((p) => p.day === day)?.totalCents).toBe(150_000);
    }
    expect(bridged.find((p) => p.day === "2026-07-02")?.inTransitCents).toBe(10_000);
    expect(bridged.find((p) => p.day === "2026-07-04")?.inTransitCents).toBe(0);
  });

  test("in credited before out posts -> a 'doubled' float removes the spike", () => {
    pairFixture({ outPostedOn: "2026-07-04", inPostedOn: "2026-07-02" });

    const floats = transferFloats(bundle.db);
    expect(floats).toHaveLength(1);
    expect(floats[0]).toMatchObject({
      kind: "doubled",
      startDay: "2026-07-02",
      endDay: "2026-07-04",
      deltaCents: -10_000,
    });

    const raw = netWorthSeries(bundle.db);
    expect(raw.find((p) => p.day === "2026-07-02")?.totalCents).toBe(160_000);
    const bridged = bridgedNetWorthSeries(bundle.db);
    for (const day of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]) {
      expect(bridged.find((p) => p.day === day)?.totalCents).toBe(150_000);
    }
    expect(bridged.find((p) => p.day === "2026-07-03")?.inTransitCents).toBe(-10_000);
  });

  test("bridged points preserve the NetWorthPoint annotations", () => {
    pairFixture({ outPostedOn: "2026-07-02", inPostedOn: "2026-07-04" });
    const p = bridgedNetWorthSeries(bundle.db).find((x) => x.day === "2026-07-02")!;
    expect(p.complete).toBe(true);
    expect(p.coveredAccounts).toBeGreaterThan(0);
    expect(p.coveredAccountNames.length).toBe(p.coveredAccounts);
  });

  test("a pair touching an investment account is never a float (no cash replay there)", () => {
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    const inv = createAccount(bundle.db, {
      institutionId: institutionId("Robinhood"),
      name: "Inv",
      type: "investment",
    });
    anchor(a, "2026-07-01", 100_000);
    anchor(inv, "2026-07-01", 500_000);
    txn(a, "2026-07-02", -10_000, "g1");
    txn(inv, "2026-07-04", 10_000, "g1");
    rebuildAccount(bundle.db, a, TODAY);
    rebuildAccount(bundle.db, inv, TODAY);
    expect(transferFloats(bundle.db)).toEqual([]);
  });

  test("a pair touching an inactive account is never a float (outside the visible universe)", () => {
    const { b } = pairFixture({ outPostedOn: "2026-07-02", inPostedOn: "2026-07-04" });
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, b)).run();
    expect(transferFloats(bundle.db)).toEqual([]);
  });

  test("legs on the same account (a pass-through) are never a float", () => {
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    anchor(a, "2026-07-01", 100_000);
    txn(a, "2026-07-02", 10_000, "g1");
    txn(a, "2026-07-03", -10_000, "g1");
    rebuildAccount(bundle.db, a, TODAY);
    expect(transferFloats(bundle.db)).toEqual([]);
  });

  test("groups with more or fewer than two usable legs are skipped", () => {
    const { a, b } = pairFixture({ outPostedOn: "2026-07-02", inPostedOn: "2026-07-04", gid: "g3" });
    // third leg joins g3 -> no longer a clean pair
    txn(a, "2026-07-03", -1_000, "g3");
    rebuildAccount(bundle.db, a, TODAY);
    rebuildAccount(bundle.db, b, TODAY);
    expect(transferFloats(bundle.db)).toEqual([]);
  });

  test("a quarantined leg drops out, leaving a single-leg group -> skipped", () => {
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
    anchor(a, "2026-07-01", 100_000);
    anchor(b, "2026-07-01", 50_000);
    txn(a, "2026-07-02", -10_000, "g1");
    txn(b, "2026-07-04", 10_000, "g1", "quarantined");
    rebuildAccount(bundle.db, a, TODAY);
    rebuildAccount(bundle.db, b, TODAY);
    expect(transferFloats(bundle.db)).toEqual([]);
  });

  test("fee-bearing pair bridges the smaller magnitude, never over-stating", () => {
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
    anchor(a, "2026-07-01", 100_000);
    anchor(b, "2026-07-01", 50_000);
    txn(a, "2026-07-02", -10_050, "g1"); // $100.50 left (fee absorbed)
    txn(b, "2026-07-04", 10_000, "g1"); // $100.00 arrived
    rebuildAccount(bundle.db, a, TODAY);
    rebuildAccount(bundle.db, b, TODAY);
    const floats = transferFloats(bundle.db);
    expect(floats).toHaveLength(1);
    expect(floats[0]!.amountCents).toBe(10_000);
  });

  test("a gap-basis sender span suppresses the correction — the raw total already counts the money once", () => {
    // adversarial-review regression (2026-07-18): the sender's statement chain
    // fails to close, so its whole span is basis 'gap' — invisible to
    // netWorthSeries (the day is flagged partial). The receiver's early credit
    // is then the ONLY visible copy; subtracting a "double-count" would dig
    // the partial day's dip deeper.
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
    anchor(a, "2026-07-01", 100_000);
    anchor(a, "2026-07-06", 95_001); // off by 1c from replay -> interior span is 'gap'
    anchor(b, "2026-07-01", 50_000);
    anchor(b, "2026-07-06", 55_000);
    txn(a, "2026-07-04", -5_000, "g1"); // out posts AFTER the in leg (doubled shape)
    txn(b, "2026-07-02", 5_000, "g1");
    rebuildAccount(bundle.db, a, TODAY);
    rebuildAccount(bundle.db, b, TODAY);

    // sanity: the span really derived as gap
    const gapDays = bundle.db
      .select()
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, a))
      .all()
      .filter((r) => r.basis === "gap");
    expect(gapDays.length).toBeGreaterThan(0);

    expect(transferFloats(bundle.db)).toEqual([]);
  });

  test("an anchor-less sender (no curve at all) never yields a doubled float — real money is not hidden", () => {
    // adversarial-review regression (2026-07-18): the sender has transactions
    // but zero balance anchors, so it contributes nothing to the total on any
    // day. The receiver's credit is first-time visibility, not a double-count.
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "NoAnchors", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
    anchor(b, "2026-07-01", 50_000);
    txn(a, "2026-07-03", -10_000, "g1");
    txn(b, "2026-07-01", 10_000, "g1"); // credited before the sender's posting
    rebuildAccount(bundle.db, a, TODAY);
    rebuildAccount(bundle.db, b, TODAY);
    expect(transferFloats(bundle.db)).toEqual([]);
  });

  test("receiver whose coverage never restates the arrival -> open-ended window to the series end", () => {
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
    anchor(a, "2026-07-01", 100_000);
    anchor(b, "2026-06-01", 50_000); // B's coverage is stale — nothing after Jun 1
    txn(a, "2026-07-02", -10_000, "g1");
    txn(b, "2026-07-20", 10_000, "g1"); // posted date past B's replayed span AND past today
    rebuildAccount(bundle.db, a, TODAY);
    // B deliberately NOT rebuilt past its stale anchor: wipe rows after Jun 1
    rebuildAccount(bundle.db, b, "2026-06-01");

    const floats = transferFloats(bundle.db);
    expect(floats).toHaveLength(1);
    expect(floats[0]).toMatchObject({ kind: "missing", startDay: "2026-07-02", endDay: null });

    const bridged = bridgedNetWorthSeries(bundle.db);
    const last = bridged.at(-1)!;
    expect(last.inTransitCents).toBe(10_000);
  });

  /**
   * latestBridgedNetWorthCents skips the series entirely, so every one of these
   * asserts BOTH the invariant (it equals the last point) and the literal cents
   * — a purely relative assertion would pass if both sides broke together.
   *
   * Each shape is one that a wrong-but-plausible implementation actually fails:
   * these are the four an adversarial sweep found among 5,400 randomized DBs.
   */
  describe("latestBridgedNetWorthCents", () => {
    function bothWays(): { cheap: number; fromSeries: number } {
      return {
        cheap: latestBridgedNetWorthCents(bundle.db),
        fromSeries: bridgedNetWorthSeries(bundle.db).at(-1)?.totalCents ?? 0,
      };
    }

    test("carry-forward: an account whose last statement is stale still counts", () => {
      const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
      const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
      anchor(a, "2026-07-01", 100_000); // stale: nothing after Jul 1
      anchor(b, "2026-07-20", 50_000); // the axis ends here
      rebuildAccount(bundle.db, a, "2026-07-01");
      rebuildAccount(bundle.db, b, "2026-07-20");

      const { cheap, fromSeries } = bothWays();
      expect(cheap).toBe(150_000); // NOT 50_000 — A carries forward to the axis end
      expect(cheap).toBe(fromSeries);
    });

    test("an INACTIVE account's balance is excluded (latestBalances does not filter)", () => {
      const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
      const dead = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "Dead", type: "savings" });
      anchor(a, "2026-07-01", 100_000);
      anchor(dead, "2026-07-01", 888_888);
      rebuildAccount(bundle.db, a, "2026-07-02");
      rebuildAccount(bundle.db, dead, "2026-07-02");
      bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, dead)).run();

      const { cheap, fromSeries } = bothWays();
      expect(cheap).toBe(100_000); // summing latestBalances unfiltered would give 988_888
      expect(cheap).toBe(fromSeries);
    });

    test("a trailing 'gap' row must not drag the last day past the axis end", () => {
      const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
      anchor(a, "2026-07-01", 100_000);
      rebuildAccount(bundle.db, a, "2026-07-02");
      // a gap day LATER than every covered day: invisible to netWorthSeries, so
      // it is not on the axis — but a naive MAX(day) would pick it up
      bundle.db
        .insert(dailyBalances)
        .values({ accountId: a, day: "2026-07-09", balanceCents: 0, basis: "gap" })
        .run();

      const { cheap, fromSeries } = bothWays();
      expect(cheap).toBe(100_000);
      expect(cheap).toBe(fromSeries);
    });

    /** Same shape as pairFixture, but the curves stop on `through`. */
    function pairEndingOn(opts: { outPostedOn: string; inPostedOn: string; through: string }) {
      const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
      const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
      anchor(a, "2026-07-01", 100_000);
      anchor(a, "2026-07-02", 90_000);
      anchor(b, "2026-07-01", 50_000);
      anchor(b, "2026-07-02", 60_000);
      txn(a, opts.outPostedOn, -10_000, "g1");
      txn(b, opts.inPostedOn, 10_000, "g1");
      rebuildAccount(bundle.db, a, opts.through);
      rebuildAccount(bundle.db, b, opts.through);
      return { a, b };
    }

    test("a window whose endDay IS the last axis day has already resolved", () => {
      // [startDay, endDay) is half-open: on endDay the two ledgers agree again,
      // so a float ending exactly on the last day must NOT be re-added.
      pairEndingOn({ outPostedOn: "2026-07-02", inPostedOn: "2026-07-04", through: "2026-07-04" });
      expect(transferFloats(bundle.db)).toMatchObject([{ endDay: "2026-07-04", deltaCents: 10_000 }]);

      const series = bridgedNetWorthSeries(bundle.db);
      expect(series.at(-1)!.day).toBe("2026-07-04"); // endDay === last axis day
      expect(series.at(-1)!.inTransitCents).toBe(0); // resolved, not bridged

      const { cheap, fromSeries } = bothWays();
      expect(cheap).toBe(fromSeries);
      expect(cheap).toBe(160_000); // an inclusive end test would give 170_000
    });

    test("a window still open on the last axis day IS counted (inclusive start)", () => {
      // receiver credits first: the money is visible in both books from 07-02,
      // and 07-02 is also where the axis stops — startDay === lastDay.
      pairEndingOn({ outPostedOn: "2026-07-05", inPostedOn: "2026-07-02", through: "2026-07-02" });
      expect(transferFloats(bundle.db)).toMatchObject([{ startDay: "2026-07-02", endDay: null, deltaCents: -10_000 }]);

      const { cheap, fromSeries } = bothWays();
      expect(cheap).toBe(fromSeries);
      expect(cheap).toBe(140_000); // an exclusive start test would give 150_000
    });

    test("a window opening AFTER the last axis day is not counted", () => {
      const { b } = pairEndingOn({ outPostedOn: "2026-07-05", inPostedOn: "2026-07-02", through: "2026-07-02" });
      // a gap run past both curves splits the pair's correction in two: the
      // second window opens at 07-05, three days beyond where the axis stops
      for (const day of ["2026-07-03", "2026-07-04"]) {
        bundle.db.insert(dailyBalances).values({ accountId: b, day, balanceCents: 0, basis: "gap" }).run();
      }
      const floats = transferFloats(bundle.db);
      const series = bridgedNetWorthSeries(bundle.db);
      const lastDay = series.at(-1)!.day;
      expect(lastDay).toBe("2026-07-02");
      expect(floats).toMatchObject([
        { startDay: "2026-07-02", endDay: "2026-07-03" }, // covers the last day
        { startDay: "2026-07-05", endDay: null }, // opens past it
      ]);
      expect(floats.some((f) => compareDates(f.startDay, lastDay) > 0)).toBe(true);

      const { cheap, fromSeries } = bothWays();
      expect(cheap).toBe(fromSeries);
      expect(cheap).toBe(140_000); // without the start test the second window gives 130_000
    });

    test("an unresolved float (endDay null) IS counted on the last day", () => {
      const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
      const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
      anchor(a, "2026-07-01", 100_000);
      anchor(b, "2026-06-01", 50_000);
      txn(a, "2026-07-02", -10_000, "g1");
      txn(b, "2026-07-20", 10_000, "g1");
      rebuildAccount(bundle.db, a, TODAY);
      rebuildAccount(bundle.db, b, "2026-06-01");
      expect(transferFloats(bundle.db)).toMatchObject([{ endDay: null, deltaCents: 10_000 }]);

      const { cheap, fromSeries } = bothWays();
      expect(cheap).toBe(fromSeries);
      expect(cheap).toBe(bridgedNetWorthSeries(bundle.db).at(-1)!.totalCents);
    });

    test("no accounts and no coverage both fall back to 0", () => {
      expect(latestBridgedNetWorthCents(bundle.db)).toBe(0); // seeded db, no accounts

      const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
      bundle.db
        .insert(dailyBalances)
        .values({ accountId: a, day: "2026-07-01", balanceCents: 5_000, basis: "gap" })
        .run();
      // every row is a gap -> netWorthSeries returns [] -> 0, not 5_000
      expect(latestBridgedNetWorthCents(bundle.db)).toBe(0);
      expect(bridgedNetWorthSeries(bundle.db).at(-1)?.totalCents ?? 0).toBe(0);
    });
  });
});
