import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { strippedDescriptionKey } from "@/lib/description-key";
import { todayIso } from "@/lib/dates";
import { bulkApply, type BulkResult } from "./bulk-edit";

/**
 * The review inbox (ux-overhaul-plan §3.3): the `needsReview` backlog rendered
 * as a clearable, merchant-clustered queue instead of a flat list. Rows group
 * by merchant (or the stripped-key fallback for the merchantless), so a whole
 * "Trader Joe's ×6 — all Groceries?" cluster confirms or recategorizes in one
 * gesture. Every action recomputes its id set FROM the cluster identity on the
 * server (never a client-supplied id list), so the blast radius is honest even
 * if the queue shifted between load and click — the same race-safety contract
 * as bulkApplyByFilter (§3.5).
 */

/** The client holds this opaque handle; the server recomputes the live id set. */
export const clusterRefSchema = z.union([
  z.object({ kind: z.literal("merchant"), merchantId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("similar"), strippedKey: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("single"), id: z.string().min(1) }).strict(),
]);
export type ClusterRef = z.infer<typeof clusterRefSchema>;

/** How the cluster reads to the user — "merchant" carries an entity, "similar" a shape. */
export type ReviewClusterKind = "merchant" | "similar";

export interface ReviewClusterSampleRow {
  id: string;
  postedOn: string;
  description: string;
  accountName: string;
  amountCents: number;
}

export interface ReviewCluster {
  /** stable React key + selection identity */
  key: string;
  /** server-recomputable handle for confirm/recategorize */
  ref: ClusterRef;
  kind: ReviewClusterKind;
  label: string;
  count: number;
  /** signed net of the cluster's rows — UI formats magnitude */
  netCents: number;
  /**
   * Plurality current category across the cluster, null when the plurality is
   * uncategorized. Drives the "— all {category}?" confirm copy.
   */
  dominantCategoryId: string | null;
  dominantCategoryLabel: string | null;
  /** every row carries the same non-null category (confirm reads "all X") */
  uniformCategory: boolean;
  /** newest-first preview rows (bounded) */
  sample: ReviewClusterSampleRow[];
}

export interface ReviewInboxSummary {
  clusters: ReviewCluster[];
  /** total active needsReview rows across all clusters */
  totalCount: number;
  clusterCount: number;
  /** first of the current month — the amnesty boundary */
  amnestyCutoff: string;
  /** needsReview rows strictly before the cutoff (the one-time drain target) */
  amnestyBeforeCount: number;
}

const SAMPLE_LIMIT = 4;

interface RawRow {
  id: string;
  postedOn: string;
  rawDescription: string;
  normalizedDescription: string;
  amountCents: number;
  categoryId: string | null;
  merchantId: string | null;
  merchantName: string | null;
  accountName: string;
}

/** Full category label — "Parent > Child" for children, bare name for roots. */
function buildCategoryLabels(db: AppDatabase): Map<string, string> {
  const all = db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
    .from(categories)
    .all();
  const byId = new Map(all.map((c) => [c.id, c]));
  return new Map(
    all.map((c) => {
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      return [c.id, parent ? `${parent.name} > ${c.name}` : c.name];
    }),
  );
}

function representativeLabel(row: RawRow): string {
  const normalized = row.normalizedDescription.trim();
  return normalized !== "" ? normalized : row.rawDescription;
}

/** The grouping decision for one row — its ref, display kind, and label seed. */
function classify(row: RawRow): { keyStr: string; ref: ClusterRef; kind: ReviewClusterKind } {
  if (row.merchantId) {
    return {
      keyStr: `m:${row.merchantId}`,
      ref: { kind: "merchant", merchantId: row.merchantId },
      kind: "merchant",
    };
  }
  const strippedKey = strippedDescriptionKey(row.normalizedDescription);
  if (strippedKey !== "") {
    return { keyStr: `s:${strippedKey}`, ref: { kind: "similar", strippedKey }, kind: "similar" };
  }
  // nothing survived stripping — a genuine singleton, keyed by its own id
  return { keyStr: `t:${row.id}`, ref: { kind: "single", id: row.id }, kind: "similar" };
}

/**
 * Plurality category across a cluster. Counts uncategorized (null) as its own
 * bucket; on a tie a real category beats null (more actionable to surface), and
 * ties among real categories break by id for determinism.
 */
function dominantCategory(rows: readonly RawRow[]): {
  categoryId: string | null;
  uniform: boolean;
} {
  const counts = new Map<string | null, number>();
  for (const row of rows) counts.set(row.categoryId, (counts.get(row.categoryId) ?? 0) + 1);
  const distinctNonNull = [...counts.keys()].filter((k) => k !== null);
  const uniform = distinctNonNull.length === 1 && !counts.has(null);

  let best: string | null = null;
  let bestCount = -1;
  for (const [categoryId, n] of counts) {
    const beats =
      n > bestCount ||
      // tie: prefer a real category over null, then smaller id
      (n === bestCount &&
        best !== null &&
        categoryId !== null &&
        categoryId < best) ||
      (n === bestCount && best === null && categoryId !== null);
    if (beats) {
      best = categoryId;
      bestCount = n;
    }
  }
  return { categoryId: best, uniform };
}

