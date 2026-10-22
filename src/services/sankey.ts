import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { spendingNotFoundFact } from "@/lib/budget-coverage";
import { categoryHueVar, isCategoryHueName } from "@/lib/category-palette";
import { ledgerHref } from "@/lib/ledger-href";
import type { SankeyGraph, SankeyLinkInput, SankeyNodeInput } from "@/lib/sankey-layout";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { hisLiveIncomeSeries, noIncomeDayReadOf } from "./budgets";
import {
  activeTxnsInRange,
  hisIncomeRows,
  incomeSeriesOfRender,
  loadCategoryIndex,
  spendingBucket,
  type DateRange,
} from "./analytics";
import { spendingReadThrough } from "./movers-card";
import { ledgerOpens } from "./observation-frontier";

/**
 * The money-flow Sankey feed for a date range (dashboard hero + /spending view).
 * A three-column flow that always balances: income sources → a "Money in" hub →
 * spending categories, with the leftover as a "Net saved" leaf (or, when the
 * range overspent, a "From outside this period" source that makes the money
 * conserve — a plug that names no source, because it cannot know one).
 *
 * Built directly from `activeTxnsInRange` on the SAME classifiers as
 * periodTotals/cashFlowByPeriod (split-aware, GROSS spend = `spendingBucket`,
 * income = `hisIncomeRows`, his pay by the day: each off the agent's cash account), so every ribbon
 * reconciles to the StatCards and the ledger. Balance is exact:
 *   in  = earned + refunds + max(-net, 0)
 *   out = spent  + max(net, 0)
 * and net = earned + refunds − spent, so in ≡ out for every range.
 *
 * Node ids are stable/namespaced (`inc:<catId>`, `cat:<catId>`, `hub`, `saved`,
 * `refunds`, `drawdown`, `cat:__uncat`) and carry `meta.kind` + a drill `href`
 * so the renderer can colour, label, and link each node without re-deriving.
 */

export type SankeyNodeKind =
  | "income"
  | "hub"
  | "category"
  | "uncategorized"
  | "saved"
  | "refund"
  | "drawdown";

const COL_SOURCE = 0;
const COL_HUB = 1;
const COL_DEST = 2;
const HUB_ID = "hub";
const UNCAT_ID = "cat:__uncat";

interface Bucket {
  name: string;
  hue: string | null;
  cents: number;
}

function hueColor(hue: string | null, fallback: string): string {
  return isCategoryHueName(hue) ? categoryHueVar(hue) : fallback;
}

function byValueThenName(a: [string, Bucket], b: [string, Bucket]): number {
  return b[1].cents - a[1].cents || a[1].name.localeCompare(b[1].name);
}

/**
 * The flow, and why it draws none where its spending has not been found.
 *
 * ⚖️ Decisions 64 + 72: a window holding money in and NO spending row, not one elapsed day of it read by the day every
 * account he spends from is imported through (`spendingReadThrough`), has no "Net saved" — that leaf is Spent's
 * arithmetic, and Spent is no measurement there. The graph comes back empty with the window's `spendingNotFoundFact`
 * ("spending imported through Aug 12"), the fact /spending's stat cards, table and heatmap print, and the chart says
 * it (`SankeyChart`). 🔴 Review of b356d57, on a second copy of his ledger with one plausible row added — a $1,141.92
 * pay on Oct 16, the day after Venture X's Oct 14 import, spending read through Aug 12: `/spending?period=2026-10-16`
 * carded "Spent — · Net —" over "Salary $1,141.92 → Money in → Net saved $1,141.92", and the dashboard's Flow 1W (Oct
 * 15 – 21) drew the same. No day window of his own copy holds it on 2026-10-21 (Jul 1 – Oct 21 swept); his next Wells
 * Fargo statement makes one if it lands before the card statements.
 *
 * ⛔ Both rules below are asked of a window where NOTHING flowed too: no row at all over days nobody has read is not a
 * window "with no money flow", and the empty graph carries both facts. Only a window read on both sides that found
 * nothing — or one the ledger has not reached — keeps the surface's own empty words. 🔴 Measured on his ledger copy
 * 2026-10-21 (review of e953d70): the dashboard's Flow 1D (Oct 21) and 1W (Oct 15 – 21) printed "No money flow in this
 * range." under that page's Income card, "Not one day of Oct 2026 has been checked in the accounts that pay lands in";
 * the nothing-flowed return ran before either rule was asked.
 */
