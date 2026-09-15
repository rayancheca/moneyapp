import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { aiCalls } from "@/db/schema/ai";
import { insightSelections } from "@/db/schema/insights";
import { appSettings } from "@/db/schema/settings";
import type { Fact } from "@/lib/insight-facts";
import { insightPoolHash } from "@/lib/insight-hash";
import { checkClaim } from "@/lib/insight-validator";
import { factSet } from "@/lib/insight-facts";
import { budgetInsightInput } from "./budget-insights";
import type { InsightSurfaceId } from "@/lib/insight-surfaces";
import { candidateKey, type InsightCandidate } from "./insights";
import { insightsEnabled, type InsightInput } from "./insight-surface";
import { spendingInsightInput } from "./spending-insights";
import { aiSpend, readSettings } from "./settings";
import { yearInsightInput, yearsWithInsights } from "./year-insights";

/**
 * PASS 72d — the model, and the only job in this feature it is allowed to have.
 *
 * ⛔ **It selects. It does not write.** Every sentence it sees was composed by
 * the app from measured facts, passed the write gate, and would render with or
 * without it; what it returns is an ORDER of keys from a closed enum. It cannot
 * emit a word, a digit, or a claim — not because a validator would catch it,
 * but because there is no field in which it could put one. That is the same
 * move `insight-grammar` made after pass 46's validator accepted 16 of 17
 * attack strings: make fabrication unrepresentable rather than detectable.
 *
 * ⚠️ **And it has less to do than the plan assumed.** Measured on the real
 * ledger before this was written (`scripts/probe-insight-pool.ts`, 533
 * surfaces): every page offers 1–4 candidates, ALL 360 of them were accepted
 * and proven, and raising `MAX_INSIGHTS` from 4 to 40 produced an identical
 * distribution. Nothing has ever been dropped by the cap, so the model is
 * choosing an ORDER and never a subset. That is a real but small job, it is why
 * `insightModelEnabled` defaults to OFF, and it is why the surfaces below are
 * the four a person actually lands on rather than all 533 — 528 of which show
 * three sentences or fewer, where the order barely exists.
 *
 * ## The run, and why it looks like `claude-categorize`
 *
 * Same shape on purpose: a model constant, a run-state machine so the UI can
 * say what is happening, a re-entrancy guard so a second click cannot
 * double-spend, a Stop honoured between calls, the monthly cap as a hard stop,
 * and every call's ACTUAL token usage written to `ai_calls`. Cost is measured
 * from the response, never estimated from the prompt.
 */

const MODEL = "claude-haiku-4-5-20251001";
/** published per-MTok pricing for the model above — the ledger records actuals */
const USD_PER_INPUT_TOKEN = 1 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 5 / 1_000_000;

/**
 * A pool this small is not a judgement. One sentence has one order, and asking
 * a model to confirm it would be paying for arithmetic.
 *
 * ⚠️ Deliberately carries no test, because no surface in the app can currently
 * reach it: `/spending` offers at least three candidates and every other
 * selectable surface offers a rank AND a share, so the smallest pool that
 * exists is two. Deleting this line changes nothing today — verified by
 * mutation — and it stays as insurance for a surface that offers one, rather
 * than carrying an assertion that would pass either way.
 */
const MIN_POOL_TO_SELECT = 2;

const RUNNING_KEY = "insightSelectRunStartedAt";
const STOP_KEY = "insightSelectStopRequested";
const LAST_RUN_KEY = "insightSelectLastRun";
/** a running flag older than this is a crashed run, not a live one */
const STALE_RUN_MS = 15 * 60_000;

const orderSchema = z.object({ order: z.array(z.string()) });

export interface InsightSelectRunResult {
  ran: boolean;
  /** pools worth an opinion that were found */
  pools: number;
  /** pools already cached — these cost nothing */
  cached: number;
  /** pools sent to the model */
  selected: number;
  estCostUsd: number;
  capReached?: boolean;
  stopped?: boolean;
  failed?: boolean;
  error?: string;
}

/** display-only estimate for the button (≈ actuals from real runs) */
export const EST_USD_PER_POOL = 0.0004;

/* ── Run state (visibility + the Stop button) ───────────────────────── */

function readStateKey(db: AppDatabase, key: string): string | null {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  return row ? (JSON.parse(row.value) as string) : null;
}

function writeStateKey(db: AppDatabase, key: string, value: string | null): void {
  if (value === null) {
    db.delete(appSettings).where(eq(appSettings.key, key)).run();
    return;
  }
  db.insert(appSettings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify(value) } })
    .run();
}

