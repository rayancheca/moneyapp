import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { addDays } from "@/lib/dates";
import { parseAmountHistoryText } from "@/lib/series-kind";
import { rateHistoryRefusals, storedRateHistoryCount } from "@/services/rate-history-check";
import {
  BASIS_CENTS,
  FALL_CENTS,
  HISTORY,
  HISTORY_TEXT,
  PAY,
  ROWS,
  applyHistory,
  captureState,
  classify,
  compareStates,
  loadFacts,
  rehearse,
} from "./pay-rate-history";

/**
 * His ledger as it stood on 2026-10-08, in the shape the write reads: "It America LLC (weekly pay)" under its real id,
 * weekly Thursdays anchored Jul 23, his $1,141.92 and no rate history; the four deposits he linked, under their real
 * ids — two ATM cash deposits in Chase Checking, the payroll lump and week in Wells Fargo, the account the series names
 * and the one read through Sep 24. A second series stands beside it, so "every other series keeps NULL" is asked.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-10-08";
const CHASE = "019f4ca7-a6bd-7cc7-9a5f-e7f91c499722";
const WELLS = "01a03a43-ab5d-7000-a3d4-e4d2c112e2b8";
const RENT = "series-rent";
const now = (): string => new Date().toISOString();

function categoryId(name: string, parentName: string): string {
  const parent = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.parentId, parent.id)))
    .get()!.id;
}

function addAccount(id: string, name: string): void {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name,
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function addRow(id: string, accountId: string, postedOn: string, amountCents: number, seriesId: string | null): void {
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId,
      postedOn,
      amountCents,
      rawDescription: `DEPOSIT ${postedOn}`,
      normalizedDescription: `DEPOSIT ${postedOn}`,
      categoryId: categoryId("Salary", "Income"),
      recurringSeriesId: seriesId,
      seriesLinkSource: seriesId === null ? null : "user",
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${id}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

const sql = (statement: string, ...params: unknown[]) => bundle.sqlite.prepare(statement).run(...params);
const plan = () => classify(loadFacts(bundle));
const reasons = (): string[] => {
  const verdict = plan();
  return verdict.kind === "refuse" ? verdict.reasons : [`(not refused: ${verdict.kind})`];
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-pay-rate-history-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  addAccount(CHASE, "Chase Checking");
  addAccount(WELLS, "Wells Fargo Everyday Checking");
  bundle.db
    .insert(recurringSeries)
    .values({
      id: PAY.id,
      name: PAY.name,
      accountId: WELLS,
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: 104_600,
      userAmountCents: 114_192,
      nextExpectedOn: "2026-07-23",
      nextExpectedAmountCents: 104_600,
      lastMatchedOn: "2026-07-23",
      status: "confirmed",
      createdAt: "2026-07-18T01:32:05.436Z",
      // his ledger's: a write in the same millisecond as the insert would leave `updated_at` unmoved
      updatedAt: "2026-09-28T15:22:00.106Z",
    })
    .run();
  bundle.db
    .insert(recurringSeries)
    .values({
      id: RENT,
      name: "Rent",
      accountId: WELLS,
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-10-01",
      nextExpectedAmountCents: -210_900,
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  for (const r of ROWS) addRow(r.id, r.postedOn < "2026-09-01" ? CHASE : WELLS, r.postedOn, r.amountCents, PAY.id);
  for (let day = "2026-06-01"; day <= "2026-09-24"; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: WELLS, day, balanceCents: 100_000, basis: "derived" }).run();
  }
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("what the write stores — his decision 55, 2026-10-08", () => {
  test("one past period, read back by the app's one reader as $1,047.00 through Wed Aug 26", () => {
    expect(HISTORY_TEXT).toBe('[{"throughOn":"2026-08-26","amountCents":104700}]');
    expect(parseAmountHistoryText(HISTORY_TEXT, 114_192)).toEqual([{ throughOn: "2026-08-26", amountCents: 104_700 }]);
    expect(HISTORY).toEqual([{ throughOn: "2026-08-26", amountCents: 104_700 }]);
  });

  test("the four deposits he linked, under their ids on his ledger", () => {
    expect(ROWS.map((r) => [r.id, r.postedOn, r.amountCents])).toEqual([
      ["019f4ca7-a6c4-7a76-9755-8f73b271a7b4", "2026-06-04", 104_700],
      ["019f4ca7-a6c4-779c-83e4-ab69ac748ca0", "2026-06-05", 40_000],
      ["01a0e898-c5ca-7004-864c-da99c173b10d", "2026-09-23", 456_768],
      ["01a0e898-c5ca-7005-aece-a262e0465a27", "2026-09-24", 114_192],
    ]);
  });

  test("what it moves: twelve cash weeks, Jun 4 – Aug 20, each $94.92 less; the basis stays his $1,141.92 rate", () => {
    expect(FALL_CENTS).toBe(113_904);
    expect(FALL_CENTS).toBe(12 * (114_192 - 104_700));
    expect(BASIS_CENTS).toBe(494_832); // $1,141.92 × 52 ÷ 12
  });
});

describe("the plan", () => {
  test("the measured state is a PLAN; once written, ALREADY APPLIED", () => {
    expect(plan()).toEqual({ kind: "plan" });
    applyHistory(bundle);
    expect(plan()).toEqual({ kind: "applied" });
  });

  test("rehearsed: Earned vs banked falls by exactly the twelve weeks, the basis holds, every guard passes", () => {
    const { before, after, failures } = rehearse(bundle, TODAY);
    expect(failures).toEqual([]);
    expect([before.figures.impliedCents, after.figures.impliedCents]).toEqual([2_055_456, 1_941_552]);
    expect([before.figures.checkedGapCents, after.figures.checkedGapCents]).toEqual([1_225_604, 1_111_700]);
    expect([before.figures.basisCents, after.figures.basisCents]).toEqual([494_832, 494_832]);
  });

  test("written: his row stores the text exactly; every other series keeps NULL; the app reads every history", () => {
    applyHistory(bundle);
    const stored = bundle.sqlite.prepare("SELECT id, user_amount_history AS h FROM recurring_series ORDER BY id").all();
    expect(stored).toEqual([
      { id: PAY.id, h: HISTORY_TEXT },
      { id: RENT, h: null },
    ]);
    expect(rateHistoryRefusals(bundle.db)).toEqual([]);
    expect(storedRateHistoryCount(bundle.db)).toBe(1);
  });

  test("ALREADY APPLIED is read before the row guards — a later change to his rows does not refuse a re-run", () => {
    applyHistory(bundle);
    sql("UPDATE transactions SET amount_cents = 104600 WHERE id = ?", ROWS[0].id);
    sql("UPDATE recurring_series SET user_amount_cents = 120000 WHERE id = ?", PAY.id);
    expect(plan()).toEqual({ kind: "applied" });
  });
});

describe("refused — any state but the measured one or the written one", () => {
  test.each([
    ["his series renamed", "UPDATE recurring_series SET name = 'It America LLC' WHERE id = ?", "named"],
    ["not income", "UPDATE recurring_series SET kind = 'transfer' WHERE id = ?", "income"],
    // his own cadence is the one read — detection's says weekly too
    ["not weekly", "UPDATE recurring_series SET user_cadence = 'biweekly' WHERE id = ?", "biweekly, not weekly"],
    ["not confirmed", "UPDATE recurring_series SET status = 'detected' WHERE id = ?", "confirmed"],
    ["another amount now", "UPDATE recurring_series SET user_amount_cents = 104700 WHERE id = ?", "$1,141.92"],
    ["no amount of his own", "UPDATE recurring_series SET user_amount_cents = NULL WHERE id = ?", "$1,141.92"],
    [
      "a different history stored",
      `UPDATE recurring_series SET user_amount_history = '[{"throughOn":"2026-08-19","amountCents":104700}]' WHERE id = ?`,
      "never overwritten",
    ],
    ["a history the app cannot read", "UPDATE recurring_series SET user_amount_history = '[]' WHERE id = ?", "an empty list"],
    ["Aug 27 is not a payday", "UPDATE recurring_series SET user_next_expected_on = '2026-07-22' WHERE id = ?", "2026-08-27"],
  ])("%s", (_name, statement, reason) => {
    sql(statement, PAY.id);
    expect(reasons().join("\n")).toContain(reason);
  });

  test.each([
    ["a row's amount", "UPDATE transactions SET amount_cents = 104600 WHERE id = ?", "$1,046.00"],
    ["a row's day", "UPDATE transactions SET posted_on = '2026-06-03' WHERE id = ?", "2026-06-03"],
    ["a row no longer active", "UPDATE transactions SET status = 'superseded' WHERE id = ?", "superseded"],
    ["a row linked elsewhere", "UPDATE transactions SET recurring_series_id = 'series-rent' WHERE id = ?", "Rent"],
    ["a row gone", "DELETE FROM transactions WHERE id = ?", "not in this ledger"],
  ])("%s", (_name, statement, reason) => {
    sql(statement, ROWS[0].id);
    expect(reasons().join("\n")).toContain(reason);
  });

  test("a fifth deposit linked to his series", () => {
    addRow("a-fifth-row", WELLS, "2026-10-01", 114_192, PAY.id);
    expect(reasons().join("\n")).toContain("a-fifth-row");
  });

  test("…but a superseded row linked to it is no deposit, as the settlement reads it", () => {
    addRow("a-superseded-row", WELLS, "2026-09-24", 114_192, PAY.id);
    sql("UPDATE transactions SET status = 'superseded' WHERE id = 'a-superseded-row'");
    expect(plan()).toEqual({ kind: "plan" });
  });

  test("his series not in this ledger", () => {
    expect(classify({ ...loadFacts(bundle), series: undefined }).kind).toBe("refuse");
    expect(JSON.stringify(classify({ ...loadFacts(bundle), series: undefined }))).toContain("not in this ledger");
  });

  test("the column missing — migration 0025 has not run", () => {
    expect(JSON.stringify(classify({ ...loadFacts(bundle), hasColumn: false }))).toContain("0025");
  });
});

describe("the write itself", () => {
  test("writes only over NULL — a history stored meanwhile is never overwritten", () => {
    const other = '[{"throughOn":"2026-08-19","amountCents":104700}]';
    sql("UPDATE recurring_series SET user_amount_history = ? WHERE id = ?", other, PAY.id);
    expect(() => applyHistory(bundle)).toThrow(/not written/);
    const stored = bundle.sqlite.prepare("SELECT user_amount_history AS h FROM recurring_series WHERE id = ?").get(PAY.id);
    expect(stored).toEqual({ h: other });
  });

  test("moves exactly one series row, in exactly two columns", () => {
    const before = bundle.sqlite.prepare("SELECT * FROM recurring_series WHERE id = ?").get(PAY.id) as Record<string, unknown>;
    applyHistory(bundle);
    const after = bundle.sqlite.prepare("SELECT * FROM recurring_series WHERE id = ?").get(PAY.id) as Record<string, unknown>;
    expect(Object.keys(after).filter((k) => after[k] !== before[k]).sort()).toEqual(["updated_at", "user_amount_history"]);
  });
});

describe("the guards after the write — each fails on what it guards", () => {
  /** The write between two captures; `prior` runs before the first, `extra` after the write. */
  const after = (extra: () => void, prior: () => void = () => {}): string[] => {
    prior();
    const before = captureState(bundle, TODAY);
    applyHistory(bundle);
    extra();
    return compareStates(before, captureState(bundle, TODAY));
  };
  /** a second pay, linked after the first capture: it moves the card's totals and not his line */
  const sidePay = (): void => {
    bundle.db
      .insert(recurringSeries)
      .values({
        id: "series-side",
        name: "Side pay",
        kind: "income",
        cadence: "weekly",
        intervalDaysAvg: 7,
        userAmountCents: 10_000,
        nextExpectedOn: "2026-09-03",
        nextExpectedAmountCents: 10_000,
        status: "confirmed",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    addRow("side-1", WELLS, "2026-09-03", 10_000, "series-side");
  };

  test("nothing else moved: none", () => {
    expect(after(() => {})).toEqual([]);
  });

  test.each([
    ["a transaction", () => sql("UPDATE transactions SET needs_review = 1 WHERE id = ?", ROWS[2].id), "transactions moved"],
    [
      "a daily balance",
      () => sql("UPDATE daily_balances SET balance_cents = 1 WHERE account_id = ? AND day = '2026-07-01'", WELLS),
      "daily balances moved",
    ],
    [
      "the status counts",
      () => sql("UPDATE transactions SET status = 'superseded' WHERE id = ?", ROWS[1].id),
      "status counts moved",
    ],
    [
      "another series",
      () => sql("UPDATE recurring_series SET name = 'Rent (lease)' WHERE id = ?", RENT),
      `series rows moved: ${PAY.id}, ${RENT}`,
    ],
    [
      "a third column of his",
      () => sql("UPDATE recurring_series SET confidence = 0.5 WHERE id = ?", PAY.id),
      "columns moved: confidence,",
    ],
    [
      "his row stores another spelling of the history",
      () =>
        sql(
          `UPDATE recurring_series SET user_amount_history = '[{"amountCents":104700,"throughOn":"2026-08-26"}]' WHERE id = ?`,
          PAY.id,
        ),
      `stores [{"amountCents":104700,"throughOn":"2026-08-26"}], not ${HISTORY_TEXT}`,
    ],
    [
      "his implied pay by another amount",
      () =>
        sql(
          `UPDATE recurring_series SET user_amount_history = '[{"throughOn":"2026-08-19","amountCents":104700}]' WHERE id = ?`,
          PAY.id,
        ),
      "his implied pay read $20,554.56 → $19,510.44",
    ],
    ["his checked gap by another amount", () => addRow("late-cash", CHASE, "2026-07-02", 104_700, PAY.id), "his checked gap"],
    ["the card's total implied", sidePay, "the income card's total implied"],
    ["the card's total checked gap", sidePay, "the income card's total checked gap"],
    [
      "the basis after",
      () => sql("UPDATE recurring_series SET user_amount_cents = 120000 WHERE id = ?", PAY.id),
      "basis read $4,948.32 → $5,200.00",
    ],
  ])("%s", (_name, extra, failure) => {
    expect(after(extra).join("\n")).toContain(failure);
  });

  test("the basis before — the write must not be what brings it to $4,948.32", () => {
    const failures = after(
      () => sql("UPDATE recurring_series SET user_amount_cents = 114192 WHERE id = ?", PAY.id),
      () => sql("UPDATE recurring_series SET user_amount_cents = 120000 WHERE id = ?", PAY.id),
    );
    expect(failures.join("\n")).toContain("basis read $5,200.00 → $4,948.32");
  });

  test("a history the app cannot read", () => {
    const failures = after(() => sql("UPDATE recurring_series SET user_amount_history = '[]' WHERE id = ?", RENT));
    expect(failures.join("\n")).toContain("the app cannot read 1 stored history(ies)");
  });
});
