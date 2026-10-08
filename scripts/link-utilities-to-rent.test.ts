import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import {
  LABEL_PREFIX,
  PAYMENTS,
  RENT,
  UTILITIES,
  applyLink,
  captureState,
  classify,
  compareStates,
  loadFacts,
  rehearse,
} from "./link-utilities-to-rent";

/**
 * His ledger as it stood on 2026-10-08, in the shape the write reads: `Rent utilities & fees` under its real id — a
 * confirmed monthly bill at -$182.21 on the 1st, never posted, filed in a category of his — and `Flamingo South Beach
 * (rent)` under its real id, -$2,109.00 on the 1st, with the five payments he named linked under their real ids. A
 * gym that really has never been billed stands beside them, so "every other series is untouched" is asked.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-10-08";
const WELLS = "01a03a43-ab5d-7000-a3d4-e4d2c112e2b8";
const GYM = "series-gym";
const now = (): string => new Date().toISOString();

function addRow(id: string, postedOn: string, amountCents: number, seriesId: string | null): void {
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: WELLS,
      postedOn,
      amountCents,
      rawDescription: `043257 Flamingo Rent ${postedOn}`,
      normalizedDescription: `043257 FLAMINGO RENT ${postedOn}`,
      categoryId: null,
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-link-utilities-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: WELLS,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Wells Fargo Everyday Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  const categoryId = bundle.db.select().from(categories).all()[0]!.id;
  const monthly = {
    kind: "bill" as const,
    cadence: "monthly" as const,
    intervalDaysAvg: 30,
    anchorDay: 1,
    status: "confirmed" as const,
    createdAt: "2026-08-31T18:16:39.816Z",
    // his ledger's: a write in the same millisecond as the insert would leave `updated_at` unmoved
    updatedAt: "2026-08-31T18:16:39.816Z",
  };
  bundle.db
    .insert(recurringSeries)
    .values([
      {
        ...monthly,
        id: RENT.id,
        name: RENT.name,
        amountCentsAvg: -228_570,
        nextExpectedOn: "2026-09-01",
        userNextExpectedOn: "2026-09-01",
        nextExpectedAmountCents: -210_900,
        userAmountCents: -210_900,
        lastMatchedOn: "2026-09-02",
      },
      {
        ...monthly,
        id: UTILITIES.id,
        name: UTILITIES.name,
        amountCentsAvg: -18_221,
        nextExpectedOn: "2026-09-01",
        nextExpectedAmountCents: -18_221,
        userAmountCents: -18_221,
        lastMatchedOn: null,
        userCategoryId: categoryId,
      },
      {
        ...monthly,
        id: GYM,
        name: "Gym",
        anchorDay: null,
        nextExpectedOn: "2026-10-22",
        nextExpectedAmountCents: -10_000,
        userAmountCents: -10_000,
        lastMatchedOn: null,
        userCategoryId: categoryId,
      },
    ])
    .run();
  for (const p of PAYMENTS) addRow(p.id, p.postedOn, p.amountCents, RENT.id);
  for (let day = "2026-06-01"; day <= "2026-09-30"; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: WELLS, day, balanceCents: 500_000, basis: "derived" }).run();
  }
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("what the write stores — his decision 59, 2026-10-08", () => {
  test("the utilities, billed with the rent — both under their ids on his ledger", () => {
    expect(UTILITIES).toEqual({ id: "01a05909-a688-7000-9898-39563628004d", name: "Rent utilities & fees", amountCents: -18_221 });
    expect(RENT).toEqual({ id: "019f72f5-055f-7000-a3ef-2ac408a6044b", name: "Flamingo South Beach (rent)", amountCents: -210_900 });
  });

  test("the five rent payments he named: Jun 16 $1,100.00 + $1,334.80, Jul 8, Aug 4, Sep 2 $2,291.21", () => {
    expect(PAYMENTS.map((p) => [p.postedOn, p.amountCents])).toEqual([
      ["2026-06-16", -110_000],
      ["2026-06-16", -133_480],
      ["2026-07-08", -228_570],
      ["2026-08-04", -223_711],
      ["2026-09-02", -229_121],
    ]);
    // Sep 2's payment is the rent's $2,109.00 plus the utilities' $182.21
    expect(PAYMENTS[4].amountCents).toBe(RENT.amountCents + UTILITIES.amountCents);
  });
});

describe("the plan", () => {
  test("the measured state is a PLAN; once written, ALREADY APPLIED", () => {
    expect(plan()).toEqual({ kind: "plan" });
    applyLink(bundle);
    expect(plan()).toEqual({ kind: "applied" });
  });

  test("rehearsed: its line reads billed with the rent, never billed falls by $182.21, no money moves", () => {
    const { before, after, failures } = rehearse(bundle, TODAY);
    expect(failures).toEqual([]);
    expect([before.figures.neverBilledCents, after.figures.neverBilledCents]).toEqual([28_221, 10_000]);
    expect(after.figures.line?.billedWithLabel).toBe(LABEL_PREFIX);
    expect([before.figures.utilitiesEvidence, after.figures.utilitiesEvidence]).toEqual(["never-billed", "active"]);
    expect(after.figures.money).toBe(before.figures.money);
  });

  test("written: its row is billed with the rent; every other series is billed with nothing", () => {
    applyLink(bundle);
    const stored = bundle.sqlite
      .prepare("SELECT id, user_billed_with_series_id AS l FROM recurring_series ORDER BY id")
      .all();
    expect(stored).toEqual(
      [
        { id: RENT.id, l: null },
        { id: UTILITIES.id, l: RENT.id },
        { id: GYM, l: null },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  test("ALREADY APPLIED is read before the row guards — a rent payment linked later does not refuse a re-run", () => {
    applyLink(bundle);
    addRow("oct-rent", "2026-10-02", -229_121, RENT.id);
    sql("UPDATE recurring_series SET last_matched_on = '2026-10-02' WHERE id = ?", RENT.id);
    expect(plan()).toEqual({ kind: "applied" });
  });
});

describe("refused — any state but the measured one or the written one", () => {
  test.each([
    ["renamed", "UPDATE recurring_series SET name = 'Utilities' WHERE id = ?", "named"],
    ["not a bill", "UPDATE recurring_series SET kind = 'subscription' WHERE id = ?", "not a bill"],
    ["not monthly", "UPDATE recurring_series SET user_cadence = 'quarterly' WHERE id = ?", "quarterly, not monthly"],
    ["not confirmed", "UPDATE recurring_series SET status = 'detected' WHERE id = ?", "not confirmed"],
    ["another amount", "UPDATE recurring_series SET user_amount_cents = -20000 WHERE id = ?", "-$182.21"],
    ["once posted", "UPDATE recurring_series SET last_matched_on = '2026-09-01' WHERE id = ?", "measured never posted"],
    [
      "already billed with another series",
      `UPDATE recurring_series SET user_billed_with_series_id = '${"series-gym"}' WHERE id = ?`,
      "never overwritten",
    ],
  ])("the utilities: %s", (_name, statement, reason) => {
    sql(statement, UTILITIES.id);
    expect(reasons().join("\n")).toContain(reason);
  });

  test("the utilities: a row of its own linked to it", () => {
    addRow("own-row", "2026-09-01", -18_221, UTILITIES.id);
    expect(reasons().join("\n")).toContain("own-row");
  });

  test.each([
    ["renamed", "UPDATE recurring_series SET name = 'Rent' WHERE id = ?", "named"],
    ["not a bill", "UPDATE recurring_series SET kind = 'transfer' WHERE id = ?", "not a bill"],
    ["not monthly", "UPDATE recurring_series SET user_cadence = 'weekly' WHERE id = ?", "weekly, not monthly"],
    ["ended", "UPDATE recurring_series SET status = 'ended' WHERE id = ?", "ended, not confirmed"],
    ["another amount", "UPDATE recurring_series SET user_amount_cents = -228570 WHERE id = ?", "-$2,109.00"],
    [
      "itself billed with another series",
      `UPDATE recurring_series SET user_billed_with_series_id = '${"series-gym"}' WHERE id = ?`,
      "one hop",
    ],
    ["gone", "UPDATE transactions SET recurring_series_id = NULL WHERE recurring_series_id = ?", "not Flamingo"],
  ])("the rent: %s", (_name, statement, reason) => {
    sql(statement, RENT.id);
    expect(reasons().join("\n")).toContain(reason);
  });

  test.each([
    ["a payment's amount", "UPDATE transactions SET amount_cents = -229000 WHERE id = ?", "-$2,290.00"],
    ["a payment's day", "UPDATE transactions SET posted_on = '2026-09-03' WHERE id = ?", "2026-09-03"],
    ["a payment no longer active", "UPDATE transactions SET status = 'superseded' WHERE id = ?", "superseded"],
    ["a payment linked elsewhere", `UPDATE transactions SET recurring_series_id = '${"series-gym"}' WHERE id = ?`, "Gym"],
    ["a payment gone", "DELETE FROM transactions WHERE id = ?", "not in this ledger"],
  ])("%s", (_name, statement, reason) => {
    sql(statement, PAYMENTS[4].id);
    expect(reasons().join("\n")).toContain(reason);
  });

  test("a sixth payment linked to the rent", () => {
    addRow("a-sixth-payment", "2026-10-02", -229_121, RENT.id);
    expect(reasons().join("\n")).toContain("a-sixth-payment");
  });

  test("the series not in this ledger", () => {
    expect(JSON.stringify(classify({ ...loadFacts(bundle), utilities: undefined }))).toContain("not in this ledger");
    expect(JSON.stringify(classify({ ...loadFacts(bundle), rent: undefined }))).toContain("not in this ledger");
  });

  test("the column missing — migration 0026 has not run", () => {
    expect(JSON.stringify(classify({ ...loadFacts(bundle), hasColumn: false }))).toContain("0026");
  });
});

describe("the write itself", () => {
  test("writes only over NULL — a link stored meanwhile is never overwritten", () => {
    sql("UPDATE recurring_series SET user_billed_with_series_id = ? WHERE id = ?", GYM, UTILITIES.id);
    expect(() => applyLink(bundle)).toThrow(/not written/);
    const stored = bundle.sqlite
      .prepare("SELECT user_billed_with_series_id AS l FROM recurring_series WHERE id = ?")
      .get(UTILITIES.id);
    expect(stored).toEqual({ l: GYM });
  });

  test("moves exactly one series row, in exactly two columns", () => {
    const row = () => bundle.sqlite.prepare("SELECT * FROM recurring_series WHERE id = ?").get(UTILITIES.id) as Record<string, unknown>;
    const before = row();
    applyLink(bundle);
    const after = row();
    expect(Object.keys(after).filter((k) => after[k] !== before[k]).sort()).toEqual(["updated_at", "user_billed_with_series_id"]);
  });
});

describe("the guards after the write — each fails on what it guards", () => {
  /** The write between two captures; `extra` runs after the write. */
  const after = (extra: () => void): string[] => {
    const before = captureState(bundle, TODAY);
    applyLink(bundle);
    extra();
    return compareStates(before, captureState(bundle, TODAY));
  };

  test("nothing else moved: none", () => {
    expect(after(() => {})).toEqual([]);
  });

  test.each([
    ["a transaction", () => sql("UPDATE transactions SET needs_review = 1 WHERE id = ?", PAYMENTS[0].id), "transactions moved"],
    [
      "a daily balance",
      () => sql("UPDATE daily_balances SET balance_cents = 1 WHERE account_id = ? AND day = '2026-07-01'", WELLS),
      "daily balances moved",
    ],
    [
      "the status counts",
      () => sql("UPDATE transactions SET status = 'superseded' WHERE id = ?", PAYMENTS[0].id),
      "status counts moved",
    ],
    [
      "another series",
      () => sql("UPDATE recurring_series SET name = 'Gym (Crunch)' WHERE id = ?", GYM),
      `series rows moved: ${UTILITIES.id}, ${GYM}`,
    ],
    [
      "a third column of its",
      () => sql("UPDATE recurring_series SET confidence = 0.5 WHERE id = ?", UTILITIES.id),
      "columns moved: confidence,",
    ],
    [
      "billed with another series",
      () => sql("UPDATE recurring_series SET user_billed_with_series_id = ? WHERE id = ?", GYM, UTILITIES.id),
      `billed with ${GYM}, not ${RENT.id}`,
    ],
    [
      "its amount — the money moved",
      () => sql("UPDATE recurring_series SET user_amount_cents = -20000 WHERE id = ?", UTILITIES.id),
      "the money moved",
    ],
    [
      "the rent last seen another day — its line reads another sighting",
      () => sql("UPDATE recurring_series SET last_matched_on = '2026-08-04' WHERE id = ?", RENT.id),
      `not "${LABEL_PREFIX}"`,
    ],
    [
      "the rent quiet — the two read one evidence, never billed is not it",
      () => sql("UPDATE recurring_series SET last_matched_on = NULL WHERE id = ?", RENT.id),
      "not one evidence",
    ],
    [
      "the gym billed — never billed falls by another amount",
      () => sql("UPDATE recurring_series SET last_matched_on = '2026-10-01' WHERE id = ?", GYM),
      "not a fall of exactly $182.21",
    ],
    [
      "the gym billed — the committed book's not-charged-yet money falls by more than its line",
      () => sql("UPDATE recurring_series SET last_matched_on = '2026-10-01' WHERE id = ?", GYM),
      "not-charged-yet money read",
    ],
    [
      "the gym ended — the card's headline moved",
      () => sql("UPDATE recurring_series SET status = 'ended' WHERE id = ?", GYM),
      "the card's headline moved: $2,391.21 → $2,291.21",
    ],
  ])("%s", (_name, extra, failure) => {
    expect(after(extra).join("\n")).toContain(failure);
  });

  test("before the write the line must read never billed — a link already there is not this write", () => {
    const before = captureState(bundle, TODAY);
    sql("UPDATE recurring_series SET user_billed_with_series_id = ? WHERE id = ?", RENT.id, UTILITIES.id);
    const failures = compareStates(captureState(bundle, TODAY), captureState(bundle, TODAY));
    expect(failures.join("\n")).toContain('before: the card\'s Rent utilities & fees line was not "never billed"');
    expect(failures.join("\n")).toContain("before: Rent utilities & fees read active");
    expect(compareStates(before, captureState(bundle, TODAY)).join("\n")).not.toContain("before: the card");
  });
});
