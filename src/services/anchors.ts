import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { withPreMutationSnapshot } from "@/db/backup";
import type { AppDatabase } from "@/db/client";
import { isLiability, type AccountType } from "@/db/schema/accounts";
import { balanceAnchors, type AnchorSource } from "@/db/schema/balances";
import { financialWindowMessage, isWithinFinancialWindow } from "@/lib/date-window";
import { isValidIsoDate, todayIso } from "@/lib/dates";
import { getAccount } from "./accounts";
import {
  changedDayCount,
  deriveDailyRows,
  derivesFromHoldings,
  loadReplayInputs,
  pickWinners,
  rebuildAccount,
  removalEffect,
  storedDailyRows,
  type RemovalEffect,
} from "./derivation";

/**
 * Manual balance entry. UI collects credit-card balances as positive
 * "amount owed" — this boundary converts to the net-worth sign convention
 * (liabilities stored negative) so nothing downstream ever branches on type.
 */
export const manualAnchorInputSchema = z.object({
  accountId: z.string().min(1),
  // an anchor is a replay endpoint: a typo'd year would make derivation walk
  // one row per day across a millennium, so the year is bounded, not just the
  // shape (the pure cap in derivation.ts backs this up for non-UI callers)
  anchoredOn: z
    .string()
    .refine(isValidIsoDate, "Invalid date")
    .refine(isWithinFinancialWindow, financialWindowMessage("anchoredOn")),
  /** For credit accounts: the positive amount owed. Others: the balance. */
  enteredCents: z.number().int(),
});
export type ManualAnchorInput = z.infer<typeof manualAnchorInputSchema>;

/** Why an account takes no balance the owner counts — `countRefusal`'s answer. */
export interface CountRefusal {
  /** what the account is — the account page says it where "Add a balance you counted" would be */
  why: string;
  /** `addManualAnchor`'s refusal: the why, and what a count there would do */
  message: string;
}

/**
 * Why the owner may NOT count a balance for this account, or null where he may. The account page (through
 * `balanceListWords`) and `addManualAnchor` ask this one rule, so the form is offered exactly where a count is taken.
 *
 *  - ⛔ A brokerage book (`cash_account_id`): the import creates it, values it from the positions its statements
 *    prove, and removes it once no statement stands on it (services/import/brokerage-book.ts).
 *  - ⛔ An account priced from its holdings — `derivesFromHoldings`, the branch `rebuildAccount` takes, where the curve
 *    is holding events × closes and `balance_anchors` is never read. An investment account with NO holding events
 *    still takes a count: the rebuild holds its balances as its value, so there a count IS its value.
 *
 * 🔴 The Add-holding form refused the agent's book and "Record a balance" did not. The typed figure changed nothing
 * while statements valued the book, and then kept the book alive after its last statement was un-imported, in net
 * worth — measured 2026-09-16 on a copy of the real ledger: $500.00 typed on 2026-09-14, net worth +$500.00 and
 * investable cash +$500.00 once both constructed months were un-imported.
 *
 * ⚖️ His answer, 2026-10-08 (§6A 58): hide it on an account valued from its holdings too. 🔴 Measured on a copy of
 * his ledger: a $17,000.00 count on Oct 2 left Robinhood Brokerage at $73,194.17 and Robinhood Crypto at $38,233.79,
 * was listed "you counted it", and its remove dialog said it "verifies nothing and plays no part in its curve".
 */
export function countRefusal(
  db: AppDatabase,
  account: {
    readonly id: string;
    readonly name: string;
    readonly type: AccountType;
    readonly cashAccountId: string | null;
  },
): CountRefusal | null {
  // the book first: its statements write holding events too, and its own words say why
  if (account.cashAccountId !== null) {
    const why = `${account.name} holds only what its statements prove`;
    return { why, message: `${why} — a balance typed here would outlive them` };
  }
  if (derivesFromHoldings(db, account)) {
    // the remove dialog's words for a balance already there (`removeBalanceRadius`)
    const why = `${account.name} is priced from its holdings`;
    return { why, message: `${why} — a balance you count there plays no part in its curve` };
  }
  return null;
}

export function addManualAnchor(db: AppDatabase, input: ManualAnchorInput): string {
  const parsed = manualAnchorInputSchema.parse(input);
  const account = getAccount(db, parsed.accountId);
  if (!account) throw new Error(`Unknown account ${parsed.accountId}`);
  const refusal = countRefusal(db, account);
  if (refusal) throw new Error(refusal.message);
  if (isLiability(account.type) && parsed.enteredCents < 0) {
    throw new Error("Enter credit-card balances as the positive amount owed");
  }
  const balanceCents = isLiability(account.type) ? -parsed.enteredCents : parsed.enteredCents;

  // Only the CONFLICT branch is irreversible: re-anchoring a day that already
  // carries a manual anchor overwrites the old figure with no trace of it, and
  // every derived balance after that day moves with it. A first anchor for the
  // day adds information, and an identical re-save loses none — neither is
  // worth a restore point.
  const superseded = db
    .select({ balanceCents: balanceAnchors.balanceCents })
    .from(balanceAnchors)
    .where(
      and(
        eq(balanceAnchors.accountId, parsed.accountId),
        eq(balanceAnchors.anchoredOn, parsed.anchoredOn),
        eq(balanceAnchors.source, "manual"),
      ),
    )
    .get();
  const overwrites = superseded !== undefined && superseded.balanceCents !== balanceCents;

  const write = (): string => {
    const row = db
      .insert(balanceAnchors)
      .values({
        accountId: parsed.accountId,
        anchoredOn: parsed.anchoredOn,
        balanceCents,
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [balanceAnchors.accountId, balanceAnchors.anchoredOn, balanceAnchors.source],
        set: { balanceCents },
      })
      .returning({ id: balanceAnchors.id })
      .get();

    rebuildAccount(db, parsed.accountId);
    return row.id;
  };

  return overwrites ? withPreMutationSnapshot(db, "overwrite-anchor", write) : write();
}

