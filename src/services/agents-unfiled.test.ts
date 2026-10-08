import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadSpendingCategoryTxns } from "@/app/spending/actions";
import { parseFilters } from "@/components/transactions/query";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { cashFlowSegmentHref, UNCATEGORIZED_SERIES_KEY } from "@/lib/ledger-href";
import { resolvePeriod } from "@/lib/period";
import { createAccount, outsidePortfolioCashAccountIds } from "./accounts";
import {
  categoryBreakdown,
  categorySpending,
  loadCategoryIndex,
  monthlySpending,
  spendingBucket,
  spendingTransactions,
  transactionsHref,
} from "./analytics";
import { addManualAnchor } from "./anchors";
import { netWorthAttribution } from "./attribution";
import { categoryFlowLabel, categoryFlowSign } from "./category-detail";
import { dashboardData } from "./dashboard";
import { netWorthSeries, rebuildAccount } from "./derivation";
import { forecastCurrentMonth } from "./forecast";
import { ledgerOpens, ledgerReaches } from "./observation-frontier";
import { periodActivity } from "./period-activity";
import { printOnOneStatement } from "./printed-statement-fixture";
import { provenanceFor } from "./provenance";
import { uncategorizedCount } from "./review-count";
import { spendingSankey } from "./sankey";
import {
  agentsMoneyRowCount,
  cashFlowByPeriod,
  categoryEmptyCopy,
  honestyBuckets,
  periodTotals,
  spendingEmptyCopy,
} from "./spending";
import { setSplits } from "./transaction-splits";
import { matchingTransactionIds } from "./transactions-query";

/**
 * ⚖️ Owner decision 2026-10-05: money leaving the AGENT'S cash UNFILED — no category, or the system "Uncategorized"
 * category — is out of HIS Spent too. Whatever it is later filed as, it is not his spending: the account it left
 * decides now. 🔴 The 2026-10-02 rule (§6A 34, `agents-costs.test.ts`) took the agent's FILED costs out of every Spent
 * figure and left its unfiled money out in his Uncategorized bucket — /spending's Spent and honesty card, the category
 * table, the chart, the Sankey, the dashboard's panel and the forecast's Uncategorized pace all charged it to him.
 *
 * His ledger holds none of it (Robinhood Agentic carries one transfer row), so the rows are hypothetical, each the kind
 * the importer leaves unfiled: the agent's "ACH Withdrawal" (trans code ACH, which `RH_CODE_CATEGORY` files nowhere so
 * transfer detection can pair its legs) and its Gold fee filed by hand on the system row — beside his own unfiled ATM
 * withdrawal, which is still his.
 */

const TODAY = "2026-10-05";
const SEPT = { from: "2026-09-01", to: "2026-09-30" };
/** his September pay: the It America payroll */
const HIS_PAY = 114_192;
/** his September fee, filed: "Non-Wells Fargo ATM Transaction Fee" */
const HIS_FEE = 1_500;
/** his September cash, unfiled: an ATM withdrawal nothing has categorized yet */
const HIS_UNFILED = 4_000;
/** the agent's unfiled money out: an ACH withdrawal transfer detection has not paired */
const AGENTS_ACH = 2_000;
/** the agent's Gold fee, filed on the system "Uncategorized" row */
const AGENTS_GOLD = 500;
/** money into the agent's cash that nothing has filed — a deposit, in the filing queue and in no Spent */
const AGENTS_CREDIT = 300;

let dir: string;
let bundle: DbBundle;
let fakeToday: string | undefined;
let wellsFargo: string;
let agentic: string;
let book: string;

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

function post(accountId: string, postedOn: string, amountCents: number, category: string | null, raw: string): void {
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription: raw,
      normalizedDescription: raw,
      categoryId: category === null ? null : catId(category),
      status: "active",
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: 0 }),
    })
    .run();
}

/** the agent's two unfiled outflows of a month: the ACH withdrawal (no category) and the Gold fee (the system row) */
function agentsUnfiled(month: string): void {
  post(agentic, `${month}-01`, -AGENTS_GOLD, "Uncategorized", "Gold Monthly Fee");
  post(agentic, `${month}-18`, -AGENTS_ACH, null, "ACH Withdrawal");
}

/** the rule's own edge: with no book paired, Agentic is a cash account like any other, and its money is his */
function unpair(): void {
  bundle.db.update(accounts).set({ cashAccountId: null }).where(eq(accounts.id, book)).run();
}

