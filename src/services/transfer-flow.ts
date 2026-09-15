import { and, gte, isNotNull, lte, eq } from "drizzle-orm";

import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { transactions } from "@/db/schema/transactions";
import { CATEGORY_HUE_NAMES, categoryHueVar } from "@/lib/category-palette";
import { ledgerHref } from "@/lib/ledger-href";
import type { DateRange } from "./analytics";
import { isCancelledTransfer } from "./transfer-links";

/**
 * Money moving between the owner's OWN accounts — the one part of his financial
 * life the app deliberately renders nowhere else.
 *
 * `spendingSankey` excludes transfers on purpose: counting them as spending
 * would double-count every dollar. That is right for the Sankey and wrong as a
 * permanent answer, because 12–28 transfers a month sustained for 2.7 years is
 * not noise. This service is the additive surface that gives them a home. It
 * changes no existing feed and no existing total.
 *
 * TWO QUESTIONS SHAPE THE OUTPUT:
 *
 *  1. Where does money actually settle?  → `netCents` per account, source→sink.
 *  2. How much movement is real, how much is churn?  → `churnCents`.
 *
 * He round-trips money, so gross badly overstates real movement. Net is
 * therefore first-class, not a footnote: `churnCents = gross − net`, which is
 * identically `2 × Σ min(A→B, B→A)` over bidirectional pairs. Both derivations
 * are asserted equal in the tests.
 *
 * RECONCILIATION IS NOT OPTIONAL. The detector currently reports groups it never
 * paired (measured on the real database: 650 groups, 516 paired, 134 single-leg,
 * and the 107 Chase Sapphire ones alone carry $33,893.97 of card payments). A
 * view that silently dropped those would violate the codebase's reconciliation
 * doctrine and would hide a whole account. So every group in range is accounted
 * for: it either becomes an edge or it lands in `unattributedGroupCount` /
 * `unattributedCents`, which the UI is expected to SHOW, not swallow.
 *
 * Note the deliberate asymmetry with net: netting money must not net away the
 * events. A net edge carries `count = countA + countB`, because both directions
 * of transfer really happened.
 */

/**
 * A transfer leg pair could not be resolved to exactly one out + one in across
 * two accounts. `cancelled` is the one-account pair whose legs cancel
 * (transfer-links' `isCancelledTransfer`): money that left and came back, not a
 * gap in pairing — it is still counted here, so no group is ever dropped.
 */
export type UnattributedReason = "single-leg" | "multi-leg" | "same-account" | "cancelled";

export interface TransferAccount {
  id: string;
  label: string;
  /** an OKLCH palette var; hue is the SENDING account wherever it is used */
  color: string;
  /** in − out over the range, cents; across all accounts this ALWAYS sums to 0 */
  netCents: number;
  inCents: number;
  outCents: number;
  /** drill target for this account's ledger, windowed to the range */
  href: string;
}

export interface TransferEdge {
  /** `${fromAccountId}>${toAccountId}` — stable and sortable */
  id: string;
  fromAccountId: string;
  toAccountId: string;
  /** cents on this directed edge over the range */
  cents: number;
  /** number of transfer groups on this directed edge */
  count: number;
  /** the gross behind a net edge, and how much of it round-tripped */
  grossCents: number;
  returnedCents: number;
  /** per-month cents, index-aligned to `months`; sums to `cents` */
  monthCents: readonly number[];
  /** per-month count, index-aligned to `months`; sums to `count` */
  monthCounts: readonly number[];
}

export interface TransferFlowTotals {
  grossCents: number;
  netCents: number;
  /** gross − net; identically 2 × Σ min(A→B, B→A) */
  churnCents: number;
  /** transfer groups that resolved into the edges above */
  pairedGroupCount: number;
  /** every group the detector emitted in range, paired or not */
  groupCount: number;
  /** groups these edges do NOT explain — surfaced in the UI, never dropped */
  unattributedGroupCount: number;
  /** money sitting in those unattributed groups (absolute leg value) */
  unattributedCents: number;
  unattributedByReason: Readonly<Record<UnattributedReason, number>>;
}

export interface TransferFlowData {
  /** ordered by netCents ASC — biggest net SOURCE first, biggest net SINK last */
  accounts: readonly TransferAccount[];
  /** gross edges, ordered by cents DESC then id */
  edges: readonly TransferEdge[];
  /** net edges: one per unordered pair, in the winning direction */
  netEdges: readonly TransferEdge[];
  /** "YYYY-MM" ascending and GAP-FREE across the observed span */
  months: readonly string[];
  totals: TransferFlowTotals;
}

interface Leg {
  accountId: string;
  amountCents: number;
  postedOn: string;
}

