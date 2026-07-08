import { text } from "drizzle-orm/sqlite-core";
import { uuidv7 } from "../../lib/ids";

export const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const createdAt = () =>
  text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString());

export const updatedAt = () =>
  text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString())
    .$onUpdateFn(() => new Date().toISOString());

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
