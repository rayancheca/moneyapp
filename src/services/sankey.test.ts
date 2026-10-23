import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { importedThroughFact } from "@/lib/budget-coverage";
import { notImportedTitle } from "@/lib/empty-period";
import { formatDayLong } from "@/lib/format-date";
import { dedupeHash } from "@/lib/hash";
import { resolvePeriod } from "@/lib/period";
import { computeSankeyLayout, type SankeyGraph } from "@/lib/sankey-layout";
import { createAccount } from "./accounts";
import { checkedThrough } from "./checked-days-fixture";
import { spendingReadThrough } from "./movers-card";
import { ledgerOpens, ledgerReaches } from "./observation-frontier";
import { spendingSankey } from "./sankey";
import { cashFlowByPeriod, spendingEmptyCopy } from "./spending";

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
    expect(spendingSankey(bundle.db, RANGE)).toEqual({
      nodes: [],
      links: [],
      spendingUnaccounted: null,
      incomeUnread: false,
    });
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

  /*
   * 🔴 This node was labelled "From savings", which asserts a drawdown the
   * ledger flatly contradicts: on `/spending?period=2026-08&cash=sankey` it was
   * 100% of the chart's money in — $11,063.56 — while SoFi Savings held $0.10
   * and did not move all month. The plug knows only that the window spent more
   * than its recorded income; it cannot know where the difference came from,
   * and the note two cards up already says the app cannot tell.
   */
  test("overspend: the balancing source names no source it cannot know", () => {
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

    const label = g.nodes.find((n) => n.id === "drawdown")!.label;
    expect(label).toBe("From outside this period");
    expect(label).not.toContain("savings");
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

/*
 * ⚖️ Decisions 64 + 72: a window holding money in and NO spending row, not one elapsed day of it read by the day every
 * account he spends from is imported through (`spendingReadThrough`), draws no flow: its "Net saved" is Spent's
 * arithmetic, and Spent is no measurement there. It says why instead — the window's `spendingNotFoundFact`, the one
 * /spending's stat cards, table and heatmap print. 🔴 Review of b356d57, on a second copy of his ledger with one
 * plausible row added (a $1,141.92 pay on Oct 16, the day after Venture X's Oct 14 import; spending read through Aug
 * 12): `/spending?period=2026-10-16` carded "Spent — · Net —" over a Sankey of "Salary $1,141.92 → Money in → Net saved
 * $1,141.92", and the dashboard's Flow 1W drew the same. No day window of his own copy holds it on 2026-10-21; his next
 * Wells Fargo statement makes one if it lands before the card statements.
 */
describe("spendingSankey — a window whose spending has not been found", () => {
  const TODAY = "2026-07-08";

  /** checking is imported through Jul 3, the card through Jul 7: all spending is read through Jul 3 */
  function twoAccountsReadApart(): void {
    insertTxn({ accountId: checkingId, postedOn: "2026-07-01", amountCents: -1_000, category: "Food > Dining" });
    insertTxn({ accountId: checkingId, postedOn: "2026-07-03", amountCents: -2_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-02", amountCents: -500, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-06", amountCents: 50_000, category: "Income > Salary" });
    insertTxn({ postedOn: "2026-07-07", amountCents: -3_000, category: "Food > Dining" });
  }

  test("pay past that day with no spending found draws no Net saved — the graph is empty and names the day", () => {
    twoAccountsReadApart();
    for (const range of [{ from: "2026-07-06", to: "2026-07-06" }, { from: "2026-07-04", to: "2026-07-06" }]) {
      expect(spendingSankey(bundle.db, range, TODAY), JSON.stringify(range)).toEqual({
        nodes: [],
        links: [],
        spendingUnaccounted: "spending imported through Jul 3",
        incomeUnread: false,
      });
    }
  });

  test("a window whose spending is found keeps its flow and its Net saved", () => {
    twoAccountsReadApart();
    const g = spendingSankey(bundle.db, { from: "2026-07-06", to: "2026-07-07" }, TODAY);
    expect(g.spendingUnaccounted).toBeNull();
    expect(g.links.find((l) => l.target === "saved")!.valueCents).toBe(50_000 - 3_000);
    // …and so does one with a day read through it: Jul 1 – 6 holds the checking account's rows
    expect(spendingSankey(bundle.db, { from: "2026-07-01", to: "2026-07-06" }, TODAY).spendingUnaccounted).toBeNull();
  });

  /*
   * Review of 927976a (nit): the tests above never reached money in made only of REFUNDS — earned 0, refunds > 0, spent
   * 0, which the guard routes the same way — nor a window that OPENS on the read day with no spending row in it. Here
   * checking's newest row, Jul 3, is pay, so the read day holds no spending.
   */
  test("money back alone past that day draws no Net saved either; a window opening ON that day keeps its flow", () => {
    insertTxn({ accountId: checkingId, postedOn: "2026-07-01", amountCents: -1_000, category: "Food > Dining" });
    insertTxn({ accountId: checkingId, postedOn: "2026-07-03", amountCents: 20_000, category: "Income > Salary" });
    insertTxn({ postedOn: "2026-07-02", amountCents: -500, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-06", amountCents: 1_500, category: "Food > Dining" }); // a refund
    insertTxn({ postedOn: "2026-07-07", amountCents: -3_000, category: "Food > Dining" });

    expect(spendingSankey(bundle.db, { from: "2026-07-06", to: "2026-07-06" }, TODAY)).toEqual({
      nodes: [],
      links: [],
      spendingUnaccounted: "spending imported through Jul 3",
      incomeUnread: false,
    });
    // the read day is a day read: its window's zero is a measurement, and the pay and the refund flow to Net saved
    const g = spendingSankey(bundle.db, { from: "2026-07-03", to: "2026-07-06" }, TODAY);
    expect(g.spendingUnaccounted).toBeNull();
    expect(g.links.find((l) => l.target === "saved")!.valueCents).toBe(20_000 + 1_500);
    // one day past it is not
    expect(spendingSankey(bundle.db, { from: "2026-07-04", to: "2026-07-06" }, TODAY).spendingUnaccounted).toBe(
      "spending imported through Jul 3",
    );
  });
});

/*
 * ⚖️ §6A 68 on the Sankey lens: a window holding spending and NO income row, not one of its days checked in the
 * accounts his pay lands in (`noIncomeDayReadOf`), draws no flow: its "From outside this period" plug is −Net, Income's
 * arithmetic, and Income is no measurement there. It says why instead (`incomeUnread`). ⚖️ default built, not asked
 * (2026-10-21): decision 64's treatment of the mirror case, in this same function. 🔴 On his ledger copy 2026-10-21
 * `spendingSankey(Oct 1 – 31)` drew "From outside this period $1,603.00" and Sep 26 – Oct 10 "Refunds $15.16 · From
 * outside this period $2,042.17" — Wells Fargo, where It America LLC's pay lands, checked through Sep 24 — beside a Net
 * card, table and hover printing "—" for the same windows.
 */
describe("spendingSankey — a window whose income nobody has looked for", () => {
  const TODAY = "2026-07-08";

  /** his weekly pay lands in checking; the card holds the spending and a refund */
  function payInChecking(): void {
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "It America LLC (weekly pay)",
        kind: "income",
        cadence: "weekly",
        intervalDaysAvg: 7,
        amountCentsAvg: 114_192,
        nextExpectedOn: "2026-07-02",
        nextExpectedAmountCents: 114_192,
        status: "confirmed",
        lastMatchedOn: "2026-06-25",
        accountId: checkingId,
      })
      .run();
    insertTxn({ postedOn: "2026-07-01", amountCents: -21_661, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-02", amountCents: 1_516, category: "Food > Dining" }); // a refund
    insertTxn({ postedOn: "2026-07-07", amountCents: -19_758, category: "Food > Groceries" });
  }

  test("spending with no day checked where the pay lands draws no plug — the graph is empty and says so", () => {
    payInChecking();
    checkedThrough(bundle.db, checkingId, "2026-06-30");
    for (const range of [RANGE, { from: "2026-07-02", to: "2026-07-07" }]) {
      expect(spendingSankey(bundle.db, range, TODAY), JSON.stringify(range)).toEqual({
        nodes: [],
        links: [],
        spendingUnaccounted: null,
        incomeUnread: true,
      });
    }
  });

  test("one day checked makes its $0.00 a measurement: the flow and its plug stand", () => {
    payInChecking();
    checkedThrough(bundle.db, checkingId, "2026-07-01");
    const g = spendingSankey(bundle.db, RANGE, TODAY);
    expect(g.incomeUnread).toBe(false);
    expect(g.links.find((l) => l.source === "drawdown")!.valueCents).toBe(21_661 + 19_758 - 1_516);
    // …and so does a window that opens past the checked day but holds income found
    insertTxn({ accountId: checkingId, postedOn: "2026-07-03", amountCents: 114_192, category: "Income > Salary" });
    expect(spendingSankey(bundle.db, { from: "2026-07-02", to: "2026-07-07" }, TODAY).incomeUnread).toBe(false);
  });

  test("with no live pay schedule there is nothing to wait for: the plug stands, as it always has", () => {
    payInChecking();
    bundle.db.update(recurringSeries).set({ status: "ended" }).run();
    const g = spendingSankey(bundle.db, RANGE, TODAY);
    expect(g.incomeUnread).toBe(false);
    expect(g.nodes.some((n) => n.id === "drawdown")).toBe(true);
  });

  // ⛔ the one rule: /spending's own reading of the same window (`CashFlow.incomeUnread`), never a second one
  test("a window reads exactly as /spending's cash flow reads it", () => {
    payInChecking();
    for (const through of ["2026-06-30", "2026-07-01"]) {
      checkedThrough(bundle.db, checkingId, through);
      const period = resolvePeriod({ period: "2026-07" }, TODAY);
      expect(spendingSankey(bundle.db, RANGE, TODAY).incomeUnread, through).toBe(
        cashFlowByPeriod(bundle.db, period, TODAY).incomeUnread,
      );
    }
  });
});

/*
 * ⚖️ Decisions 64 + 72 and §6A 68 where NOTHING flowed: a window holding no row at all, past the day his spending is
 * read through and with not one day checked where his pay lands, is a window nobody has looked at — both rules answer
 * it as they answer a window holding one side only, and the empty graph carries both facts. Only a window that IS read
 * and found nothing keeps the surface's own words. 🔴 Measured on his ledger copy 2026-10-21 (review of e953d70): the
 * dashboard's Flow 1D (Oct 21) and 1W (Oct 15 – 21) printed "No money flow in this range." — spending read through Aug
 * 12, Wells Fargo checked through Sep 24 — on the page whose Income card reads "Not one day of Oct 2026 has been
 * checked in the accounts that pay lands in", while /spending called the same days "a window nobody has looked at, not
 * one in which nothing happened". The nothing-flowed return ran before either rule was asked.
 */
describe("spendingSankey — a window where nothing was found", () => {
  const TODAY = "2026-07-08";

  /** checking — where the pay lands — is imported and checked through Jul 3; the card through Jul 7 */
  function readThroughJul3(): void {
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "It America LLC (weekly pay)",
        kind: "income",
        cadence: "weekly",
        intervalDaysAvg: 7,
        amountCentsAvg: 114_192,
        nextExpectedOn: "2026-07-02",
        nextExpectedAmountCents: 114_192,
        status: "confirmed",
        lastMatchedOn: "2026-06-25",
        accountId: checkingId,
      })
      .run();
    insertTxn({ accountId: checkingId, postedOn: "2026-07-01", amountCents: -1_000, category: "Food > Dining" });
    insertTxn({ accountId: checkingId, postedOn: "2026-07-03", amountCents: -2_000, category: "Food > Groceries" });
    insertTxn({ postedOn: "2026-07-02", amountCents: -500, category: "Food > Dining" });
    insertTxn({ postedOn: "2026-07-07", amountCents: -3_000, category: "Food > Dining" });
    checkedThrough(bundle.db, checkingId, "2026-07-03");
  }

  test("no row, no spending day read, no pay day checked: the empty graph names both, not 'no money flow'", () => {
    readThroughJul3();
    for (const range of [{ from: "2026-07-06", to: "2026-07-06" }, { from: "2026-07-04", to: "2026-07-06" }]) {
      expect(spendingSankey(bundle.db, range, TODAY), JSON.stringify(range)).toEqual({
        nodes: [],
        links: [],
        spendingUnaccounted: "spending imported through Jul 3",
        incomeUnread: true,
      });
    }
  });

  test("with no live pay schedule only spending's day is named", () => {
    readThroughJul3();
    bundle.db.update(recurringSeries).set({ status: "ended" }).run();
    expect(spendingSankey(bundle.db, { from: "2026-07-04", to: "2026-07-06" }, TODAY)).toEqual({
      nodes: [],
      links: [],
      spendingUnaccounted: "spending imported through Jul 3",
      incomeUnread: false,
    });
  });

  // 🔴 "or one the ledger has not reached" named this window until 2026-10-23 — read as past `ledgerReaches`, the one
  // window that does NOT keep them (below)
  test("a window read that found nothing — or one before the ledger opens — keeps the surface's words", () => {
    readThroughJul3();
    const quiet = { nodes: [], links: [], spendingUnaccounted: null, incomeUnread: false };
    // checking imported and checked through Jul 5: Jul 4 is read on both sides and holds no row — a measured zero
    insertTxn({ accountId: checkingId, postedOn: "2026-07-05", amountCents: -4_000, category: "Food > Dining" });
    checkedThrough(bundle.db, checkingId, "2026-07-05");
    expect(spendingSankey(bundle.db, { from: "2026-07-04", to: "2026-07-04" }, TODAY)).toEqual(quiet);
    // before the ledger opens: nothing there to wait for
    expect(spendingSankey(bundle.db, { from: "2026-06-01", to: "2026-06-30" }, TODAY)).toEqual(quiet);
  });

  /*
   * ⛔ …and the window the guard was written for: one past every account's newest row (`ledgerReaches`) — what his
   * dashboard's Flow 1D and 1W hold whenever a week passes with no statement. 🔴 Second reader of a1c67f0 (round 2):
   * every window above ends on or before the card's Jul 7, so dropping the guard there — `notFound` skipped where
   * `range.from > ledgerReaches(db)` — passed all 192 tests of sankey, SankeyChart and src/app. Measured on his ledger
   * copy 2026-10-23 (newest row Oct 14, spending read through Aug 12): Flow 1D (Oct 23) and 1W (Oct 17 – 23) read
   * "Nothing found so far — spending imported through Aug 12. Not one day of this period has been checked in the
   * accounts that pay lands in, so nothing is shown."; under that mutation, the second sentence alone.
   */
  test("one past every account's newest row, the empty graph still names spending's day", () => {
    readThroughJul3();
    // two days on and nothing imported since: the card's Jul 7 is every account's newest row
    const later = "2026-07-10";
    expect(ledgerReaches(bundle.db)).toBe("2026-07-07");
    for (const range of [{ from: later, to: later }, { from: "2026-07-08", to: later }]) {
      expect(spendingSankey(bundle.db, range, later), JSON.stringify(range)).toEqual({
        nodes: [],
        links: [],
        spendingUnaccounted: "spending imported through Jul 3",
        incomeUnread: true,
      });
    }
  });

  /**
   * What /spending prints of an EMPTY window's spending, in the graph's words: the day its empty state names as all
   * spending's over a window nobody has looked at — the page's own call (`spendingEmptyCopy`, with its one read of that
   * day and its formatter) — or null where it names none.
   */
  function emptyStateNamesSpendingDay(range: { from: string; to: string }): string | null {
    const label = resolvePeriod(range, TODAY).label;
    const through = spendingReadThrough(bundle.db, TODAY);
    const { title, description } = spendingEmptyCopy(bundle.db, range, {
      today: TODAY,
      label,
      ledgerOpens: ledgerOpens(bundle.db),
      ledgerReaches: ledgerReaches(bundle.db),
      spendingReadThrough: through,
      formatDay: formatDayLong,
    });
    const names =
      through !== null &&
      title === notImportedTitle(label) &&
      description.includes(`spending is imported through ${formatDayLong(through)}`);
    return names ? importedThroughFact(through, range.from) : null;
  }

  /*
   * ⛔ The one rule: /spending's own reading of the same window, never a second one — the reading it PRINTS. Over a
   * window holding nothing that is its empty state ("Jul 8, 2026 has not been imported yet — … spending is imported
   * through Fri, Jul 3, 2026. That is a window nobody has looked at …"), and the graph names its day. Its cash flow
   * (`CashFlow.spendingUnaccounted`, what its cards print where a window holds money) agrees where it reaches a bucket
   * of the window; past every account's newest row it reaches none, asks no day and reads null — the dashboard tile's
   * "not imported yet" world (`SpendingPace.spendingNotFound`), never printed over an empty window. 🔴 This pin compared
   * against `CashFlow` over Jul 4 – 6 alone: extended to Jul 8 it failed against the right graph, and held only with
   * the guard dropped (second reader of a1c67f0, round 2). Income is the cash flow's everywhere
   * (`CashFlow.incomeUnread`, `noIncomeDayReadOf`, asked of every window, reached or not).
   */
  test("an empty window reads exactly as /spending reads it", () => {
    readThroughJul3();
    const read = (range: { from: string; to: string }) => {
      const flow = cashFlowByPeriod(bundle.db, resolvePeriod(range, TODAY), TODAY);
      // no money in it: /spending prints its empty state, not its cards
      expect([flow.totals.spentCents, flow.totals.earnedCents], JSON.stringify(range)).toEqual([0, 0]);
      const g = spendingSankey(bundle.db, range, TODAY);
      return {
        graph: [g.spendingUnaccounted, g.incomeUnread],
        page: [emptyStateNamesSpendingDay(range), flow.incomeUnread],
        cashFlow: [flow.buckets.some((b) => b.unreached === null), flow.spendingUnaccounted],
      };
    };
    const readings = [
      { from: "2026-07-04", to: "2026-07-06" }, // inside the ledger, past spending's day
      { from: "2026-07-08", to: "2026-07-08" }, // one past every account's newest row
      { from: "2026-07-08", to: "2026-07-14" }, // …and a week running on past today
      { from: "2026-06-01", to: "2026-06-30" }, // before the ledger opens
    ].map(read);
    expect(readings.map((r) => r.graph)).toEqual(readings.map((r) => r.page));
    // ⚠️ not vacuous: the page names spending's day over every window past it, and over June none
    expect(readings.map((r) => r.page)).toEqual([
      ["spending imported through Jul 3", true],
      ["spending imported through Jul 3", true],
      ["spending imported through Jul 3", true],
      [null, false],
    ]);
    // …and why the cash flow alone was no arbiter: [reaches a bucket, its fact]
    expect(readings.map((r) => r.cashFlow)).toEqual([
      [true, "spending imported through Jul 3"],
      [false, null],
      [false, null],
      [false, null],
    ]);
    // a window read on both sides that found nothing names no day: checking imported and checked through Jul 5
    insertTxn({ accountId: checkingId, postedOn: "2026-07-05", amountCents: -4_000, category: "Food > Dining" });
    checkedThrough(bundle.db, checkingId, "2026-07-05");
    const quiet = read({ from: "2026-07-04", to: "2026-07-04" });
    expect([quiet.graph, quiet.page]).toEqual([
      [null, false],
      [null, false],
    ]);
  });
});
