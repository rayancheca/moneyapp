import { describe, expect, test } from "vitest";
import { emptyPeriodReason } from "./empty-period";
import { formatDayLong } from "./format-date";
import { categoryEmptyPeriodCopy, categoryReach, type CategoryCoverageFacts } from "./category-reach";

/**
 * ⚖️ OWNER DECISION 2026-10-07 (§6A 49): `/categories/[id]` names the CATEGORY'S OWN imported-through day — the rule
 * its `/budgets` row uses — not the ledger-wide one. Measured on his ledger that day: the Car row read "spending
 * imported through Aug 12 · 7 days of this period unaccounted" (Chase Checking stops Aug 12), and `/categories/<Car>`
 * one click away "October 2026 has not been imported yet. Nothing has been imported for 7 days of it; the ledger is
 * imported through Thu, Sep 24, 2026."
 */

const LEDGER_OPENS = "2022-08-25";
const LEDGER_REACHES = "2026-09-24";
const TODAY = "2026-10-07";
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

function facts(over: Partial<CategoryCoverageFacts> = {}): CategoryCoverageFacts {
  return {
    importedThroughOn: "2026-08-12",
    spentFromSince: "2026-04-01",
    spentFromAccounts: 2,
    spentFromWallets: 1,
    ...over,
  };
}

describe("categoryReach — whose day an empty window on a category page is asked against", () => {
  test("the category's own day when its accounts have one — wallets left out, as on its budget row", () => {
    expect(categoryReach(facts(), LEDGER_REACHES, TODAY)).toMatchObject({ whose: "category", through: "2026-08-12" });
  });

  test("⚖️ cash only: no import day and none coming, so every elapsed day holds what was typed", () => {
    const cash = facts({ importedThroughOn: null, spentFromAccounts: 0, spentFromWallets: 1 });
    expect(categoryReach(cash, LEDGER_REACHES, TODAY)).toMatchObject({ whose: "cash-only", through: TODAY });
  });

  test("no account of its own to ask — spent from nothing, or only from accounts with no import date — is the ledger's", () => {
    const none = facts({ importedThroughOn: null, spentFromAccounts: 0, spentFromWallets: 0 });
    const priced = facts({ importedThroughOn: null, spentFromAccounts: 1, spentFromWallets: 0 });
    expect(categoryReach(none, LEDGER_REACHES, TODAY)).toMatchObject({ whose: "ledger", through: LEDGER_REACHES });
    expect(categoryReach(priced, LEDGER_REACHES, TODAY)).toMatchObject({ whose: "ledger", through: LEDGER_REACHES });
  });

  test("the facts ride along, so the sentence cannot be built from a second read", () => {
    const f = facts();
    expect(categoryReach(f, LEDGER_REACHES, TODAY).coverage).toEqual(f);
  });
});

describe("categoryEmptyPeriodCopy — the page's sentence names whose day it is", () => {
  function copyFor(f: CategoryCoverageFacts, window = OCTOBER, label = "October 2026", kind: "expense" | "income" | "transfer" = "expense", name = "Car") {
    const reach = categoryReach(f, LEDGER_REACHES, TODAY);
    const reason = emptyPeriodReason({ ...window, today: TODAY, ledgerOpens: LEDGER_OPENS, ledgerReaches: reach.through });
    return categoryEmptyPeriodCopy(reason, { label, from: window.from }, reach, { name, kind }, formatDayLong, {
      ledgerOpens: LEDGER_OPENS,
    });
  }

  test("Car in October names Car's day, Aug 12, and never 'the ledger is imported through'", () => {
    const copy = copyFor(facts());
    expect(copy.title).toBe("October 2026 has not been imported yet");
    expect(copy.description).toBe(
      "Nothing has been imported for 7 days of it; spending in Car is imported through Wed, Aug 12, 2026. " +
        "That is a window nobody has looked at, not one in which nothing happened — import the statements that cover it.",
    );
    expect(copy.description).not.toMatch(/the ledger is imported through/);
  });

  test("a window the category's day stops inside names the same day as its cause", () => {
    // Aug 1 – Sep 20: the ledger has every day of it, Car's accounts only through Aug 12
    const copy = copyFor(facts(), { from: "2026-08-01", to: "2026-09-20" }, "Aug 1 – Sep 20, 2026");
    expect(copy.description).toMatch(/^39 days of it have not been imported — spending in Car is imported through Wed, Aug 12, 2026, so this is a lower bound/);
  });

  test("the subject is the page's own flow — income in an income category, activity in any other", () => {
    expect(copyFor(facts(), OCTOBER, "October 2026", "income", "Salary").description).toMatch(
      /; income in Salary is imported through Wed, Aug 12, 2026\./,
    );
    expect(copyFor(facts(), OCTOBER, "October 2026", "transfer", "Transfers").description).toMatch(
      /; activity in Transfers is imported through Wed, Aug 12, 2026\./,
    );
  });

  test("the ledger's day keeps the ledger's words — there was no account of the category's own to name", () => {
    const copy = copyFor(facts({ importedThroughOn: null, spentFromAccounts: 0, spentFromWallets: 0 }));
    expect(copy.description).toMatch(/; the ledger is imported through Thu, Sep 24, 2026\./);
  });

  test("⚖️ cash only says so in its budget row's own words, and waits for no statement", () => {
    const cash = facts({ importedThroughOn: null, spentFromAccounts: 0, spentFromWallets: 1 });
    const copy = copyFor(cash);
    expect(copy.title).toBe("Nothing recorded for October 2026");
    expect(copy.description).toBe(
      "Car is spent only from a cash wallet since Apr 1 — no statement will ever cover it. " +
        "Nothing was typed in for this period, so there is no import to wait for.",
    );
    expect(copy.description).not.toMatch(/imported through|not been imported/);
  });

  test("cash only still says a period has not happened when it has not", () => {
    const cash = facts({ importedThroughOn: null, spentFromAccounts: 0, spentFromWallets: 1 });
    expect(copyFor(cash, { from: "2026-11-01", to: "2026-11-30" }, "November 2026").title).toBe(
      "November 2026 has not happened yet",
    );
  });
});
