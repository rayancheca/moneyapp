import { integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { id, timestamps } from "./common";

export const CATEGORY_KINDS = [
  "expense",
  "income",
  "transfer",
  "rewards",
  "investment",
  "system",
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/**
 * One level of subcategories, enforced in code. kind drives analytics
 * semantics: transfer/investment/rewards never count as spending or income.
 */
export const categories = sqliteTable(
  "categories",
  {
    id: id(),
    name: text("name").notNull(),
    parentId: text("parent_id").references((): AnySQLiteColumn => categories.id),
    kind: text("kind", { enum: CATEGORY_KINDS }).notNull(),
    icon: text("icon"),
    color: text("color"),
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ux_categories_parent_name").on(table.parentId, table.name),
    // SQLite treats NULLs as distinct — root categories need their own guard
    uniqueIndex("ux_categories_root_name").on(table.name).where(sql`parent_id IS NULL`),
  ],
);
