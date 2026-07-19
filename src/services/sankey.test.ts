import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { computeSankeyLayout, type SankeyGraph } from "@/lib/sankey-layout";
import { createAccount } from "./accounts";
import { spendingSankey } from "./sankey";

const RANGE = { from: "2026-07-01", to: "2026-07-31" };

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let cardId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-sankey-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function catId(pathStr: string): string {
  const [parentName, subName] = pathStr.split(" > ");
  const parent = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get();
  if (!parent) throw new Error(`missing category ${parentName}`);
  if (!subName) return parent.id;
  const sub = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get();
  if (!sub) throw new Error(`missing category ${pathStr}`);
  return sub.id;
}

let seq = 0;
function insertTxn(spec: { postedOn: string; amountCents: number; category?: string | null; accountId?: string }): void {
  seq += 1;
  const accountId = spec.accountId ?? cardId;
  const raw = `TXN ${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: spec.postedOn,
      amountCents: spec.amountCents,
      rawDescription: raw,
      normalizedDescription: raw,
      categoryId: spec.category ? catId(spec.category) : null,
      status: "active",
      dedupeHash: dedupeHash({ accountId, postedOn: spec.postedOn, amountCents: spec.amountCents, rawDescription: raw, occurrenceIndex: seq }),
    })
    .run();
}

/** the sum of link widths flowing INTO / OUT OF a node id */
function faceSums(graph: SankeyGraph) {
  const inSum = new Map<string, number>();
  const outSum = new Map<string, number>();
  for (const l of graph.links) {
    inSum.set(l.target, (inSum.get(l.target) ?? 0) + l.valueCents);
    outSum.set(l.source, (outSum.get(l.source) ?? 0) + l.valueCents);
  }
  return { inSum, outSum };
}

describe("spendingSankey — balance & structure", () => {
  test("empty range → empty graph", () => {
    expect(spendingSankey(bundle.db, RANGE)).toEqual({ nodes: [], links: [] });
  });

  test("income > spend: sources feed a hub that feeds categories + a 'Net saved' leaf, and it conserves", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 500_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-02", amountCents: 100_000, category: "Income > Interest", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-05", amountCents: -30_000, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-08", amountCents: -70_000, category: "Housing > Rent" });
    insertTxn({ postedOn: "2026-07-10", amountCents: -3_000, category: null }); // uncategorized outflow

    const g = spendingSankey(bundle.db, RANGE);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("hub");
    expect(ids).toContain("saved");
    expect(ids).toContain("cat:__uncat");
    expect(g.nodes.filter((n) => n.meta?.kind === "income")).toHaveLength(2);

    const { inSum, outSum } = faceSums(g);
    // hub conserves: everything in == everything out
    expect(inSum.get("hub")).toBe(outSum.get("hub"));
    // total in == earned (600_000); total out == spent (103_000) + saved (497_000)
    expect(inSum.get("hub")).toBe(600_000);
    const saved = g.links.find((l) => l.target === "saved")!;
    expect(saved.valueCents).toBe(600_000 - 103_000); // net = earned − spent
  });

  test("overspend: a 'From savings' source balances the hub, no saved leaf", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 50_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-05", amountCents: -80_000, category: "Food > Dining" });

    const g = spendingSankey(bundle.db, RANGE);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("drawdown");
    expect(ids).not.toContain("saved");

    const { inSum, outSum } = faceSums(g);
    expect(inSum.get("hub")).toBe(outSum.get("hub"));
    expect(inSum.get("hub")).toBe(80_000); // in = earned 50k + drawdown 30k = spent 80k
    const drawdown = g.links.find((l) => l.source === "drawdown")!;
    expect(drawdown.valueCents).toBe(30_000);
  });

  test("refunds appear as a source so the hub still balances (gross-spend convention)", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 100_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-05", amountCents: -20_000, category: "Shopping > General" });
    insertTxn({ postedOn: "2026-07-09", amountCents: 5_000, category: "Shopping > General" }); // refund, not netted into spend

    const g = spendingSankey(bundle.db, RANGE);
    const refund = g.links.find((l) => l.source === "refunds")!;
    expect(refund.valueCents).toBe(5_000);
    const { inSum, outSum } = faceSums(g);
    expect(inSum.get("hub")).toBe(outSum.get("hub"));
    expect(inSum.get("hub")).toBe(105_000); // earned 100k + refund 5k
  });

  test("net == 0 exactly: no saved or drawdown leaf, hub still balances", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 40_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-05", amountCents: -40_000, category: "Food > Dining" });

    const g = spendingSankey(bundle.db, RANGE);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).not.toContain("saved");
    expect(ids).not.toContain("drawdown");
    const { inSum, outSum } = faceSums(g);
    expect(inSum.get("hub")).toBe(40_000);
    expect(inSum.get("hub")).toBe(outSum.get("hub"));
  });

  test("refunds-only period (no income, no spend): Refunds → hub → Net saved, balanced", () => {
    insertTxn({ postedOn: "2026-07-09", amountCents: 5_000, category: "Shopping > General" }); // a return credit

    const g = spendingSankey(bundle.db, RANGE);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("refunds");
    expect(ids).toContain("saved");
    const { inSum, outSum } = faceSums(g);
    expect(inSum.get("hub")).toBe(5_000);
    expect(inSum.get("hub")).toBe(outSum.get("hub"));
  });

  test("all-uncategorized outflow: a single Uncategorized destination, balanced with a drawdown", () => {
    insertTxn({ postedOn: "2026-07-05", amountCents: -12_000, category: null }); // uncategorized spend
    const g = spendingSankey(bundle.db, RANGE);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("cat:__uncat");
    expect(ids).toContain("drawdown"); // no income → the spend is funded from savings
    const { inSum, outSum } = faceSums(g);
    expect(inSum.get("hub")).toBe(12_000);
    expect(inSum.get("hub")).toBe(outSum.get("hub"));
  });

  test("a category fully offset by a same-period refund still draws its GROSS ribbon (gross convention)", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 100_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-05", amountCents: -30_000, category: "Shopping > General" }); // spend
    insertTxn({ postedOn: "2026-07-06", amountCents: 30_000, category: "Shopping > General" }); // refund (nets to $0)

    const g = spendingSankey(bundle.db, RANGE);
    // the category ribbon is the FULL $30k (gross), NOT netted to $0 — the $30k
    // refund is booked to the generic Refunds source, matching periodTotals
    const shopping = g.links.find((l) => l.target.startsWith("cat:") && l.source === "hub" && l.valueCents === 30_000);
    expect(shopping).toBeDefined();
    expect(g.links.find((l) => l.source === "refunds")!.valueCents).toBe(30_000);
    const { inSum, outSum } = faceSums(g);
    expect(inSum.get("hub")).toBe(outSum.get("hub")); // still conserves
    expect(inSum.get("hub")).toBe(130_000); // earned 100k + refund 30k
  });

  test("nodes carry drill hrefs, kinds, and hue colours; the layout renders every ribbon within bounds", () => {
    insertTxn({ postedOn: "2026-07-01", amountCents: 300_000, category: "Income > Salary", accountId: checkingId });
    insertTxn({ postedOn: "2026-07-05", amountCents: -40_000, category: "Food > Dining" });

    const g = spendingSankey(bundle.db, RANGE);
    const food = g.nodes.find((n) => n.meta?.kind === "category")!;
    expect(food.href).toContain("/transactions?");
    expect(food.href).toContain("flow=out");
    expect(food.color).toMatch(/^var\(--/);
    const salary = g.nodes.find((n) => n.meta?.kind === "income")!;
    expect(salary.href).toContain("flow=in");

    // the pure layout accepts this graph and keeps everything on-canvas
    const layout = computeSankeyLayout(g, { width: 600, height: 320 });
    for (const n of layout.nodes) {
      expect(n.x1).toBeLessThanOrEqual(600 + 1e-6);
      expect(n.y1).toBeLessThanOrEqual(320 + 1e-6);
    }
    expect(layout.columns).toBe(3);
  });
});