function sortClusters(a: ReviewCluster, b: ReviewCluster): number {
  return (
    b.count - a.count ||
    Math.abs(b.netCents) - Math.abs(a.netCents) ||
    a.label.localeCompare(b.label)
  );
}

/** Loads and clusters the active needsReview backlog. */
export function reviewInbox(db: AppDatabase, today: string = todayIso()): ReviewInboxSummary {
  const rows: RawRow[] = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      rawDescription: transactions.rawDescription,
      normalizedDescription: transactions.normalizedDescription,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      merchantId: transactions.merchantId,
      merchantName: merchants.canonicalName,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(and(eq(transactions.status, "active"), eq(transactions.needsReview, true)))
    // newest first, with content-column tiebreaks so cluster samples/labels are
    // stable across re-imports/reseeds (uuidv7 ids and per-seed account ids
    // shuffle otherwise-identical rows — same discipline as the ledger orderBy).
    // id is only an absolute fallback for byte-identical rows, which render the
    // same, so it never moves a pixel.
    .orderBy(
      desc(transactions.postedOn),
      desc(transactions.amountCents),
      desc(transactions.rawDescription),
      asc(accounts.name),
      desc(transactions.id),
    )
    .all();

  const labels = buildCategoryLabels(db);
  const groups = new Map<string, { ref: ClusterRef; kind: ReviewClusterKind; rows: RawRow[] }>();
  for (const row of rows) {
    const { keyStr, ref, kind } = classify(row);
    const existing = groups.get(keyStr);
    if (existing) existing.rows.push(row);
    else groups.set(keyStr, { ref, kind, rows: [row] });
  }

  const clusters: ReviewCluster[] = [];
  for (const [key, group] of groups) {
    const { categoryId, uniform } = dominantCategory(group.rows);
    const head = group.rows[0]!;
    clusters.push({
      key,
      ref: group.ref,
      kind: group.kind,
      label: group.kind === "merchant" ? (head.merchantName ?? representativeLabel(head)) : representativeLabel(head),
      count: group.rows.length,
      netCents: group.rows.reduce((sum, r) => sum + r.amountCents, 0),
      dominantCategoryId: categoryId,
      dominantCategoryLabel: categoryId ? (labels.get(categoryId) ?? null) : null,
      uniformCategory: uniform,
      sample: group.rows.slice(0, SAMPLE_LIMIT).map((r) => ({
        id: r.id,
        postedOn: r.postedOn,
        description: representativeLabel(r),
        accountName: r.accountName,
        amountCents: r.amountCents,
      })),
    });
  }
  clusters.sort(sortClusters);

  const amnestyCutoff = `${today.slice(0, 7)}-01`;
  const amnestyBeforeCount = rows.filter((r) => r.postedOn < amnestyCutoff).length;

  return {
    clusters,
    totalCount: rows.length,
    clusterCount: clusters.length,
    amnestyCutoff,
    amnestyBeforeCount,
  };
}

/**
 * Recomputes the live active-needsReview id set for a cluster from its identity.
 * Recomputing (rather than trusting client ids) keeps confirm/recategorize
 * race-safe and idempotent: a re-confirm hits the now-empty set.
 */
export function clusterMatchingIds(db: AppDatabase, ref: ClusterRef): string[] {
  const base = and(eq(transactions.status, "active"), eq(transactions.needsReview, true))!;
  if (ref.kind === "merchant") {
    return db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(base, eq(transactions.merchantId, ref.merchantId)))
      .all()
      .map((r) => r.id);
  }
  if (ref.kind === "single") {
    return db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(base, eq(transactions.id, ref.id)))
      .all()
      .map((r) => r.id);
  }
  // similar: the stripped key is a derived value, so recompute it over the
  // merchantless backlog (the only rows the fallback ever grouped)
  return db
    .select({ id: transactions.id, normalizedDescription: transactions.normalizedDescription })
    .from(transactions)
    .where(and(base, isNull(transactions.merchantId)))
    .all()
    .filter((r) => strippedDescriptionKey(r.normalizedDescription) === ref.strippedKey)
    .map((r) => r.id);
}

/** Confirm a cluster: mark every live member reviewed (§3.3). */
export function confirmCluster(db: AppDatabase, ref: ClusterRef): BulkResult {
  const parsed = clusterRefSchema.parse(ref);
  return bulkApply(db, clusterMatchingIds(db, parsed), { markReviewed: true });
}

/** Fix a cluster: recategorize every live member (also clears needsReview). */
export function recategorizeCluster(
  db: AppDatabase,
  ref: ClusterRef,
  categoryId: string,
): BulkResult {
  const parsed = clusterRefSchema.parse(ref);
  const category = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .get();
  if (!category) throw new Error("Unknown category");
  return bulkApply(db, clusterMatchingIds(db, parsed), { categoryId });
}
