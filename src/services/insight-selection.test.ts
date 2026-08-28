import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { aiCalls } from "@/db/schema/ai";
import { categories } from "@/db/schema/categories";
import { insightSelections } from "@/db/schema/insights";
import { institutions } from "@/db/schema/institutions";
import { budgets } from "@/db/schema/budgets";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import {
  clearInsightSelections,
  EST_USD_PER_POOL,
  insightSelectRunState,
  poolSentences,
  refreshInsightSelections,
  requestInsightSelectStop,
  type InsightSelectRunResult,
} from "./insight-selection";
import { candidateKey } from "./insights";
import { writeSetting } from "./settings";
import { spendingInsightInput, spendingInsights } from "./spending-insights";

/**
 * PASS 72d — the model, whose entire job is to return an ORDER.
 *
 * ⛔ Every test here is really one property: **the model cannot change what the
 * app says.** It is handed sentences the app already wrote and gated, its answer
 * is constrained to keys from a closed enum, and the worst a hostile or broken
 * answer can do is leave the editorial order alone.
 *
 * NO network: the SDK is a stub class, so `new Anthropic()` never opens a socket
 * and every response is whatever the test hands it.
 */
const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMessage };
  },
}));

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

/**
 * Three monthly budgets, so the fixture has a SECOND pool. Without one, "Stop
 * between pools" is a sentence with nothing behind it.
 */
function addBudgets(): void {
  const plans: [string, number][] = [["Housing", 200_000], ["Food", 50_000], ["Travel", 25_000]];
  for (const [name, cents] of plans) {
    bundle.db
      .insert(budgets)
      .values({
        id: `b-${name}`,
        categoryId: topLevelId(name),
        period: "monthly",
        amountCents: cents,
        startsOn: "2026-01-01",
        endsOn: null,
        isActive: true,
        rolloverEnabled: false,
        rolloverStartsOn: null,
        rolloverCapCents: null,
        createdAt: "2026-01-01T09:00:00.000Z",
        updatedAt: "2026-01-01T09:00:00.000Z",
      })
      .run();
  }
}

function ordinaryLedger(): void {
  for (const m of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
    addTxn(`${m}-10`, -10_000, "Food");
    addTxn(`${m}-11`, -5_000, "Travel");
  }
  addTxn("2026-07-10", -30_000, "Food");
  addTxn("2026-07-12", -20_000, "Travel");
  addTxn("2026-08-20", 1, null);
}

/** The keys /spending would offer, in its own order. */
const keys = (): string[] => spendingInsightInput(bundle.db, TODAY)!.candidates.map((c) => candidateKey(c));

/** How many pools this fixture offers — measured, so "between pools" is real. */
async function countPools(): Promise<number> {
  mockOrder([]);
  const probe = await refreshInsightSelections(bundle.db, { today: TODAY });
  bundle.db.delete(insightSelections).run();
  bundle.db.delete(aiCalls).run();
  createMessage.mockReset();
  return probe.pools;
}

