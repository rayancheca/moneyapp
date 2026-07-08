import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { id, timestamps } from "./common";

/**
 * User rules — precedence: explicit user set > rules > merchant map > Claude.
 * conditions/actions are JSON columns validated by the Zod schemas below at
 * every boundary (never trusted raw from the DB either).
 */
export const rules = sqliteTable("rules", {
  id: id(),
  name: text("name").notNull().unique(),
  priority: integer("priority").notNull().default(0),
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
  conditions: text("conditions").notNull(),
  actions: text("actions").notNull(),
  timesApplied: integer("times_applied").notNull().default(0),
  ...timestamps(),
});

export const ruleConditionsSchema = z
  .object({
    descriptionContains: z.string().min(1).optional(),
    descriptionRegex: z.string().min(1).optional(),
    accountIds: z.array(z.string()).nonempty().optional(),
    amountMinCents: z.number().int().optional(),
    amountMaxCents: z.number().int().optional(),
    direction: z.enum(["in", "out"]).optional(),
  })
  .strict();

export const ruleActionsSchema = z
  .object({
    categoryId: z.string().optional(),
    merchantId: z.string().optional(),
    markTransfer: z.boolean().optional(),
    exclude: z.boolean().optional(),
  })
  .strict();

export type RuleConditions = z.infer<typeof ruleConditionsSchema>;
export type RuleActions = z.infer<typeof ruleActionsSchema>;
