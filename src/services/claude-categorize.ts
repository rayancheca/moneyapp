import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { aiCalls } from "@/db/schema/ai";
import { categories } from "@/db/schema/categories";
import { merchantAliases, merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";

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
        // NULL != 'user' is NULL in SQL, not true — must be explicit
        or(isNull(transactions.categorizationSource), ne(transactions.categorizationSource, "user")),
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

  const confidenceMin = options.confidenceMin ?? 0.8;
  const anthropic = new Anthropic({ apiKey });
  const paths = taxonomyPaths(db);
  const result: ClaudeRunResult = { ran: true, queued: queue.length, classified: 0, needsReview: 0, estCostUsd: 0 };

  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
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
        const categoryId = resolveCategoryPath(db, m.category);
        if (!categoryId) continue;

        let merchant = tx
          .select({ id: merchants.id, mappingSource: merchants.mappingSource })
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
          };
        }
        // never overwrite a user mapping (precedence)
        tx.insert(merchantAliases)
          .values({ merchantId: merchant.id, pattern: m.description, matchType: "exact", priority: 10 })
          .onConflictDoNothing()
          .run();

        const lowConfidence = m.confidence < confidenceMin;
        const updated = tx
          .update(transactions)
          .set({
            merchantId: merchant.id,
            categoryId,
            categorizationSource: "claude",
            categorizationConfidence: m.confidence,
            needsReview: lowConfidence,
          })
          .where(
            and(
              eq(transactions.normalizedDescription, m.description),
              eq(transactions.status, "active"),
              isNull(transactions.categoryId),
            ),
          )
          .run();
        result.classified += updated.changes;
        if (lowConfidence) result.needsReview += updated.changes;
      }
    });
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
