import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries, type SeriesKind } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount, outsidePortfolioCashAccountIds } from "./accounts";
import { agentsBand, agentsSeriesBand, loadCategoryIndex } from "./analytics";
import { addManualAnchor } from "./anchors";
import { netWorthAttribution } from "./attribution";
import { netWorthSeries, rebuildAccount } from "./derivation";
import { forecastCurrentMonth, forecastForMonth } from "./forecast";

/**
 * ⚖️ Owner decision 2026-10-06 (§6A 39): a scheduled CREDIT to the agent's cash is named by its CATEGORY, as the
 * net-worth bridge names the row it becomes. 🔴 The forecast named it by its sign alone: a monthly refund of the
 * agent's Gold fee, filed in Fees and detected as an "other" or "bill" series, was "Agent's income" on the forecast
 * card while the same refund, posted, netted inside "Agent's costs" on the bridge. EOM net worth was the same either
 * way — it adds both — and still is: only the note that names the money moves.
 *
 * His ledger holds none of it (Robinhood Agentic carries one transfer row, and no book is paired), so the rows are
 * hypothetical: Robinhood's Gold fee is $5.00 on the 1st (`agents-costs.test.ts`), and its refund is that $5.00 back on
 * the 20th, filed where the fee is filed (Fees > Bank Fees) at the seed's "Robinhood Gold" merchant.
 */

const TODAY = "2026-10-05";
const SEPT = { from: "2026-09-01", to: "2026-09-30" };
/** his September pay: the It America payroll */
const HIS_PAY = 114_192;
/** the agent's Gold fee, refunded */
const CREDIT = 500;
const FEES = "Fees > Bank Fees";
const INTEREST = "Income > Interest";

let dir: string;
let bundle: DbBundle;
let fakeToday: string | undefined;
let wellsFargo: string;
let agentic: string;
let book: string;
let gold: string;

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

function post(accountId: string, postedOn: string, amountCents: number, category: string | null, raw: string): string {
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription: raw,
      normalizedDescription: raw,
      categoryId: category === null ? null : catId(category),
      merchantId: gold,
      status: "active",
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: 0 }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

/**
 * A monthly schedule on the agent's cash, on the 20th — October's still to come on Oct 5 — and the rows detection read
 * it off, linked: each a `[postedOn, category]` of the schedule's amount.
 */
function agentsSchedule(input: {
  kind: SeriesKind;
  amountCents: number;
  rows: readonly (readonly [string, string | null])[];
  userCategory?: string;
  name?: string;
}): string {
  const id = bundle.db
    .insert(recurringSeries)
    .values({
      name: input.name ?? `Gold fee refund (${input.kind})`,
      kind: input.kind,
      accountId: agentic,
      merchantId: gold,
      cadence: "monthly",
      intervalDaysAvg: 30,
      toleranceDays: 3,
      nextExpectedOn: "2026-10-20",
      nextExpectedAmountCents: input.amountCents,
      amountCentsAvg: input.amountCents,
      lastMatchedOn: input.rows.at(-1)?.[0] ?? "2026-09-20",
      status: "detected",
      userCategoryId: input.userCategory === undefined ? null : catId(input.userCategory),
    })
    .returning({ id: recurringSeries.id })
    .get().id;
  for (const [postedOn, category] of input.rows) {
    const row = post(agentic, postedOn, input.amountCents, category, input.name ?? "Gold Monthly Fee Refund");
    bundle.db.update(transactions).set({ recurringSeriesId: id }).where(eq(transactions.id, row)).run();
  }
  return id;
}

/** take a schedule and its rows back off the ledger, so the next case reads from the same start */
function drop(id: string): void {
  bundle.db.delete(transactions).where(eq(transactions.recurringSeriesId, id)).run();
  bundle.db.delete(recurringSeries).where(eq(recurringSeries.id, id)).run();
}

beforeEach(() => {
  fakeToday = process.env.MONEYAPP_FAKE_TODAY;
  process.env.MONEYAPP_FAKE_TODAY = TODAY;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-agents-credit-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);

  const wf = bundle.db.insert(institutions).values({ name: "Wells Fargo" }).returning({ id: institutions.id }).get();
  const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  wellsFargo = createAccount(bundle.db, { institutionId: wf.id, name: "Wells Fargo Everyday Checking", type: "checking" });
  agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
  // the agent's brokerage book, paired with its cash account — what makes Agentic's money the agent's
  book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
  bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
  gold = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Robinhood Gold")).get()!.id;

  addManualAnchor(bundle.db, { accountId: wellsFargo, anchoredOn: "2026-08-31", enteredCents: 392_640 });
  addManualAnchor(bundle.db, { accountId: agentic, anchoredOn: "2026-08-31", enteredCents: 2_664 });
  post(wellsFargo, "2026-09-24", HIS_PAY, "Income > Salary", "It America LLC Payroll 260924");
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (fakeToday === undefined) delete process.env.MONEYAPP_FAKE_TODAY;
  else process.env.MONEYAPP_FAKE_TODAY = fakeToday;
});