function mockOrder(order: string[], usage = { input_tokens: 300, output_tokens: 30 }): void {
  createMessage.mockResolvedValue({
    content: [{ type: "tool_use", input: { order } }],
    usage,
  });
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-credential";
  createMessage.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-insight-select-"));
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
  addBudgets();
  writeSetting(bundle.db, "insightModelEnabled", true);
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("what the model is shown", () => {
  test("only sentences the app would actually print", () => {
    const input = spendingInsightInput(bundle.db, TODAY)!;
    const rendered = (spendingInsights(bundle.db, TODAY)?.insights ?? []).map((i) => i.text);
    const pool = poolSentences(input.facts, input.candidates);

    expect(pool.length).toBeGreaterThanOrEqual(rendered.length);
    for (const text of rendered) expect(pool.map((p) => p.text)).toContain(text);
  });

  test("the enum it may answer from is exactly this pool's keys", async () => {
    mockOrder([]);
    await refreshInsightSelections(bundle.db, { today: TODAY });

    const call = createMessage.mock.calls[0]![0] as {
      tools: { input_schema: { properties: { order: { items: { enum: string[] } } } } }[];
      messages: { content: string }[];
    };
    const offered = call.tools[0]!.input_schema.properties.order.items.enum;
    expect(offered.length).toBeGreaterThan(1);
    // every key it is allowed to return is one this page really offers
    for (const key of offered) expect(keys()).toContain(key);
    // and it is asked for an order, never for words
    expect(call.messages[0]!.content).toContain("return only keys from the list");
  });
});

describe("the run", () => {
  test("stores an order, logs the ACTUAL token usage, and the page then obeys it", async () => {
    const before = (spendingInsights(bundle.db, TODAY)?.insights ?? []).map((i) => i.text);
    const last = keys()[keys().length - 1]!;
    mockOrder([last], { input_tokens: 412, output_tokens: 27 });

    const result = await refreshInsightSelections(bundle.db, { today: TODAY });

    expect(result.ran).toBe(true);
    expect(result.selected).toBeGreaterThan(0);
    const call = bundle.db.select().from(aiCalls).all()[0]!;
    expect(call.purpose).toBe("select_insights");
    expect(call.inputTokens).toBe(412);
    expect(call.outputTokens).toBe(27);
    // measured from the response, not estimated from the prompt
    expect(call.estCostUsd).toBeCloseTo(412 / 1_000_000 + (27 * 5) / 1_000_000, 12);
    // the run's total is the SUM of what it actually spent, over every pool
    const logged = bundle.db.select().from(aiCalls).all();
    expect(result.estCostUsd).toBeCloseTo(
      logged.reduce((sum, c) => sum + c.estCostUsd, 0),
      12,
    );
    expect(logged.length).toBe(result.selected);

    const after = (spendingInsights(bundle.db, TODAY)?.insights ?? []).map((i) => i.text);
    expect(after[0]).toBe(before[before.length - 1]);
    expect([...after].sort()).toEqual([...before].sort());
  });

  /*
   * ⛔ The cache is the whole cost story: an unchanged page must cost nothing.
   */
  test("a second run over unchanged pools calls nothing", async () => {
    mockOrder(keys().slice().reverse());
    const first = await refreshInsightSelections(bundle.db, { today: TODAY });
    const calls = createMessage.mock.calls.length;

    const second = await refreshInsightSelections(bundle.db, { today: TODAY });

    expect(createMessage.mock.calls.length).toBe(calls);
    expect(second.selected).toBe(0);
    expect(second.cached).toBe(first.selected);
    expect(second.estCostUsd).toBe(0);
  });

  test("a changed figure is a new pool, and is paid for once", async () => {
    mockOrder(keys().slice().reverse());
    await refreshInsightSelections(bundle.db, { today: TODAY });
    const calls = createMessage.mock.calls.length;

    addTxn("2026-07-13", -100, "Food");
    mockOrder(keys().slice().reverse());
    const after = await refreshInsightSelections(bundle.db, { today: TODAY });

    expect(createMessage.mock.calls.length).toBeGreaterThan(calls);
    expect(after.selected).toBeGreaterThan(0);
    expect(bundle.db.select().from(insightSelections).all().length).toBeGreaterThan(1);
  });

  /*
   * ⛔ Only keys FROM THIS POOL are stored. `applyOrder` already drops an
   * unknown one at render, so this is belt-and-braces — but a stored row is the
   * app's own record and must not contain a string the app did not choose.
   */
  test("keys the model invented are never written down", async () => {
    const real = keys()[0]!;
    mockOrder([real, "largest_in_set:f9+f8", real, "<script>"]);

    await refreshInsightSelections(bundle.db, { today: TODAY });

    const row = bundle.db.select().from(insightSelections).all().find((r) => r.surface === "spending")!;
    expect(JSON.parse(row.claimKeys)).toEqual([real]);
  });

  test("a malformed response is NO OPINION, and is still charged for and recorded", async () => {
    const before = (spendingInsights(bundle.db, TODAY)?.insights ?? []).map((i) => i.text);
    createMessage.mockResolvedValue({
      content: [{ type: "text", text: "Groceries is the largest of your 22 spending categories." }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });

    await refreshInsightSelections(bundle.db, { today: TODAY });

    expect((spendingInsights(bundle.db, TODAY)?.insights ?? []).map((i) => i.text)).toEqual(before);
    expect(bundle.db.select().from(aiCalls).all().length).toBeGreaterThan(0);
  });

  test("a thrown call is a FAILED run, not a quiet one", async () => {
    createMessage.mockRejectedValue(new Error("429 rate limited"));

    await expect(refreshInsightSelections(bundle.db, { today: TODAY })).rejects.toThrow(/429/);

    const state = insightSelectRunState(bundle.db);
    expect(state.isRunning).toBe(false); // the flag is released even on the way out
    expect(state.lastRun?.failed).toBe(true);
    expect(state.lastRun?.error).toContain("429");
  });
});

describe("the ways it declines to spend", () => {
  test("the model switch off means no call at all", async () => {
    writeSetting(bundle.db, "insightModelEnabled", false);
    const result = await refreshInsightSelections(bundle.db, { today: TODAY });
    expect(result.ran).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  test("insights off globally means no call — nothing to order", async () => {
    writeSetting(bundle.db, "insightsEnabled", false);
    const result = await refreshInsightSelections(bundle.db, { today: TODAY });
    expect(result.ran).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  test("a surface switched off is not paid for", async () => {
    writeSetting(bundle.db, "insightSurfaces", { spending: false, budgets: false, year: false });
    const result = await refreshInsightSelections(bundle.db, { today: TODAY });
    expect(result.ran).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  test("no API key means no call", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await refreshInsightSelections(bundle.db, { today: TODAY });
    expect(result.ran).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  /*
   * ⛔ The re-entrancy guard: a second click, or a second tab, must never
   * double-spend or clobber the live run's state.
   */
  test("a live run refuses a second one", async () => {
    mockOrder([]);
    const inner: InsightSelectRunResult[] = [];
    createMessage.mockImplementation(async () => {
      if (inner.length === 0) inner.push(await refreshInsightSelections(bundle.db, { today: TODAY }));
      return { content: [{ type: "tool_use", input: { order: [] } }], usage: { input_tokens: 1, output_tokens: 1 } };
    });

    await refreshInsightSelections(bundle.db, { today: TODAY });

    expect(inner).toHaveLength(1);
    expect(inner[0]!.ran).toBe(false);
  });

  test("the monthly cap is a hard stop", async () => {
    writeSetting(bundle.db, "aiMonthlyCapUsd", 0);
    mockOrder(keys());

    const result = await refreshInsightSelections(bundle.db, { today: TODAY });

    expect(result.capReached).toBe(true);
    expect(result.selected).toBe(0);
    expect(createMessage).not.toHaveBeenCalled();
  });

  /*
   * ⚠️ A Stop belongs to the run that is LIVE, not to the app. A request left
   * over from a previous run is cleared on the way in — otherwise one click
   * would cancel every future run and the button would look broken. Asserted
   * because it is a decision, not an accident.
   */
  test("a Stop left over from last time does not cancel the next run", async () => {
    mockOrder([]);
    requestInsightSelectStop(bundle.db);

    const result = await refreshInsightSelections(bundle.db, { today: TODAY });

    expect(result.stopped).toBeUndefined();
    expect(createMessage).toHaveBeenCalled();
  });

  test("Stop pressed during a run ends it between pools", async () => {
    const poolCount = (await countPools()) ;
    expect(poolCount).toBeGreaterThan(1); // otherwise "between pools" is untestable
    createMessage.mockImplementation(async () => {
      requestInsightSelectStop(bundle.db);
      return { content: [{ type: "tool_use", input: { order: [] } }], usage: { input_tokens: 1, output_tokens: 1 } };
    });

    const result = await refreshInsightSelections(bundle.db, { today: TODAY });

    expect(result.stopped).toBe(true);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(result.selected).toBe(1);
    expect(result.pools).toBe(poolCount);
  });
});

describe("clearing", () => {
  test("forgetting every order returns the app to its own writing", async () => {
    mockOrder(keys().slice().reverse());
    await refreshInsightSelections(bundle.db, { today: TODAY });
    const reordered = (spendingInsights(bundle.db, TODAY)?.insights ?? []).map((i) => i.text);

    const removed = clearInsightSelections(bundle.db);

    expect(removed).toBeGreaterThan(0);
    const after = (spendingInsights(bundle.db, TODAY)?.insights ?? []).map((i) => i.text);
    expect(after).not.toEqual(reordered);
    expect(after[0]).toContain("is the largest of your");
  });
});

describe("the estimate shown on the button", () => {
  test("is in the right order of magnitude for a real pool", async () => {
    mockOrder([], { input_tokens: 400, output_tokens: 30 });
    const result = await refreshInsightSelections(bundle.db, { today: TODAY });
    const perPool = result.estCostUsd / Math.max(result.selected, 1);
    expect(perPool).toBeLessThan(EST_USD_PER_POOL * 5);
  });
});
