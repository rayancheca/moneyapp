import type { CategoryKind } from "@/db/schema/categories";
import { budgetCoverageSentence, spentOnlyFromCashWallets, type BudgetCoverageInput } from "./budget-coverage";
import { AGENTS_MONEY_LEFT_OUT, emptyPeriodCopy, type EmptyPeriodReason } from "./empty-period";

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
 *    no account of its own narrows the day. `categoryReachFor` then asks the nearest ANCESTOR, and only a category
 *    with none to ask keeps the ledger's day, named as the ledger's. ⚠️ The budget row counts every elapsed day of
 *    such a window as unaccounted; a page whose category has no rows anywhere near the window would then call every
 *    month "not imported", which no import could change.
 */
export type CategoryCoverageFacts = Pick<
  BudgetCoverageInput,
  "importedThroughOn" | "spentFromSince" | "spentFromAccounts" | "spentFromWallets"
>;

/** the category a day belongs to — the page's own, or the ancestor it was asked of */
export interface CategoryReachOwner {
  name: string;
  kind: CategoryKind;
}

export interface CategoryReach {
  /** whose day `through` is — the sentence names it as that */
  whose: "category" | "cash-only" | "ledger";
  /** the day an empty window is asked against; null only for an empty ledger */
  through: string | null;
  /** the budget row's own facts, carried so the sentence is built from the same read */
  coverage: CategoryCoverageFacts;
  /** whose facts they are: the page's category, or the nearest ancestor that had a day (`categoryReachFor`) */
  owner: CategoryReachOwner;
}

export function categoryReach(
  coverage: CategoryCoverageFacts,
  ledgerReaches: string | null,
  today: string,
  owner: CategoryReachOwner,
): CategoryReach {
  if (coverage.importedThroughOn !== null) {
    return { whose: "category", through: coverage.importedThroughOn, coverage, owner };
  }
  if (spentOnlyFromCashWallets(coverage)) return { whose: "cash-only", through: today, coverage, owner };
  return { whose: "ledger", through: ledgerReaches, coverage, owner };
}

/** "spending in Car" — the owner's own flow (`categoryFlowLabel`): Spent, Received, or a Net of anything else */
function reachSubject(owner: CategoryReachOwner): string {
  const noun = owner.kind === "expense" ? "spending" : owner.kind === "income" ? "income" : "activity";
  return `${noun} in ${owner.name}`;
}

/**
 * The category page's empty-window heading and body, naming whose day it is.
 *
 * ⛔ "the ledger is imported through" only where the day IS the ledger's: on Car's page in October it would name Sep
 * 24 over a category whose accounts stop Aug 12. Every other world is `emptyPeriodCopy`'s, unchanged.
 *
 * ⚖️ `agentsMoney` is said on EVERY branch that can hold the agent's rows (owner decisions 2026-09-28 → 2026-10-06),
 * the cash-only one included: the agent's account is never a wallet, so its rows sit in a window a wallet says
 * nothing about.
 */
export function categoryEmptyPeriodCopy(
  reason: EmptyPeriodReason,
  window: { label: string; from: string },
  reach: CategoryReach,
  formatDay: (iso: string) => string,
  opts: { ledgerOpens?: string | null; agentsMoney?: boolean } = {},
): { title: string; description: string } {
  if (reach.whose === "cash-only" && reason.kind === "measured") {
    // "spent only from a cash wallet since Apr 1 — no statement will ever cover it", the row's own sentence
    const cash = budgetCoverageSentence({ ...reach.coverage, uncoveredDays: 0, bounds: { start: window.from } });
    return {
      title: `Nothing recorded for ${window.label}`,
      description:
        `${reach.owner.name} is ${cash}. Nothing was typed in for this period, so there is no import to wait for.` +
        (opts.agentsMoney ? AGENTS_MONEY_LEFT_OUT : ""),
    };
  }
  return emptyPeriodCopy(reason, window.label, reach.through, formatDay, {
    ledgerOpens: opts.ledgerOpens,
    agentsMoney: opts.agentsMoney,
    ...(reach.whose === "category" ? { importedThroughSubject: reachSubject(reach.owner) } : {}),
  });
}