beforeEach(() => {
  fakeToday = process.env.MONEYAPP_FAKE_TODAY;
  process.env.MONEYAPP_FAKE_TODAY = TODAY;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-agents-unfiled-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);

  const wf = bundle.db.insert(institutions).values({ name: "Wells Fargo" }).returning({ id: institutions.id }).get();
  const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  wellsFargo = createAccount(bundle.db, { institutionId: wf.id, name: "Wells Fargo Everyday Checking", type: "checking" });
  agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
  // the agent's brokerage book, paired with its cash account — what makes Agentic's money the agent's
  book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
  bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
  // …and printed beside it, as on his ledger: the agent's cash is investable, no part of his spendable cash
  printOnOneStatement(bundle.db, rh.id, [agentic, book]);

  addManualAnchor(bundle.db, { accountId: wellsFargo, anchoredOn: "2026-08-31", enteredCents: 392_640 });
  addManualAnchor(bundle.db, { accountId: agentic, anchoredOn: "2026-08-31", enteredCents: 2_664 });

  post(wellsFargo, "2026-09-24", HIS_PAY, "Income > Salary", "It America LLC Payroll 260924");
  post(wellsFargo, "2026-09-01", -HIS_FEE, "Fees > ATM Fees", "Non-Wells Fargo ATM Transaction Fee");
  post(wellsFargo, "2026-09-10", -HIS_UNFILED, null, "ATM Withdrawal");
  agentsUnfiled("2026-09");
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (fakeToday === undefined) delete process.env.MONEYAPP_FAKE_TODAY;
  else process.env.MONEYAPP_FAKE_TODAY = fakeToday;
});

/** The rows a `/transactions` link opens — the ledger's own filter, as the page and its bulk actions select them. */
function opened(href: string): { accountId: string; amountCents: number }[] {
  const filters = parseFilters(Object.fromEntries(new URL(href, "http://ledger.test").searchParams));
  return bundle.db
    .select({ accountId: transactions.accountId, amountCents: transactions.amountCents })
    .from(transactions)
    .where(inArray(transactions.id, matchingTransactionIds(bundle.db, filters, "all")))
    .all();
}

/** /spending's empty state over a window, as the page asks for it */
function emptyState(range: { from: string; to: string }, label = "the day") {
  return spendingEmptyCopy(bundle.db, range, {
    today: TODAY,
    label,
    ledgerOpens: ledgerOpens(bundle.db),
    ledgerReaches: ledgerReaches(bundle.db),
    formatDay: (iso) => iso,
  });
}

/** /categories/<id>'s empty state over a window, as the page asks for it */
function categoryEmptyState(pathStr: string, range: { from: string; to: string }) {
  return categoryEmptyCopy(bundle.db, catId(pathStr), range, {
    today: TODAY,
    label: "the day",
    ledgerOpens: ledgerOpens(bundle.db),
    formatDay: (iso) => iso,
  });
}

/** the clause every empty state that left the agent's money out ends on */
const AGENTS_LEFT_OUT = /The agent's own account paid or was paid money in this period, and none of it is counted here/;

const sum = (rows: readonly { amountCents: number }[]) => rows.reduce((s, r) => s + r.amountCents, 0);
const agents = (rows: readonly { accountId: string }[]) => rows.filter((r) => r.accountId === agentic).length;