export function listAnchors(db: AppDatabase, accountId: string) {
  return db
    .select()
    .from(balanceAnchors)
    .where(eq(balanceAnchors.accountId, accountId))
    .orderBy(asc(balanceAnchors.anchoredOn))
    .all();
}

/**
 * The balances a person can remove from /accounts/[id]. A statement or bank-export
 * balance leaves only when its file is un-imported. One rule for `deleteAnchor`
 * and for the prediction the dialog quotes before it.
 */
export function isRemovableAnchorSource(source: AnchorSource): boolean {
  return source === "manual" || source === "live";
}

export type AnchorRemovalEffect =
  | { pricedFromHoldings: true }
  | ({
      pricedFromHoldings: false;
      /**
       * The branch `deriveDailyRows` takes for this account. True: its recorded
       * balances are held flat as a VALUE, which `accountCoverage` grades
       * `market_value` — the dialog says what a balance sets, never what it
       * verifies. False: balances close transaction arithmetic.
       */
      isInvestment: boolean;
      /**
       * Days the STORED curve differs from a rebuild at `today` with every balance
       * kept: the part of confirming that happens whichever balance goes, or none.
       * `RemovalEffect` compares two derivations at today and cannot see it.
       */
      catchUpDays: number;
    } & RemovalEffect);

/**
 * What `deleteAnchor` WOULD do to each removable balance on one account — the
 * figures the remove-balance dialog quotes before the owner confirms.
 *
 * It takes the branch `rebuildAccount` takes: an account priced from its holdings
 * never reads a recorded balance, so removing one changes nothing it contributes;
 * any other is `removalEffect` over `loadReplayInputs`. Loaded ONCE per account
 * however many rows the page renders — building drizzle queries is this app's
 * measured cost, and per-row loads would multiply it by the rows. Keys are
 * exactly the balances `deleteAnchor` accepts.
 *
 * 🔴 `curveUnchanged` was quoted as "Removing it leaves the curve exactly as it
 * is", but the page draws `daily_balances`, which stops wherever today stood at
 * the last rebuild, and `deleteAnchor` rebuilds at today. Measured 2026-09-14 on
 * the owner's ledger: Robinhood Cash's cache ended 2026-08-28 and Chase
 * Sapphire's 2026-09-03, so confirming either removal added 17 and 11 days to the
 * drawn curve under a dialog that promised none. `catchUpDays` is that difference,
 * counted by the same `changedDayCount` the effect itself is counted by.
 *
 * (A single-balance `anchorRemovalEffect` shipped beside this with no caller but
 * its own tests — a prediction nothing quoted. The map is the one entry point.)
 */
export function anchorRemovalEffects(
  db: AppDatabase,
  accountId: string,
  today: string = todayIso(),
): Map<string, AnchorRemovalEffect> {
  const account = getAccount(db, accountId);
  if (!account) throw new Error(`Unknown account ${accountId}`);

  if (derivesFromHoldings(db, account)) {
    return new Map(
      listAnchors(db, accountId)
        .filter((a) => isRemovableAnchorSource(a.source))
        .map((a): [string, AnchorRemovalEffect] => [a.id, { pricedFromHoldings: true }]),
    );
  }

  const { anchors, txnSumByDay } = loadReplayInputs(db, accountId);
  const options = { isInvestment: account.type === "investment", today };
  // exactly what `rebuildAccount` would write if nothing were removed
  const rebuiltToday = deriveDailyRows(pickWinners(anchors), txnSumByDay, options);
  const catchUpDays = changedDayCount(storedDailyRows(db, accountId), rebuiltToday);
  return new Map(
    anchors
      .filter((a) => isRemovableAnchorSource(a.source))
      .map((a): [string, AnchorRemovalEffect] => [
        a.id,
        {
          pricedFromHoldings: false,
          isInvestment: options.isInvestment,
          catchUpDays,
          ...removalEffect(anchors, a.id, txnSumByDay, options),
        },
      ]),
  );
}

export function deleteAnchor(db: AppDatabase, anchorId: string): void {
  const anchor = db.select().from(balanceAnchors).where(eq(balanceAnchors.id, anchorId)).get();
  if (!anchor) return;
  if (!isRemovableAnchorSource(anchor.source)) {
    throw new Error("Statement-derived anchors are removed by un-importing their file");
  }
  // A hand-entered balance is unrecoverable — nothing re-derives it.
  withPreMutationSnapshot(db, "delete-anchor", () => {
    db.delete(balanceAnchors)
      .where(and(eq(balanceAnchors.id, anchorId)))
      .run();
    rebuildAccount(db, anchor.accountId);
  });
}
