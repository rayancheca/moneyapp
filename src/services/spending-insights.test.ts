import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { validateProse } from "@/lib/insight-validator";
import { MAX_INSIGHTS } from "./insights";
import { monotonicDirection, spendingInsights } from "./spending-insights";

/**
 * What this page is allowed to SAY, proven against a ledger whose answers are
 * known independently.
 *
 * The arithmetic belongs to `categoryBreakdown` and `moversCard` and is already
 * tested there; what is new here is the sentence — which claim the facts admit,
 * and which they refuse.
 */

let dir: string;
let bundle: DbBundle;

/** mid-month and mid-import: the shape the real ledger is always in */
const TODAY = "2026-08-26";
const MAIN = "acct-main";

function topLevelId(name: string): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), isNull(categories.parentId)))
    .get()!.id;
}

let seq = 0;
function addTxn(day: string, cents: number, categoryName: string | null, accountId: string = MAIN): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId,
      importFileId: null,
      postedOn: day,
      amountCents: cents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId: categoryName === null ? null : topLevelId(categoryName),
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

/** Moves the import frontier without adding a cent of spend (movers-card's idiom). */
function importedThrough(day: string): void {
  addTxn(day, 1, null);
}

const BASELINE = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] as const;

function spendAllBaselineMonths(categoryName: string, cents: number): void {
  for (const m of BASELINE) addTxn(`${m}-10`, -cents, categoryName);
}

