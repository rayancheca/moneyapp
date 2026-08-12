import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { id, timestamps } from "./common";
import { categories } from "./categories";

export const BUDGET_PERIODS = ["daily", "weekly", "monthly", "annual"] as const;
export type BudgetPeriodKind = (typeof BUDGET_PERIODS)[number];

/**
 * Rollover is OPT-IN per budget and OFF by default: with rolloverEnabled false
 * leftover/overrun is displayed informationally only, exactly as before. With it
 * on, unspent plan from CLOSED periods accumulates into a carry the budget is
 * then graded against (services/budgets.ts `carryInto`).
 *
 * Child spend rolls into a parent's budget by design; alerts fire independently
 * per budget row; aggregates exclude descendant-budgeted overlap (schema.md
 * overlap semantics), and those aggregates stay on the PLAN amount — a carry is
 * money an earlier period brought in, so it must not inflate "budgeted this
 * month" against this month's expected income.
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
    /** opt-in; false keeps the pre-rollover behaviour bit-for-bit */
    rolloverEnabled: integer("rollover_enabled", { mode: "boolean" }).notNull().default(false),
    /**
     * First period the carry may accumulate from. NULL = the budget's own
     * startsOn. It can only ever move the start LATER (validated on write):
     * accumulating from before the budget existed would credit the owner with
     * savings for months he never planned, which is the same fabricated history
     * this codebase refuses to draw elsewhere.
     */
    rolloverStartsOn: text("rollover_starts_on"),
    /** NULL = uncapped. A ceiling on the accumulated carry, in cents. */
    rolloverCapCents: integer("rollover_cap_cents"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ux_budgets_category_period_active")
      .on(table.categoryId, table.period)
      .where(sql`is_active = 1`),
  ],
);
