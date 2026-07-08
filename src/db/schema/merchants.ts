import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { categories } from "./categories";

export const MAPPING_SOURCES = ["user", "claude", "seed"] as const;
export type MappingSource = (typeof MAPPING_SOURCES)[number];

/**
 * The learning layer. default_category_id is the merchant→category map;
 * mapping_source='user' wins permanently. The direction guard (a correction
 * on a sign-opposing transaction never flips the default without explicit
 * confirmation) is enforced in the categorization service.
 */
export const merchants = sqliteTable("merchants", {
  id: id(),
  canonicalName: text("canonical_name").notNull().unique(),
  defaultCategoryId: text("default_category_id").references(() => categories.id),
  mappingSource: text("mapping_source", { enum: MAPPING_SOURCES }),
  ...timestamps(),
});

export const ALIAS_MATCH_TYPES = ["exact", "prefix", "contains"] as const;
export type AliasMatchType = (typeof ALIAS_MATCH_TYPES)[number];

/** Observed normalized-description patterns → merchant. Grows with every import. */
export const merchantAliases = sqliteTable(
  "merchant_aliases",
  {
    id: id(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    pattern: text("pattern").notNull(),
    matchType: text("match_type", { enum: ALIAS_MATCH_TYPES }).notNull(),
    priority: integer("priority").notNull().default(0),
    ...timestamps(),
  },
  (table) => [uniqueIndex("ux_merchant_aliases_pattern_type").on(table.pattern, table.matchType)],
);
