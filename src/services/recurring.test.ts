import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { addDays } from "@/lib/dates";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { categorizeAll, detectTransfers } from "./categorize";
import {
  analyzeGroup,
  detectRecurringSeries,
  fitCadence,
  isDayOfMonthBimodal,
  median,
  populationStddev,
  projectOccurrences,
  setSeriesStatus,
  upcomingOccurrences,
} from "./recurring";

const TODAY = "2026-07-08";

/** Deterministic PRNG (mulberry32) — the corpus must be identical every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("statistics primitives", () => {
  test("median of odd-length list", () => {
    expect(median([31, 28, 31, 30, 31])).toBe(31);
  });

  test("median of even-length list averages the middle pair", () => {
    expect(median([28, 30, 31, 31])).toBe(30.5);
  });

  test("population stddev of identical values is 0", () => {
    expect(populationStddev([1549, 1549, 1549])).toBe(0);
  });

  test("population stddev matches a hand calculation", () => {
    // mean 20, deviations ±10 → variance 100 → stddev 10
    expect(populationStddev([10, 30, 10, 30])).toBe(10);
  });
});

describe("isDayOfMonthBimodal", () => {
  test("1st + 15th pattern is bimodal", () => {
    expect(isDayOfMonthBimodal([1, 15, 1, 15, 1, 15])).toBe(true);
  });

  test("weekend-shifted clusters (±1 day) still count as two modes", () => {
    expect(isDayOfMonthBimodal([1, 2, 15, 16, 1, 15])).toBe(true);
  });

  test("biweekly drift across the month is not bimodal", () => {
    expect(isDayOfMonthBimodal([2, 16, 30, 13, 27, 10, 24])).toBe(false);
  });

  test("a single stray day is not a second mode", () => {
    expect(isDayOfMonthBimodal([1, 1, 1, 1, 15])).toBe(false);
  });
});

describe("fitCadence buckets", () => {
  test("weekly: median 5–9 days", () => {
    expect(fitCadence(7, [1, 8, 15])).toBe("weekly");
    expect(fitCadence(5, [1, 6, 11])).toBe("weekly");
    expect(fitCadence(9, [1, 10, 19])).toBe("weekly");
  });

  test("monthly: median 28–33 days", () => {
    expect(fitCadence(31, [1, 1, 1])).toBe("monthly");
    expect(fitCadence(28, [15, 15, 15])).toBe("monthly");
  });

  test("quarterly and annual buckets", () => {
    expect(fitCadence(91, [1, 1, 1])).toBe("quarterly");
    expect(fitCadence(365.5, [10, 10, 10])).toBe("annual");
  });

  test("semimonthly needs day-of-month bimodality", () => {
    expect(fitCadence(14, [1, 15, 1, 15, 1, 15])).toBe("semimonthly");
  });

  test("median 14–16 without bimodality prefers biweekly (too close to call)", () => {
    expect(fitCadence(14, [2, 16, 30, 13, 27])).toBe("biweekly");
    expect(fitCadence(16, [3, 19, 4, 20, 6])).toBe("biweekly");
  });

  test("median 17 without bimodality is not a series", () => {
    expect(fitCadence(17, [2, 19, 5, 22, 9])).toBeNull();
  });

  test("gaps outside every bucket are rejected", () => {
    expect(fitCadence(3, [1, 4, 7])).toBeNull();
    expect(fitCadence(11, [1, 12, 23])).toBeNull();
    expect(fitCadence(20, [1, 21, 11])).toBeNull();
    expect(fitCadence(50, [1, 21, 11])).toBeNull();
    expect(fitCadence(200, [1, 21, 11])).toBeNull();
  });
});

describe("analyzeGroup", () => {
  const txn = (id: string, postedOn: string, amountCents: number) => ({ id, postedOn, amountCents });

  test("fewer than 3 occurrences is never a series", () => {
    expect(analyzeGroup([txn("a", "2026-01-01", -1000), txn("b", "2026-02-01", -1000)])).toBeNull();
  });

  test("unstable amounts (stddev/|mean| > 0.2) are rejected", () => {
    expect(
      analyzeGroup([
        txn("a", "2026-01-01", -1000),
        txn("b", "2026-02-01", -9000),
        txn("c", "2026-03-01", -400),
      ]),
    ).toBeNull();
  });

  test("identical amounts pass stability even with zero variance shortcut", () => {
    const stats = analyzeGroup([
      txn("a", "2026-01-01", -180000),
      txn("b", "2026-02-01", -180000),
      txn("c", "2026-03-01", -180000),
    ]);
    expect(stats).not.toBeNull();
    expect(stats!.cadence).toBe("monthly");
    expect(stats!.amountCentsStddev).toBe(0);
    expect(stats!.amountCentsAvg).toBe(-180000);
    // gaps 31, 28 → median 29.5 → next = Mar 1 + 30
    expect(stats!.nextExpectedOn).toBe("2026-03-31");
  });

  test("stores every stat the UI needs to show the math", () => {
    const stats = analyzeGroup([
      txn("a", "2026-01-05", -5000),
      txn("b", "2026-01-12", -5200),
      txn("c", "2026-01-19", -4800),
      txn("d", "2026-01-26", -5000),
    ]);
    expect(stats).toMatchObject({
      cadence: "weekly",
      medianGapDays: 7,
      intervalDaysAvg: 7,
      toleranceDays: 2,
      amountCentsAvg: -5000,
      nextExpectedOn: "2026-02-02",
      nextExpectedAmountCents: -5000,
      lastMatchedOn: "2026-01-26",
    });
    expect(stats!.confidence).toBeGreaterThan(0.5);
  });
});

describe("projectOccurrences", () => {
  const series = {
    id: "s1",
    name: "Payroll",
    kind: "income" as const,
    cadence: "weekly" as const,
    intervalDaysAvg: 7,
    nextExpectedOn: "2026-07-09",
    nextExpectedAmountCents: 80000,
  };

  test("a weekly series contributes every expected date inside the window", () => {
    const occ = projectOccurrences(series, "2026-07-08", "2026-07-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-07-09", "2026-07-16", "2026-07-23", "2026-07-30"]);
    expect(occ.every((o) => o.amountCents === 80000)).toBe(true);
  });

  test("overdue expected dates roll forward instead of projecting the past", () => {
    const occ = projectOccurrences({ ...series, nextExpectedOn: "2026-07-01" }, "2026-07-08", "2026-07-31");
    expect(occ.map((o) => o.date)).toEqual(["2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29"]);
  });

  test("a series without next-expected data projects nothing", () => {
    expect(projectOccurrences({ ...series, nextExpectedOn: null }, "2026-07-08", "2026-07-31")).toEqual([]);
  });
});

/* ── synthetic corpus (Phase 6 fixed targets) ─────────────────────────── */

