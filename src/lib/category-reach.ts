import type { CategoryKind } from "@/db/schema/categories";
import { budgetCoverageSentence, spentOnlyFromCashWallets, type BudgetCoverageInput } from "./budget-coverage";
import { emptyPeriodCopy, type EmptyPeriodReason } from "./empty-period";

/**
 * Whose imported-through day a category page asks an empty window against.
 *
 * ⚖️ OWNER DECISION 2026-10-07 (§6A 49): `/categories/[id]` names the CATEGORY'S OWN day — the rule its `/budgets`
 * row uses (`services/budgets::categoryCoverage`: the earliest import frontier among the accounts the category is
 * spent from, cash wallets left out) — not the ledger-wide `ledgerReaches`. 🔴 Measured on his ledger that day: the
 * Car row read "spending imported through Aug 12 · 7 days of this period unaccounted" (Chase Checking stops Aug 12),
 * and `/categories/<Car>` one click away "October 2026 has not been imported yet. Nothing has been imported for 7 days
 * of it; the ledger is imported through Thu, Sep 24, 2026."
 *
 * The facts are the budget row's (`categoryCoverage`), so this only decides what to do where they name no day:
 *  - ⚖️ spent ONLY from cash wallets (owner decision 2026-09-15): no import day and none is coming. A wallet holds
 *    what was typed into it, so every elapsed day is as read as it will ever be — `through` is today, and the page
 *    says "cash only" in the row's own words (`budgetCoverageSentence`) instead of waiting for a statement.
 *  - spent from no account in the window, or only from accounts with no import date (priced investment accounts):
 *    there is no account of the category's own to narrow the day with, so the ledger's day stands, named as the
 *    ledger's. ⚠️ The budget row counts every elapsed day of such a window as unaccounted; a page whose category has
 *    no rows anywhere near the window would then call every month "not imported", which no import could change.
 */
export type CategoryCoverageFacts = Pick<
  BudgetCoverageInput,
  "importedThroughOn" | "spentFromSince" | "spentFromAccounts" | "spentFromWallets"
>;

export interface CategoryReach {
  /** whose day `through` is — the sentence names it as that */
  whose: "category" | "cash-only" | "ledger";
  /** the day an empty window is asked against; null only for an empty ledger */
  through: string | null;
  /** the budget row's own facts, carried so the sentence is built from the same read */
  coverage: CategoryCoverageFacts;
}

export function categoryReach(
  coverage: CategoryCoverageFacts,
  ledgerReaches: string | null,
  today: string,
): CategoryReach {
  if (coverage.importedThroughOn !== null) {
    return { whose: "category", through: coverage.importedThroughOn, coverage };
  }
  if (spentOnlyFromCashWallets(coverage)) return { whose: "cash-only", through: today, coverage };
  return { whose: "ledger", through: ledgerReaches, coverage };
}

/** "spending in Car" — the page's own flow (`categoryFlowLabel`): Spent, Received, or a Net of anything else */
function reachSubject(category: { name: string; kind: CategoryKind }): string {
  const noun = category.kind === "expense" ? "spending" : category.kind === "income" ? "income" : "activity";
  return `${noun} in ${category.name}`;
}

/**
 * The category page's empty-window heading and body, naming whose day it is.
 *
 * ⛔ "the ledger is imported through" only where the day IS the ledger's: on Car's page in October it would name Sep
 * 24 over a category whose accounts stop Aug 12. Every other world is `emptyPeriodCopy`'s, unchanged.
 */
export function categoryEmptyPeriodCopy(
  reason: EmptyPeriodReason,
  window: { label: string; from: string },
  reach: CategoryReach,
  category: { name: string; kind: CategoryKind },
  formatDay: (iso: string) => string,
  opts: { ledgerOpens?: string | null } = {},
): { title: string; description: string } {
  if (reach.whose === "cash-only" && reason.kind === "measured") {
    // "spent only from a cash wallet since Apr 1 — no statement will ever cover it", the row's own sentence
    const cash = budgetCoverageSentence({ ...reach.coverage, uncoveredDays: 0, bounds: { start: window.from } });
    return {
      title: `Nothing recorded for ${window.label}`,
      description: `${category.name} is ${cash}. Nothing was typed in for this period, so there is no import to wait for.`,
    };
  }
  return emptyPeriodCopy(reason, window.label, reach.through, formatDay, {
    ledgerOpens: opts.ledgerOpens,
    ...(reach.whose === "category" ? { importedThroughSubject: reachSubject(category) } : {}),
  });
}
