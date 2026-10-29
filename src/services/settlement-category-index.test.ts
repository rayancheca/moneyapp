import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { addDays } from "@/lib/dates";
import { loadCategoryIndex } from "./analytics";
import { incomeCard } from "./income-card";
import { postedAveragesBySeries } from "./posted-average";

/**
 * Settlement reads a pay series' days by the category index (`payDayRows`), and a caller settling several series
 * loads that index once for the batch and hands it to each (`paydaySettlement`'s `idx`) — 059d8aa's rule, which
 * `paydaySettlementsBySeries`, `stillToComeReader` and `cashEarningsReadings` follow. So a second pay series costs a
 * reader no second read of the categories table.
 *
 * 🔴 Review of the pay-words batch (#26): two per-series callers still settled without it — the posted average's loop
 * (`postedAveragesBySeries`, `idx` already in scope) and Earned vs banked's pay lines (`incomeCard`) — so each re-read
 * the categories table once per pay series on every load. Measured on his ledger copy 2026-10-29, one pay series: the
 * posted average over his 42 series read it twice and now reads it once; the card's 7 reads stay 7 with his one line —
 * below, a second line made them 8.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-15";
const CHASE = "acct-chase";
const now = (): string => new Date().toISOString();

function salaryId(): string {
  const named = (name: string, parentId: string | null) => {
    const parent = parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId);
    return bundle.db.select().from(categories).where(and(eq(categories.name, name), parent)).get()!;
  };
  return named("Salary", named("Income", null).id).id;
}

let seq = 0;
/** A confirmed weekly pay series of $1,000.00, paid into Chase on every Thursday Jun 4 … Aug 27. */
function paySeries(id: string, name: string): typeof recurringSeries.$inferSelect {
  bundle.db
    .insert(recurringSeries)
    .values({
      id,
      name,
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: 100_000,
      userAmountCents: 100_000,
      nextExpectedOn: "2026-06-04",
      nextExpectedAmountCents: 100_000,
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  for (let day = "2026-06-04"; day <= "2026-08-27"; day = addDays(day, 7)) {
    seq += 1;
    bundle.db
      .insert(transactions)
      .values({
        id: `t-${seq}`,
        accountId: CHASE,
        postedOn: day,
        amountCents: 100_000,
        rawDescription: "PAYROLL",
        normalizedDescription: "PAYROLL",
        categoryId: salaryId(),
        recurringSeriesId: id,
        status: "active",
        needsReview: false,
        occurrenceIndex: 0,
        dedupeHash: `h-${seq}`,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }
  return bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get()!;
}

/** How often `read` loads the category index: the statement `loadCategoryIndex` prepares, counted. */
function indexReads(read: () => unknown): number {
  const prepare = bundle.sqlite.prepare.bind(bundle.sqlite);
  const statements: string[] = [];
  const spy = vi.spyOn(bundle.sqlite, "prepare").mockImplementation(((source: string) => {
    statements.push(source);
    return prepare(source);
  }) as unknown as typeof bundle.sqlite.prepare);
  try {
    loadCategoryIndex(bundle.db);
    const index = statements.splice(0).at(-1);
    read();
    return statements.filter((s) => s === index).length;
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-category-index-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: CHASE,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Chase",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  // read through Sat Sep 5, so each pay line settles its own (`checkedThrough` is a day)
  for (let day = "2026-06-01"; day <= "2026-09-05"; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: CHASE, day, balanceCents: 100_000, basis: "derived" }).run();
  }
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a reader settling several pay series loads the category index once, however many there are", () => {
  test("the posted average: one read for the batch, with one pay series or two", () => {
    const first = paySeries("series-a", "It America LLC (weekly pay)");
    const second = paySeries("series-b", "Second job (weekly pay)");

    expect(indexReads(() => postedAveragesBySeries(bundle.db, [first], TODAY))).toBe(1);
    expect(indexReads(() => postedAveragesBySeries(bundle.db, [first, second], TODAY))).toBe(1);
    // …and both are read per payday, by their settlement
    const both = postedAveragesBySeries(bundle.db, [first, second], TODAY);
    expect([both.get(first.id)!.perPayday, both.get(second.id)!.perPayday]).not.toContain(null);
  });

  test("Earned vs banked: a second pay line reads the categories table no more often than the first", () => {
    paySeries("series-a", "It America LLC (weekly pay)");
    const one = indexReads(() => expect(incomeCard(bundle.db, TODAY)!.pay).toHaveLength(1));
    paySeries("series-b", "Second job (weekly pay)");
    const two = indexReads(() => expect(incomeCard(bundle.db, TODAY)!.pay).toHaveLength(2));

    expect(one).toBeGreaterThan(0);
    expect(two).toBe(one);
  });
});
