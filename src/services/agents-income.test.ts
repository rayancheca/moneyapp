import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { parseFilters } from "@/components/transactions/query";
import { dedupeHash } from "@/lib/hash";
import { cashFlowSegmentHref } from "@/lib/ledger-href";
import { resolvePeriod } from "@/lib/period";
import { createAccount } from "./accounts";
import { incomeByMonth } from "./analytics";
import { addManualAnchor } from "./anchors";
import { netWorthAttribution } from "./attribution";
import { incomeExpectation } from "./budgets";
import { netWorthSeries, rebuildAccount } from "./derivation";
import { periodActivity } from "./period-activity";
import { spendingSankey } from "./sankey";
import { cashFlowByPeriod, dailySpendHeatmap, periodTotals } from "./spending";
import { countMatching, matchingTransactionIds } from "./transactions-query";

/**
 * ⚖️ Owner decision 2026-09-28 (§6A 27, option b): what the AGENT'S account is paid — a dividend its shares pay, the
 * interest on its uninvested cash — is not HIS income. /summary already refused it (`lineFor`'s `agentsCash`); every
 * other surface that says "Income" counted it. The net-worth bridge is the exception by his choice: net worth holds
 * that money, so the bridge must still explain it — on its own band, never hidden inside his.
 *
 * His ledger holds none of it yet (Robinhood Agentic has only the +$26.64 he funded, and no book is paired), so this
 * fixture is the proof. His rows are real statement lines; the agent's dividend is the WMT line's own rate
 * (0.2475/share, P/D 2026-09-08) on the 0.25 share the rehearsal bought, and the interest is Robinhood's
 * month-end "Interest Payment" — a second income category, because /summary first gated Dividends alone.
 */

const TODAY = "2026-10-05";
const SEPT = { from: "2026-09-01", to: "2026-09-30" };
/** his September income: the It America payroll plus his own GOOG dividend */
const HIS_CENTS = 114_192 + 7;
/** the agent's September income: 0.25 WMT × $0.2475, and a month of interest on its cash */
const AGENTS_CENTS = 6 + 4;

let dir: string;
let bundle: DbBundle;
let fakeToday: string | undefined;
let wellsFargo: string;
let robinhoodCash: string;
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

function post(accountId: string, postedOn: string, amountCents: number, category: string, raw: string): void {
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription: raw,
      normalizedDescription: raw,
      categoryId: catId(category),
      status: "active",
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: 0 }),
    })
    .run();
}