/** "2026-07-14" → "2026-07". Dates are stored as ISO strings, so this is exact. */
function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Every month from `first` to `last` inclusive, with no holes. */
function monthSpan(first: string, last: string): string[] {
  const out: string[] = [];
  let year = Number(first.slice(0, 4));
  let month = Number(first.slice(5, 7));
  const endYear = Number(last.slice(0, 4));
  const endMonth = Number(last.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/**
 * A stable colour per account. Hue is assigned from the account's position in a
 * deterministic ordering (id ASC), never from iteration order of a Map or from
 * the range — so an account keeps its colour when the date window changes and
 * the visual baselines stay put.
 */
function colorFor(index: number): string {
  const hue = CATEGORY_HUE_NAMES[index % CATEGORY_HUE_NAMES.length] ?? "blue";
  return categoryHueVar(hue);
}

export function transferFlow(db: AppDatabase, range: DateRange): TransferFlowData {
  const rows = db
    .select({
      groupId: transactions.transferGroupId,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      postedOn: transactions.postedOn,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNotNull(transactions.transferGroupId),
        gte(transactions.postedOn, range.from),
        lte(transactions.postedOn, range.to),
      ),
    )
    .all();

  // group by transfer_group_id
  const groups = new Map<string, Leg[]>();
  for (const r of rows) {
    if (r.groupId === null) continue; // isNotNull already excludes these; narrows the type
    const legs = groups.get(r.groupId);
    if (legs) legs.push(r);
    else groups.set(r.groupId, [r]);
  }

  interface EdgeAcc {
    fromAccountId: string;
    toAccountId: string;
    cents: number;
    count: number;
    byMonth: Map<string, { cents: number; count: number }>;
  }
  const edgeAcc = new Map<string, EdgeAcc>();
  const touchedAccounts = new Set<string>();
  const unattributedByReason: Record<UnattributedReason, number> = {
    "single-leg": 0,
    "multi-leg": 0,
    "same-account": 0,
    cancelled: 0,
  };
  let unattributedCents = 0;
  let unattributedGroupCount = 0;
  let pairedGroupCount = 0;
  let firstMonth: string | null = null;
  let lastMonth: string | null = null;

  const noteMonth = (m: string) => {
    if (firstMonth === null || m < firstMonth) firstMonth = m;
    if (lastMonth === null || m > lastMonth) lastMonth = m;
  };

  for (const legs of groups.values()) {
    const outs = legs.filter((l) => l.amountCents < 0);
    const ins = legs.filter((l) => l.amountCents > 0);

    // Anything that is not exactly one outflow and one inflow across two
    // DIFFERENT accounts is unattributed. It is counted and its money is kept
    // visible; it is never quietly discarded.
    const out = outs.length === 1 ? outs[0] : undefined;
    const inn = ins.length === 1 ? ins[0] : undefined;

    let reason: UnattributedReason | null = null;
    if (legs.length === 1) reason = "single-leg";
    else if (out === undefined || inn === undefined) reason = "multi-leg";
    else if (out.accountId === inn.accountId) reason = isCancelledTransfer(legs) ? "cancelled" : "same-account";

    if (reason !== null || out === undefined || inn === undefined) {
      unattributedGroupCount += 1;
      unattributedByReason[reason ?? "multi-leg"] += 1;
      for (const l of legs) {
        unattributedCents += Math.abs(l.amountCents);
        noteMonth(monthOf(l.postedOn));
      }
      continue;
    }

    pairedGroupCount += 1;
    touchedAccounts.add(out.accountId);
    touchedAccounts.add(inn.accountId);

    // The OUTFLOW leg keys the group — the detector's own convention
    // (transfer-links.ts) — and its magnitude is the edge amount, so a wire fee
    // on the receiving side can never inflate the edge.
    const cents = -out.amountCents;
    const month = monthOf(out.postedOn);
    noteMonth(month);

    const id = `${out.accountId}>${inn.accountId}`;
    let acc = edgeAcc.get(id);
    if (!acc) {
      acc = {
        fromAccountId: out.accountId,
        toAccountId: inn.accountId,
        cents: 0,
        count: 0,
        byMonth: new Map(),
      };
      edgeAcc.set(id, acc);
    }
    acc.cents += cents;
    acc.count += 1;
    const bucket = acc.byMonth.get(month);
    if (bucket) {
      bucket.cents += cents;
      bucket.count += 1;
    } else {
      acc.byMonth.set(month, { cents, count: 1 });
    }
  }

  const months = firstMonth !== null && lastMonth !== null ? monthSpan(firstMonth, lastMonth) : [];
  const monthIndex = new Map(months.map((m, i) => [m, i]));

  const buildEdge = (
    id: string,
    fromAccountId: string,
    toAccountId: string,
    acc: EdgeAcc,
    grossCents: number,
    returnedCents: number,
  ): TransferEdge => {
    const monthCents = new Array<number>(months.length).fill(0);
    const monthCounts = new Array<number>(months.length).fill(0);
    for (const [m, v] of acc.byMonth) {
      const i = monthIndex.get(m);
      if (i === undefined) continue;
      monthCents[i] = (monthCents[i] ?? 0) + v.cents;
      monthCounts[i] = (monthCounts[i] ?? 0) + v.count;
    }
    return {
      id,
      fromAccountId,
      toAccountId,
      cents: acc.cents,
      count: acc.count,
      grossCents,
      returnedCents,
      monthCents,
      monthCounts,
    };
  };

  const byCentsThenId = (a: TransferEdge, b: TransferEdge): number =>
    b.cents - a.cents || a.id.localeCompare(b.id);

  const edges: TransferEdge[] = [];
  for (const [id, acc] of edgeAcc) {
    edges.push(buildEdge(id, acc.fromAccountId, acc.toAccountId, acc, acc.cents, 0));
  }
  edges.sort(byCentsThenId);

  // ---- net: one edge per unordered pair, in the winning direction -----------
  // Money nets; EVENTS DO NOT. A net edge keeps count = countA + countB because
  // both directions really happened. A pair that nets to exactly zero drops out
  // of the net view but still contributes its gross to churn.
  const netEdges: TransferEdge[] = [];
  const seenPairs = new Set<string>();
  let churnCents = 0;
  for (const [id, acc] of edgeAcc) {
    const from = acc.fromAccountId;
    const to = acc.toAccountId;
    const pairKey = from < to ? `${from}|${to}` : `${to}|${from}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const back = edgeAcc.get(`${to}>${from}`);
    const backCents = back?.cents ?? 0;
    churnCents += 2 * Math.min(acc.cents, backCents);

    const netCents = acc.cents - backCents;
    if (netCents === 0) continue; // a perfectly balanced pair: no net movement

    const forward = netCents > 0;
    // `back` is necessarily defined when it wins: netCents < 0 requires
    // backCents > acc.cents >= 0, and backCents is 0 when `back` is absent.
    const winner = forward ? acc : (back ?? acc);
    const winnerId = forward ? id : `${to}>${from}`;

    // Month buckets net per month too, clamped at 0 in the winning direction:
    // a month where the pair ran backwards contributes nothing to the net edge
    // rather than a negative bar the eye cannot read.
    const merged: EdgeAcc = {
      fromAccountId: winner.fromAccountId,
      toAccountId: winner.toAccountId,
      cents: 0,
      count: acc.count + (back?.count ?? 0),
      byMonth: new Map(),
    };
    const loser = forward ? back : acc;
    for (const m of months) {
      const w = winner.byMonth.get(m);
      const l = loser?.byMonth.get(m);
      const net = (w?.cents ?? 0) - (l?.cents ?? 0);
      const count = (w?.count ?? 0) + (l?.count ?? 0);
      if (net > 0 || count > 0) {
        merged.byMonth.set(m, { cents: Math.max(0, net), count });
      }
    }
    merged.cents = Math.abs(netCents);
    netEdges.push(
      buildEdge(
        winnerId,
        merged.fromAccountId,
        merged.toAccountId,
        merged,
        winner.cents,
        Math.min(acc.cents, backCents),
      ),
    );
  }
  netEdges.sort(byCentsThenId);

  // ---- accounts -------------------------------------------------------------
  const accountRows = db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .all()
    .filter((a) => touchedAccounts.has(a.id))
    .sort((a, b) => a.id.localeCompare(b.id)); // stable hue assignment

  const inBy = new Map<string, number>();
  const outBy = new Map<string, number>();
  for (const e of edges) {
    outBy.set(e.fromAccountId, (outBy.get(e.fromAccountId) ?? 0) + e.cents);
    inBy.set(e.toAccountId, (inBy.get(e.toAccountId) ?? 0) + e.cents);
  }

  const accountList: TransferAccount[] = accountRows.map((a, i) => {
    const inCents = inBy.get(a.id) ?? 0;
    const outCents = outBy.get(a.id) ?? 0;
    return {
      id: a.id,
      label: a.name,
      color: colorFor(i),
      netCents: inCents - outCents,
      inCents,
      outCents,
      href: ledgerHref({ account: a.id, from: range.from, to: range.to }),
    };
  });
  // source → sink. Ties broken by label so the order is total, never arbitrary.
  accountList.sort((a, b) => a.netCents - b.netCents || a.label.localeCompare(b.label));

  const grossCents = edges.reduce((s, e) => s + e.cents, 0);
  const netTotalCents = netEdges.reduce((s, e) => s + e.cents, 0);

  return {
    accounts: accountList,
    edges,
    netEdges,
    months,
    totals: {
      grossCents,
      netCents: netTotalCents,
      churnCents,
      pairedGroupCount,
      groupCount: groups.size,
      unattributedGroupCount,
      unattributedCents,
      unattributedByReason,
    },
  };
}