/** `loadSpendingCategoryTxns`, the server action a category's row list awaits, pointed at this fixture for one call */
async function bucketPanel(categoryId: string | null) {
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

describe("the agent's unfiled money out is not his spending", () => {
  test("⛔ /spending's Spent, its proof and the links under it count his unfiled money alone", () => {
    expect(periodTotals(bundle.db, SEPT)).toMatchObject({ spentCents: HIS_FEE + HIS_UNFILED, refundsCents: 0 });
    expect(provenanceFor(bundle.db, { kind: "allSpend", ...SEPT })?.headline).toMatch(/the sum of 2 rows /);

    const spent = opened(`/transactions?category=spending&from=${SEPT.from}&to=${SEPT.to}`);
    expect([sum(spent), agents(spent)]).toEqual([-(HIS_FEE + HIS_UNFILED), 0]);
    const net = opened(`/transactions?category=cashflow&from=${SEPT.from}&to=${SEPT.to}`);
    expect([sum(net), agents(net)]).toEqual([HIS_PAY - HIS_FEE - HIS_UNFILED, 0]);
  });

  test("⛔ the honesty card's Uncategorized is his, and its link opens exactly it", () => {
    const { uncategorized } = honestyBuckets(bundle.db, SEPT);
    expect([uncategorized.spentCents, uncategorized.txnCount]).toEqual([HIS_UNFILED, 1]);
    const rows = opened(uncategorized.href);
    expect([sum(rows), agents(rows)]).toEqual([-HIS_UNFILED, 0]);
  });

  test("⛔ the category table, the stacked bars, the chart, the Sankey and the dashboard's panel: Uncategorized is his", () => {
    const uncat = categoryBreakdown(bundle.db, SEPT).find((r) => r.categoryId === null)!;
    expect([uncat.spentCents, uncat.txnCount]).toEqual([HIS_UNFILED, 1]);
    const cell = monthlySpending(bundle.db, { months: 1, refDate: SEPT.to }).find((c) => c.categoryId === null)!;
    expect([cell.spentCents, cell.txnCount]).toEqual([HIS_UNFILED, 1]);

    const flow = cashFlowByPeriod(bundle.db, resolvePeriod({ period: "2026-09" }, TODAY), TODAY);
    expect(flow.totals.spentCents).toBe(HIS_FEE + HIS_UNFILED);
    const week = flow.buckets.find((b) => (b.spending[UNCATEGORIZED_SERIES_KEY] ?? 0) > 0)!;
    expect(week.spending[UNCATEGORIZED_SERIES_KEY]).toBe(HIS_UNFILED);
    expect(sum(opened(cashFlowSegmentHref(UNCATEGORIZED_SERIES_KEY, null, week, "out")))).toBe(-HIS_UNFILED);
    // the agent's weeks hold none of his spending at all
    const his = (key: string) => (key === week.key ? HIS_UNFILED : key === "2026-09-01" ? HIS_FEE : 0);
    for (const b of flow.buckets) expect(b.spendingCents, b.key).toBe(his(b.key));

    const graph = spendingSankey(bundle.db, SEPT);
    const node = graph.nodes.find((n) => n.meta?.kind === "uncategorized")!;
    expect(graph.links.find((l) => l.target === node.id)!.valueCents).toBe(HIS_UNFILED);
    expect(sum(opened(node.href!))).toBe(-HIS_UNFILED);
    // what he earned less what he spent was saved — the agent's money left the agent's cash, not his
    expect(graph.links.find((l) => l.target === "saved")!.valueCents).toBe(HIS_PAY - HIS_FEE - HIS_UNFILED);

    const panel = periodActivity(bundle.db, SEPT.from, SEPT.to, 10).summary;
    expect(panel.outCents).toBe(HIS_FEE + HIS_UNFILED);
    expect(panel.topCategories.find((c) => c.categoryId === null)?.spentCents).toBe(HIS_UNFILED);
  });

  test("⛔ the bucket's own row list, and every spelling of its link, are his rows", async () => {
    expect(categorySpending(bundle.db, { categoryId: null, ...SEPT })).toEqual({ spentCents: HIS_UNFILED, txnCount: 1 });
    expect(agents(spendingTransactions(bundle.db, { categoryId: null, ...SEPT }))).toBe(0);
    // the movers' link, and the bucket's panel and its "see all"
    expect(sum(opened(transactionsHref({ categoryId: null, ...SEPT })))).toBe(-HIS_UNFILED);
    const panel = await bucketPanel(null);
    expect([panel.total, sum(panel.rows)]).toEqual([1, -HIS_UNFILED]);
    expect(sum(opened(panel.href))).toBe(-HIS_UNFILED);
  });

  /*
   * 🔴 A day whose only outflow is the agent's unfiled money holds nothing of his, so /spending reads its empty state —
   * which promised "Uncategorized outflows would show up above, as their own explicit bucket" of the agent's ACH
   * withdrawal, which shows up nowhere. The bucket it names is his own now, and the agent's money is said to be left out.
   */
  test("⛔ a day holding only the agent's unfiled money reads empty, names his own bucket, and says the agent's is left out", () => {
    const day = { from: "2026-09-18", to: "2026-09-18" };
    expect(periodTotals(bundle.db, day)).toMatchObject({ spentCents: 0, earnedCents: 0, refundsCents: 0 });
    expect(honestyBuckets(bundle.db, day).uncategorized.txnCount).toBe(0);
    expect(agentsMoneyRowCount(bundle.db, day)).toBe(1);

    const copy = emptyState(day);
    expect(copy.title).toBe("No spending or income in this period");
    expect(copy.description).toContain("Your own uncategorized outflows would show up above");
    expect(copy.description).toMatch(/The agent's own account paid or was paid money in this period, and none of it is counted here/);
  });

  /*
   * 🔴 The partly-imported window is the one most often read — the week or month still running — and its branch of the
   * copy dropped the agent's-money flag and said "Nothing posted in the part of … that has been imported" over the
   * agent's unfiled ACH withdrawal, which posted inside that very part. Before §6A 34 the row made the window active.
   */
  test("⛔ a partly-imported week holding only the agent's money says no spending or income, and that the agent's is left out", () => {
    post(agentic, "2026-09-28", -AGENTS_ACH, null, "ACH Withdrawal");
    const week = { from: "2026-09-28", to: "2026-10-04" };
    expect(ledgerReaches(bundle.db)).toBe("2026-09-28");
    expect(periodTotals(bundle.db, week)).toMatchObject({ spentCents: 0, earnedCents: 0, refundsCents: 0 });
    expect(honestyBuckets(bundle.db, week).uncategorized.txnCount).toBe(0);
    expect(agentsMoneyRowCount(bundle.db, week)).toBe(1);

    const copy = emptyState(week, "the week of Sep 28");
    expect(copy.title).not.toContain("Nothing posted");
    expect(copy.title).toBe("No spending or income in the part of the week of Sep 28 that has been imported");
    expect(copy.description).toContain("6 days of it have not been imported");
    expect(copy.description).toContain("lower bound");
    expect(copy.description).toMatch(/The agent's own account paid or was paid money in this period, and none of it is counted here/);
  });

  test("the clause counts what the agent's account paid or was paid — and not its transfers, which the copy names already", () => {
    const day = { from: "2026-09-05", to: "2026-09-05" };
    // his funding of the agent: a transfer, "not counted here" in the copy's own words
    post(agentic, day.from, 2_664, "Transfers > Internal Transfer", "Transfer from Wells Fargo");
    expect(agentsMoneyRowCount(bundle.db, day)).toBe(0);
    expect(emptyState(day).description).not.toContain("agent");
    // the agent's dividend is the agent's income, and its Gold fee filed under Fees the agent's cost
    post(agentic, day.from, 6, "Income > Dividends", "Dividend from SGOV");
    post(agentic, day.from, -500, "Fees > Bank Fees", "Gold Monthly Fee");
    expect(agentsMoneyRowCount(bundle.db, day)).toBe(2);
    expect(emptyState(day).description).toContain("none of it is counted here");
  });

  /*
   * 🔴 §6A 43: money OUT of the agent's cash filed in an income category — a clawback of what it was paid — is the
   * agent's: it lowers "Agent's income" on the bridge and at the pace (`isAgentsIncomeCategoryRow`, either sign), and is
   * none of his spending or income. The count asked the credits alone, so a day holding only the
   * agent's clawback read a measured zero and said nothing of the money left out.
   */
  test("⛔ the clause counts the agent's income-category clawback — its money out, as the bridge nets it — and not his", () => {
    const day = { from: "2026-09-05", to: "2026-09-05" };
    post(agentic, day.from, -300, "Income > Interest", "Interest Clawback");
    expect(periodTotals(bundle.db, day)).toMatchObject({ spentCents: 0, earnedCents: 0 });
    expect(agentsMoneyRowCount(bundle.db, day)).toBe(1);
    expect(emptyState(day).description).toMatch(AGENTS_LEFT_OUT);

    // ⛔ his own clawback, filed in Interest, is his — no money of the agent's to name
    const his = { from: "2026-09-06", to: "2026-09-06" };
    post(wellsFargo, his.from, -300, "Income > Interest", "Interest Clawback");
    expect(agentsMoneyRowCount(bundle.db, his)).toBe(0);
    expect(emptyState(his).description).not.toContain("agent");
  });

  test("the rule's own edge: unpaired, the agent's day is his — his own Uncategorized, and no empty state at all", () => {
    unpair();
    const day = { from: "2026-09-18", to: "2026-09-18" };
    expect(agentsMoneyRowCount(bundle.db, day)).toBe(0);
    expect(honestyBuckets(bundle.db, day).uncategorized.txnCount).toBe(1);
  });
});

describe("a category's own page names the agent's money its window left out", () => {
  /*
   * 🔴 §6A 34: `/categories/<id>` leaves the agent's rows out of an income or expense category, either sign
   * (`spendingTransactions`), so a window holding only the agent's money there reads its empty state — and the page
   * composed that copy apart from /spending's, without the flag: "a measured zero" over a Bank Fees day holding the
   * agent's Gold fee, and nothing said of it. One rule (`agentsMoneyRowCount`), asked of the category's own rows.
   */
  test("⛔ a day holding only the agent's fee, dividend or clawback in a category says the agent's money is left out", () => {
    const day = { from: "2026-09-05", to: "2026-09-05" };
    post(agentic, day.from, -500, "Fees > Bank Fees", "Gold Monthly Fee");
    post(agentic, day.from, 6, "Income > Dividends", "Dividend from SGOV");
    post(agentic, day.from, -300, "Income > Interest", "Interest Clawback");
    const pages = [
      ["Fees", 1],
      ["Fees > Bank Fees", 1],
      ["Income", 2],
      ["Income > Dividends", 1],
      ["Income > Interest", 1],
    ] as const;
    for (const [pathStr, rows] of pages) {
      // the page's own gate: none of its rows is his
      expect(categorySpending(bundle.db, { categoryId: catId(pathStr), ...day }).txnCount, pathStr).toBe(0);
      expect(agentsMoneyRowCount(bundle.db, day, { categoryId: catId(pathStr) }), pathStr).toBe(rows);
      const copy = categoryEmptyState(pathStr, day);
      expect(copy.title, pathStr).toBe("No spending or income in this period");
      expect(copy.description, pathStr).toMatch(AGENTS_LEFT_OUT);
      // ⛔ the page prints no Uncategorized bucket, so its copy names none
      expect(copy.description, pathStr).not.toContain("uncategorized outflows");
    }
    // ⛔ the clause is the category's, not the day's: a category the agent's money is not in says nothing of it
    expect(agentsMoneyRowCount(bundle.db, day, { categoryId: catId("Food") })).toBe(0);
    expect(categoryEmptyState("Food", day).description).not.toContain("agent");
  });

  /*
   * A SPLIT row arrives as one part-row per part (`activeTxnsInRange`), each filed apart — so the count is of
   * TRANSACTIONS, and a part is asked where IT is filed, not where its row is. Hypothetical, as `agents-costs.test.ts`
   * splits the agent's Gold fee: one charge, filed Bank Fees, split across two Fees subcategories and Shopping.
   */
  test("⛔ a split row of the agent's is one row — counted once, on every page one of its parts is filed under", () => {
    const day = { from: "2026-09-05", to: "2026-09-05" };
    post(agentic, day.from, -1_000, "Fees > Bank Fees", "Gold Monthly Fee and margin");
    const row = bundle.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.accountId, agentic), eq(transactions.postedOn, day.from)))
      .get()!;
    setSplits(bundle.db, row.id, [
      { categoryId: catId("Fees > Bank Fees"), amountCents: -500 },
      { categoryId: catId("Fees > ATM Fees"), amountCents: -100 },
      { categoryId: catId("Shopping > General"), amountCents: -400 },
    ]);
    const pages = [
      // two of its parts under one page are still the one row
      ["Fees", 1],
      ["Fees > Bank Fees", 1],
      ["Fees > ATM Fees", 1],
      // the part filed apart from its row is counted where it is filed
      ["Shopping", 1],
      ["Shopping > General", 1],
      ["Food", 0],
    ] as const;
    for (const [pathStr, rows] of pages) {
      expect(categorySpending(bundle.db, { categoryId: catId(pathStr), ...day }).txnCount, pathStr).toBe(0);
      expect(agentsMoneyRowCount(bundle.db, day, { categoryId: catId(pathStr) }), pathStr).toBe(rows);
    }
    expect(categoryEmptyState("Shopping", day).description).toMatch(AGENTS_LEFT_OUT);
    // …and /spending's day: three part-rows, one transaction
    expect(agentsMoneyRowCount(bundle.db, day)).toBe(1);
  });

  test("⛔ a page that lists the agent's rows leaves none out — a transfer, and the unfiled", () => {
    const day = { from: "2026-09-18", to: "2026-09-18" };
    post(agentic, day.from, 2_664, "Transfers > Internal Transfer", "Transfer from Wells Fargo");
    for (const pathStr of ["Transfers", "Uncategorized"]) {
      expect(categorySpending(bundle.db, { categoryId: catId(pathStr), ...day }).txnCount, pathStr).toBeGreaterThan(0);
      expect(agentsMoneyRowCount(bundle.db, day, { categoryId: catId(pathStr) }), pathStr).toBe(0);
    }
  });

  test("the rule's own edge: unpaired, the agent's fee is his, and his page lists it", () => {
    const day = { from: "2026-09-05", to: "2026-09-05" };
    post(agentic, day.from, -500, "Fees > Bank Fees", "Gold Monthly Fee");
    unpair();
    expect(categorySpending(bundle.db, { categoryId: catId("Fees > Bank Fees"), ...day }).txnCount).toBe(1);
    expect(agentsMoneyRowCount(bundle.db, day, { categoryId: catId("Fees > Bank Fees") })).toBe(0);
  });
});