beforeEach(() => {
  fakeToday = process.env.MONEYAPP_FAKE_TODAY;
  process.env.MONEYAPP_FAKE_TODAY = TODAY;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-agents-income-"));
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

  // the three balances his ledger reads on 2026-08-31
  addManualAnchor(bundle.db, { accountId: wellsFargo, anchoredOn: "2026-08-31", enteredCents: 392_640 });
  addManualAnchor(bundle.db, { accountId: robinhoodCash, anchoredOn: "2026-08-31", enteredCents: 100_101 });
  addManualAnchor(bundle.db, { accountId: agentic, anchoredOn: "2026-08-31", enteredCents: 2_664 });

  post(wellsFargo, "2026-09-24", 114_192, "Income > Salary", "It America LLC Payroll 260924");
  post(robinhoodCash, "2026-09-09", 7, "Income > Dividends", "Cash Div: R/D 2026-09-07 P/D 2026-09-14 - 0.312739 shares at 0.22 (GOOG)");
  post(agentic, "2026-09-08", 6, "Income > Dividends", "Cash Div: R/D 2026-08-21 P/D 2026-09-08 - 0.25 shares at 0.2475 (WMT)");
  post(agentic, "2026-09-30", 4, "Income > Interest", "Interest Payment");
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

describe("the agent's income is not his — on every surface that says Income", () => {
  test("⛔ /spending: the Income card, the cash-flow chart and the heatmap leave it out", () => {
    const period = resolvePeriod({ period: "2026-09" }, TODAY);

    expect(periodTotals(bundle.db, SEPT).earnedCents).toBe(HIS_CENTS);

    const flow = cashFlowByPeriod(bundle.db, period, TODAY);
    expect(flow.totals.earnedCents).toBe(HIS_CENTS);
    // no series and no bar carries the agent's money: Dividends are his $0.07, and the agent's Interest is no series
    const series = new Map(flow.incomeSeries.map((s) => [s.label, s.key]));
    expect([...series.keys()].sort()).toEqual(["Dividends", "Salary"]);
    const perSeries = (key: string) => flow.buckets.reduce((sum, b) => sum + (b.income[key] ?? 0), 0);
    expect(perSeries(series.get("Dividends")!)).toBe(7);
    expect(flow.buckets.find((b) => b.key === "2026-09-08")!.incomeCents).toBe(0);
    expect(flow.buckets.find((b) => b.key === "2026-09-30")!.incomeCents).toBe(0);

    // the heatmap's earned bar for the day only the agent was paid is empty, and his days are whole
    const days = new Map(dailySpendHeatmap(bundle.db, "2026-09").days.map((d) => [d.iso, d.incomeCents]));
    const earnedOn = (iso: string) => days.get(iso) ?? 0;
    expect(["2026-09-08", "2026-09-09", "2026-09-24", "2026-09-30"].map(earnedOn)).toEqual([0, 7, 114_192, 0]);
  });

  test("⛔ the Sankey's income sources are his alone, and its hub still balances", () => {
    const graph = spendingSankey(bundle.db, SEPT);
    const into = (target: string) => graph.links.filter((l) => l.target === target);
    const sources = Object.fromEntries(
      into("hub").map((l) => [graph.nodes.find((n) => n.id === l.source)!.label, l.valueCents]),
    );
    expect(sources).toEqual({ Salary: 114_192, Dividends: 7 });
    // nothing was spent, so everything that came in was saved — his money, not the agent's
    expect(graph.links.find((l) => l.target === "saved")!.valueCents).toBe(HIS_CENTS);
  });

  test("⛔ /budgets' \"$X in so far\" and the dashboard's period panel leave it out", () => {
    expect(incomeExpectation(bundle.db, SEPT.from, SEPT.to, TODAY).postedCents).toBe(HIS_CENTS);
    expect(periodActivity(bundle.db, SEPT.from, SEPT.to, 10).summary.inCents).toBe(HIS_CENTS);
  });

  test("⛔ analytics' per-month income split has no caller on a page, and still leaves it out", () => {
    const cells = incomeByMonth(bundle.db, { months: 1, refDate: SEPT.to });
    expect(cells.map((c) => [c.categoryName, c.incomeCents, c.txnCount])).toEqual([
      ["Dividends", 7, 1],
      ["Salary", 114_192, 1],
    ]);
  });

  test("⛔ the Income card's link opens exactly the rows behind it — the agent's are not among them", () => {
    const filters = parseFilters({ category: "income", from: SEPT.from, to: SEPT.to });
    const ids = matchingTransactionIds(bundle.db, filters, "all");
    const rows = bundle.db
      .select({ accountId: transactions.accountId, amountCents: transactions.amountCents })
      .from(transactions)
      .where(inArray(transactions.id, ids))
      .all();
    expect(countMatching(bundle.db, filters, "all")).toBe(2);
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(periodTotals(bundle.db, SEPT).earnedCents);
    expect(rows.some((r) => r.accountId === agentic)).toBe(false);
    // the Net card's population is spending ∪ income, and the agent's income is in neither
    expect(countMatching(bundle.db, parseFilters({ category: "cashflow", ...SEPT }), "all")).toBe(2);
  });

  /*
   * 🔴 The drill-down contract, one category at a time. The Sankey's income sources and the cash-flow chart's income
   * segments link to `category=<subcategory>&flow=in`, and only the `income` and `cashflow` scopes had learned whose
   * money is whose: "Dividends $0.07" (his GOOG) opened his row AND the agent's WMT $0.06. On main the figure and the
   * link had counted the agent's row together; the branch moved one and not the other.
   */
  test("⛔ a per-category income link — the Sankey's sources, the cash-flow chart's segments — opens exactly its rows", () => {
    const opened = (href: string) => {
      const filters = parseFilters(Object.fromEntries(new URL(href, "http://ledger.test").searchParams));
      return bundle.db
        .select({ accountId: transactions.accountId, amountCents: transactions.amountCents })
        .from(transactions)
        .where(inArray(transactions.id, matchingTransactionIds(bundle.db, filters, "all")))
        .all();
    };
    const sum = (rows: readonly { amountCents: number }[]) => rows.reduce((s, r) => s + r.amountCents, 0);

    const graph = spendingSankey(bundle.db, SEPT);
    const sources = graph.nodes.filter((n) => n.meta?.kind === "income");
    expect(sources.map((n) => n.label).sort()).toEqual(["Dividends", "Salary"]);
    for (const node of sources) {
      const rows = opened(node.href!);
      expect(sum(rows), node.label).toBe(graph.links.find((l) => l.source === node.id)!.valueCents);
      expect(rows.some((r) => r.accountId === agentic), node.label).toBe(false);
    }

    const flow = cashFlowByPeriod(bundle.db, resolvePeriod({ period: "2026-09" }, TODAY), TODAY);
    let segments = 0;
    for (const s of flow.incomeSeries) {
      for (const b of flow.buckets) {
        const cents = b.income[s.key] ?? 0;
        if (cents === 0) continue;
        segments += 1;
        const rows = opened(cashFlowSegmentHref(s.key, s.categoryId, { from: b.from, to: b.to }, "in"));
        expect(sum(rows), `${s.label} ${b.key}`).toBe(cents);
      }
    }
    // his two rows are two segments; the agent's two days draw none, and a link on one opens none
    expect(segments).toBe(2);
    const dividends = flow.incomeSeries.find((s) => s.label === "Dividends")!;
    expect(opened(cashFlowSegmentHref(dividends.key, dividends.categoryId, { from: "2026-09-08", to: "2026-09-08" }, "in"))).toEqual([]);
  });

  test("⚖️ the net-worth bridge still counts it — on its own band — and the window still closes", () => {
    for (const a of bundle.db.select({ id: accounts.id }).from(accounts).all()) rebuildAccount(bundle.db, a.id);
    const got = netWorthAttribution(bundle.db, "2026-08-31", SEPT.to, nwOn("2026-08-31"), nwOn(SEPT.to));

    const band = Object.fromEntries(got.bands.map((b) => [b.key, b.cents]));
    expect(band).toMatchObject({ earned: HIS_CENTS, agentIncome: AGENTS_CENTS });
    // every cent of the month is named: his pay, his dividend, and the agent's $0.10 on a line of its own
    expect(got.deltaCents).toBe(HIS_CENTS + AGENTS_CENTS);
    expect([got.unexplainedCents, got.unattributedCents, got.closes]).toEqual([0, 0, true]);
  });

  test("the rule's own edge: with no book paired, Agentic is a cash account like any other, and its income is his", () => {
    // `outsidePortfolioCashAccountIds` names the agent's cash by the pairing; unpaired, nothing says it is not his
    bundle.db.update(accounts).set({ cashAccountId: null }).where(eq(accounts.id, book)).run();

    expect(periodTotals(bundle.db, SEPT).earnedCents).toBe(HIS_CENTS + AGENTS_CENTS);
    expect(incomeExpectation(bundle.db, SEPT.from, SEPT.to, TODAY).postedCents).toBe(HIS_CENTS + AGENTS_CENTS);
    expect(countMatching(bundle.db, parseFilters({ category: "income", ...SEPT }), "all")).toBe(4);

    for (const a of bundle.db.select({ id: accounts.id }).from(accounts).all()) rebuildAccount(bundle.db, a.id);
    const got = netWorthAttribution(bundle.db, "2026-08-31", SEPT.to, nwOn("2026-08-31"), nwOn(SEPT.to));
    expect(Object.fromEntries(got.bands.map((b) => [b.key, b.cents]))).toMatchObject({
      earned: HIS_CENTS + AGENTS_CENTS,
      agentIncome: 0,
    });
    expect(got.closes).toBe(true);
  });
});
