import { asc, type SQL } from "drizzle-orm";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";

/**
 * THE order accounts are listed in, wherever they are listed: institution, then
 * the within-institution `displayOrder`, then name. Spread it into `orderBy` on
 * a query that joins `institutions` — its first key is the institution's NAME.
 *
 * 🔴 `displayOrder` is an ordinal `reorderAccounts` writes across ONE
 * institution's list, so ordering the whole ledger by it alone orders by a
 * number that means nothing between institutions. On the owner's ledger every
 * account carries 0 except Chase Checking (1), Robinhood Cash (1) and Robinhood
 * Crypto (2), so such a list reads nine accounts alphabetically and then appends
 * those three after Wells Fargo, splitting both Chase accounts and all three
 * Robinhood ones apart.
 *
 * ⛔ One home, because the order was spelled out seven times and four of them
 * were wrong. `/transactions`' picker was fixed on its own, in
 * `listAccountOptions`; measured 2026-09-15, the same `orderBy(displayOrder,
 * name)` was still ordering the dashboard net-worth popover and
 * ConcentrationCard's copy of it (`accountCoverage`), the dashboard Statements
 * teaser (`statementPulls`) and the /imports missing-statements panel
 * (`statementGaps`), and the ⌘K palette (`commandEntityGroups`) sorted by
 * institution then NAME, ignoring the drag-reorder outright.
 */
export const ACCOUNT_ORDER: readonly SQL[] = [asc(institutions.name), asc(accounts.displayOrder), asc(accounts.name)];