export interface InsightSelectRunState {
  isRunning: boolean;
  lastRun: (InsightSelectRunResult & { at: string }) | null;
}

export function insightSelectRunState(db: AppDatabase, now: Date = new Date()): InsightSelectRunState {
  const startedAt = readStateKey(db, RUNNING_KEY);
  const lastRaw = readStateKey(db, LAST_RUN_KEY);
  return {
    isRunning: startedAt !== null && now.getTime() - Date.parse(startedAt) < STALE_RUN_MS,
    lastRun: lastRaw ? (JSON.parse(lastRaw) as InsightSelectRunResult & { at: string }) : null,
  };
}

/** Takes effect between pools — at most one in-flight call completes after. */
export function requestInsightSelectStop(db: AppDatabase): void {
  writeStateKey(db, STOP_KEY, "1");
}

/* ── The pools ──────────────────────────────────────────────────────── */

/**
 * The surfaces the run walks.
 *
 * ⛔ NOT every surface in the app. `/categories/[id]`, `/merchants/[id]`,
 * `/accounts/[id]` and `/recurring/[id]` are 529 pages between them on the real
 * ledger and would be 529 calls; 528 of the 533 measured show three sentences
 * or fewer. They still READ the cache (`surfaceInsights`), so a future pass that
 * decides they are worth paying for fills the same table and they light up with
 * no change to the render path.
 */
function poolsToSelect(db: AppDatabase, today?: string): { surface: InsightSurfaceId; input: InsightInput }[] {
  const out: { surface: InsightSurfaceId; input: InsightInput }[] = [];
  const add = (surface: InsightSurfaceId, input: InsightInput | null): void => {
    // the kill switch is honoured here too: a surface nobody will read is a
    // surface nobody should pay to have ordered
    if (input && insightsEnabled(db, surface)) out.push({ surface, input });
  };
  add("spending", spendingInsightInput(db, today));
  add("budgets", budgetInsightInput(db, today));
  for (const year of yearsWithInsights(db, today)) add("year", yearInsightInput(db, year, today));
  return out;
}

export interface PoolSentence {
  key: string;
  text: string;
}

/**
 * The sentences a pool would print, in the surface's own order.
 *
 * ⛔ Built with the SAME write gate the page uses, so the model is never shown a
 * sentence the app would refuse — and never shown one it would not print.
 * Provenance is deliberately not computed: proving a candidate the model may
 * put last would be paying for a chain nobody reads.
 */
export function poolSentences(facts: readonly Fact[], candidates: readonly InsightCandidate[]): PoolSentence[] {
  const set = factSet(facts);
  const out: PoolSentence[] = [];
  for (const candidate of candidates) {
    const verdict = checkClaim(candidate, set);
    if (!verdict.ok) continue;
    out.push({ key: candidateKey(candidate), text: verdict.text });
  }
  return out;
}

/* ── The call ───────────────────────────────────────────────────────── */

const TOOL_NAME = "order_sentences";

/**
 * ⛔ Neutral, and it says what the model may NOT do in the same breath as what
 * it may. The instruction never asks for an opinion about his money — it asks
 * which already-true sentence a reader would want first. An instruction that
 * invited judgement ("which is most concerning?") would be asking for exactly
 * the accusation `insight-grammar`'s neutrality sweep exists to refuse.
 */
const INSTRUCTION =
  "Each sentence below was written and verified by a personal-finance app about one person's own ledger. " +
  "Every one of them is true and every one of them may be shown. Return their keys ordered by which a " +
  "reader would most want to read first: prefer the sentence that tells them something they could not " +
  "read off the page's own charts, and put near-duplicates last. Do not judge the spending, do not add " +
  "or reword anything, and return only keys from the list.";