/** Everything the forecast says this month and next: his figures, the agent's two notes, and EOM net worth. */
function read() {
  const oct = forecastCurrentMonth(bundle.db, TODAY);
  const nov = forecastForMonth(bundle.db, "2026-11", TODAY)!;
  const his = (f: typeof oct) => ({
    components: f.components,
    committed: [f.committed.incomeCents, f.committed.spendCents, f.committed.netCents, f.committed.eomCashCents],
    pace: [f.projectedIncomeCents, f.projectedSpendCents, f.projectedNetCents, f.projectedEomCashCents],
  });
  return {
    his: [his(oct), his(nov)],
    costs: [oct.agentsCosts, nov.agentsCosts],
    income: [oct.agentsIncome, nov.agentsIncome],
    nw: [
      oct.committed.eomNetWorthCents,
      oct.projectedEomNetWorthCents,
      nov.committed.eomNetWorthCents,
      nov.projectedEomNetWorthCents,
    ],
  };
}

type Notes = ReturnType<typeof read>["costs"];

/** a note `cents` higher on both readings: October's occurrence, and November chaining it with its own */
const plus = (notes: Notes, cents: number): Notes => [
  { netCents: notes[0]!.netCents + cents, committedNetCents: notes[0]!.committedNetCents + cents },
  { netCents: notes[1]!.netCents + 2 * cents, committedNetCents: notes[1]!.committedNetCents + 2 * cents },
];

/** EOM net worth, every reading, as it moves by a schedule of `cents` a month — whichever note names the money */
const nwPlus = (nw: readonly number[], cents: number): number[] => [
  nw[0]! + cents,
  nw[1]! + cents,
  nw[2]! + 2 * cents,
  nw[3]! + 2 * cents,
];

