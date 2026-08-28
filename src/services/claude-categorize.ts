import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { aiCalls } from "@/db/schema/ai";
import { categories } from "@/db/schema/categories";
import { merchantAliases, merchants } from "@/db/schema/merchants";
import { appSettings } from "@/db/schema/settings";
import { transactions } from "@/db/schema/transactions";
import { isPrintableName } from "@/lib/printable-name";
import { notUserOwned } from "./merchants";

/**
 * Claude fallback (master-plan §3 step 4): unknown merchants batched to
 * Haiku, classified against the FIXED taxonomy, results stored permanently
 * in the merchant map so a merchant is never asked twice. The app is fully
 * functional without a key — the queue just waits.
 */

const MODEL = "claude-haiku-4-5-20251001";
const BATCH_SIZE = 50;
// published per-MTok pricing for the model above — display estimate only
const USD_PER_INPUT_TOKEN = 1 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 5 / 1_000_000;

const classificationSchema = z.object({
  merchants: z.array(
    z.object({
      description: z.string(),
      canonicalName: z.string().min(1),
      category: z.string().min(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export interface ClaudeRunResult {
  ran: boolean;
  queued: number;
  classified: number;
  needsReview: number;
  estCostUsd: number;
  /** the monthly AI cap stopped the run early */
  capReached?: boolean;
  /** the user pressed Stop — run ended between batches */
  stopped?: boolean;
  /** a batch threw — the counters above are partial progress, not a result */
  failed?: boolean;
  /** why it failed, carried through to the header strip */
  error?: string;
}

/** display-only estimate for the queue (≈ actuals from real runs) */
export const EST_USD_PER_MERCHANT = 0.0005;

/* ── Run state (visibility + the Stop button) ───────────────────────── */

const RUNNING_KEY = "claudeRunStartedAt";
const STOP_KEY = "claudeStopRequested";
const LAST_RUN_KEY = "claudeLastRun";
/** a running flag older than this is a crashed run, not a live one */
const STALE_RUN_MS = 15 * 60_000;

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

export interface ClaudeRunState {
  /** a run is live right now (started < 15 min ago and not finished) */
  isRunning: boolean;
  lastRun: (ClaudeRunResult & { at: string }) | null;
}

export function claudeRunState(db: AppDatabase, now: Date = new Date()): ClaudeRunState {
  const startedAt = readStateKey(db, RUNNING_KEY);
  const isRunning =
    startedAt !== null && now.getTime() - Date.parse(startedAt) < STALE_RUN_MS;
  const lastRaw = readStateKey(db, LAST_RUN_KEY);
  return {
    isRunning,
    lastRun: lastRaw ? (JSON.parse(lastRaw) as ClaudeRunResult & { at: string }) : null,
  };
}

/** Takes effect between batches — at most one in-flight batch completes after. */
export function requestClaudeStop(db: AppDatabase): void {
  writeStateKey(db, STOP_KEY, "1");
}

export function pendingMerchantQueue(db: AppDatabase): { description: string; count: number }[] {
  const rows = db
    .select({ normalizedDescription: transactions.normalizedDescription })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "active"),
        isNull(transactions.categoryId),
        isNull(transactions.merchantId),
        notUserOwned(),
      ),
    )
    .all();
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.normalizedDescription, (counts.get(r.normalizedDescription) ?? 0) + 1);
  return [...counts.entries()]
    .map(([description, count]) => ({ description, count }))
    .sort((a, b) => b.count - a.count);
}

function taxonomyPaths(db: AppDatabase): string[] {
  const rows = db.select().from(categories).where(eq(categories.isArchived, false)).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows
    .filter((r) => r.kind !== "system")
    .map((r) => (r.parentId ? `${byId.get(r.parentId)?.name} > ${r.name}` : r.name))
    .sort();
}

export async function classifyPendingMerchants(
  db: AppDatabase,
  options: { confidenceMin?: number } = {},
): Promise<ClaudeRunResult> {
  const queue = pendingMerchantQueue(db);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || queue.length === 0) {
    return { ran: false, queued: queue.length, classified: 0, needsReview: 0, estCostUsd: 0 };
  }
  // re-entrancy guard: a second click/tab must never double-spend the API
  // or clobber the live run's stop/run state
  if (claudeRunState(db).isRunning) {
    return { ran: false, queued: queue.length, classified: 0, needsReview: 0, estCostUsd: 0 };
  }

  const confidenceMin = options.confidenceMin ?? 0.8;
  const anthropic = new Anthropic({ apiKey });
  const paths = taxonomyPaths(db);
  const result: ClaudeRunResult = { ran: true, queued: queue.length, classified: 0, needsReview: 0, estCostUsd: 0 };

  writeStateKey(db, STOP_KEY, null);
  writeStateKey(db, RUNNING_KEY, new Date().toISOString());
  try {
  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    // heartbeat: long runs must keep reading as live past the stale window
    writeStateKey(db, RUNNING_KEY, new Date().toISOString());
    // the user's Stop button — honored between batches
    if (readStateKey(db, STOP_KEY) !== null) {
      result.stopped = true;
      break;
    }
    // the monthly cap is a hard stop, not a display nicety
    const { aiSpend } = await import("./settings");
    if (aiSpend(db).overCap) {
      result.capReached = true;
      break;
    }
    const batch = queue.slice(i, i + BATCH_SIZE);
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: [
        {
          name: "classify_merchants",
          description: "Classify bank-transaction merchant descriptions into the fixed taxonomy",
          input_schema: {
            type: "object" as const,
            properties: {
              merchants: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                    canonicalName: { type: "string" },
                    category: { type: "string", enum: paths },
                    confidence: { type: "number" },
                  },
                  required: ["description", "canonicalName", "category", "confidence"],
                },
              },
            },
            required: ["merchants"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "classify_merchants" },
      messages: [
        {
          role: "user",
          content: `Classify each normalized bank-transaction description below. For each: the real-world merchant's canonical name and the best-fitting category from the allowed list. Confidence in [0,1] — be honest when a description is ambiguous.\n\n${batch
            .map((b) => `- "${b.description}" (seen ${b.count}x)`)
            .join("\n")}`,
        },
      ],
    });

    const toolUse = response.content.find((c) => c.type === "tool_use");
    const parsed = classificationSchema.safeParse(toolUse?.type === "tool_use" ? toolUse.input : null);
    const estCost =
      response.usage.input_tokens * USD_PER_INPUT_TOKEN +
      response.usage.output_tokens * USD_PER_OUTPUT_TOKEN;
    result.estCostUsd += estCost;

    db.insert(aiCalls)
      .values({
        purpose: "categorize",
        model: MODEL,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        estCostUsd: estCost,
        batchSize: batch.length,
      })
      .run();

    if (!parsed.success) continue;

    const submitted = new Set(batch.map((b) => b.description));
    db.transaction((tx) => {
      for (const m of parsed.data.merchants) {
        // prompt-injection guard: the model's `description` is a DB write
        // selector — it must be exactly one of the descriptions we sent, or a
        // hostile bank string could poison OTHER merchants' mappings
        if (!submitted.has(m.description)) continue;
        /*
         * ⛔ And the model's NAME is content the app will print, not just a
         * selector. This exact path wrote a merchant called `<UNKNOWN>`, four
         * real rows landed on it, and `/merchants/019f4ccc…` rendered its error
         * boundary from then on: every insight surface puts a merchant name in
         * a fact subject, and `insight-facts` refuses `< > { } \` by throwing.
         *
         * Skipped rather than sanitised — a name the app rewrote would be the
         * app's invention, and the queue leaving the merchant unclassified is
         * the honest outcome. See `lib/printable-name`.
         */
        if (!isPrintableName(m.canonicalName)) continue;
        const categoryId = resolveCategoryPath(db, m.category);
        if (!categoryId) continue;

        let merchant = tx
          .select({
            id: merchants.id,
            mappingSource: merchants.mappingSource,
            defaultCategoryId: merchants.defaultCategoryId,
          })
          .from(merchants)
          .where(eq(merchants.canonicalName, m.canonicalName))
          .get();
        if (!merchant) {
          merchant = {
            id: tx
              .insert(merchants)
              .values({ canonicalName: m.canonicalName, defaultCategoryId: categoryId, mappingSource: "claude" })
              .returning({ id: merchants.id })
              .get().id,
            mappingSource: "claude",
            defaultCategoryId: categoryId,
          };
        }
        // Never overwrite a user mapping (precedence) — which has to mean the
        // ROWS too. Leaving the user's default in place and then stamping
        // Claude's category on its transactions was one rule with two answers:
        // "Blue Bottle is Coffee" survived on the merchant while its rows
        // landed wherever Claude put them.
        const userDefaultCategoryId =
          merchant.mappingSource === "user" ? merchant.defaultCategoryId : null;
        tx.insert(merchantAliases)
          .values({ merchantId: merchant.id, pattern: m.description, matchType: "exact", priority: 10 })
          .onConflictDoNothing()
          .run();

        // a user-owned mapping is certain — Claude's confidence doesn't apply
        const lowConfidence = userDefaultCategoryId === null && m.confidence < confidenceMin;
        const updated = tx
          .update(transactions)
          .set({
            merchantId: merchant.id,
            categoryId: userDefaultCategoryId ?? categoryId,
            categorizationSource: userDefaultCategoryId === null ? "claude" : "merchant_map",
            categorizationConfidence: userDefaultCategoryId === null ? m.confidence : 1,
            needsReview: lowConfidence,
          })
          .where(
            and(
              eq(transactions.normalizedDescription, m.description),
              eq(transactions.status, "active"),
              isNull(transactions.categoryId),
              // defence in depth: category_id IS NULL already excludes every
              // categorized row, so this only ever catches the deliberate
              // "user left it uncategorized" case the queue also skips
              notUserOwned(),
            ),
          )
          .run();
        result.classified += updated.changes;
        if (lowConfidence) result.needsReview += updated.changes;
      }
    });
  }
  } catch (error) {
    // a throwing batch (network, 401, rate limit) is a FAILED run, not a quiet
    // one. Without this the finally below records {ran:true, classified:0} and
    // the header reads it back as a successful no-op. Committed batches stay
    // committed, so the counters travel with the failure as partial progress.
    result.failed = true;
    result.error = error instanceof Error ? error.message : "Unexpected error";
    throw error;
  } finally {
    // always release the running flag and record the outcome — a crashed
    // run must not leave the UI showing "classifying…" forever
    writeStateKey(db, RUNNING_KEY, null);
    writeStateKey(db, STOP_KEY, null);
    writeStateKey(db, LAST_RUN_KEY, JSON.stringify({ ...result, at: new Date().toISOString() }));
  }

  return result;
}

function resolveCategoryPath(db: AppDatabase, path: string): string | null {
  const [parentName, subName] = path.split(" > ").map((s) => s.trim());
  if (!parentName) return null;
  const parent = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.name, parentName), isNull(categories.parentId)))
    .get();
  if (!parent) return null;
  if (!subName) return parent.id;
  const sub = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get();
  return sub?.id ?? null;
}
