import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadSpendingCategoryTxns } from "@/app/spending/actions";
import { parseFilters } from "@/components/transactions/query";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries, type Cadence, type SeriesKind } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { ATTRIBUTION_BAND_LABEL, ATTRIBUTION_BAND_MEANING, ATTRIBUTION_BAND_ORDER } from "@/lib/attribution";
import { dedupeHash } from "@/lib/hash";
import { cashFlowSegmentHref } from "@/lib/ledger-href";
import { resolvePeriod } from "@/lib/period";
import { createAccount, outsidePortfolioCashAccountIds } from "./accounts";
import {
  categoryBreakdown,
  categorySpending,
  isAgentsCostCategoryRow,
  loadCategoryIndex,
  monthlySpending,
  spendingBucket,
} from "./analytics";
import { addManualAnchor } from "./anchors";
import { netWorthAttribution } from "./attribution";
import { budgetPaceStatuses, budgetStatuses, createBudget } from "./budgets";
import { predictCategory } from "./category-forecast";
import { categoryFlowSign, categoryMonthlyTrend, categorySubcategorySplit, seriesInCategory } from "./category-detail";
import { runwayCard } from "./committed";
import { dashboardData } from "./dashboard";
import { netWorthSeries, rebuildAccount } from "./derivation";
import { eatingOutCard } from "./eating-out";
import { feesCard } from "./fees-card";
import { forecastCurrentMonth, forecastForMonth } from "./forecast";
import { merchantInsightInput } from "./merchant-insights";
import { merchantIntelligence } from "./merchants";
import { noticesCard } from "./notices-card";
import { ledgerOpens, ledgerReaches } from "./observation-frontier";
import { periodActivity } from "./period-activity";
import { provenanceFor } from "./provenance";
import { upcomingOccurrences } from "./recurring";
import { calendarMonthFlow, recurringCalendar } from "./recurring-calendar";
import { recurringInsightInput } from "./recurring-insights";
import { spendingSankey } from "./sankey";
import { subscriptionsCard } from "./subscriptions-card";
import { cashFlowByPeriod, dailySpendHeatmap, largestTransactions, periodTotals, topMerchants } from "./spending";
import { matchingTransactionIds } from "./transactions-query";
import { setSplits } from "./transaction-splits";
import { spendingCoverageThrough } from "./movers-card";

/**
 * ⚖️ Owner decision 2026-10-02 (§6A 34): what the AGENT'S account PAYS — a fee, or any other expense charged to its
 * cash — is not HIS spending, as what it is paid is not his income (§6A 27). Not /spending's Spent (its card, chart,
 * heatmap and Sankey), not the dashboard's Fees card, and not any surface that says spent or spending: /budgets,
 * /categories/<expense>, the dashboard's period panel, the forecast's pace, the merchants. The net-worth bridge is the
 * exception, as it was for the income: net worth holds the agent's money, so the bridge names what it paid on a band
 * of its own, "Agent's costs", beside "Agent's income".
 *
 * His ledger holds none of it yet (Robinhood Agentic carries one transfer row, and no book is paired), so this fixture
 * is the proof. His rows are the agents-income fixture's real lines; the agent's cost is Robinhood's monthly Gold fee as
 * its activity report prints it — "Gold Monthly Fee", trans code GOLD, ($5.00) on the 1st
 * (tests/fixtures/synthetic/robinhood) — filed where the importer files that code (`RH_CODE_CATEGORY`: Fees > Bank
 * Fees), at the seed's own "Robinhood Gold" merchant.
 */

const TODAY = "2026-10-05";
const SEPT = { from: "2026-09-01", to: "2026-09-30" };
/** his September pay: the It America payroll */
const HIS_PAY = 114_192;
/** his September fee: "Non-Wells Fargo ATM Transaction Fee", the review's $15.00 */
const HIS_FEE = 1_500;
/** the agent's September cost: Robinhood's Gold fee, charged to the agent's cash */
const AGENTS_FEE = 500;

let dir: string;
let bundle: DbBundle;
let fakeToday: string | undefined;
let wellsFargo: string;
let robinhoodCash: string;
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

function post(
  accountId: string,
  postedOn: string,
  amountCents: number,
  category: string | null,
  raw: string,
  merchantId: string | null = null,
): void {
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription: raw,
      normalizedDescription: raw,
      categoryId: category === null ? null : catId(category),
      merchantId,
      status: "active",
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: 0 }),
    })
    .run();
}

/** the agent's Gold fee on the 1st of a month, as the activity report prints it */
function goldFee(postedOn: string): void {
  post(agentic, postedOn, -AGENTS_FEE, "Fees > Bank Fees", "Gold Monthly Fee", gold);
}

/** the rule's own edge: with no book paired, Agentic is a cash account like any other, and its money is his */
function unpair(): void {
  bundle.db.update(accounts).set({ cashAccountId: null }).where(eq(accounts.id, book)).run();
}

