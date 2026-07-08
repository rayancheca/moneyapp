import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { updatedAt } from "./common";

/** key/value JSON — AI cap, review thresholds, price staleness, backups, week start. */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: updatedAt(),
});
