import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";

export const institutions = sqliteTable("institutions", {
  id: id(),
  name: text("name").notNull().unique(),
  ...timestamps(),
});