beforeEach(() => {
  fakeToday = process.env.MONEYAPP_FAKE_TODAY;
  process.env.MONEYAPP_FAKE_TODAY = TODAY;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-agents-costs-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);

  const wf = bundle.db.insert(institutions).values({ name: "Wells Fargo" }).returning({ id: institutions.id }).get();
  const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  wellsFargo = createAccount(bundle.db, { institutionId: wf.id, name: "Wells Fargo Everyday Checking", type: "checking" });
  robinhoodCash = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Cash", type: "checking" });
  agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
  // the agent's brokerage book, paired with its cash account — what makes Agentic's money the agent's
  book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
  bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
  gold = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Robinhood Gold")).get()!.id;

  // the three balances his ledger reads on 2026-08-31
  addManualAnchor(bundle.db, { accountId: wellsFargo, anchoredOn: "2026-08-31", enteredCents: 392_640 });
  addManualAnchor(bundle.db, { accountId: robinhoodCash, anchoredOn: "2026-08-31", enteredCents: 100_101 });
  addManualAnchor(bundle.db, { accountId: agentic, anchoredOn: "2026-08-31", enteredCents: 2_664 });

  post(wellsFargo, "2026-09-24", HIS_PAY, "Income > Salary", "It America LLC Payroll 260924");
  post(wellsFargo, "2026-09-01", -HIS_FEE, "Fees > ATM Fees", "Non-Wells Fargo ATM Transaction Fee");
  goldFee("2026-09-01");
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (fakeToday === undefined) delete process.env.MONEYAPP_FAKE_TODAY;
  else process.env.MONEYAPP_FAKE_TODAY = fakeToday;
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

/** The rows a `/transactions` link opens — the ledger's own filter, as the page and its bulk actions select them. */
function opened(href: string): { accountId: string; amountCents: number }[] {
  const filters = parseFilters(Object.fromEntries(new URL(href, "http://ledger.test").searchParams));
  return bundle.db
    .select({ accountId: transactions.accountId, amountCents: transactions.amountCents })
    .from(transactions)
    .where(inArray(transactions.id, matchingTransactionIds(bundle.db, filters, "all")))
    .all();
}

const sum = (rows: readonly { amountCents: number }[]) => rows.reduce((s, r) => s + r.amountCents, 0);

describe("the agent's costs are not his spending — on every surface that says Spent", () => {
  test("⛔ /spending: the Spent card, the cash-flow chart and the heatmap leave it out", () => {
    expect(periodTotals(bundle.db, SEPT)).toMatchObject({ spentCents: HIS_FEE, refundsCents: 0, earnedCents: HIS_PAY });

    const flow = cashFlowByPeriod(bundle.db, resolvePeriod({ period: "2026-09" }, TODAY), TODAY);
    expect(flow.totals.spentCents).toBe(HIS_FEE);
    expect(flow.spendingSeries.map((s) => s.label)).toEqual(["Fees"]);
    expect(flow.buckets.find((b) => b.key === "2026-09-01")!.spendingCents).toBe(HIS_FEE);

    // the day both were charged: his fee is the day's spending, and the agent's Gold fee is no part of it
    const day = dailySpendHeatmap(bundle.db, "2026-09").days.find((d) => d.iso === "2026-09-01")!;
    expect([day.spentCents, day.txnCount, day.refundedCents]).toEqual([HIS_FEE, 1, 0]);
    expect(day.topMerchants.map((m) => m.name)).not.toContain("Robinhood Gold");

    // …and the proof under the Spent card names the rows it sums: his one fee, never the agent's
    expect(provenanceFor(bundle.db, { kind: "allSpend", ...SEPT })?.headline).toMatch(/the sum of 1 row /);
  });

  test("⛔ the Sankey's spending is his alone, and its hub still balances", () => {
    const graph = spendingSankey(bundle.db, SEPT);
    const spend = graph.nodes.filter((n) => n.meta?.kind === "category");
    expect(spend.map((n) => [n.label, graph.links.find((l) => l.target === n.id)!.valueCents])).toEqual([
      ["Fees", HIS_FEE],
    ]);
    // what he earned less what he spent was saved — the agent's fee came out of the agent's money, not his
    expect(graph.links.find((l) => l.target === "saved")!.valueCents).toBe(HIS_PAY - HIS_FEE);
  });

  test("⛔ the dashboard's period panel and every analytics grid leave it out", () => {
    const panel = periodActivity(bundle.db, SEPT.from, SEPT.to, 10).summary;
    expect(panel.outCents).toBe(HIS_FEE);
    expect(panel.topCategories.map((c) => [c.name, c.spentCents])).toEqual([["Fees", HIS_FEE]]);

    // the stacked bars, the movers' grid and the runway's baseline all read this one
    const cells = monthlySpending(bundle.db, { months: 1, refDate: SEPT.to });
    expect(cells.map((c) => [c.categoryName, c.spentCents, c.txnCount])).toEqual([["Fees", HIS_FEE, 1]]);
    // /spending's category table and its insights: Fees is his ATM fee, and Bank Fees no child of it
    const [fees] = categoryBreakdown(bundle.db, SEPT);
    expect([fees!.name, fees!.spentCents, fees!.txnCount]).toEqual(["Fees", HIS_FEE, 1]);
    expect(fees!.children.map((c) => [c.name, c.spentCents])).toEqual([["ATM Fees", HIS_FEE]]);
  });

  test("⛔ the Spent, Net and segment links open exactly the rows behind them — the agent's are not among them", () => {
    const spent = opened(`/transactions?category=spending&from=${SEPT.from}&to=${SEPT.to}`);
    expect(sum(spent)).toBe(-periodTotals(bundle.db, SEPT).spentCents);
    expect(spent.some((r) => r.accountId === agentic)).toBe(false);
    // the Net card's population is spending ∪ income, and the agent's cost is in neither
    expect(sum(opened(`/transactions?category=cashflow&from=${SEPT.from}&to=${SEPT.to}`))).toBe(HIS_PAY - HIS_FEE);

    // the Sankey's spending node and the cash-flow chart's Fees segment
    const graph = spendingSankey(bundle.db, SEPT);
    const node = graph.nodes.find((n) => n.meta?.kind === "category")!;
    expect(sum(opened(node.href!))).toBe(-HIS_FEE);
    const flow = cashFlowByPeriod(bundle.db, resolvePeriod({ period: "2026-09" }, TODAY), TODAY);
    const series = flow.spendingSeries[0]!;
    const bucket = flow.buckets.find((b) => b.key === "2026-09-01")!;
    expect(sum(opened(cashFlowSegmentHref(series.key, series.categoryId, bucket, "out")))).toBe(-bucket.spending[series.key]!);
  });

  test("⛔ /spending's merchants and largest purchases are his — Robinhood Gold is no merchant he spends at", () => {
    const top = topMerchants(bundle.db, SEPT);
    expect(top.entries.map((e) => e.name)).not.toContain("Robinhood Gold");
    expect(top.linkedCount).toBe(0);
    expect(largestTransactions(bundle.db, SEPT).map((t) => t.amountCents)).toEqual([-HIS_FEE]);
  });
});

/**
 * `/categories/[id]`'s transaction panel: the server action the page awaits, which reads through `getDb()`. Pointed at
 * this fixture for the one call and handed back, so nothing else can reach it.
 */
async function categoryPanel(categoryId: string) {
  const handle = globalThis as { __moneyappDb?: DbBundle };
  const prior = handle.__moneyappDb;
  handle.__moneyappDb = bundle;
  try {
    const result = await loadSpendingCategoryTxns({ categoryId, ...SEPT });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  } finally {
    if (prior === undefined) delete handle.__moneyappDb;
    else handle.__moneyappDb = prior;
  }
}

/** `/categories/<path>?period=2026-09`: every figure read the way the page reads it, in the page's own frame. */
async function categoryPage(pathStr: string) {
  const id = catId(pathStr);
  const sign = categoryFlowSign("expense");
  const { spentCents, txnCount } = categorySpending(bundle.db, { categoryId: id, ...SEPT });
  const reaches = ledgerReaches(bundle.db);
  const [bar] = categoryMonthlyTrend(bundle.db, id, 1, SEPT.to, reaches, ledgerOpens(bundle.db), TODAY);
  const name = pathStr.split(" > ").at(-1)!;
  return {
    spent: sign * spentCents + 0,
    txnCount,
    bar: { cents: sign * bar!.spentCents + 0, href: bar!.href },
    subcategories: categorySubcategorySplit(bundle.db, id, SEPT),
    panel: await categoryPanel(id),
    merchants: topMerchants(bundle.db, SEPT, 8, { categoryId: id }).entries.map((e) => e.name),
    proof: provenanceFor(bundle.db, { kind: "categorySpend", categoryId: id, ...SEPT, label: name })?.headline,
  };
}

describe("the agent's costs are no row of his on an expense category's own page", () => {
  test("⛔ Spent, its trend, subcategories, rows, merchants and proof are his alone — and every link opens them", async () => {
    const fees = await categoryPage("Fees");
    expect([fees.spent, fees.txnCount, fees.bar.cents]).toEqual([HIS_FEE, 1, HIS_FEE]);
    expect(fees.subcategories.map((s) => [s.name, s.flowCents, s.txnCount])).toEqual([["ATM Fees", HIS_FEE, 1]]);
    expect([fees.panel.total, sum(fees.panel.rows)]).toEqual([1, -HIS_FEE]);
    expect(fees.merchants).not.toContain("Robinhood Gold");
    expect(fees.proof).toMatch(/^This total is the sum of 1 row /);
    const links: [string, number][] = [
      [fees.bar.href, -fees.bar.cents],
      [fees.panel.href, -fees.spent],
      ...fees.subcategories.map((s): [string, number] => [s.href!, -s.flowCents]),
    ];
    for (const [href, cents] of links) {
      const rows = opened(href);
      expect(sum(rows), href).toBe(cents);
      expect(rows.some((r) => r.accountId === agentic), href).toBe(false);
    }

    // September's only Bank Fee is the agent's Gold fee: his Bank Fees page has none to show
    const bank = await categoryPage("Fees > Bank Fees");
    expect([bank.spent, bank.txnCount, bank.bar.cents, bank.panel.total]).toEqual([0, 0, 0, 0]);
    expect(opened(bank.panel.href)).toEqual([]);
    expect(opened(bank.bar.href)).toEqual([]);
    expect(bank.merchants).toEqual([]);
    expect(bank.proof).not.toMatch(/the sum of/);
  });

  test("⛔ /budgets: a Fees budget is graded on his fees alone", () => {
    createBudget(bundle.db, { categoryId: catId("Fees"), period: "monthly", amountCents: 5_000, startsOn: SEPT.from });
    createBudget(bundle.db, { categoryId: catId("Fees > Bank Fees"), period: "monthly", amountCents: 1_000, startsOn: SEPT.from });
    const spent = Object.fromEntries(budgetStatuses(bundle.db, SEPT.to).map((s) => [s.categoryName, s.spentCents]));
    expect(spent).toEqual({ Fees: HIS_FEE, "Bank Fees": 0 });
  });

  test("the rule's own edge: unpaired, the account is his, and so is every row of it on the page", async () => {
    unpair();
    const fees = await categoryPage("Fees");
    expect([fees.spent, fees.txnCount]).toEqual([HIS_FEE + AGENTS_FEE, 2]);
    expect(fees.subcategories.map((s) => [s.name, s.flowCents])).toEqual([
      ["ATM Fees", HIS_FEE],
      ["Bank Fees", AGENTS_FEE],
    ]);
    expect(sum(opened(fees.panel.href))).toBe(-(HIS_FEE + AGENTS_FEE));
    expect(fees.merchants).toContain("Robinhood Gold");
    expect(periodTotals(bundle.db, SEPT).spentCents).toBe(HIS_FEE + AGENTS_FEE);
    const spent = opened(`/transactions?category=spending&from=${SEPT.from}&to=${SEPT.to}`);
    expect(sum(spent)).toBe(-(HIS_FEE + AGENTS_FEE));
  });
});

describe("the agent's fee is no fee the banks charged him", () => {
  /*
   * The Fees card sets the `Fees` taxonomy against the interest the banks paid "across every account" — and §6A 27
   * already took the agent's interest out of its other half. A month whose only Bank Fee was the agent's Gold fee read
   * "$20.00 went out in fees": the agent's $5.00, charged to him.
   */
  test("⛔ the Fees card's paid half is his alone, and its lines open exactly it", () => {
    const card = feesCard(bundle.db, TODAY)!;
    expect([card.recent.from, card.recent.to, card.months]).toEqual([SEPT.from, SEPT.to, 1]);
    expect([card.recent.paidCents, card.recent.paidCharges, card.allTime.paidCents]).toEqual([HIS_FEE, 1, HIS_FEE]);
    expect(card.lines.map((l) => [l.name, l.cents])).toEqual([["ATM Fees", HIS_FEE]]);
    for (const line of card.lines) expect(sum(opened(line.href)), line.name).toBe(-line.cents);

    unpair();
    const his = feesCard(bundle.db, TODAY)!;
    expect([his.recent.paidCents, his.allTime.paidCents]).toEqual([HIS_FEE + AGENTS_FEE, HIS_FEE + AGENTS_FEE]);
  });
});

describe("Robinhood Gold, charged to the agent, is no merchant of his", () => {
  /*
   * `/merchants/<id>` — "what this merchant costs a month", its rank among his regular merchants, the category it
   * charges most in — reads expense-kind rows by merchant, every account. Two Gold fees make it a regular merchant of
   * his: "the largest of your 1 regular merchants".
   */
  test("⛔ the merchant's page measures nothing of the agent's, and says nothing about it", () => {
    goldFee("2026-08-01");
    const profile = merchantIntelligence(bundle.db, gold, TODAY).profile;
    expect([profile.visitCount, profile.totalCents]).toEqual([0, 0]);
    expect(merchantInsightInput(bundle.db, gold, TODAY)).toBeNull();

    unpair();
    const his = merchantIntelligence(bundle.db, gold, TODAY).profile;
    expect([his.visitCount, his.totalCents]).toEqual([2, 2 * AGENTS_FEE]);
    expect(merchantInsightInput(bundle.db, gold, TODAY)).not.toBeNull();
  });

  /*
   * A merchant both of them pay — hypothetical: he subscribes to Gold too — is ranked, totalled and placed in a
   * category by HIS charges there. The agent's refund and a charge of the agent's filed elsewhere (Shopping, larger
   * than his Fees there) are the rule's other halves: left in, the refund comes off his total, the Shopping charge
   * makes the merchant his largest and moves "where it charges most" to a category he spent nothing in there.
   */
  test("⛔ a merchant both pay: its total, rank and category share are his charges alone", () => {
    const starbucks = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Starbucks")).get()!.id;
    post(robinhoodCash, "2026-08-01", -AGENTS_FEE, "Fees > Bank Fees", "Gold Monthly Fee", gold);
    post(robinhoodCash, "2026-09-01", -AGENTS_FEE, "Fees > Bank Fees", "Gold Monthly Fee", gold);
    post(wellsFargo, "2026-08-15", -700, "Food > Coffee", "Starbucks", starbucks);
    post(wellsFargo, "2026-09-15", -700, "Food > Coffee", "Starbucks", starbucks);
    post(agentic, "2026-09-02", AGENTS_FEE, "Fees > Bank Fees", "Gold Monthly Fee Refund", gold);
    post(agentic, "2026-09-03", -3_000, "Shopping > General", "Robinhood Gold", gold);
    const read = () => {
      const profile = merchantIntelligence(bundle.db, gold, TODAY).profile;
      const input = merchantInsightInput(bundle.db, gold, TODAY)!;
      const share = input.facts.find((f) => f.kind === "share");
      return {
        visits: profile.visitCount,
        total: profile.totalCents,
        rank: input.candidates.find((c) => c.claimId.endsWith("_in_set"))?.claimId,
        shareOf: share && "ofLabel" in share ? (/spent on (\w+)/.exec(share.ofLabel)?.[1] ?? null) : null,
      };
    };
    // his two fees: $10.00, second to his $14.00 of coffee, and 40% of his Fees over Aug 1 – Sep 1
    expect(read()).toEqual({ visits: 2, total: 1_000, rank: "ranked_in_set", shareOf: "Fees" });

    unpair();
    expect(read()).toEqual({ visits: 4, total: 4_000, rank: "largest_in_set", shareOf: "Shopping" });
  });

  /*
   * The rank and the share sentences hand the reader one proof — the merchant's rows over its first and last visit.
   * 🔴 It summed every active row at the merchant, every account and every kind: under "Robinhood Gold … $10.00" (his
   * two fees) and "40.0% of what you spent on Fees" it read "the sum of 3 rows", the agent's Sep 1 fee the third. A
   * transfer at a merchant is no visit either, so the proof leaves it out as the figure does.
   */
  test("⛔ the proof under the rank and the share counts the rows the figure counts — his, of an expense kind", () => {
    post(robinhoodCash, "2026-08-01", -AGENTS_FEE, "Fees > Bank Fees", "Gold Monthly Fee", gold);
    post(robinhoodCash, "2026-09-01", -AGENTS_FEE, "Fees > Bank Fees", "Gold Monthly Fee", gold);
    post(robinhoodCash, "2026-08-20", -2_000, "Transfers > Internal Transfer", "Robinhood Gold", gold);
    // a second regular merchant of his, so there is a rank to state
    const starbucks = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Starbucks")).get()!.id;
    post(wellsFargo, "2026-08-15", -700, "Food > Coffee", "Starbucks", starbucks);
    post(wellsFargo, "2026-09-15", -700, "Food > Coffee", "Starbucks", starbucks);
    const proofs = () => {
      const input = merchantInsightInput(bundle.db, gold, TODAY)!;
      return input.candidates.map((c) => c.prove()?.headline);
    };
    const read = proofs();
    expect(read.length).toBe(2); // the rank and the share
    for (const headline of read) expect(headline).toMatch(/^This total is the sum of 2 rows /);

    // the rule's own edge: unpaired, the agent's fee is his, a third visit, and the proof counts it
    unpair();
    for (const headline of proofs()) expect(headline).toMatch(/^This total is the sum of 3 rows /);
  });

  /*
   * /spending cuts a comparison at the day every account he spends from habitually has been imported through
   * (`spendingCoverageThrough`, the movers card's live spenders). An account that charges the agent's Gold fee every
   * month is no account he spends from, and its lag is not his.
   */
  test("⛔ the day /spending's comparisons are cut at is set by his accounts, not the agent's", () => {
    for (const month of ["2026-06", "2026-07", "2026-08"]) {
      post(wellsFargo, `${month}-01`, -HIS_FEE, "Fees > ATM Fees", "Non-Wells Fargo ATM Transaction Fee");
      goldFee(`${month}-01`);
    }
    const paired = spendingCoverageThrough(bundle.db, TODAY);
    unpair();
    const unpaired = spendingCoverageThrough(bundle.db, TODAY);
    bundle.db.delete(transactions).where(eq(transactions.accountId, agentic)).run();
    const without = spendingCoverageThrough(bundle.db, TODAY);
    expect(paired).toBe(without);
    expect(unpaired).not.toBe(without);
  });

  /*
   * The dashboard's notices read a merchant's charges, expense-kind and every account: a merchant's first charge
   * above a floor reads "<merchant> appears once in your ledger". The rule's other half, pinned on a hypothetical
   * charge large enough to clear any floor.
   */
  test("⛔ the dashboard's notices name no charge of the agent's", () => {
    // the merchant's only charge, so unpaired it is a first sighting
    bundle.db.delete(transactions).where(eq(transactions.accountId, agentic)).run();
    post(agentic, "2026-09-15", -250_000, "Fees > Bank Fees", "Gold Annual Fee", gold);
    const named = (card: ReturnType<typeof noticesCard>) => JSON.stringify(card ?? {});
    expect(named(noticesCard(bundle.db, TODAY))).not.toContain("Robinhood Gold");
    unpair();
    expect(named(noticesCard(bundle.db, TODAY))).toContain("Robinhood Gold");
  });

  /*
   * The eating-out card averages Food's children over complete months, every account. No agent buys lunch — this is
   * the rule's other half, pinned on a hypothetical charge.
   */
  test("⛔ the eating-out card's dining is his alone", () => {
    post(wellsFargo, "2026-09-12", -2_000, "Food > Dining", "Dining");
    post(agentic, "2026-09-13", -3_000, "Food > Dining", "Dining");
    const dining = (card: ReturnType<typeof eatingOutCard>) => card?.eatingOut.find((l) => l.name === "Dining")?.spentCents;
    expect(dining(eatingOutCard(bundle.db, TODAY))).toBe(2_000);
    unpair();
    expect(dining(eatingOutCard(bundle.db, TODAY))).toBe(5_000);
  });
});

describe("the agent's trailing costs are not his pace either", () => {
  /*
   * `variableComponents` bucketed spending with its own copy of the rule — the category's root kind, the system
   * category — which never asked whose account. The agent's Gold fee in each trailing month projects as HIS "Fees".
   */
  test("⛔ the forecast's pace Spending leaves the agent's fee out, and its EOM net worth keeps it", () => {
    goldFee("2026-07-01");
    goldFee("2026-08-01");
    const paired = forecastCurrentMonth(bundle.db, TODAY);
    const pairedNov = forecastForMonth(bundle.db, "2026-11", TODAY)!;
    unpair();
    const unpaired = forecastCurrentMonth(bundle.db, TODAY);
    // the agent's three fees gone altogether: the Fees line his own rows draw
    bundle.db.delete(transactions).where(eq(transactions.accountId, agentic)).run();
    const without = forecastCurrentMonth(bundle.db, TODAY);

    const fees = (f: typeof paired) => f.components.find((c) => c.label === "Fees")?.cents;
    expect(fees(paired)).toBe(fees(without));
    expect(fees(unpaired)).not.toBe(fees(without));
    expect(paired.projectedSpendCents).toBe(without.projectedSpendCents);

    // the agent's 3-mo avg $5.00 × 27/31 days, this month; chained through a whole November
    expect(paired.agentsCosts).toEqual({ netCents: -435, committedNetCents: 0 });
    expect(pairedNov.agentsCosts).toEqual({ netCents: -435 - 500, committedNetCents: 0 });
    expect(unpaired.agentsCosts).toEqual({ netCents: 0, committedNetCents: 0 });
    // …and net worth still pays it: what EOM net worth starts from is the same, paired or not
    const start = (f: typeof paired) =>
      f.projectedEomNetWorthCents - f.projectedNetCents - f.agentsIncome.netCents - f.agentsCosts.netCents;
    expect(start(paired)).toBe(start(unpaired));
    // …and November's chains October's net and both months of the agent's, from that same start
    expect(pairedNov.projectedEomNetWorthCents).toBe(
      start(paired) +
        paired.projectedNetCents +
        pairedNov.projectedNetCents +
        pairedNov.agentsIncome.netCents +
        pairedNov.agentsCosts.netCents,
    );
    expect(paired.committed).toEqual(unpaired.committed);
  });
});

describe("the net-worth bridge still counts it — on its own band", () => {
  test("⚖️ \"Agent's costs\" sits beside \"Agent's income\", holds the agent's fee, and the window still closes", () => {
    expect(ATTRIBUTION_BAND_ORDER.slice(0, 3)).toEqual(["earned", "agentIncome", "agentCosts"]);
    expect(ATTRIBUTION_BAND_LABEL.agentCosts).toBe("Agent's costs");
    expect(ATTRIBUTION_BAND_MEANING.agentCosts).toMatch(/agent's own cash account/);

    for (const a of bundle.db.select({ id: accounts.id }).from(accounts).all()) rebuildAccount(bundle.db, a.id);
    const got = netWorthAttribution(bundle.db, "2026-08-31", SEPT.to, nwOn("2026-08-31"), nwOn(SEPT.to));
    const band = Object.fromEntries(got.bands.map((b) => [b.key, b.cents]));
    expect(band).toMatchObject({
      earned: HIS_PAY,
      spent: -HIS_FEE,
      refunds: 0,
      agentCosts: -AGENTS_FEE,
      agentIncome: 0,
    });
    expect(got.deltaCents).toBe(HIS_PAY - HIS_FEE - AGENTS_FEE);
    expect([got.unexplainedCents, got.unattributedCents, got.closes]).toEqual([0, 0, true]);

    unpair();
    for (const a of bundle.db.select({ id: accounts.id }).from(accounts).all()) rebuildAccount(bundle.db, a.id);
    const his = netWorthAttribution(bundle.db, "2026-08-31", SEPT.to, nwOn("2026-08-31"), nwOn(SEPT.to));
    expect(Object.fromEntries(his.bands.map((b) => [b.key, b.cents]))).toMatchObject({
      spent: -(HIS_FEE + AGENTS_FEE),
      agentCosts: 0,
    });
    expect(his.closes).toBe(true);
  });

  /*
   * A refund of the agent's fee is the agent's as much as the fee it reverses: left in, it would be "money back" of
   * his — a Refund on /spending and the bridge — for a charge he never paid.
   */
  test("⛔ either sign: the agent's refund is the agent's too — not a Refund of his", () => {
    post(agentic, "2026-09-02", AGENTS_FEE, "Fees > Bank Fees", "Gold Monthly Fee Refund", gold);
    expect(periodTotals(bundle.db, SEPT)).toMatchObject({ spentCents: HIS_FEE, refundsCents: 0 });
    for (const a of bundle.db.select({ id: accounts.id }).from(accounts).all()) rebuildAccount(bundle.db, a.id);
    const got = netWorthAttribution(bundle.db, "2026-08-31", SEPT.to, nwOn("2026-08-31"), nwOn(SEPT.to));
    expect(Object.fromEntries(got.bands.map((b) => [b.key, b.cents]))).toMatchObject({ refunds: 0, agentCosts: 0 });
    expect(got.closes).toBe(true);
  });
});

describe("the rule's halves, at its home", () => {
  /*
   * Every row this fixture charges the agent is an expense, so no surface above can tell an expense rule from an
   * account rule. This can.
   */
  test("the account half and the category half: the $26.64 he funded the agent with is no cost of the agent's", () => {
    const idx = loadCategoryIndex(bundle.db);
    const agentsCash = outsidePortfolioCashAccountIds(bundle.db);
    const read = (txn: { accountId: string; categoryId: string | null; amountCents: number }) => [
      isAgentsCostCategoryRow(idx, agentsCash, txn),
      spendingBucket(idx, agentsCash, txn)?.categoryName ?? null,
    ];
    const fee = { accountId: agentic, categoryId: catId("Fees > Bank Fees"), amountCents: -AGENTS_FEE };
    // the agent's fee is the agent's either sign, and no bucket of his spending
    expect(read(fee)).toEqual([true, null]);
    expect(read({ ...fee, amountCents: AGENTS_FEE })).toEqual([true, null]);
    // …and on his own account the same row is his
    expect(read({ ...fee, accountId: robinhoodCash })).toEqual([false, "Fees"]);
    // the funding, filed Investment Contribution on his ledger: the agent's money, and no cost
    expect(read({ ...fee, categoryId: catId("Transfers > Investment Contribution"), amountCents: 2_664 })).toEqual([
      false,
      null,
    ]);
    /*
     * ⚖️ An UNCATEGORIZED outflow on the agent's cash is no row of an expense category — and no spending of his either:
     * whatever it is later filed as, the account it left decides (owner decision 2026-10-05, `agents-unfiled.test.ts`).
     */
    expect(read({ ...fee, categoryId: null })).toEqual([false, null]);
  });

  /*
   * /spending's per-category forecast and Predict budgets read a category's trailing non-recurring spend with their
   * own query. The agent's three Gold fees made Fees a $5.00-a-month habit of his.
   */
  test("⛔ the category forecast's discretionary trend is his alone — a split part of the agent's included", () => {
    goldFee("2026-07-01");
    goldFee("2026-08-01");
    // hypothetical: one charge of the agent's split across two categories — a part posts where its row does
    post(agentic, "2026-08-15", -1_000, "Fees > Bank Fees", "Gold Monthly Fee and margin");
    const split = bundle.db.select().from(transactions).where(eq(transactions.postedOn, "2026-08-15")).get()!;
    setSplits(bundle.db, split.id, [
      { categoryId: catId("Fees > Bank Fees"), amountCents: -600 },
      { categoryId: catId("Shopping > General"), amountCents: -400 },
    ]);
    const paired = predictCategory(bundle.db, catId("Fees"), "Fees", TODAY);
    unpair();
    const unpaired = predictCategory(bundle.db, catId("Fees"), "Fees", TODAY);
    bundle.db.delete(transactions).where(eq(transactions.accountId, agentic)).run();
    const without = predictCategory(bundle.db, catId("Fees"), "Fees", TODAY);
    expect(paired.forecast).toEqual(without.forecast);
    expect(unpaired.forecast.expectedTotalCents).toBeGreaterThan(without.forecast.expectedTotalCents);
  });
});

/** A recurring series as detection or the owner leaves one: the fields every projection reads. */
function schedule(input: {
  name: string;
  kind: SeriesKind;
  accountId: string;
  merchantId?: string;
  cadence: Cadence;
  intervalDaysAvg: number;
  nextExpectedOn: string;
  nextExpectedAmountCents: number;
  lastMatchedOn: string;
  status: "detected" | "confirmed";
}): string {
  return bundle.db
    .insert(recurringSeries)
    // detection writes the average it measured beside the amount it expects
    .values({ toleranceDays: 3, amountCentsAvg: input.nextExpectedAmountCents, ...input })
    .returning({ id: recurringSeries.id })
    .get().id;
}

/** link a posted row to a series, as detection links the row it read the schedule off */
function link(seriesId: string, accountId: string, postedOn: string): void {
  bundle.db
    .update(transactions)
    .set({ recurringSeriesId: seriesId })
    .where(and(eq(transactions.accountId, accountId), eq(transactions.postedOn, postedOn)))
    .run();
}

const LEASE = "Car lease";
const INSURANCE = "Car insurance";

/** his two car bills, as he registered them: the lease $695.04 on the 15th, the insurance $357.58 on the 11th */
function hisCar(): { lease: string; insurance: string } {
  const bill = (name: string, day: string, cents: number) =>
    schedule({
      name,
      kind: "bill",
      accountId: wellsFargo,
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: `2026-10-${day}`,
      nextExpectedAmountCents: -cents,
      lastMatchedOn: `2026-09-${day}`,
      status: "confirmed",
    });
  return { lease: bill(LEASE, "15", 69_504), insurance: bill(INSURANCE, "11", 35_758) };
}

const GOLD = "Gold Monthly Fee";

/**
 * The agent's Gold fee as detection reads it off the Sep 1 row — monthly on the 1st, $5.00 — and that row linked.
 * October's has not posted: read on Oct 5, it came due on the 1st.
 */
function agentsGold(): string {
  const id = schedule({
    name: GOLD,
    kind: "subscription",
    accountId: agentic,
    merchantId: gold,
    cadence: "monthly",
    intervalDaysAvg: 30,
    nextExpectedOn: "2026-10-01",
    nextExpectedAmountCents: -AGENTS_FEE,
    lastMatchedOn: "2026-09-01",
    status: "detected",
  });
  link(id, agentic, "2026-09-01");
  return id;
}

describe("the agent's cost SERIES is not his bill either", () => {
  /*
   * §6A 27's income series, mirrored: every reader that projects, sums, ranks or lists a spending series as HIS read
   * every live series. Detected on the agent's cash, its Gold fee was a Fees bill of his on the forecast (October's
   * came due and "has not posted"), /budgets' overdue and tail, Predict budgets, the runway's committed bills, the
   * Upcoming lists and the dashboard's "before your next paycheck".
   */
  test("⛔ a series detected on the agent's cash moves no figure that projects his bills", () => {
    hisCar();
    createBudget(bundle.db, { categoryId: catId("Fees"), period: "monthly", amountCents: 5_000, startsOn: SEPT.from });
    const read = () => {
      const f = forecastCurrentMonth(bundle.db, TODAY);
      const nov = forecastForMonth(bundle.db, "2026-11", TODAY)!;
      const fees = budgetPaceStatuses(bundle.db, TODAY).find((b) => b.categoryName === "Fees")!;
      return {
        forecast: {
          components: f.components,
          committed: [f.committed.spendCents, f.committed.netCents, f.committed.eomCashCents],
          pace: [f.projectedSpendCents, f.projectedNetCents, f.projectedEomCashCents],
        },
        nov: { components: nov.components, committed: nov.committed.spendCents },
        budget: { tail: fees.tail, overdue: fees.overdue, projected: fees.projectedCents },
        predict: predictCategory(bundle.db, catId("Fees"), "Fees", TODAY).forecast,
        runway: runwayCard(bundle.db, TODAY),
        upcoming: upcomingOccurrences(bundle.db, TODAY, 30),
        // the dashboard's next 14 days, read on Oct 25 so that they hold the agent's Nov 1
        dashboard: dashboardData(bundle.db, "2026-10-25").upcoming,
      };
    };
    const before = read();
    // Oct 5 through Nov 3: his two car bills, and — once detected — the agent's Nov 1 Gold fee
    expect(before.upcoming.map((o) => `${o.date} ${o.name}`)).toEqual([`2026-10-11 ${INSURANCE}`, `2026-10-15 ${LEASE}`]);

    agentsGold();
    expect(read()).toEqual(before);
  });

  test("⚖️ …and the forecast's EOM net worth still pays what the agent's series charges, as the bridge does", () => {
    hisCar();
    const before = forecastCurrentMonth(bundle.db, TODAY);
    const beforeNov = forecastForMonth(bundle.db, "2026-11", TODAY)!;
    agentsGold();
    const after = forecastCurrentMonth(bundle.db, TODAY);
    const afterNov = forecastForMonth(bundle.db, "2026-11", TODAY)!;

    // October's Gold fee came due on the 1st and has not posted: the agent's to pay, so net worth's — and no line
    expect(after.agentsCosts).toEqual({ netCents: -AGENTS_FEE, committedNetCents: -AGENTS_FEE });
    expect(after.committed.eomNetWorthCents - before.committed.eomNetWorthCents).toBe(-AGENTS_FEE);
    expect(after.projectedEomNetWorthCents - before.projectedEomNetWorthCents).toBe(
      after.agentsCosts.netCents - before.agentsCosts.netCents,
    );
    expect(after.committed.eomCashCents).toBe(before.committed.eomCashCents);
    expect(after.components.map((c) => c.label)).not.toContain(GOLD);
    // November chains October's and its own Nov 1, on both readings, and still no line of his
    expect(afterNov.agentsCosts).toEqual({ netCents: -2 * AGENTS_FEE, committedNetCents: -2 * AGENTS_FEE });
    expect(afterNov.committed.eomNetWorthCents - beforeNov.committed.eomNetWorthCents).toBe(-2 * AGENTS_FEE);
    expect(afterNov.committed.spendCents).toBe(beforeNov.committed.spendCents);
  });

  test("the rule's own edge: unpaired, the account is his, and so is the series", () => {
    hisCar();
    agentsGold();
    unpair();
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect(f.components.map((c) => c.label)).toContain(GOLD);
    expect(f.agentsCosts).toEqual({ netCents: 0, committedNetCents: 0 });
    expect(upcomingOccurrences(bundle.db, TODAY, 30).map((o) => o.name)).toContain(GOLD);
    expect(predictCategory(bundle.db, catId("Fees"), "Fees", TODAY).forecast.recurringCents).toBe(
      AGENTS_FEE,
    );
  });

  test("⛔ /recurring: the strip's \"as scheduled\" is the card's net, and the grid draws no day of the agent's", () => {
    hisCar();
    agentsGold();
    const NOV = "2026-11";
    const read = () => {
      const month = recurringCalendar(bundle.db, NOV, TODAY);
      return {
        cardNet: forecastForMonth(bundle.db, NOV, TODAY)!.committed.netCents,
        asScheduled: calendarMonthFlow(month, TODAY).endCents,
        drawn: Object.entries(month.entriesByDay)
          .flatMap(([day, entries]) => entries.map((e) => `${day} ${e.name}`))
          .sort(),
      };
    };
    const car = [`2026-11-11 ${INSURANCE}`, `2026-11-15 ${LEASE}`];
    expect(read()).toEqual({ cardNet: -(69_504 + 35_758), asScheduled: -(69_504 + 35_758), drawn: car });

    unpair();
    expect(read()).toEqual({
      cardNet: -(69_504 + 35_758 + AGENTS_FEE),
      asScheduled: -(69_504 + 35_758 + AGENTS_FEE),
      drawn: [`2026-11-01 ${GOLD}`, ...car],
    });
  });

  test("⛔ …nor its posted fee: no mark and no Settled cent in September", () => {
    hisCar();
    const read = () => recurringCalendar(bundle.db, "2026-09", TODAY);
    const before = read();
    agentsGold();
    expect(read()).toEqual(before);
  });

  test("⛔ /categories/<Fees>'s Recurring series card, a budget's recurring spend and the subscriptions card", () => {
    hisCar();
    createBudget(bundle.db, { categoryId: catId("Fees"), period: "monthly", amountCents: 5_000, startsOn: SEPT.from });
    const subscriptions = () => subscriptionsCard(bundle.db, TODAY);
    const before = subscriptions();
    const series = agentsGold();
    // hypothetical: a second charge of the agent's, split across two categories and linked to the same series
    post(agentic, "2026-09-20", -1_000, "Fees > Bank Fees", "Gold Monthly Fee and margin");
    const split = bundle.db.select().from(transactions).where(eq(transactions.postedOn, "2026-09-20")).get()!;
    setSplits(bundle.db, split.id, [
      { categoryId: catId("Fees > Bank Fees"), amountCents: -600 },
      { categoryId: catId("Shopping > General"), amountCents: -400 },
    ]);
    link(series, agentic, "2026-09-20");
    expect(seriesInCategory(bundle.db, catId("Fees"), TODAY)).toEqual([]);
    // September's Fees: his ATM fee is variable spend, and the agent's linked charges are no recurring spend of his
    const sept = budgetPaceStatuses(bundle.db, SEPT.to).find((b) => b.categoryName === "Fees")!;
    expect([sept.spentCents, sept.recurringPostedCents]).toEqual([HIS_FEE, 0]);
    expect(subscriptions()).toEqual(before);

    unpair();
    expect(seriesInCategory(bundle.db, catId("Fees"), TODAY).map((s) => s.name)).toEqual([GOLD]);
    const his = budgetPaceStatuses(bundle.db, SEPT.to).find((b) => b.categoryName === "Fees")!;
    expect([his.spentCents, his.recurringPostedCents]).toEqual([HIS_FEE + AGENTS_FEE + 600, AGENTS_FEE + 600]);
    expect(subscriptions()?.live.map((l) => l.name)).toContain(GOLD);
  });

  /*
   * A series page ranks a commitment against "what your scheduled commitments cost in a year". Counted among them, the
   * agent's Gold fee is one of his — and its own page ranks itself among his bills.
   */
  test("⛔ a series page's ranking: the agent's Gold fee is none of \"your scheduled commitments\"", () => {
    const { lease } = hisCar();
    const gold = agentsGold();
    const among = (id: string) => recurringInsightInput(bundle.db, id, TODAY)?.facts.find((f) => f.kind === "rank");
    expect(among(lease)).toMatchObject({ value: 1, outOf: 2 });
    expect(recurringInsightInput(bundle.db, gold, TODAY)).toBeNull();

    unpair();
    expect(among(lease)).toMatchObject({ value: 1, outOf: 3 });
    expect(among(gold)).toMatchObject({ value: 3, outOf: 3 });
  });

  /*
   * 🔴 The cost-series rule asked the kind and never the sign, so money IN under a series of the agent's that is no
   * income series — a monthly credit detection filed "other" or "bill" — was a COST of the agent's: `agentsCosts` read
   * +$3.00, past the ≤ 0 its own type promises, and the card's note would say the agent's account "is projected to pay
   * +$3.00". Money in on the agent's cash is what it is PAID, whatever kind the schedule carries — as his own series
   * are income or spending by their sign (`seriesIsIncomeOrSpending`). Hypothetical: no such series exists.
   */
  test("⛔ money IN under a series of the agent's is no cost of its: it is what the agent's cash is paid", () => {
    hisCar();
    const read = () => {
      const f = forecastCurrentMonth(bundle.db, TODAY);
      const nov = forecastForMonth(bundle.db, "2026-11", TODAY)!;
      return {
        his: {
          components: [f.components, nov.components],
          committed: [f.committed.incomeCents, f.committed.spendCents, f.committed.eomCashCents],
          pace: [f.projectedIncomeCents, f.projectedSpendCents, f.projectedEomCashCents],
          subscriptions: subscriptionsCard(bundle.db, TODAY),
          upcoming: upcomingOccurrences(bundle.db, TODAY, 30),
          runway: runwayCard(bundle.db, TODAY),
        },
        agents: { costs: [f.agentsCosts, nov.agentsCosts], income: [f.agentsIncome, nov.agentsIncome] },
        nw: [f.committed.eomNetWorthCents, f.projectedEomNetWorthCents, nov.committed.eomNetWorthCents],
      };
    };
    const before = read();
    for (const kind of ["other", "bill", "subscription"] as const) {
      const id = schedule({
        name: `Monthly credit (${kind})`,
        kind,
        accountId: agentic,
        cadence: "monthly",
        intervalDaysAvg: 30,
        nextExpectedOn: "2026-10-20",
        nextExpectedAmountCents: CREDIT,
        lastMatchedOn: "2026-09-20",
        status: "detected",
      });
      const after = read();
      // no figure of his moves, and the agent's costs do not either
      expect(after.his, kind).toEqual(before.his);
      expect(after.agents.costs, kind).toEqual(before.agents.costs);
      // what the agent's cash is paid: October's on the 20th, and November chains it with its own
      expect(after.agents.income, kind).toEqual([
        { netCents: CREDIT, committedNetCents: CREDIT },
        { netCents: 2 * CREDIT, committedNetCents: 2 * CREDIT },
      ]);
      expect(after.nw, kind).toEqual([before.nw[0]! + CREDIT, before.nw[1]! + CREDIT, before.nw[2]! + 2 * CREDIT]);
      bundle.db.delete(recurringSeries).where(eq(recurringSeries.id, id)).run();
    }
  });

  test("…and the owner's amount decides it before detection's: overridden to money out, it is the agent's cost", () => {
    hisCar();
    // the agent's Sep 1 Gold fee, unlinked, already projects at the pace
    const before = forecastCurrentMonth(bundle.db, TODAY);
    schedule({
      name: "Monthly credit, reversed by him",
      kind: "other",
      accountId: agentic,
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-10-20",
      nextExpectedAmountCents: CREDIT,
      lastMatchedOn: "2026-09-20",
      status: "confirmed",
    });
    bundle.db.update(recurringSeries).set({ userAmountCents: -CREDIT }).where(eq(recurringSeries.accountId, agentic)).run();
    const f = forecastCurrentMonth(bundle.db, TODAY);
    expect({
      costs: [f.agentsCosts.netCents - before.agentsCosts.netCents, f.agentsCosts.committedNetCents - before.agentsCosts.committedNetCents],
      income: f.agentsIncome,
    }).toEqual({ costs: [-CREDIT, -CREDIT], income: before.agentsIncome });
  });
});

/** a hypothetical monthly credit the agent's cash is paid under a schedule that is no income series */
const CREDIT = 300;
