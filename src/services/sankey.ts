import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { categoryHueVar, isCategoryHueName } from "@/lib/category-palette";
import { ledgerHref } from "@/lib/ledger-href";
import type { SankeyGraph, SankeyLinkInput, SankeyNodeInput } from "@/lib/sankey-layout";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { activeTxnsInRange, isIncome, loadCategoryIndex, spendingBucket, type DateRange } from "./analytics";

/**
 * The money-flow Sankey feed for a date range (dashboard hero + /spending view).
 * A three-column flow that always balances: income sources → a "Money in" hub →
 * spending categories, with the leftover as a "Net saved" leaf (or, when the
 * range overspent, a "From outside this period" source that makes the money
 * conserve — a plug that names no source, because it cannot know one).
 *
 * Built directly from `activeTxnsInRange` on the SAME classifiers as
 * periodTotals/cashFlowByPeriod (split-aware, GROSS spend, income = `isIncome`:
 * positive income-kind amounts off the agent's cash account), so every ribbon
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

export function spendingSankey(db: AppDatabase, range: DateRange): SankeyGraph {
  const idx = loadCategoryIndex(db);
  // 🔴 the agent's dividend flowed "Dividends → Money in" as his until 2026-09-28 (`isIncome`)
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

  for (const txn of activeTxnsInRange(db, range.from, range.to)) {
    const sb = spendingBucket(idx, txn);
    if (sb) {
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
      continue;
    }
    if (isIncome(idx, agentsCash, txn)) {
      const node = idx.byId.get(txn.categoryId!)!;
      earned += txn.amountCents;
      const cur = income.get(node.id) ?? { name: node.name, hue: colorOf.get(node.id) ?? null, cents: 0 };
      cur.cents += txn.amountCents;
      income.set(node.id, cur);
    }
  }

  const net = earned + refunds - spent;

  // Nothing flowed → an empty graph; the renderer shows its own empty state.
  if (earned + refunds === 0 && spent === 0) return { nodes: [], links: [] };

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
     * account", and the runway card's own doctrine — "Cash pay can sit
     * undeposited, be spent without ever touching a bank, or the arrangement can
     * have quietly ended — nothing here can tell those three apart."
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

  return { nodes, links };
}
