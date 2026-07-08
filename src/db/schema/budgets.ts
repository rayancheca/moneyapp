import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { id, timestamps } from "./common";
import { categories } from "./categories";

export const BUDGET_PERIODS = ["daily", "weekly", "monthly", "annual"] as const;
export type BudgetPeriodKind = (typeof BUDGET_PERIODS)[number];

/**
 * No rollover — leftover/overrun is displayed informationally only.
 * Child spend rolls into a parent's budget by design; alerts fire
 * independently per budget row; aggregates exclude descendant-budgeted
 * overlap (schema.md overlap semantics).
 */
export const budgets = sqliteTable(
  "budgets",
  {
    id: id(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    period: text("period", { enum: BUDGET_PERIODS }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    startsOn: text("starts_on").notNull(),
    endsOn: text("ends_on"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ux_budgets_category_period_active")
      .on(table.categoryId, table.period)
      .where(sql`is_active = 1`),
  ],
);