describe("a scheduled credit to the agent's cash is named by its category", () => {
  test("⚖️ a refund filed in Fees nets inside the agent's costs — whatever kind detection gave the schedule", () => {
    const before = read();
    for (const kind of ["other", "bill", "subscription", "income"] as const) {
      const id = agentsSchedule({ kind, amountCents: CREDIT, rows: [["2026-09-20", FEES]] });
      const after = read();
      expect(after.costs, kind).toEqual(plus(before.costs, CREDIT));
      expect(after.income, kind).toEqual(before.income);
      // ⛔ EOM net worth adds both notes, so it moves by the credit exactly as it did when the credit was "income"
      expect(after.nw, kind).toEqual(nwPlus(before.nw, CREDIT));
      // …and no figure of his moves
      expect(after.his, kind).toEqual(before.his);
      drop(id);
    }
  });

  test("⚖️ …an income-kind one stays the agent's income", () => {
    const before = read();
    for (const kind of ["other", "income"] as const) {
      const id = agentsSchedule({ kind, amountCents: CREDIT, rows: [["2026-09-20", INTEREST]] });
      const after = read();
      expect(after.income, kind).toEqual(plus(before.income, CREDIT));
      expect(after.costs, kind).toEqual(before.costs);
      expect(after.nw, kind).toEqual(nwPlus(before.nw, CREDIT));
      expect(after.his, kind).toEqual(before.his);
      drop(id);
    }
  });

  /*
   * An unfiled schedule names no category, so it goes as the forecast's rows go: the agent's unfiled money out is its
   * cost (`agentsCostBucket`, owner decision 2026-10-05), and money in is what its cash is paid — the note an unfiled
   * credit has always landed in.
   */
  test("an unfiled one — no category, or the system \"Uncategorized\" — follows the rows: in is income, out is a cost", () => {
    const before = read();
    for (const category of [null, "Uncategorized"]) {
      for (const cents of [CREDIT, -CREDIT]) {
        const shape = JSON.stringify({ category, cents });
        const id = agentsSchedule({ kind: "other", amountCents: cents, rows: [["2026-09-20", category]] });
        const after = read();
        expect(after.income, shape).toEqual(cents > 0 ? plus(before.income, cents) : before.income);
        expect(after.costs, shape).toEqual(cents < 0 ? plus(before.costs, cents) : before.costs);
        expect(after.nw, shape).toEqual(nwPlus(before.nw, cents));
        expect(after.his, shape).toEqual(before.his);
        drop(id);
      }
    }
  });

  test("the owner's category decides before the rows', as a series page names it", () => {
    const before = read();
    const filedIn = (rows: string, userCategory: string) =>
      agentsSchedule({ kind: "other", amountCents: CREDIT, rows: [["2026-09-20", rows]], userCategory });
    const toCosts = filedIn(INTEREST, FEES);
    expect(read().costs).toEqual(plus(before.costs, CREDIT));
    drop(toCosts);
    const toIncome = filedIn(FEES, INTEREST);
    expect(read().income).toEqual(plus(before.income, CREDIT));
    drop(toIncome);
  });

  test("the rows' category is the one most of them are filed in — a row not filed yet says nothing", () => {
    const before = read();
    // unfiled is NULL or the system "Uncategorized" category (`CategoryIndex.isUncategorized`): three, and one Fees
    const fees = agentsSchedule({
      kind: "other",
      amountCents: CREDIT,
      rows: [["2026-06-20", null], ["2026-07-20", "Uncategorized"], ["2026-08-20", "Uncategorized"], ["2026-09-20", FEES]],
    });
    expect(read().costs).toEqual(plus(before.costs, CREDIT));
    drop(fees);
    const interest = agentsSchedule({
      kind: "other",
      amountCents: CREDIT,
      rows: [["2026-07-20", INTEREST], ["2026-08-20", INTEREST], ["2026-09-20", FEES]],
    });
    expect(read().income).toEqual(plus(before.income, CREDIT));
    drop(interest);
  });

  /*
   * 🔴 The arrears leg asked the KIND before the sign (the old `isAgentsCostSeries`): an agent's schedule detection
   * called "income" that came due money OUT, unposted, was "came due … and has not posted" — a bill of HIS on the card,
   * in his Spending and Net. Every schedule on the agent's cash is the agent's, and the one rule names its note.
   */
  test("⛔ a schedule of the agent's that came due unposted is no line of his, whatever kind detection gave it", () => {
    const before = read();
    const id = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Gold fee clawback",
        kind: "income",
        accountId: agentic,
        cadence: "monthly",
        intervalDaysAvg: 30,
        toleranceDays: 3,
        nextExpectedOn: "2026-10-01",
        nextExpectedAmountCents: -CREDIT,
        amountCentsAvg: -CREDIT,
        lastMatchedOn: "2026-09-01",
        status: "detected",
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    const after = read();
    expect(after.his).toEqual(before.his);
    // October's came due on the 1st and is the agent's to pay; November chains it with its own Nov 1
    expect(after.costs).toEqual(plus(before.costs, -CREDIT));
    expect(after.nw).toEqual(nwPlus(before.nw, -CREDIT));
    drop(id);
  });
});

/** Net worth from the app's own chain, so the test never invents its own. */
function nwOn(day: string): number {
  let cents = 0;
  for (const p of netWorthSeries(bundle.db)) {
    if (p.day > day) break;
    cents = p.totalCents;
  }
  return cents;
}

