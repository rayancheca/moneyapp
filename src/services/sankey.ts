import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { categoryHueVar, isCategoryHueName } from "@/lib/category-palette";
import { ledgerHref } from "@/lib/ledger-href";
import type { SankeyGraph, SankeyLinkInput, SankeyNodeInput } from "@/lib/sankey-layout";
import { activeTxnsInRange, loadCategoryIndex, spendingBucket, type DateRange } from "./analytics";

/**
 * The money-flow Sankey feed for a date range (dashboard hero + /spending view).
 * A three-column flow that always balances: income sources → a "Money in" hub →
 * spending categories, with the leftover as a "Net saved" leaf (or, when the
 * range overspent, a "From savings" source that makes the money conserve).
 *
 * Built directly from `activeTxnsInRange` on the SAME classifiers as
 * periodTotals/cashFlowByPeriod (split-aware, GROSS spend, income = positive
 * income-kind amounts), so every ribbon reconciles to the StatCards and the
 * ledger. Balance is exact:
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
    if (txn.categoryId !== null && txn.amountCents > 0 && idx.topLevelOf(txn.categoryId).kind === "income") {
      const node = idx.byId.get(txn.categoryId)!;
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
    nodes.push({ id: "drawdown", label: "From savings", column: COL_SOURCE, color: "var(--cat-amber)", meta: { kind: "drawdown" } });
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
