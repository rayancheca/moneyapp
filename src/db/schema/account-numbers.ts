import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";

/**
 * A card or account number, other than `accounts.last4`, that this account's statements print: a card reissued
 * under a new number keeps the statements it printed under the old ones.
 *
 * 🔴 The import matched a statement to an account by `accounts.last4` alone. Venture X (last4 4208) was merged by hand
 * from the numbers its earlier statements print (9082, then 4147 — docs/future-ideas.md, pass 12), so un-importing
 * any of capitalone-venturex-statement-2026-02..06.pdf and importing the same bytes again created a second "Venture
 * X" and filed the statement under it (a copy of the real ledger, 2026-09-16: 2026-03 took 195 rows and net worth
 * −$149.15 with it). `resolveAccount` asks this table after `last4` (services/import/service.ts).
 */
export const accountNumbers = sqliteTable(
  "account_numbers",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    last4: text("last4").notNull(),
    ...timestamps(),
  },
  (table) => [uniqueIndex("ux_account_numbers_account_last4").on(table.accountId, table.last4)],
);