const KNOWN_SERIES_NAMES = [
  "Employer (cash)", // weekly cash salary via the seeded ATM rule
  "MONTHLY RENT PAYMENT", // exact monthly, description-fallback grouping
  "Netflix", // monthly subscription via the seeded merchant map
  "ONLINE TRANSFER TO SAVINGS REF", // biweekly transfer, outflow leg
  "ONLINE TRANSFER FROM CHECKING REF", // biweekly transfer, inflow leg
] as const;

const NOISE_WORDS = [
  "ZALVO", "MIRKET", "PLOVEN", "QUARNIX", "VELTIS", "DORNAB", "SELVIK",
  "TRUMBO", "HALVYON", "GRELDA", "OSMIRE", "FENWIP", "LUBROK", "TINDER0",
  "VARNISH9", "KOLPUT", "WREXIS", "YONDEL", "BLIMVER", "SORNAK",
] as const;

describe("detection on the synthetic corpus", () => {
  let dir: string;
  let bundle: DbBundle;
  let checkingId: string;
  let savingsId: string;
  let cardId: string;
  let seq = 0;

  function insertTxn(accountId: string, postedOn: string, amountCents: number, rawDescription: string): string {
    seq += 1;
    return bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription,
        normalizedDescription: normalizeDescription(rawDescription),
        // seq salts the hash so intentionally-identical corpus rows coexist
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription, occurrenceIndex: seq }),
      })
      .returning({ id: transactions.id })
      .get().id;
  }

  /**
   * 6 months of known series + ~30 deterministic noise one-offs:
   * - weekly income, Thursdays, ±3% amount jitter (2026-01-01 is a Thursday)
   * - exact monthly rent on the 1st
   * - monthly $15.49 subscription on the 15th
   * - biweekly $200.00 transfer (both legs)
   * - 20 unique-description one-offs + 10 same-description random visits
   */
  function buildCorpus(): void {
    const rng = mulberry32(1337);

    for (let i = 0; i < 26; i++) {
      const jitter = 1 + (rng() * 0.06 - 0.03);
      insertTxn(checkingId, addDays("2026-01-01", i * 7), Math.round(80000 * jitter), "ATM CASH DEPOSIT NEW YORK");
    }

    for (const day of ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]) {
      insertTxn(checkingId, day, -180000, "MONTHLY RENT PAYMENT");
    }

    for (const day of ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15", "2026-06-15"]) {
      insertTxn(cardId, day, -1549, "NETFLIX.COM NETFLIX.COM CA");
    }

    for (let i = 0; i < 13; i++) {
      const day = addDays("2026-01-02", i * 14);
      insertTxn(checkingId, day, -20000, "ONLINE TRANSFER TO SAVINGS REF 1234567");
      insertTxn(savingsId, day, 20000, "ONLINE TRANSFER FROM CHECKING REF 1234567");
    }

    for (const word of NOISE_WORDS) {
      const day = addDays("2026-01-01", Math.floor(rng() * 181));
      const amount = -Math.round(500 + rng() * 14500);
      insertTxn(cardId, day, amount, `POS PURCHASE ${word} LLC`);
    }
    for (let i = 0; i < 10; i++) {
      const day = addDays("2026-01-01", Math.floor(rng() * 181));
      const amount = -Math.round(500 + rng() * 9500);
      insertTxn(cardId, day, amount, "CORNER COFFEE SHOP");
    }

    categorizeAll(bundle.db);
    detectTransfers(bundle.db);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rec-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
    savingsId = createAccount(bundle.db, { institutionId: chase.id, name: "Savings", type: "savings" });
    cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
    buildCorpus();
    detectRecurringSeries(bundle.db, TODAY);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function allSeries() {
    return bundle.db.select().from(recurringSeries).all();
  }

  function seriesByName(name: string) {
    const row = allSeries().find((s) => s.name === name);
    if (!row) throw new Error(`series not detected: ${name}`);
    return row;
  }

  test("precision ≥ 95% and recall ≥ 90% against the known series", () => {
    const detected = allSeries();
    const known = new Set<string>(KNOWN_SERIES_NAMES);
    const truePositives = detected.filter((s) => known.has(s.name)).length;
    const precision = truePositives / detected.length;
    const recall = truePositives / KNOWN_SERIES_NAMES.length;
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });

  test("exact next expected date and amount on the noiseless monthly rent", () => {
    const rent = seriesByName("MONTHLY RENT PAYMENT");
    expect(rent.cadence).toBe("monthly");
    // gaps 31,28,31,30,31 → median 31 → 2026-06-01 + 31
    expect(rent.nextExpectedOn).toBe("2026-07-02");
    expect(rent.nextExpectedAmountCents).toBe(-180000);
    expect(rent.amountCentsStddev).toBe(0);
    expect(rent.kind).toBe("bill");
    expect(rent.accountId).toBe(checkingId);
    expect(rent.merchantId).toBeNull();
  });

  test("weekly cash salary detects as income via the synthetic merchant", () => {
    const salary = seriesByName("Employer (cash)");
    expect(salary.cadence).toBe("weekly");
    expect(salary.kind).toBe("income");
    expect(salary.merchantId).not.toBeNull();
    // last deposit 2026-06-25, median gap 7
    expect(salary.nextExpectedOn).toBe("2026-07-02");
    expect(salary.nextExpectedAmountCents).toBeGreaterThan(76000);
    expect(salary.nextExpectedAmountCents).toBeLessThan(84000);
    expect(salary.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("merchant under Subscriptions detects as a subscription", () => {
    const netflix = seriesByName("Netflix");
    expect(netflix.kind).toBe("subscription");
    expect(netflix.cadence).toBe("monthly");
    expect(netflix.nextExpectedOn).toBe("2026-07-16");
    expect(netflix.nextExpectedAmountCents).toBe(-1549);
  });

  test("both transfer legs detect as biweekly transfer kind — never income", () => {
    const out = seriesByName("ONLINE TRANSFER TO SAVINGS REF");
    const inn = seriesByName("ONLINE TRANSFER FROM CHECKING REF");
    expect(out.cadence).toBe("biweekly");
    expect(inn.cadence).toBe("biweekly");
    expect(out.kind).toBe("transfer");
    // the inflow leg has mean > 0 but its category kind is transfer
    expect(inn.kind).toBe("transfer");
  });

  test("matched transactions are tagged with their series id", () => {
    const salary = seriesByName("Employer (cash)");
    const tagged = bundle.db
      .select()
      .from(transactions)
      .where(eq(transactions.recurringSeriesId, salary.id))
      .all();
    expect(tagged).toHaveLength(26);
  });

  test("re-running detection never duplicates series", () => {
    const before = allSeries().length;
    const summary = detectRecurringSeries(bundle.db, TODAY);
    expect(allSeries().length).toBe(before);
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(before);
  });

  test("a dismissed series stays dismissed on re-run while stats refresh", () => {
    const rent = seriesByName("MONTHLY RENT PAYMENT");
    setSeriesStatus(bundle.db, rent.id, "dismissed");
    insertTxn(checkingId, "2026-07-01", -180000, "MONTHLY RENT PAYMENT");

    detectRecurringSeries(bundle.db, TODAY);
    const after = seriesByName("MONTHLY RENT PAYMENT");
    expect(after.id).toBe(rent.id);
    expect(after.status).toBe("dismissed");
    expect(after.lastMatchedOn).toBe("2026-07-01");
    // gaps now 31,28,31,30,31,30 → median 30.5 → round 31 → Aug 1
    expect(after.nextExpectedOn).toBe("2026-08-01");
  });

  test("a confirmed series stays confirmed on re-run while stats refresh", () => {
    const netflix = seriesByName("Netflix");
    setSeriesStatus(bundle.db, netflix.id, "confirmed");
    insertTxn(cardId, "2026-07-15", -1549, "NETFLIX.COM NETFLIX.COM CA");
    categorizeAll(bundle.db); // assign the merchant to the new row

    detectRecurringSeries(bundle.db, "2026-07-20");
    const after = seriesByName("Netflix");
    expect(after.id).toBe(netflix.id);
    expect(after.status).toBe("confirmed");
    expect(after.lastMatchedOn).toBe("2026-07-15");
    expect(after.nextExpectedOn).toBe("2026-08-15");
  });

  test("upcoming occurrences are windowed, sorted, and skip dismissed series", () => {
    const rent = seriesByName("MONTHLY RENT PAYMENT");
    setSeriesStatus(bundle.db, rent.id, "dismissed");

    const upcoming = upcomingOccurrences(bundle.db, TODAY, 30);
    expect(upcoming.length).toBeGreaterThan(0);
    expect(upcoming.some((o) => o.name === "MONTHLY RENT PAYMENT")).toBe(false);
    expect(upcoming.some((o) => o.name === "Netflix" && o.date === "2026-07-16")).toBe(true);
    const dates = upcoming.map((o) => o.date);
    expect([...dates].sort()).toEqual(dates);
    const windowEnd = addDays(TODAY, 30);
    expect(dates.every((d) => d >= TODAY && d <= windowEnd)).toBe(true);
  });

  test("setSeriesStatus rejects unknown ids", () => {
    expect(() => setSeriesStatus(bundle.db, "nope", "confirmed")).toThrow(/Unknown recurring series/);
  });
});
