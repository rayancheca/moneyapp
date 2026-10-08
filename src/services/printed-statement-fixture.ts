import type { AppDatabase } from "@/db/client";
import { importFiles, statementPeriods } from "@/db/schema/imports";

/**
 * TEST FIXTURE. One imported Robinhood statement printing every account in `accountIds`, as his June–August statements
 * print Robinhood Agentic beside Robinhood Brokerage — the fact `accountLiquidity` reads to call a deposit account
 * INVESTABLE. Without it a fixture's Agentic is a `checking` account like any other, so its balance is spendable: "Cash
 * you can spend today", the runway and EOM cash hold the agent's money, which on his ledger they never do (owner
 * decision 2026-09-15).
 *
 * 🔴 Three of the four agent fixtures (`agents-costs`, `agents-income`, `agents-unfiled`) left it out and pinned his
 * figures over a spendable Agentic his ledger does not have. Printed as his ledger prints it (2026-10-08), every
 * outcome they pin held. What is at stake shows in `agents-credit-by-category`: spendable, the agent's clawback moves
 * his EOM cash.
 */
export function printOnOneStatement(db: AppDatabase, institutionId: string, accountIds: readonly string[]): void {
  const fileId = "robinhood-2026-08";
  const now = new Date().toISOString();
  db.insert(importFiles)
    .values({
      id: fileId,
      fileName: `${fileId}.pdf`,
      fileSha256: `sha-${fileId}`,
      format: "pdf",
      institutionId,
      status: "parsed",
      storagePath: `/tmp/${fileId}.pdf`,
      importedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  accountIds.forEach((accountId, i) => {
    db.insert(statementPeriods)
      .values({
        id: `${fileId}-${i}`,
        importFileId: fileId,
        accountId,
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        reconciliation: "reconciled",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
}