async function orderFor(
  anthropic: Anthropic,
  sentences: readonly PoolSentence[],
): Promise<{ order: string[]; inputTokens: number; outputTokens: number }> {
  const keys = sentences.map((s) => s.key);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    tools: [
      {
        name: TOOL_NAME,
        description: "Order the given sentence keys by reading interest",
        input_schema: {
          type: "object" as const,
          properties: {
            /*
             * ⛔ The enum IS the allowlist, exactly as `CLAIM_IDS` is for the
             * vocabulary. A key outside this pool is not a wrong answer the app
             * has to detect — it is not expressible.
             */
            order: { type: "array", items: { type: "string", enum: keys } },
          },
          required: ["order"],
        },
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: `${INSTRUCTION}\n\n${sentences.map((s) => `${s.key}\n  ${s.text}`).join("\n")}`,
      },
    ],
  });

  const toolUse = response.content.find((c) => c.type === "tool_use");
  const parsed = orderSchema.safeParse(toolUse?.type === "tool_use" ? toolUse.input : null);
  return {
    // a malformed response is NO OPINION, not a failure: the surface keeps its
    // own order and the call is still charged for and recorded
    order: parsed.success ? parsed.data.order : [],
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/**
 * Fill the selection cache for the surfaces a person lands on.
 *
 * Returns `{ran: false}` — never throws — when there is no key, nothing to do,
 * the model is switched off, or a run is already live. Those are all ordinary
 * states of a feature that costs money, not errors.
 */
export async function refreshInsightSelections(
  db: AppDatabase,
  options: { today?: string } = {},
): Promise<InsightSelectRunResult> {
  const idle: InsightSelectRunResult = { ran: false, pools: 0, cached: 0, selected: 0, estCostUsd: 0 };
  const settings = readSettings(db);
  if (!settings.insightsEnabled || !settings.insightModelEnabled) return idle;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return idle;
  // re-entrancy guard: a second click or tab must never double-spend
  if (insightSelectRunState(db).isRunning) return idle;

  const pools = poolsToSelect(db, options.today)
    .map((p) => ({
      ...p,
      hash: insightPoolHash(p.input.facts, p.input.candidates),
      sentences: poolSentences(p.input.facts, p.input.candidates),
    }))
    .filter((p) => p.sentences.length >= MIN_POOL_TO_SELECT);

  const result: InsightSelectRunResult = { ran: true, pools: pools.length, cached: 0, selected: 0, estCostUsd: 0 };
  if (pools.length === 0) return { ...result, ran: false };

  const anthropic = new Anthropic({ apiKey });
  writeStateKey(db, STOP_KEY, null);
  writeStateKey(db, RUNNING_KEY, new Date().toISOString());
  try {
    for (const pool of pools) {
      writeStateKey(db, RUNNING_KEY, new Date().toISOString()); // heartbeat
      if (readStateKey(db, STOP_KEY) !== null) {
        result.stopped = true;
        break;
      }
      // an unchanged pool is a question already answered — this is the whole
      // point of hashing the content rather than keying on the surface
      const already = db
        .select({ factHash: insightSelections.factHash })
        .from(insightSelections)
        .where(eq(insightSelections.factHash, pool.hash))
        .get();
      if (already) {
        result.cached += 1;
        continue;
      }
      // the monthly cap is a hard stop, not a display nicety
      if (aiSpend(db).overCap) {
        result.capReached = true;
        break;
      }

      const { order, inputTokens, outputTokens } = await orderFor(anthropic, pool.sentences);
      const estCost = inputTokens * USD_PER_INPUT_TOKEN + outputTokens * USD_PER_OUTPUT_TOKEN;
      result.estCostUsd += estCost;
      db.insert(aiCalls)
        .values({
          purpose: "select_insights",
          model: MODEL,
          inputTokens,
          outputTokens,
          estCostUsd: estCost,
          batchSize: pool.sentences.length,
        })
        .run();

      /*
       * ⛔ Only keys FROM THIS POOL are stored. `applyOrder` already drops an
       * unknown key at render, so this is belt-and-braces — but a stored row is
       * the app's own record and it should not contain a string the app did not
       * choose. Duplicates collapse for the same reason.
       */
      const allowed = new Set(pool.sentences.map((s) => s.key));
      const cleaned = [...new Set(order.filter((k) => allowed.has(k)))];
      db.insert(insightSelections)
        .values({
          factHash: pool.hash,
          surface: pool.surface,
          claimKeys: JSON.stringify(cleaned),
          model: MODEL,
        })
        .onConflictDoNothing()
        .run();
      result.selected += 1;
    }
  } catch (error) {
    // a throwing call is a FAILED run, not a quiet one — without this the
    // finally below records {ran:true, selected:0} and the UI reads it back as
    // a successful no-op
    result.failed = true;
    result.error = error instanceof Error ? error.message : "Unexpected error";
    throw error;
  } finally {
    writeStateKey(db, RUNNING_KEY, null);
    writeStateKey(db, STOP_KEY, null);
    writeStateKey(db, LAST_RUN_KEY, JSON.stringify({ ...result, at: new Date().toISOString() }));
  }
  return result;
}

/** Forget every stored order — the switch that makes "off" mean off. */
export function clearInsightSelections(db: AppDatabase): number {
  return db.delete(insightSelections).run().changes;
}