describe("one rule with the bridge: the note a schedule lands in is the band its row lands on", () => {
  test("⚖️ September's posted refund nets inside \"Agent's costs\" on the bridge, and October's inside the card's", () => {
    const before = read();
    agentsSchedule({ kind: "other", amountCents: CREDIT, rows: [["2026-09-20", FEES]] });
    for (const a of bundle.db.select({ id: accounts.id }).from(accounts).all()) rebuildAccount(bundle.db, a.id);
    const bridge = netWorthAttribution(bundle.db, "2026-08-31", SEPT.to, nwOn("2026-08-31"), nwOn(SEPT.to));
    expect(Object.fromEntries(bridge.bands.map((b) => [b.key, b.cents]))).toMatchObject({
      agentCosts: CREDIT,
      agentIncome: 0,
      refunds: 0,
    });
    expect(bridge.closes).toBe(true);
    expect(read().costs).toEqual(plus(before.costs, CREDIT));
  });

  /*
   * Every category kind a row of the agent's can carry, either sign. Where the bridge names a band, the schedule's note
   * is that band; where it names none — the bridge's Moved: an unfiled row, a transfer — the forecast has no Moved note,
   * and EOM net worth must still count the money, so it goes by its sign. ⚖️ An income-kind clawback is no longer one of
   * them: it lowers the agent's income (owner decision 2026-10-06, §6A 43).
   */
  test("the table, at its home: `agentsSeriesBand` asks `agentsBand`, and its sign only where the bridge says Moved", () => {
    const idx = loadCategoryIndex(bundle.db);
    const agentsCash = outsidePortfolioCashAccountIds(bundle.db);
    const cases: [string | null, number, "agentIncome" | "agentCosts" | null, "agentIncome" | "agentCosts"][] = [
      [FEES, CREDIT, "agentCosts", "agentCosts"],
      [FEES, -CREDIT, "agentCosts", "agentCosts"],
      [INTEREST, CREDIT, "agentIncome", "agentIncome"],
      [INTEREST, -CREDIT, "agentIncome", "agentIncome"],
      ["Transfers > Investment Contribution", CREDIT, null, "agentIncome"],
      ["Transfers > Investment Contribution", -CREDIT, null, "agentCosts"],
      ["Uncategorized", CREDIT, null, "agentIncome"],
      ["Uncategorized", -CREDIT, null, "agentCosts"],
      [null, CREDIT, null, "agentIncome"],
      [null, -CREDIT, null, "agentCosts"],
    ];
    for (const [category, amountCents, row, schedule] of cases) {
      const categoryId = category === null ? null : catId(category);
      const shape = JSON.stringify({ category, amountCents });
      // a row of either sign: the band never asks it (`agentsBand` takes no amount), so the table says so
      const posted = { accountId: agentic, categoryId, amountCents };
      expect(agentsBand(idx, agentsCash, posted), shape).toBe(row);
      const series = { kind: "other" as const, accountId: agentic, userAmountCents: null, nextExpectedAmountCents: amountCents };
      expect(agentsSeriesBand(idx, agentsCash, series, categoryId), shape).toBe(schedule);
      // ⛔ his: no band of the agent's, on his account or with no account at all
      expect(agentsBand(idx, agentsCash, { ...posted, accountId: wellsFargo }), shape).toBeNull();
      expect(agentsSeriesBand(idx, agentsCash, { ...series, accountId: wellsFargo }, categoryId), shape).toBeNull();
      expect(agentsSeriesBand(idx, agentsCash, { ...series, accountId: null }, categoryId), shape).toBeNull();
      // …and a transfer schedule is nobody's income or spending (`seriesIsIncomeOrSpending`)
      expect(agentsSeriesBand(idx, agentsCash, { ...series, kind: "transfer" }, categoryId), shape).toBeNull();
    }
    // the owner's amount decides the sign before detection's (`seriesAmountCents`)
    const reversed = { kind: "other" as const, accountId: agentic, userAmountCents: -CREDIT, nextExpectedAmountCents: CREDIT };
    expect(agentsSeriesBand(idx, agentsCash, reversed, null)).toBe("agentCosts");
  });

  test("the rule's own edge: unpaired, the account is his, and so is every schedule and row of it", () => {
    bundle.db.update(accounts).set({ cashAccountId: null }).where(eq(accounts.id, book)).run();
    const idx = loadCategoryIndex(bundle.db);
    const agentsCash = outsidePortfolioCashAccountIds(bundle.db);
    const categoryId = catId(FEES);
    expect(agentsBand(idx, agentsCash, { accountId: agentic, categoryId })).toBeNull();
    const series = { kind: "other" as const, accountId: agentic, userAmountCents: null, nextExpectedAmountCents: CREDIT };
    expect(agentsSeriesBand(idx, agentsCash, series, categoryId)).toBeNull();
  });
});

/**
 * ⚖️ Owner decision 2026-10-06 (§6A 43): a schedule of the agent's filed in an INCOME category that takes money OUT — a
 * clawback of interest it was paid — LOWERS the agent's income. The category decides, as it does for a refund of the
 * agent's fee (§6A 39). 🔴 The forecast netted it inside "Agent's costs" by its sign, and the bridge kept the posted row
 * in "Moved": one clawback, a cost on the card and a transfer on the bridge. EOM net worth adds both notes, so it moves
 * by the clawback exactly as it did — only the note that names the money moves.
 *
 * His ledger holds none of it (the agent's cash carries no income row yet), so the rows are hypothetical: $5.00 of
 * interest taken back on the 20th, filed where interest is filed (Income > Interest).
 *
 * ⛔ HIS clawback is not this: a debit that claws back earlier pay of his stays in "Moved" on the bridge, and the Income
 * band is his money in, only (docs/income-ground-truth.md).
 */