describe("what is left as it was", () => {
  /*
   * ⚖️ Session decision 2026-10-06 (the session's, not the owner's): the owner's 2026-10-05 decision is about his SPENT,
   * and the filing queue is not a Spent figure. The ledger's Uncategorized filter — the queue the dashboard's "N
   * uncategorized" counts and links to — and /categories/<Uncategorized>, the page a row is filed from, keep every
   * account's unfiled rows, both signs, until they are filed: that page's headline is a Net of the rows to file. The
   * agent's unfiled rows still need filing, and nothing there says spent.
   */
  test("⚖️ the filing queue keeps the agent's rows, both signs: the dashboard's count and its link, the category's page and its proof", async () => {
    // the agent's unfiled money IN — a deposit nothing has filed — is a row to file as much as its money out
    post(agentic, "2026-09-20", AGENTS_CREDIT, null, "ACH Deposit");

    const dashboard = dashboardData(bundle.db, TODAY);
    const queue = opened(dashboard.uncategorizedHref);
    expect([dashboard.uncategorizedCount, queue.length, agents(queue)]).toEqual([4, 4, 3]);
    expect(uncategorizedCount(bundle.db)).toBe(queue.length);

    const system = catId("Uncategorized");
    const kind = loadCategoryIndex(bundle.db).topLevelOf(system).kind;
    // a Net, never a Spent figure
    expect(categoryFlowLabel(kind)).toBe("Net");
    const page = categorySpending(bundle.db, { categoryId: system, ...SEPT });
    expect(page).toEqual({ spentCents: HIS_UNFILED + AGENTS_ACH + AGENTS_GOLD - AGENTS_CREDIT, txnCount: 4 });
    // its proof measures the rows its headline measured, and its panel and links open them
    const proof = provenanceFor(bundle.db, { kind: "categorySpend", categoryId: system, ...SEPT, label: "Uncategorized" });
    expect(proof?.headline).toMatch(/^This total is the sum of 4 rows /);
    const panel = await bucketPanel(system);
    expect([panel.total, panel.rows.filter((r) => r.accountName === "Robinhood Agentic").length]).toEqual([4, 3]);
    // the headline, in the page's own frame, is the sum of the rows it lists — both signs
    expect(categoryFlowSign(kind) * page.spentCents).toBe(sum(panel.rows));
    expect(opened(panel.href).length).toBe(4);
  });

  test("the net-worth bridge: the agent's unfiled rows sit in Moved, as every unfiled row does, and the window closes", () => {
    for (const a of bundle.db.select({ id: accounts.id }).from(accounts).all()) rebuildAccount(bundle.db, a.id);
    const nwOn = (day: string) => {
      let cents = 0;
      for (const p of netWorthSeries(bundle.db)) {
        if (p.day > day) break;
        cents = p.totalCents;
      }
      return cents;
    };
    const got = netWorthAttribution(bundle.db, "2026-08-31", SEPT.to, nwOn("2026-08-31"), nwOn(SEPT.to));
    expect(Object.fromEntries(got.bands.map((b) => [b.key, b.cents]))).toMatchObject({
      earned: HIS_PAY,
      spent: -HIS_FEE,
      agentCosts: 0,
    });
    expect(got.closes).toBe(true);
  });

  test("the rule's own edge: unpaired, the account is his, and so is every unfiled dollar that left it", () => {
    unpair();
    const unfiled = HIS_UNFILED + AGENTS_ACH + AGENTS_GOLD;
    expect(periodTotals(bundle.db, SEPT).spentCents).toBe(HIS_FEE + unfiled);
    const { uncategorized } = honestyBuckets(bundle.db, SEPT);
    expect([uncategorized.spentCents, uncategorized.txnCount]).toEqual([unfiled, 3]);
    expect(sum(opened(uncategorized.href))).toBe(-unfiled);
    expect(sum(opened(`/transactions?category=spending&from=${SEPT.from}&to=${SEPT.to}`))).toBe(-(HIS_FEE + unfiled));
  });
});

