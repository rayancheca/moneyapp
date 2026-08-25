import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { applyUndoPatch } from "./bulk-edit";
import { clusterMatchingIds, clusterRows, confirmCluster, recategorizeCluster, reviewInbox, type ClusterRef } from "./review-inbox";

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let netflixId: string;
let groceriesId: string;
let groceriesLabel: string;
let diningId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-review-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  netflixId = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Netflix")).get()!.id;

  // two distinct child categories with a parent, for label + dominance tests
  const children = bundle.db.select().from(categories).where(isNotNull(categories.parentId)).all();
  const groceries = children.find((c) => /grocer/i.test(c.name)) ?? children[0]!;
  const dining = children.find((c) => c.id !== groceries.id && c.parentId !== null) ?? children[1]!;
  groceriesId = groceries.id;
  diningId = dining.id;
  const parent = bundle.db
    .select({ name: categories.name })
    .from(categories)
    .where(eq(categories.id, groceries.parentId!))
    .get()!;
  groceriesLabel = `${parent.name} > ${groceries.name}`;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function insertTxn(overrides: {
  accountId?: string;
  postedOn?: string;
  amountCents?: number;
  rawDescription?: string;
  merchantId?: string | null;
  categoryId?: string | null;
  needsReview?: boolean;
  status?: "active" | "excluded" | "superseded";
}): string {
  seq += 1;
  const accountId = overrides.accountId ?? checkingId;
  const postedOn = overrides.postedOn ?? "2026-06-15";
  const amountCents = overrides.amountCents ?? -1_549;
  const rawDescription = overrides.rawDescription ?? `TXN ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: normalizeDescription(rawDescription),
      merchantId: overrides.merchantId ?? null,
      categoryId: overrides.categoryId ?? null,
      needsReview: overrides.needsReview ?? true,
      status: overrides.status ?? "active",
      dedupeHash: dedupeHash({
        accountId,
        postedOn,
        amountCents,
        rawDescription: `${rawDescription}#${seq}`,
        occurrenceIndex: 0,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

describe("reviewInbox", () => {
  test("groups a merchant cluster: count, net, uniform dominant category, bounded sample", () => {
    // Arrange: 6 Netflix rows all Groceries (silly but tests uniformity), newest last
    for (let i = 1; i <= 6; i += 1) {
      insertTxn({ merchantId: netflixId, categoryId: groceriesId, postedOn: `2026-06-0${i}`, amountCents: -1_000 });
    }

    // Act
    const inbox = reviewInbox(bundle.db, "2026-07-08");

    // Assert
    expect(inbox.totalCount).toBe(6);
    expect(inbox.clusterCount).toBe(1);
    const cluster = inbox.clusters[0]!;
    expect(cluster.kind).toBe("merchant");
    expect(cluster.label).toBe("Netflix");
    expect(cluster.ref).toEqual({ kind: "merchant", merchantId: netflixId });
    expect(cluster.count).toBe(6);
    expect(cluster.netCents).toBe(-6_000);
    expect(cluster.dominantCategoryId).toBe(groceriesId);
    expect(cluster.dominantCategoryLabel).toBe(groceriesLabel);
    expect(cluster.uniformCategory).toBe(true);
    expect(cluster.sample).toHaveLength(4); // SAMPLE_LIMIT
    expect(cluster.sample[0]!.postedOn).toBe("2026-06-06"); // newest first
  });

  test("mixed categories → plurality dominant, uniform false", () => {
    insertTxn({ merchantId: netflixId, categoryId: groceriesId });
    insertTxn({ merchantId: netflixId, categoryId: groceriesId });
    insertTxn({ merchantId: netflixId, categoryId: diningId });

    const cluster = reviewInbox(bundle.db, "2026-07-08").clusters[0]!;
    expect(cluster.dominantCategoryId).toBe(groceriesId); // 2 vs 1
    expect(cluster.uniformCategory).toBe(false);
  });

  test("all uncategorized → dominant null, uniform false", () => {
    insertTxn({ merchantId: netflixId, categoryId: null });
    insertTxn({ merchantId: netflixId, categoryId: null });

    const cluster = reviewInbox(bundle.db, "2026-07-08").clusters[0]!;
    expect(cluster.dominantCategoryId).toBeNull();
    expect(cluster.dominantCategoryLabel).toBeNull();
    expect(cluster.uniformCategory).toBe(false);
  });

  test("a real category beats an equal-count uncategorized bucket", () => {
    // null inserted first, then a category with the same count — real wins
    insertTxn({ merchantId: netflixId, categoryId: null });
    insertTxn({ merchantId: netflixId, categoryId: groceriesId });

    const cluster = reviewInbox(bundle.db, "2026-07-08").clusters[0]!;
    expect(cluster.dominantCategoryId).toBe(groceriesId);
    expect(cluster.uniformCategory).toBe(false);
  });

  test("equal-count real categories break the tie by id, deterministically", () => {
    insertTxn({ merchantId: netflixId, categoryId: groceriesId });
    insertTxn({ merchantId: netflixId, categoryId: diningId });
    const smaller = groceriesId < diningId ? groceriesId : diningId;

    const cluster = reviewInbox(bundle.db, "2026-07-08").clusters[0]!;
    expect(cluster.dominantCategoryId).toBe(smaller);
  });

  test("merchantless rows fall back to stripped-key clustering; empty keys are singletons", () => {
    // two COKE dividends share a stripped key; a numeric-only row keys to ""
    insertTxn({ rawDescription: "CASH DIV: R/D 2026-04-24 P/D 2026-05-08 - 32. SHARES AT 0.25 (COKE)", amountCents: 800, postedOn: "2026-05-08" });
    insertTxn({ rawDescription: "CASH DIV: R/D 2026-01-16 P/D 2026-02-02 - 30. SHARES AT 0.24 (COKE)", amountCents: 720, postedOn: "2026-02-02" });
    const lone = insertTxn({ rawDescription: "12345678", amountCents: -50 });

    const inbox = reviewInbox(bundle.db, "2026-07-08");
    const similar = inbox.clusters.find((c) => c.ref.kind === "similar")!;
    const single = inbox.clusters.find((c) => c.ref.kind === "single")!;
    expect(similar.count).toBe(2);
    expect(similar.kind).toBe("similar");
    expect((similar.ref as Extract<ClusterRef, { kind: "similar" }>).strippedKey).toContain("COKE");
    expect(single.ref).toEqual({ kind: "single", id: lone });
  });

  test("excludes reviewed, excluded, and superseded rows entirely", () => {
    insertTxn({ merchantId: netflixId, needsReview: false }); // reviewed
    insertTxn({ merchantId: netflixId, status: "excluded" }); // not active
    insertTxn({ merchantId: netflixId, status: "superseded" });
    insertTxn({ merchantId: netflixId, needsReview: true }); // the only one that counts

    const inbox = reviewInbox(bundle.db, "2026-07-08");
    expect(inbox.totalCount).toBe(1);
  });

  test("sorts by count desc, then |net| desc, then label", () => {
    // cluster A: 3 rows (biggest); cluster B: 2 rows big net; stripped C: 2 rows small net
    for (let i = 0; i < 3; i += 1) insertTxn({ merchantId: netflixId, amountCents: -100 });
    const spotify = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Spotify")).get()!.id;
    for (let i = 0; i < 2; i += 1) insertTxn({ merchantId: spotify, amountCents: -9_000 });
    insertTxn({ rawDescription: "CORNER STORE PURCHASE", amountCents: -10, postedOn: "2026-06-01" });
    insertTxn({ rawDescription: "CORNER STORE PURCHASE", amountCents: -10, postedOn: "2026-06-02" });

    const clusters = reviewInbox(bundle.db, "2026-07-08").clusters;
    expect(clusters[0]!.count).toBe(3); // Netflix, most rows
    expect(clusters[1]!.label).toBe("Spotify"); // 2 rows, larger |net| than the stripped pair
  });

  test("amnesty cutoff is the first of the current month; counts rows strictly before it", () => {
    insertTxn({ merchantId: netflixId, postedOn: "2026-05-20" }); // before cutoff
    insertTxn({ merchantId: netflixId, postedOn: "2026-06-30" }); // before cutoff
    insertTxn({ merchantId: netflixId, postedOn: "2026-07-01" }); // ON cutoff — not before
    insertTxn({ merchantId: netflixId, postedOn: "2026-07-05" }); // after

    const inbox = reviewInbox(bundle.db, "2026-07-08");
    expect(inbox.amnestyCutoff).toBe("2026-07-01");
    expect(inbox.amnestyBeforeCount).toBe(2);
  });

  test("empty backlog yields an empty, non-throwing summary", () => {
    const inbox = reviewInbox(bundle.db, "2026-07-08");
    expect(inbox).toMatchObject({ clusters: [], totalCount: 0, clusterCount: 0, amnestyBeforeCount: 0 });
  });

  test("falls back to a representative description when a merchant row lacks a name join", () => {
    // merchant row with a manually-null canonical name can't happen via schema,
    // so exercise the stripped-key label path (normalized description surfaces)
    insertTxn({ rawDescription: "TRADER JOES 447 BROOKLYN NY", postedOn: "2026-06-10" });
    const cluster = reviewInbox(bundle.db, "2026-07-08").clusters[0]!;
    expect(cluster.label).toContain("TRADER JOES");
  });
});

describe("clusterMatchingIds", () => {
  test("merchant ref returns only active needsReview rows for that merchant", () => {
    const a = insertTxn({ merchantId: netflixId });
    const b = insertTxn({ merchantId: netflixId });
    insertTxn({ merchantId: netflixId, needsReview: false }); // reviewed — excluded
    insertTxn({ merchantId: null }); // different cluster

    const ids = clusterMatchingIds(bundle.db, { kind: "merchant", merchantId: netflixId });
    expect(new Set(ids)).toEqual(new Set([a, b]));
  });

  test("similar ref recomputes the stripped key over merchantless rows", () => {
    const a = insertTxn({ rawDescription: "CASH DIV: R/D 2026-04-24 - 32. SHARES AT 0.25 (COKE)", postedOn: "2026-05-08" });
    const b = insertTxn({ rawDescription: "CASH DIV: R/D 2026-01-16 - 30. SHARES AT 0.24 (COKE)", postedOn: "2026-02-02" });
    insertTxn({ rawDescription: "CASH DIV: R/D 2026-05-21 - 24. SHARES AT 0.91 (MSFT)" }); // other key

    const key = (reviewInbox(bundle.db, "2026-07-08").clusters.find((c) => c.ref.kind === "similar")!.ref as Extract<ClusterRef, { kind: "similar" }>).strippedKey;
    const ids = clusterMatchingIds(bundle.db, { kind: "similar", strippedKey: key });
    expect(new Set(ids)).toEqual(new Set([a, b]));
  });

  test("single ref returns just its row while it still needs review", () => {
    const lone = insertTxn({ rawDescription: "12345678" });
    expect(clusterMatchingIds(bundle.db, { kind: "single", id: lone })).toEqual([lone]);
  });
});

describe("confirmCluster", () => {
  test("marks every live member reviewed and is idempotent on re-confirm", () => {
    insertTxn({ merchantId: netflixId });
    insertTxn({ merchantId: netflixId });
    const ref: ClusterRef = { kind: "merchant", merchantId: netflixId };

    const first = confirmCluster(bundle.db, ref);
    expect(first.affected).toBe(2);
    expect(reviewInbox(bundle.db, "2026-07-08").totalCount).toBe(0);

    // the id set recomputes to empty, so a second confirm is a no-op
    const second = confirmCluster(bundle.db, ref);
    expect(second.affected).toBe(0);

    // the returned undo patch losslessly restores the backlog
    expect(applyUndoPatch(bundle.db, first.undo)).toBe(2);
    expect(reviewInbox(bundle.db, "2026-07-08").totalCount).toBe(2);
  });
});

describe("recategorizeCluster", () => {
  test("recategorizes members, stamps user source, clears review", () => {
    const a = insertTxn({ merchantId: netflixId, categoryId: null });
    const ref: ClusterRef = { kind: "merchant", merchantId: netflixId };

    const result = recategorizeCluster(bundle.db, ref, groceriesId);
    expect(result.affected).toBe(1);
    const row = bundle.db.select().from(transactions).where(eq(transactions.id, a)).get()!;
    expect(row.categoryId).toBe(groceriesId);
    expect(row.categorizationSource).toBe("user");
    expect(row.needsReview).toBe(false);
  });

  test("rejects an unknown category and a malformed ref", () => {
    insertTxn({ merchantId: netflixId });
    expect(() => recategorizeCluster(bundle.db, { kind: "merchant", merchantId: netflixId }, "nope")).toThrow(/Unknown category/);
    // @ts-expect-error — malformed ref must be rejected by the schema
    expect(() => recategorizeCluster(bundle.db, { kind: "bogus" }, groceriesId)).toThrow();
  });
});

describe("clusterRows", () => {
  test("returns EVERY member, not just the bounded sample", () => {
    // The card samples four; a cluster of seven Zelle payments to four different
    // people cannot be filed correctly until all seven are reachable.
    for (let i = 0; i < 7; i += 1) {
      insertTxn({ postedOn: `2026-07-0${i + 1}`, rawDescription: "ZELLE PAYMENT TO FRIEND", needsReview: true });
    }
    const inbox = reviewInbox(bundle.db);
    const cluster = inbox.clusters.find((c) => c.count === 7)!;
    expect(cluster.sample).toHaveLength(4);
    expect(clusterRows(bundle.db, cluster.ref)).toHaveLength(7);
  });

  test("each row carries its OWN category, which the cluster's dominant one may not be", () => {
    insertTxn({ postedOn: "2026-07-01", rawDescription: "ZELLE PAYMENT TO PEER", needsReview: true, categoryId: groceriesId });
    insertTxn({ postedOn: "2026-07-02", rawDescription: "ZELLE PAYMENT TO PEER", needsReview: true });

    const inbox = reviewInbox(bundle.db);
    const cluster = inbox.clusters.find((c) => c.count === 2)!;
    const rows = clusterRows(bundle.db, cluster.ref);
    const labelled = rows.filter((r) => r.categoryId !== null);
    expect(labelled).toHaveLength(1);
    expect(labelled[0]!.categoryLabel).toBe(groceriesLabel);
    expect(rows.filter((r) => r.categoryId === null)).toHaveLength(1);
  });

  test("reads the same rows in the same order as the inbox above it", () => {
    // Two queries with their own ORDER BY is how an expanded list ends up
    // disagreeing with the four rows printed directly above it.
    for (let i = 0; i < 6; i += 1) {
      insertTxn({ postedOn: `2026-07-1${i}`, rawDescription: "ZELLE PAYMENT TO C", needsReview: true });
    }
    const cluster = reviewInbox(bundle.db).clusters.find((c) => c.count === 6)!;
    const rows = clusterRows(bundle.db, cluster.ref);
    expect(rows.slice(0, cluster.sample.length).map((r) => r.id)).toEqual(
      cluster.sample.map((r) => r.id),
    );
  });

  test("a reviewed row drops out — the ref is recomputed, not remembered", () => {
    const ids = [0, 1, 2].map((i) =>
      insertTxn({ postedOn: `2026-07-0${i + 1}`, rawDescription: "ZELLE PAYMENT TO D", needsReview: true }),
    );
    const cluster = reviewInbox(bundle.db).clusters.find((c) => c.count === 3)!;
    bundle.db.update(transactions).set({ needsReview: false }).where(eq(transactions.id, ids[0]!)).run();
    expect(clusterRows(bundle.db, cluster.ref)).toHaveLength(2);
  });

  test("an emptied cluster returns nothing rather than throwing", () => {
    const id = insertTxn({ postedOn: "2026-07-01", rawDescription: "ZELLE PAYMENT TO E", needsReview: true });
    const cluster = reviewInbox(bundle.db).clusters.find((c) => c.count === 1)!;
    bundle.db.update(transactions).set({ needsReview: false }).where(eq(transactions.id, id)).run();
    expect(clusterRows(bundle.db, cluster.ref)).toEqual([]);
  });
});