describe("§6A 43 — a clawback filed in an income category lowers the agent's income", () => {
  const CLAWBACK = -CREDIT;

  test("⚖️ the forecast nets it inside the agent's income, whatever kind detection gave the schedule", () => {
    const before = read();
    for (const kind of ["other", "bill", "subscription", "income"] as const) {
      const id = agentsSchedule({ kind, amountCents: CLAWBACK, rows: [["2026-09-20", INTEREST]], name: "Interest Clawback" });
      const after = read();
      expect(after.income, kind).toEqual(plus(before.income, CLAWBACK));
      expect(after.costs, kind).toEqual(before.costs);
      // ⛔ EOM net worth adds both notes, so it moves by the clawback exactly as it did when it was a "cost"
      expect(after.nw, kind).toEqual(nwPlus(before.nw, CLAWBACK));
      // …and no figure of his moves
      expect(after.his, kind).toEqual(before.his);
      drop(id);
    }
  });

  test("a month whose clawbacks come to more than the agent is paid nets its income below zero, on both readings", () => {
    const before = read();
    expect(before.income).toEqual([
      { netCents: 0, committedNetCents: 0 },
      { netCents: 0, committedNetCents: 0 },
    ]);
    // the agent's $0.04 of monthly interest, and $5.00 of it clawed back — both filed in Interest
    agentsSchedule({ kind: "income", amountCents: 4, rows: [["2026-09-20", INTEREST]], name: "Interest Payment" });
    agentsSchedule({ kind: "other", amountCents: CLAWBACK, rows: [["2026-09-20", INTEREST]], name: "Interest Clawback" });
    const after = read();
    expect(after.income).toEqual(plus(before.income, 4 + CLAWBACK));
    for (const month of after.income) {
      expect(month.netCents).toBeLessThan(0);
      expect(month.committedNetCents).toBeLessThan(0);
    }
    expect(after.costs).toEqual(before.costs);
    expect(after.nw).toEqual(nwPlus(before.nw, 4 + CLAWBACK));
  });

  /*
   * 🔴 The arrears leg is the forward leg's other half: it names the agent's late schedules by the same rule, and the
   * rule said "cost" for any money out it had no band for. Filed in Income, a clawback that came due on the 1st and has
   * not posted is the agent's income, lowered.
   */
  test("⛔ a clawback that came due unposted lowers the agent's income too — the arrears leg asks the same rule", () => {
    const before = read();
    const id = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Interest Clawback",
        kind: "income",
        accountId: agentic,
        cadence: "monthly",
        intervalDaysAvg: 30,
        toleranceDays: 3,
        nextExpectedOn: "2026-10-01",
        nextExpectedAmountCents: CLAWBACK,
        amountCentsAvg: CLAWBACK,
        lastMatchedOn: "2026-09-01",
        status: "detected",
        userCategoryId: catId(INTEREST),
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    const after = read();
    expect(after.his).toEqual(before.his);
    // October's came due on the 1st; November chains it with its own Nov 1
    expect(after.income).toEqual(plus(before.income, CLAWBACK));
    expect(after.costs).toEqual(before.costs);
    expect(after.nw).toEqual(nwPlus(before.nw, CLAWBACK));
    drop(id);
  });

  test("⚖️ the bridge: the posted clawback lowers \"Agent's income\" and leaves \"Moved\" as it was — his stays in Moved", () => {
    const bands = () => {
      for (const a of bundle.db.select({ id: accounts.id }).from(accounts).all()) rebuildAccount(bundle.db, a.id);
      const bridge = netWorthAttribution(bundle.db, "2026-08-31", SEPT.to, nwOn("2026-08-31"), nwOn(SEPT.to));
      expect(bridge.closes).toBe(true);
      return Object.fromEntries(bridge.bands.map((b) => [b.key, b.cents]));
    };
    post(agentic, "2026-09-30", 4, INTEREST, "Interest Payment");
    const paid = bands();
    expect(paid).toMatchObject({ earned: HIS_PAY, agentIncome: 4, agentCosts: 0 });

    post(agentic, "2026-09-20", CLAWBACK, INTEREST, "Interest Clawback");
    const clawed = bands();
    // the agent's income nets to -$4.96 — below zero, said so by its sign — and no other band moves
    expect(clawed).toEqual({ ...paid, agentIncome: 4 + CLAWBACK });

    // ⛔ his own clawback is no part of it: money out of an income category of HIS is still "Moved"
    post(wellsFargo, "2026-09-25", CLAWBACK, "Income > Salary", "It America LLC Payroll Reversal");
    expect(bands()).toEqual({ ...clawed, moved: clawed.moved! + CLAWBACK });
  });
});

/*
 * ⚖️ Owner decision 2026-10-06 (§6A 45): the AGENT'S income "at your recent pace" NETS its posted income-category
 * clawbacks, as the bridge nets them inside "Agent's income" (§6A 43) — one rule for both,
 * `isAgentsIncomeCategoryRow`: an income-category row on the agent's cash, either sign. 🔴 The pace bucketed the
 * agent's trailing rows by `isAgentsIncome`, credits only, so a clawback no live schedule owns — none detected, or one
 * he dismissed, whose rows fall to the pace — lowered the bridge's "Agent's income" and no reading on the card, EOM net
 * worth included: $4.00 paid and $3.00 clawed back each month was +$1.00 on the bridge and +$3.48 projected. ⛔ HIS
 * pace is still his money in only (`isIncome`): his clawback lowers no projection of his.
 *
 * Hypothetical rows, as above: $4.00 of interest on the 28th and $3.00 of it clawed back on the 29th, July to September,
 * all filed in Interest.
 */