export interface SpendingSankey extends SankeyGraph {
  /** the window's `spendingNotFoundFact` where the graph is empty for it; null where the graph is the flow */
  spendingUnaccounted: string | null;
  /**
   * ⚖️ §6A 68: the window holds no income row and not one of its days is checked in the accounts his pay lands in
   * (`noIncomeDayReadOf` — /spending's `CashFlow.incomeUnread`, the dashboard's and /budgets' reading), so the graph is
   * empty for it: the "From outside this period" plug is −Net, Income's arithmetic, and so is "Net saved". The chart
   * says why in the Income card's words (`sankeyEmptyCopy`). ⚖️ default built, not asked (2026-10-21): decision 64's
   * treatment of the mirror case above, not a plug relabelled to keep the categories — its hub would still read "Money
   * in $1,603.00" over an Income the page dashes. 🔴 On his ledger copy 2026-10-21 Oct 1 – 31 drew "From outside this
   * period $1,603.00" and Sep 26 – Oct 10 "Refunds $15.16 · From outside this period $2,042.17", Wells Fargo checked
   * through Sep 24, beside a Net card, table and hover printing "—" (review of 6cb97ea). False where the graph is the
   * flow, and where nothing flowed over days that are read (the surface's own empty words).
   */
  incomeUnread: boolean;
}

/**
 * `today` asks whether the window's spending has been found (`SpendingSankey`) — every page passes it (`/spending`,
 * the dashboard's Flow, pinned in their page tests). ⛔ Omitted, the graph is drawn from the rows alone: a fixture
 * asking its shape. ⚡ The day is asked only where the window holds no spending row (`spendingReadThrough` is memoised
 * for the render); /spending's cash flow asks the same window by the same rule.
 */
