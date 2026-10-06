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
}): string {
  const id = bundle.db
    .insert(recurringSeries)
    .values({
      name: `Gold fee refund (${input.kind})`,
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
    const row = post(agentic, postedOn, input.amountCents, category, "Gold Monthly Fee Refund");
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
   * is that band; where it names none — the bridge's Moved: an unfiled row, a transfer, an income-kind clawback — the
   * forecast has no Moved note, and EOM net worth must still count the money, so it goes by its sign.
   */
  test("the table, at its home: `agentsSeriesBand` asks `agentsBand`, and its sign only where the bridge says Moved", () => {
    const idx = loadCategoryIndex(bundle.db);
    const agentsCash = outsidePortfolioCashAccountIds(bundle.db);
    const cases: [string | null, number, "agentIncome" | "agentCosts" | null, "agentIncome" | "agentCosts"][] = [
      [FEES, CREDIT, "agentCosts", "agentCosts"],
      [FEES, -CREDIT, "agentCosts", "agentCosts"],
      [INTEREST, CREDIT, "agentIncome", "agentIncome"],
      [INTEREST, -CREDIT, null, "agentCosts"],
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
      expect(agentsBand(idx, agentsCash, { accountId: agentic, categoryId, amountCents }), shape).toBe(row);
      const series = { kind: "other" as const, accountId: agentic, userAmountCents: null, nextExpectedAmountCents: amountCents };
      expect(agentsSeriesBand(idx, agentsCash, series, categoryId), shape).toBe(schedule);
      // ⛔ his: no band of the agent's, on his account or with no account at all
      expect(agentsBand(idx, agentsCash, { accountId: wellsFargo, categoryId, amountCents }), shape).toBeNull();
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
    expect(agentsBand(idx, agentsCash, { accountId: agentic, categoryId, amountCents: CREDIT })).toBeNull();
    const series = { kind: "other" as const, accountId: agentic, userAmountCents: null, nextExpectedAmountCents: CREDIT };
    expect(agentsSeriesBand(idx, agentsCash, series, categoryId)).toBeNull();
  });
});