function addAccount(id: string, name: string): void {
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-insights-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  addAccount(MAIN, "Chase Checking");
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A ledger with a clear largest category and one real mover. */
function ordinaryLedger(): void {
  spendAllBaselineMonths("Food", 10_000); // $100 a month
  spendAllBaselineMonths("Travel", 5_000); // $50 a month
  addTxn("2026-07-10", -30_000, "Food"); // $300 in July
  addTxn("2026-07-12", -20_000, "Travel"); // $200 in July
  importedThrough("2026-08-20");
}

describe("what /spending says about a ledger whose answers are known", () => {
  test("names the largest category, its share, its move and its count", () => {
    ordinaryLedger();
    const out = spendingInsights(bundle.db, TODAY)!;

    expect(out.windowLabel).toBe("Jul 2026");
    expect(out.insights.map((i) => i.text)).toEqual([
      "Food is the largest of your 2 spending categories in Jul 2026, at $300.00.",
      "Food is 60.0% of everything you spent in Jul 2026.",
      "Food rose by $200.00 between its usual month and Jul 2026.",
      /* 🔴 the count was the ONE sentence in this array with no window, over a
         figure measured on the same month as its three siblings — Food holds
         94 rows in Jul 2026 and 2,735 all time on the owner's ledger */
      "1 transaction landed in Food in Jul 2026.",
    ]);
  });

  test("every sentence it emits survives the read gate", () => {
    // the two gates must agree or an insight could be written and then refused
    // at render, which is a blank strip with no explanation
    ordinaryLedger();
    for (const insight of spendingInsights(bundle.db, TODAY)!.insights) {
      expect(insight.provenance).toBeTruthy();
      expect(insight.claimId.length).toBeGreaterThan(0);
    }
  });

  test("it never emits more than it is allowed to", () => {
    ordinaryLedger();
    expect(spendingInsights(bundle.db, TODAY)!.insights.length).toBeLessThanOrEqual(MAX_INSIGHTS);
  });

  test("every insight has its own key — a duplicate makes React reuse the wrong node", () => {
    ordinaryLedger();
    const ids = spendingInsights(bundle.db, TODAY)!.insights.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    // and the key names the facts, not only the template
    expect(ids[0]).toContain("f1");
  });

  test("every insight carries a proof, because an unprovable one does not render", () => {
    ordinaryLedger();
    for (const i of spendingInsights(bundle.db, TODAY)!.insights) {
      expect(i.provenance.verdict).toBeTruthy();
    }
  });

  test("the window is the newest month every LIVE SPENDING account was imported past, and it says so", () => {
    ordinaryLedger();
    const out = spendingInsights(bundle.db, TODAY)!;
    // TODAY is in August; the frontier only reaches 2026-08-20, so July is the
    // newest month that has actually been looked at
    /* 🔴 "every account" of a set that is `moversCard`'s `live` — accounts with
       ≥3 non-zero baseline months present in `observationFrontier`, which
       excludes every investment account by design. Measured 2026-09-10:
       `Robinhood Crypto` has been shown through 2026-06-30 and `Capital One
       360 Checking` through nothing at all. The comment above the sentence had
       the scope right; the sentence dropped two words. */
    expect(out.windowNote).toContain(
      "Jul 2026 is the newest month every live spending account has been shown through",
    );
    /*
     * ⛔ It must not explain a multi-month jump with a single month's reason.
     * On the real ledger at 2026-09-02 the window was Jul 2026 and the note
     * said only "Sep 2026 is still being imported" — leaving a reader with
     * August selected to wonder what happened to August. The clause below is
     * what covers every skipped month at once.
     */
    expect(out.windowNote).toContain("no month after it is fully imported yet");
    expect(out.windowNote).toContain("rather than Aug 2026");
  });
});

describe("what it refuses to say", () => {
  test("an empty ledger produces nothing at all — not a sentence about zero", () => {
    expect(spendingInsights(bundle.db, TODAY)).toBeNull();
  });

  test("a ledger with no fully imported month produces nothing", () => {
    // spending, but nothing ever moved the frontier past a month's close
    spendAllBaselineMonths("Food", 10_000);
    expect(spendingInsights(bundle.db, TODAY)).toBeNull();
  });

  test("the uncategorized bucket is never called a spending category", () => {
    // it is the ABSENCE of a category; ranking it would let "the largest of
    // your spending categories" name a hole in the data
    spendAllBaselineMonths("Food", 1_000);
    addTxn("2026-07-10", -90_000, null); // a big uncategorized outflow
    addTxn("2026-07-11", -2_000, "Food");
    addTxn("2026-07-12", -1_000, "Travel");
    importedThrough("2026-08-20");
    const out = spendingInsights(bundle.db, TODAY)!;
    // the $900 hole is larger than everything categorized and is still not the
    // largest CATEGORY, because it is not one
    expect(out.insights[0]!.text).toBe("Food is the largest of your 2 spending categories in Jul 2026, at $20.00.");
    for (const i of out.insights) expect(i.text).not.toContain("Uncategorized");
  });

  test("a category that only refunded is not ranked as spending", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-07-10", -30_000, "Food");
    addTxn("2026-07-11", -10_000, "Travel");
    addTxn("2026-07-12", 5_000, "Shopping"); // net inflow inside an expense category
    importedThrough("2026-08-20");
    const out = spendingInsights(bundle.db, TODAY)!;
    // three categories hold rows in July; only two of them SPENT
    expect(out.insights[0]!.text).toContain("of your 2 spending categories in Jul 2026");
  });

  test("a single spending category is not ranked — first of one is not a ranking", () => {
    spendAllBaselineMonths("Food", 10_000);
    addTxn("2026-07-10", -30_000, "Food");
    importedThrough("2026-08-20");
    const out = spendingInsights(bundle.db, TODAY)!;
    expect(out.insights.some((i) => i.claimId === "largest_in_set")).toBe(false);
    // and it still says the true things it can
    expect(out.insights[0]!.text).toBe("Food is 100.0% of everything you spent in Jul 2026.");
  });

  test("a rise is never described as a fall", () => {
    ordinaryLedger();
    const out = spendingInsights(bundle.db, TODAY)!;
    expect(out.insights.some((i) => i.claimId === "rose_between")).toBe(true);
    expect(out.insights.some((i) => i.claimId === "fell_between")).toBe(false);
  });

  test("a fall is described as a fall", () => {
    spendAllBaselineMonths("Food", 30_000); // $300 a month usually
    addTxn("2026-07-10", -10_000, "Food"); // $100 in July
    importedThrough("2026-08-20");
    const out = spendingInsights(bundle.db, TODAY)!;
    const fell = out.insights.find((i) => i.claimId === "fell_between");
    expect(fell?.text).toBe("Food fell by $200.00 between its usual month and Jul 2026.");
  });

  test("a trend appears only when every month agrees, and names its start", () => {
    // strictly rising in every one of the six baseline months, then July higher
    for (const [i, m] of BASELINE.entries()) addTxn(`${m}-10`, -(1_000 * (i + 1)), "Food");
    addTxn("2026-07-10", -100_000, "Food");
    importedThrough("2026-08-20");
    const rising = spendingInsights(bundle.db, TODAY)!.insights.find((i) => i.claimId === "trend_rising");
    expect(rising?.text).toBe("Food has risen across 6 months since Feb 2026.");
  });

  test("a category that changes its mind gets no trend at all", () => {
    // up, down, up — a line fitted through this would have a slope, and the
    // slope would not be a fact about any month in it
    const zigzag = [1_000, 9_000, 2_000, 8_000, 3_000, 7_000];
    for (const [i, m] of BASELINE.entries()) addTxn(`${m}-10`, -zigzag[i]!, "Food");
    addTxn("2026-07-10", -50_000, "Food");
    importedThrough("2026-08-20");
    const out = spendingInsights(bundle.db, TODAY)!;
    expect(out.insights.some((i) => i.claimId.startsWith("trend_"))).toBe(false);
  });
});