describe("the rule, at its home", () => {
  test("no row on the agent's cash is his spending — filed, unfiled, or filed on the system row", () => {
    const idx = loadCategoryIndex(bundle.db);
    const agentsCash = outsidePortfolioCashAccountIds(bundle.db);
    const bucket = (txn: { accountId: string; categoryId: string | null; amountCents: number }) =>
      spendingBucket(idx, agentsCash, txn)?.categoryName ?? null;
    const ach = { accountId: agentic, categoryId: null, amountCents: -AGENTS_ACH };
    expect(bucket(ach)).toBeNull();
    expect(bucket({ ...ach, categoryId: catId("Uncategorized") })).toBeNull();
    // …and on his own account the same rows are his Uncategorized spending
    expect(bucket({ ...ach, accountId: wellsFargo })).toBe("Uncategorized");
    expect(bucket({ ...ach, accountId: wellsFargo, categoryId: catId("Uncategorized") })).toBe("Uncategorized");
    // an unfiled credit is nobody's spending, whichever account it reaches
    expect(bucket({ ...ach, amountCents: AGENTS_ACH })).toBeNull();
    expect(bucket({ ...ach, accountId: wellsFargo, amountCents: AGENTS_ACH })).toBeNull();
  });
});

describe("the agent's trailing unfiled money out is not his pace", () => {
  /*
   * The forecast's Uncategorized line projects his unfiled money out by the trailing pace (`spendingBucket`). The
   * agent's is the agent's: it projects apart, into EOM net worth alone (`MonthForecast.agentsCosts`), as its filed
   * costs do — net worth still pays it.
   */
  test("⛔ the Uncategorized pace line is his, and the agent's unfiled pace moves to the agent's costs", () => {
    for (const month of ["2026-07", "2026-08"]) {
      post(wellsFargo, `${month}-10`, -HIS_UNFILED, null, "ATM Withdrawal");
      agentsUnfiled(month);
    }
    const paired = forecastCurrentMonth(bundle.db, TODAY);
    unpair();
    const unpaired = forecastCurrentMonth(bundle.db, TODAY);
    // the agent's unfiled rows gone altogether: the line his own rows draw
    bundle.db
      .delete(transactions)
      .where(
        and(
          eq(transactions.accountId, agentic),
          or(isNull(transactions.categoryId), eq(transactions.categoryId, catId("Uncategorized"))),
        ),
      )
      .run();
    const without = forecastCurrentMonth(bundle.db, TODAY);

    const uncat = (f: typeof paired) => f.components.find((c) => c.label === "Uncategorized")?.cents;
    expect(uncat(paired)).toBe(uncat(without));
    expect(uncat(unpaired)).not.toBe(uncat(without));
    expect(paired.projectedSpendCents).toBe(without.projectedSpendCents);

    // the agent's $25.00 a month of unfiled money out × 27/31 days
    const agentsPace = Math.round(((AGENTS_ACH + AGENTS_GOLD) * 27) / 31);
    expect(paired.agentsCosts).toEqual({ netCents: -agentsPace, committedNetCents: 0 });
    expect(unpaired.agentsCosts).toEqual({ netCents: 0, committedNetCents: 0 });
    // …and net worth still pays it: what EOM net worth starts from is the same, paired or not
    const start = (f: typeof paired) =>
      f.projectedEomNetWorthCents - f.projectedNetCents - f.agentsIncome.netCents - f.agentsCosts.netCents;
    expect(start(paired)).toBe(start(unpaired));
  });
});
