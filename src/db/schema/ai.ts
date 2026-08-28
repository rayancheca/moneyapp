import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id } from "./common";

/** ⛔ `select_insights` never writes prose — it orders sentences the app already wrote. */
export const AI_PURPOSES = ["categorize", "pdf_extract", "annotate", "select_insights"] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

/** Every Claude call is logged — surfaces monthly AI spend; settings cap warns. */
export const aiCalls = sqliteTable("ai_calls", {
  id: id(),
  purpose: text("purpose", { enum: AI_PURPOSES }).notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  estCostUsd: real("est_cost_usd").notNull(),
  batchSize: integer("batch_size").notNull().default(1),
  createdAt: createdAt(),
});