describe("§6A 45 — the pace of the agent's income nets its clawbacks, as the bridge does; his stays money in", () => {
  const PAID = 400;
  const CLAWBACK = -300;
  const MONTHS = ["07", "08", "09"] as const;

  const rebuilt = () => {
    for (const a of bundle.db.select({ id: accounts.id }).from(accounts).all()) rebuildAccount(bundle.db, a.id);
  };
  const september = () => {
    rebuilt();
    const bridge = netWorthAttribution(bundle.db, "2026-08-31", SEPT.to, nwOn("2026-08-31"), nwOn(SEPT.to));
    expect(bridge.closes).toBe(true);
    return Object.fromEntries(bridge.bands.map((b) => [b.key, b.cents]));
  };
  /** what the card reads off the ledger as it stands, with the net worth today it starts from */
  const card = () => {
    rebuilt();
    return { ...read(), today: nwOn(TODAY) };
  };
  /** his lines and nets, every reading — his EOM cash also counts this fixture's agent's balance, so it is left out */
  const hisLines = (c: ReturnType<typeof card>) =>
    c.his.map((h) => ({ components: h.components, committed: h.committed.slice(0, 3), pace: h.pace.slice(0, 3) }));
  /** EOM net worth, every reading, as the pace's two move — neither committed reading has any pace in it */
  const onPace = (nw: readonly number[], october: number, november: number): number[] => [
    nw[0]!,
    nw[1]! + october,
    nw[2]!,
    nw[3]! + november,
  ];

  test("⚖️ a clawback with no schedule, or a dismissed one's, nets inside the pace as it does on the bridge", () => {
    for (const month of MONTHS) post(agentic, `2026-${month}-28`, PAID, INTEREST, "Interest Payment");
    const paid = card();
    // the card's pace: the 3-mo avg $4.00 × 27/31 days in October, and November's whole $4.00 chained on it
    expect(paid.income).toEqual([
      { netCents: 348, committedNetCents: 0 },
      { netCents: 748, committedNetCents: 0 },
    ]);
    expect(september()).toMatchObject({ agentIncome: PAID, moved: 0 });

    const clawedBy = {
      "no schedule": () => {
        const ids = MONTHS.map((month) => post(agentic, `2026-${month}-29`, CLAWBACK, INTEREST, "Interest Clawback"));
        return () => {
          for (const id of ids) bundle.db.delete(transactions).where(eq(transactions.id, id)).run();
        };
      },
      "a dismissed schedule": () => {
        const rows = MONTHS.map((month) => [`2026-${month}-29`, INTEREST] as const);
        const id = agentsSchedule({ kind: "other", amountCents: CLAWBACK, rows, name: "Interest Clawback" });
        bundle.db.update(recurringSeries).set({ status: "dismissed" }).where(eq(recurringSeries.id, id)).run();
        return () => drop(id);
      },
    };
    for (const [owner, claw] of Object.entries(clawedBy)) {
      const undo = claw();
      // §6A 43 on the bridge: September's $4.00 paid nets to +$1.00, and nothing sits in Moved
      const bridged = september();
      expect(bridged, owner).toMatchObject({ agentIncome: PAID + CLAWBACK, moved: 0 });
      const clawed = card();
      // ⚖️ …and on the card's pace: the 3-mo avg net $1.00 × 27/31 days in October, and November's whole $1.00
      expect(clawed.income, owner).toEqual([
        { netCents: 87, committedNetCents: 0 },
        { netCents: 187, committedNetCents: 0 },
      ]);
      // a whole month at the pace is what the bridge nets for September — one rule, either sign
      expect(clawed.income[1]!.netCents - clawed.income[0]!.netCents, owner).toBe(bridged.agentIncome);
      // a clawback filed in Interest is no cost of the agent's
      expect(clawed.costs, owner).toEqual(paid.costs);
      // EOM net worth: every reading moves by September's posted clawback — the net worth today it starts from — and
      // the pace's two by the agent's share alone, what its note came down by
      expect(clawed.today - paid.today, owner).toBe(CLAWBACK);
      expect(clawed.nw, owner).toEqual(onPace(paid.nw.map((cents) => cents + CLAWBACK), 87 - 348, 187 - 748));
      // ⛔ …and no figure of his moves: not his Income, not his lines, not his net
      expect(hisLines(clawed), owner).toEqual(hisLines(paid));
      undo();
    }
  });

  /*
   * ⚖️ …and when the credit it reverses is NOT on the pace. 🔴 2d27e22 netted a clawback inside its pace bucket, and the
   * pace reads only the rows no live schedule owns (`nonRecurringAllocations`): with the agent's interest a detected
   * schedule — the likeliest shape, month-end interest is regular and a clawback is not — the bucket held the clawbacks
   * alone, came to -$3.00 every month, and `projectOngoingIncome`'s presence gate dropped it. The bridge read +$1.00 and
   * the card +$4.00 on both readings, EOM net worth with it. Now the bucket projects below zero
   * (`projectOngoingNetIncome`) and the month nets it against what the agent is projected to be paid
   * (`agentsIncomeAtPace`).
   */
  test("⚖️ a clawback whose credit is a schedule's nets at the pace against the schedule — the card reads the bridge", () => {
    const rows = MONTHS.map((month) => [`2026-${month}-20`, INTEREST] as const);
    agentsSchedule({ kind: "income", amountCents: PAID, rows, name: "Interest Payment" });
    const paid = card();
    // the schedule: October's, on the 20th, still to come, and November's chained on it — on both readings
    expect(paid.income).toEqual([
      { netCents: PAID, committedNetCents: PAID },
      { netCents: 2 * PAID, committedNetCents: 2 * PAID },
    ]);
    for (const month of MONTHS) post(agentic, `2026-${month}-21`, CLAWBACK, INTEREST, "Interest Clawback");
    const bridged = september();
    expect(bridged).toMatchObject({ agentIncome: PAID + CLAWBACK, moved: 0 });
    const clawed = card();
    // ⚖️ at the pace, the clawbacks' 3-mo avg -$3.00 × 27/31 days in October, and November's whole -$3.00, against the
    // schedule's $4.00 a month; the headline is the schedule's alone, as it was
    expect(clawed.income).toEqual([
      { netCents: PAID - 261, committedNetCents: PAID },
      { netCents: 2 * PAID - 261 - 300, committedNetCents: 2 * PAID },
    ]);
    // a whole month at the pace is what the bridge nets for September
    expect(clawed.income[1]!.netCents - clawed.income[0]!.netCents).toBe(bridged.agentIncome);
    expect(clawed.costs).toEqual(paid.costs);
    expect(clawed.today - paid.today).toBe(CLAWBACK);
    expect(clawed.nw).toEqual(onPace(paid.nw.map((cents) => cents + CLAWBACK), -261, -261 - 300));
    expect(hisLines(clawed)).toEqual(hisLines(paid));
  });

  /*
   * 🔴 So too a clawback filed in an income subcategory the agent is not paid in — its pace bucket holds the clawbacks
   * alone — while the bridge's "Agent's income" is ONE band: 2d27e22 pinned it as "projects nothing", which it did with
   * the bridge at +$1.00 and the card at +$3.48.
   */
  test("⚖️ a clawback filed in Dividends nets against the agent's interest at the pace — one band on the bridge", () => {
    for (const month of MONTHS) {
      post(agentic, `2026-${month}-28`, PAID, INTEREST, "Interest Payment");
      post(agentic, `2026-${month}-29`, CLAWBACK, "Income > Dividends", "Dividend Clawback");
    }
    const bridged = september();
    expect(bridged).toMatchObject({ agentIncome: PAID + CLAWBACK, moved: 0 });
    // Interest's $4.00 and Dividends' -$3.00, each × 27/31 days in October, and November's whole month of each
    const clawed = card().income;
    expect(clawed).toEqual([
      { netCents: 348 - 261, committedNetCents: 0 },
      { netCents: 748 - 561, committedNetCents: 0 },
    ]);
    expect(clawed[1]!.netCents - clawed[0]!.netCents).toBe(bridged.agentIncome);
  });

  /*
   * ⛔ The decision is the agent's alone. His pace is his money in, only (`isIncome`, docs/income-ground-truth.md): a
   * clawback of HIS interest is in no projection of his, as it is in no Income band of the bridge (it stays "Moved").
   */
  test("⛔ his own pace stays money in only: his clawback, filed in Interest, lowers no projection of his", () => {
    for (const month of MONTHS) post(wellsFargo, `2026-${month}-28`, PAID, INTEREST, "Interest Payment");
    const paid = card();
    // his Interest line: the credits' 3-mo avg $4.00 × 27/31 days in October
    expect(paid.his[0]!.components).toContainEqual(expect.objectContaining({ label: "Interest", cents: 348 }));
    for (const month of MONTHS) post(wellsFargo, `2026-${month}-29`, CLAWBACK, INTEREST, "Interest Clawback");
    const clawed = card();
    // …still, and his Income, Spending and Net with it, on both readings
    expect(hisLines(clawed)).toEqual(hisLines(paid));
    // his clawback is in neither of the agent's notes
    expect([clawed.income, clawed.costs]).toEqual([paid.income, paid.costs]);
    // EOM net worth moves by September's posted clawback alone — the net worth today — and by nothing projected
    expect(clawed.today - paid.today).toBe(CLAWBACK);
    expect(clawed.nw).toEqual(paid.nw.map((cents) => cents + CLAWBACK));
    expect(september()).toMatchObject({ agentIncome: 0 });
  });

  /*
   * ⚖️ Owner decision 2026-10-07 (§6A 46): the agent's pace FOLLOWS THE BRIDGE BELOW ZERO. 🔴 It netted the agent's
   * posted clawbacks against what the month projects the agent is paid down to ZERO, never below
   * (`agentsIncomeAtPace`): $4.00 paid and $5.00 clawed back each month was -$1.00 on the bridge's "Agent's income" and
   * $0 at "your recent pace" — EOM net worth with it. Now a whole month at the pace is what the bridge nets, either sign.
   * ⛔ His pace is still his money in only (`isIncome`).
   */
  test("⚖️ clawed back more than it is paid, the agent's income goes below zero at the pace, as on the bridge", () => {
    const before = card();
    for (const month of MONTHS) {
      post(agentic, `2026-${month}-28`, PAID, INTEREST, "Interest Payment");
      post(agentic, `2026-${month}-29`, -PAID - 100, INTEREST, "Interest Clawback");
    }
    const bridged = september();
    expect(bridged).toMatchObject({ agentIncome: -100, moved: 0 });
    const clawed = card();
    // the 3-mo avg net -$1.00 × 27/31 days in October, and November's whole -$1.00 chained on it
    expect(clawed.income).toEqual([
      { netCents: -87, committedNetCents: 0 },
      { netCents: -187, committedNetCents: 0 },
    ]);
    // a whole month at the pace is what the bridge nets for September
    expect(clawed.income[1]!.netCents - clawed.income[0]!.netCents).toBe(bridged.agentIncome);
    // EOM net worth: September's posted -$1.00 in the net worth today (July's and August's sit under the agent's
    // Aug 31 balance), and the pace's two below it
    expect(clawed.today - before.today).toBe(-100);
    expect(clawed.nw).toEqual(onPace(before.nw.map((cents) => cents - 100), -87, -187));
    // ⛔ …and no figure of his moves
    expect(hisLines(clawed)).toEqual(hisLines(before));
  });

  test("⚖️ …and with its interest a schedule's: the headline reads the schedule, the pace nets below zero", () => {
    const rows = MONTHS.map((month) => [`2026-${month}-20`, INTEREST] as const);
    agentsSchedule({ kind: "income", amountCents: PAID, rows, name: "Interest Payment" });
    for (const month of MONTHS) post(agentic, `2026-${month}-21`, -PAID - 100, INTEREST, "Interest Clawback");
    const bridged = september();
    expect(bridged).toMatchObject({ agentIncome: -100, moved: 0 });
    // the schedule's $4.00 a month against the clawbacks' 3-mo avg -$5.00 × 27/31 days in October (-$4.35), and
    // November's whole -$5.00
    const clawed = card().income;
    expect(clawed).toEqual([
      { netCents: PAID - 435, committedNetCents: PAID },
      { netCents: 2 * PAID - 435 - 500, committedNetCents: 2 * PAID },
    ]);
    expect(clawed[1]!.netCents - clawed[0]!.netCents).toBe(bridged.agentIncome);
  });

  test("⚖️ …and a month its schedules already take below zero (§6A 43): the pace's clawbacks take it lower", () => {
    agentsSchedule({ kind: "other", amountCents: -500, rows: [["2026-09-20", INTEREST]], name: "Interest Clawback" });
    expect(card().income).toEqual([
      { netCents: -500, committedNetCents: -500 },
      { netCents: -1000, committedNetCents: -1000 },
    ]);
    for (const month of MONTHS) post(agentic, `2026-${month}-21`, CLAWBACK, INTEREST, "Interest Adjustment");
    const bridged = september();
    expect(bridged).toMatchObject({ agentIncome: -500 + CLAWBACK, moved: 0 });
    // the schedule's -$5.00 a month, and the adjustments' 3-mo avg -$3.00 × 27/31 days in October, November's whole
    const clawed = card().income;
    expect(clawed).toEqual([
      { netCents: -500 - 261, committedNetCents: -500 },
      { netCents: -1000 - 261 - 300, committedNetCents: -1000 },
    ]);
    expect(clawed[1]!.netCents - clawed[0]!.netCents).toBe(bridged.agentIncome);
  });
});