export function spendingSankey(db: AppDatabase, range: DateRange, today?: string): SpendingSankey {
  const idx = loadCategoryIndex(db);
  // 🔴 the agent's dividend flowed "Dividends → Money in" as his until 2026-09-28 (`isIncome`), and its fees out of
  // his money until 2026-10-02 (`spendingBucket`)
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const colorOf = new Map(
    db.select({ id: categories.id, color: categories.color }).from(categories).all().map((c) => [c.id, c.color]),
  );

  const income = new Map<string, Bucket>();
  const spendTop = new Map<string, Bucket>();
  let uncatSpend = 0;
  let earned = 0;
  let spent = 0;
  let refunds = 0;

  const rows = activeTxnsInRange(db, range.from, range.to);
  for (const txn of rows) {
    const sb = spendingBucket(idx, agentsCash, txn);
    if (!sb) continue;
    if (txn.amountCents >= 0) {
      refunds += txn.amountCents; // a credit in an expense category — money back, not spend
      continue;
    }
    const out = -txn.amountCents;
    spent += out;
    if (sb.categoryId === null) {
      uncatSpend += out;
      continue;
    }
    const cur = spendTop.get(sb.categoryId) ?? { name: sb.categoryName, hue: colorOf.get(sb.categoryId) ?? null, cents: 0 };
    cur.cents += out;
    spendTop.set(sb.categoryId, cur);
  }
  // the Income card's sources, his pay by the day (`hisIncomeRows`, decision 75): a payroll returned the same day
  // flows into nothing
  for (const row of hisIncomeRows(idx, agentsCash, incomeSeriesOfRender(db), rows)) {
    const node = idx.byId.get(row.categoryId)!;
    earned += row.amountCents;
    const cur = income.get(node.id) ?? { name: node.name, hue: colorOf.get(node.id) ?? null, cents: 0 };
    cur.cents += row.amountCents;
    income.set(node.id, cur);
  }

  const net = earned + refunds - spent;

  // No spending found past the day all of it is read through draws no Net saved (see the type) — asked before
  // "nothing flowed": no row at all past that day is a window nobody has looked at, not one in which nothing happened
  const notFound =
    spent !== 0 || today === undefined
      ? null
      : spendingNotFoundFact({
          from: range.from,
          to: range.to,
          today,
          ledgerOpens: ledgerOpens(db),
          readThrough: spendingReadThrough(db, today),
          spentCents: spent,
        });
  // …and no income found with not one day checked where the pay lands draws no plug (see the type), asked the same.
  // ⚡ the schedules and the pay's frontier are read only where the window found no income
  const incomeUnread =
    today !== undefined &&
    earned === 0 &&
    noIncomeDayReadOf(db, today, hisLiveIncomeSeries(db, agentsCash))(range.from, earned);
  if (notFound !== null || incomeUnread) return { nodes: [], links: [], spendingUnaccounted: notFound, incomeUnread };
  // Nothing flowed over days that are read → an empty graph; the renderer shows the surface's own empty words.
  if (earned + refunds === 0 && spent === 0) {
    return { nodes: [], links: [], spendingUnaccounted: null, incomeUnread: false };
  }

  const nodes: SankeyNodeInput[] = [
    { id: HUB_ID, label: "Money in", column: COL_HUB, color: "var(--ink-muted)", meta: { kind: "hub" } },
  ];
  const links: SankeyLinkInput[] = [];

  // ── Sources (column 0): income subcategories, then refunds, then drawdown ──
  for (const [id, v] of [...income.entries()].sort(byValueThenName)) {
    nodes.push({
      id: `inc:${id}`,
      label: v.name,
      column: COL_SOURCE,
      color: hueColor(v.hue, "var(--cat-green)"),
      href: ledgerHref({ category: id, from: range.from, to: range.to, flow: "in" }),
      meta: { kind: "income", categoryId: id },
    });
    links.push({ source: `inc:${id}`, target: HUB_ID, valueCents: v.cents });
  }
  if (refunds > 0) {
    nodes.push({ id: "refunds", label: "Refunds", column: COL_SOURCE, color: "var(--cat-teal)", meta: { kind: "refund" } });
    links.push({ source: "refunds", target: HUB_ID, valueCents: refunds });
  }
  if (net < 0) {
    /*
     * 🔴 THE PLUG MAY NOT NAME A SOURCE. This node was labelled "From savings",
     * which asserts a drawdown the ledger flatly contradicts: on August 2026 it
     * was 100% of the chart's money in — $11,063.56 — while SoFi Savings held
     * $0.10 and did not move all month.
     *
     * The app knows better and says so two cards up: "Cash job (weekly pay)
     * implies $5,235.00 of earnings in this period and none of it reached an
     * account", and the income card's own doctrine — "Pay taken in cash can sit
     * undeposited or be spent without ever touching a bank, … or the arrangement can
     * have quietly ended — nothing here can tell those apart."
     *
     * All this node knows is that the window spent more than its recorded income,
     * so the balancing amount came from outside it. That is what it says.
     */
    nodes.push({ id: "drawdown", label: "From outside this period", column: COL_SOURCE, color: "var(--cat-amber)", meta: { kind: "drawdown" } });
    links.push({ source: "drawdown", target: HUB_ID, valueCents: -net });
  }

  // ── Destinations (column 2): categories, uncategorized, then the saved leaf ──
  for (const [id, v] of [...spendTop.entries()].sort(byValueThenName)) {
    nodes.push({
      id: `cat:${id}`,
      label: v.name,
      column: COL_DEST,
      color: hueColor(v.hue, "var(--ink-muted)"),
      href: ledgerHref({ category: id, from: range.from, to: range.to, flow: "out" }),
      meta: { kind: "category", categoryId: id },
    });
    links.push({ source: HUB_ID, target: `cat:${id}`, valueCents: v.cents });
  }
  if (uncatSpend > 0) {
    nodes.push({
      id: UNCAT_ID,
      label: "Uncategorized",
      column: COL_DEST,
      color: "var(--ink-faint)",
      href: ledgerHref({ category: null, from: range.from, to: range.to, flow: "out" }),
      meta: { kind: "uncategorized" },
    });
    links.push({ source: HUB_ID, target: UNCAT_ID, valueCents: uncatSpend });
  }
  if (net > 0) {
    nodes.push({ id: "saved", label: "Net saved", column: COL_DEST, color: "var(--positive)", meta: { kind: "saved" } });
    links.push({ source: HUB_ID, target: "saved", valueCents: net });
  }

  return { nodes, links, spendingUnaccounted: null, incomeUnread: false };
}
