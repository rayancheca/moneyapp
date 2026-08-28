import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { insightSelections } from "@/db/schema/insights";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { insightPoolHash } from "@/lib/insight-hash";
import { cachedOrder, insightsEnabled, surfaceInsights } from "./insight-surface";
import { candidateKey } from "./insights";
import { writeSetting } from "./settings";
import { spendingInsightInput, spendingInsights } from "./spending-insights";

/**
 * PASS 72d — the kill switch and the cached order, which are the only two
 * things this module does.
 *
 * ⛔ The property every test here is really about: **off is honest, not
 * degraded, and a cached order can never make a page say something new.** A
 * stored selection is a permutation of sentences the app already wrote and
 * already gated; the worst a wrong or hostile row can do is leave the editorial
 * order alone.
 */

let dir: string;
let bundle: DbBundle;
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
function addTxn(day: string, cents: number, categoryName: string | null): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: MAIN,
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

function ordinaryLedger(): void {
  for (const m of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
    addTxn(`${m}-10`, -10_000, "Food");
    addTxn(`${m}-11`, -5_000, "Travel");
  }
  addTxn("2026-07-10", -30_000, "Food");
  addTxn("2026-07-12", -20_000, "Travel");
  addTxn("2026-08-20", 1, null); // moves the import frontier without spend
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-insight-surface-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(accounts)
    .values({
      id: MAIN,
      institutionId,
      name: "Chase Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  seq = 0;
  ordinaryLedger();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const texts = (): string[] => (spendingInsights(bundle.db, TODAY)?.insights ?? []).map((i) => i.text);

/** Store an order for the pool /spending would build right now. */
function storeOrder(keys: string[]): void {
  const input = spendingInsightInput(bundle.db, TODAY)!;
  bundle.db
    .insert(insightSelections)
    .values({
      factHash: insightPoolHash(input.facts, input.candidates),
      surface: "spending",
      claimKeys: JSON.stringify(keys),
      model: "test-model",
    })
    .run();
}

const keysInEditorialOrder = (): string[] =>
  spendingInsightInput(bundle.db, TODAY)!.candidates.map((c) => candidateKey(c));

describe("the kill switch", () => {
  test("on by default — no settings row is needed to speak", () => {
    expect(insightsEnabled(bundle.db, "spending")).toBe(true);
    expect(texts().length).toBeGreaterThan(0);
  });

  test("global off silences the surface", () => {
    writeSetting(bundle.db, "insightsEnabled", false);
    expect(insightsEnabled(bundle.db, "spending")).toBe(false);
    expect(spendingInsights(bundle.db, TODAY)).toBeNull();
  });

  test("per-surface off silences only that surface", () => {
    writeSetting(bundle.db, "insightSurfaces", { spending: false });
    expect(insightsEnabled(bundle.db, "spending")).toBe(false);
    expect(insightsEnabled(bundle.db, "budgets")).toBe(true);
    expect(spendingInsights(bundle.db, TODAY)).toBeNull();
  });

  /*
   * ⛔ ABSENT means ON. The map records a decision to turn something OFF, so a
   * surface added after a preference was saved speaks rather than being mute
   * until somebody notices.
   */
  test("a surface missing from a saved map is on, and `true` is on", () => {
    writeSetting(bundle.db, "insightSurfaces", { budgets: false });
    expect(insightsEnabled(bundle.db, "spending")).toBe(true);
    writeSetting(bundle.db, "insightSurfaces", { spending: true });
    expect(insightsEnabled(bundle.db, "spending")).toBe(true);
  });

  test("off is silence, not a card saying insights are off", () => {
    writeSetting(bundle.db, "insightsEnabled", false);
    expect(spendingInsights(bundle.db, TODAY)).toBeNull();
  });
});

describe("a cached order", () => {
  test("with no row, the surface keeps its own order", () => {
    const input = spendingInsightInput(bundle.db, TODAY)!;
    expect(cachedOrder(bundle.db, input.facts, input.candidates)).toBeNull();
    expect(texts()[0]).toContain("is the largest of your");
  });

  test("moves a sentence to the front without changing a word of it", () => {
    const before = texts();
    const keys = keysInEditorialOrder();
    storeOrder([keys[keys.length - 1]!]);
    const after = texts();

    expect(after[0]).toBe(before[before.length - 1]);
    // a REORDER: the same sentences, verbatim, in a different sequence
    expect([...after].sort()).toEqual([...before].sort());
  });

  /*
   * ⛔ The safety property of the whole feature. A row naming nothing this pool
   * contains is not an error to handle — it is an opinion about a page that no
   * longer exists, and the page renders exactly as if the row were absent.
   */
  test("keys from another pool are ignored, not obeyed", () => {
    const before = texts();
    storeOrder(["largest_in_set:f9+f8", "not_a_claim:f1"]);
    expect(texts()).toEqual(before);
  });

  test("a duplicated key is used once, and does not push a sentence off the cap", () => {
    const before = texts();
    const keys = keysInEditorialOrder();
    storeOrder([keys[1]!, keys[1]!, keys[1]!, keys[0]!]);
    const after = texts();

    // second sentence first, first sentence second, and nothing said twice
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    expect(new Set(after).size).toBe(after.length);
    expect([...after].sort()).toEqual([...before].sort());
  });

  test("an empty stored order is no opinion", () => {
    const before = texts();
    storeOrder([]);
    expect(texts()).toEqual(before);
  });

  /*
   * A stored row is JSON written by an older version of this app, so it is
   * parsed rather than trusted. Neither of these may take a page down.
   */
  /*
   * ⛔ Asserted at `cachedOrder` rather than through the page, because through
   * the page it is unobservable: `applyOrder` drops an unknown key anyway, so a
   * `1` in the list and a made-up string behave identically on screen. The
   * boundary is where the filter is load-bearing — `cachedOrder` promises
   * `string[]` and must not hand back a number.
   */
  test("a row mixing non-strings with real keys keeps only the keys", () => {
    const input = spendingInsightInput(bundle.db, TODAY)!;
    const real = keysInEditorialOrder()[0]!;
    bundle.db
      .insert(insightSelections)
      .values({
        factHash: insightPoolHash(input.facts, input.candidates),
        surface: "spending",
        claimKeys: JSON.stringify([1, real, null, { a: 1 }]),
        model: "test-model",
      })
      .run();

    expect(cachedOrder(bundle.db, input.facts, input.candidates)).toEqual([real]);
  });

  test("a malformed or wrongly-typed row degrades to no opinion", () => {
    const input = spendingInsightInput(bundle.db, TODAY)!;
    const hash = insightPoolHash(input.facts, input.candidates);
    const before = texts();
    for (const raw of ["{not json", '{"order":1}', "[1,2,3]", '"a string"']) {
      bundle.db.delete(insightSelections).run();
      bundle.db
        .insert(insightSelections)
        .values({ factHash: hash, surface: "spending", claimKeys: raw, model: "t" })
        .run();
      expect(texts()).toEqual(before);
    }
  });

  /*
   * ⛔ The reason the key is the pool's CONTENT. A judgement made about a
   * $300.00 Food month is not a judgement about a $301.00 one, and nothing has
   * to expire it — the row simply stops being found.
   */
  test("a moved figure invalidates the order it was chosen over", () => {
    const keys = keysInEditorialOrder();
    storeOrder([keys[keys.length - 1]!]);
    const reordered = texts();

    addTxn("2026-07-13", -100, "Food"); // one dollar, and one more transaction
    const after = texts();
    expect(after[0]).not.toBe(reordered[0]);
    expect(after[0]).toContain("is the largest of your");
  });

  test("the switch wins over a cached order", () => {
    const keys = keysInEditorialOrder();
    storeOrder([keys[keys.length - 1]!]);
    writeSetting(bundle.db, "insightsEnabled", false);
    expect(spendingInsights(bundle.db, TODAY)).toBeNull();
  });
});

describe("surfaceInsights", () => {
  test("nothing measured is null, and the switch is not consulted for it", () => {
    expect(surfaceInsights(bundle.db, "spending", null)).toBeNull();
  });
});