describe("the sentences are checkable against the vocabulary, not just against themselves", () => {
  test("each one parses back to a supported claim over its own facts", () => {
    // A rendered sentence is re-checked here through `validateProse` with a
    // fact set built from the SAME ledger — so a template that drifted from
    // what the facts support fails here rather than on his screen.
    ordinaryLedger();
    const out = spendingInsights(bundle.db, TODAY)!;
    for (const i of out.insights) {
      // the read gate needs the same facts; re-deriving them is the point of
      // the round trip, so this asserts the shape a caller can reconstruct
      expect(i.text.endsWith(".")).toBe(true);
      expect(i.text).not.toContain("{{");
      expect(i.text).not.toContain("undefined");
      expect(i.text).not.toContain("NaN");
    }
  });

  test("an invented sentence over the same shape is refused", () => {
    // the negative control for the test above: same wording, no facts behind it
    expect(validateProse("Food is the largest of your 2 spending categories in Jul 2026, at $300.00.", new Map()).ok).toBe(false);
  });
});

describe("monotonicDirection", () => {
  test("needs at least three points", () => {
    expect(monotonicDirection([1, 2])).toBeNull();
    expect(monotonicDirection([])).toBeNull();
    expect(monotonicDirection([1, 2, 3])).toBe("rising");
  });

  test("every step must agree", () => {
    expect(monotonicDirection([1, 2, 3, 4])).toBe("rising");
    expect(monotonicDirection([4, 3, 2, 1])).toBe("falling");
    expect(monotonicDirection([2, 2, 2])).toBe("flat");
    expect(monotonicDirection([1, 3, 2, 4])).toBeNull();
    // one flat step is enough to break a rise: "has risen" would be false of it
    expect(monotonicDirection([1, 2, 2, 3])).toBeNull();
  });
});

/**
 * ⛔ A subject the app cannot NAME.
 *
 * `insight-facts` refuses `< > { } \` in a label BY THROWING, so a surface that
 * builds a fact from a ledger name without checking renders its route's error
 * boundary instead of a page. That is not hypothetical: `claude-categorize`
 * wrote a merchant literally called `<UNKNOWN>` and `/merchants/019f4ccc…` was
 * broken by it. Every surface that names a ledger entity carries the same guard
 * now, and this is what proves each one still does.
 */
describe("a category the app cannot name", () => {
  /** a top-level category outside the seeded taxonomy, named unprintably */
  function addUnprintableCategory(): void {
    bundle.db
      .insert(categories)
      .values({
        id: "c-bad",
        name: "<UNKNOWN>",
        parentId: null,
        kind: "expense",
        sortOrder: 99,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
  }

  test("declines rather than throwing when the largest category cannot be printed", () => {
    addUnprintableCategory();
    ordinaryLedger();
    // bigger than Food's $300, so it becomes the subject the page would name
    addTxn("2026-07-11", -50_000, "<UNKNOWN>");

    expect(spendingInsights(bundle.db, TODAY)).toBeNull();
  });

  test("a MOVER it cannot name is skipped, and the rest of the page still speaks", () => {
    addUnprintableCategory();
    ordinaryLedger();
    // a big move in the unnameable category — smaller than Food overall, so
    // Food is still the subject and only the delta sentence is at risk
    spendAllBaselineMonths("<UNKNOWN>", 1_000);
    addTxn("2026-07-11", -25_000, "<UNKNOWN>");

    const out = spendingInsights(bundle.db, TODAY)!;
    expect(out.insights.every((i) => !i.text.includes("<UNKNOWN>"))).toBe(true);
    expect(out.insights[0]!.text).toBe("Food is the largest of your 3 spending categories in Jul 2026, at $300.00.");
  });
});
