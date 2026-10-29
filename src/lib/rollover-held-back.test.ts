import { describe, expect, test } from "vitest";
import {
  lineMayRise,
  rolloverHeldBackSentence,
  rolloverMayRiseClause,
  rolloverToggleTitle,
  rolloverToggleToast,
  rolloverWaitsSentence,
  type RolloverRiseInput,
} from "./rollover-held-back";

/** the graded window's first day — where a day outside its year would carry the year */
const REF = "2026-10-01";

/*
 * ⚖️ Decision 67 (2026-10-13): a closed period not read whole banks nothing until its statements land. The panel names
 * what it held back, in the words of the period it is — 🔴 on his ledger copy 2026-10-12 every rolling budget banked
 * from a September no statement had confirmed, and nothing on the panel said so.
 */
describe("rolloverHeldBackSentence — what a rolling budget is waiting on", () => {
  const SEPTEMBER = { start: "2026-09-01", end: "2026-09-30" };

  test("nothing held back says nothing", () => {
    expect(rolloverHeldBackSentence([], "monthly", "2026-10-01")).toBeNull();
  });

  test("his September, by its name", () => {
    expect(rolloverHeldBackSentence([SEPTEMBER], "monthly", "2026-10-01")).toBe(
      "September 2026 is not fully imported, so nothing rolls over from it yet.",
    );
  });

  test("two months are named both, and are 'them'", () => {
    const august = { start: "2026-08-01", end: "2026-08-31" };
    expect(rolloverHeldBackSentence([august, SEPTEMBER], "monthly", "2026-10-01")).toBe(
      "August 2026 and September 2026 are not fully imported, so nothing rolls over from them yet.",
    );
  });

  test("more are counted between the first and the last", () => {
    const held = ["07", "08", "09"].map((m) => ({ start: `2026-${m}-01`, end: `2026-${m}-28` }));
    expect(rolloverHeldBackSentence(held, "monthly", "2026-10-01")).toBe(
      "3 months, July 2026 to September 2026, are not fully imported, so nothing rolls over from them yet.",
    );
  });

  test("a week is the week of its first day, and a day from another year says its year", () => {
    expect(rolloverHeldBackSentence([{ start: "2026-09-28", end: "2026-10-04" }], "weekly", "2026-10-05")).toBe(
      "The week of Sep 28 is not fully imported, so nothing rolls over from it yet.",
    );
    expect(rolloverHeldBackSentence([{ start: "2025-12-29", end: "2026-01-04" }], "weekly", "2026-01-05")).toBe(
      "The week of Dec 29, 2025 is not fully imported, so nothing rolls over from it yet.",
    );
  });

  test("days are spanned, and a year is its number", () => {
    const days = ["10", "11", "12", "13"].map((d) => ({ start: `2026-10-${d}`, end: `2026-10-${d}` }));
    expect(rolloverHeldBackSentence(days, "daily", "2026-10-14")).toBe(
      "4 days, Oct 10 – Oct 13, are not fully imported, so nothing rolls over from them yet.",
    );
    expect(rolloverHeldBackSentence([{ start: "2025-01-01", end: "2025-12-31" }], "annual", "2026-01-01")).toBe(
      "2025 is not fully imported, so nothing rolls over from it yet.",
    );
  });

  /*
   * 🔴 "…, so a missing statement cannot bank itself as savings" was flat, and the rule it stands on has a documented
   * gap (`services/budgets::categoryCoverage`): a period is read on the accounts the category has lately been spent
   * from, so a statement missing on an account it has never been spent from is not waited for (review of 73a743d).
   * The sentence says the rule's own reach, and no further — `budgets.test.ts` pins the gap it leaves.
   */
  test("on its own accounts, it says so, and says why — no further than the rule reaches", () => {
    expect(rolloverWaitsSentence({ whose: "category", ancestor: null }, REF)).toBe(
      "A period adds nothing until the accounts this category has lately been spent from are imported through its " +
        "last day, so a missing statement on one of them cannot bank itself as savings.",
    );
  });
});

/*
 * 🔴 …and it said that of EVERY rolling budget, while the carry asks the day its category page asks (`categoryReachFor`):
 * a category with no account of its own reads its nearest ancestor's, else the ledger's, and one spent only from cash
 * wallets reads through today. Measured on a copy of his ledger 2026-10-13 (review of 46b6e4b): 7 of his expense
 * categories without a budget fall back — Water/Gas and Mobile to Utilities, Hotels to Travel, Medical to Health, Card
 * Annual Fees and Interest Charges to Fees, Gifts & Donations to the ledger's Sep 24 — and a $100 rolling Gifts &
 * Donations budget from Jul 1 held September back under a sentence about accounts Gifts had never been spent from.
 */
/*
 * ⚖️ default built, not asked (2026-10-29): a period held back banks once its statements land, so the line a rolling
 * row is graded against can still rise while one of them could still bank (`services/budgets::carryInto`'s
 * `mayAddCents`). 🔴 Review of 48475ec4, measured on a copy of his ledger 2026-10-29: Fees ($15.00, rolling, September
 * held back with $0.00 of it found) with a $20.00 Oct 10 row on Venture X read "Over budget by 33%", and the note "…so
 * each is over by at least what it shows" — and once Chase Checking and Robinhood Cash were read through Sep 30, $20.00
 * of $30.00 ($15.00 rolled over), $10.00 left, with no new spending.
 */
describe("lineMayRise and rolloverMayRiseClause — a line that can still rise, and the words for it", () => {
  const SEPTEMBER = { start: "2026-09-01", end: "2026-09-30" };
  const row = (over: Partial<RolloverRiseInput> = {}): RolloverRiseInput => ({
    rolloverMayAddCents: 1_500,
    rolloverHeldBack: [SEPTEMBER],
    budget: { period: "monthly" },
    bounds: { start: "2026-10-01" },
    ...over,
  });

  test("nothing that can still bank: the line stands where it is, and nothing is said", () => {
    expect(lineMayRise(row({ rolloverMayAddCents: 0 }))).toBe(false);
    expect(rolloverMayRiseClause(row({ rolloverMayAddCents: 0 }))).toBeNull();
    // ⛔ held back and already past its plan is a period that adds nothing: Entertainment's September, $475.03 of $15.00
    expect(rolloverMayRiseClause(row({ rolloverMayAddCents: 0, rolloverHeldBack: [SEPTEMBER] }))).toBeNull();
    // …and a figure with no period named to wait on has nothing to name (the carry never hands one in)
    expect(rolloverMayRiseClause(row({ rolloverHeldBack: [] }))).toBeNull();
  });

  test("his Fees' September, by its name", () => {
    expect(lineMayRise(row())).toBe(true);
    expect(rolloverMayRiseClause(row())).toBe("more can still roll over from September 2026 once it is fully imported");
  });

  test("two named both, more counted between the first and the last, a week by its first day", () => {
    const august = { start: "2026-08-01", end: "2026-08-31" };
    expect(rolloverMayRiseClause(row({ rolloverHeldBack: [august, SEPTEMBER] }))).toBe(
      "more can still roll over from August 2026 and September 2026 once they are fully imported",
    );
    const held = ["07", "08", "09"].map((m) => ({ start: `2026-${m}-01`, end: `2026-${m}-28` }));
    expect(rolloverMayRiseClause(row({ rolloverHeldBack: held }))).toBe(
      "more can still roll over from 3 months, July 2026 to September 2026, once they are fully imported",
    );
    const week = { rolloverHeldBack: [{ start: "2026-09-28", end: "2026-10-04" }], bounds: { start: "2026-10-05" } };
    expect(rolloverMayRiseClause(row({ ...week, budget: { period: "weekly" } }))).toBe(
      "more can still roll over from the week of Sep 28 once it is fully imported",
    );
  });
});

/*
 * 🔴 A THIRD READER OF THE RULE, without decision 67's hold: the Roll over button hovered "Unspent budget carries into
 * the next period" and toasted "<category> now carries unspent budget forward" (review of 44d0104). On his ledger copy
 * 2026-10-21 Cash & ATM, Fees and Transport came in $130.00, $15.00 and $85.99 under September's plan and carried
 * $0.00 — September is not fully imported — under that hover.
 */
describe("the Roll over control's words — the setting, with the hold", () => {
  test("on, it says a period carries once it is fully imported; off, that the leftover is forgotten", () => {
    expect(rolloverToggleTitle(true)).toBe(
      "Unspent budget carries into the next period once that period is fully imported",
    );
    expect(rolloverToggleTitle(false)).toBe("Unspent budget is forgotten at the end of each period");
  });

  test("its toast says the same of the category it was turned on for", () => {
    expect(rolloverToggleToast("Transport", true)).toBe(
      "Transport now carries forward what a fully imported period leaves unspent",
    );
    expect(rolloverToggleToast("Transport", false)).toBe("Transport resets each period");
  });
});

describe("rolloverWaitsSentence — whose day the carry waits on, as it asked it", () => {
  // 🔴 "…the accounts Utilities has lately been spent from are imported through its last day" — Utilities' last day,
  // as it read, not the period's (review of 9249ae7)
  test("on an ancestor's accounts, it names the ancestor — and whose last day it waits for", () => {
    expect(rolloverWaitsSentence({ whose: "category", ancestor: "Utilities" }, REF)).toBe(
      "With no account of its own to wait on, a period of this category adds nothing until the accounts Utilities has " +
        "lately been spent from are imported through that period's last day, so a missing statement on one of them " +
        "cannot bank itself as savings.",
    );
  });

  test("on the ledger's day, it says that — and promises nothing of a missing statement the day does not wait for", () => {
    const sentence = rolloverWaitsSentence({ whose: "ledger", ancestor: null }, REF);
    expect(sentence).toBe(
      "With no account of its own to wait on, a period of this category adds nothing until the ledger is imported " +
        "through that period's last day.",
    );
    // `ledgerReaches` is the newest day ANY account reaches: a statement missing on another account does not hold it
    expect(sentence).not.toContain("missing statement");
  });

  /*
   * ⚖️ Spent only from cash wallets (2026-09-15), its own or its ancestor's: read through today, so a closed period waits
   * for no statement. 🔴 It said "cash wallets" of his one wallet and named no window, where the row's Grading line beside
   * it reads "spent only from a cash wallet since Apr 1" (`budgetCoverageFact`), and the ancestor's version read as a
   * broken clause, "…read as Travel is, spent only from cash wallets, so…" (review of 9249ae7). 🔴 …and "none will ever
   * cover it" stood under "April 2026 is not fully imported, so nothing rolls over from it yet" — a rolling budget that
   * opens before the ledger's first row holds those days back, an older statement could bring them in (review of
   * 44d0104). It says that one case instead.
   */
  test("⚖️ spent only from a cash wallet, in the row's words — only the days before the records hold it", () => {
    const cash = { spentFromSince: "2026-04-01", spentFromWallets: 1 };
    expect(rolloverWaitsSentence({ whose: "cash-only", ancestor: null, cash }, REF)).toBe(
      "This category has been spent only from a cash wallet since Apr 1, so a closed period waits for no statement — " +
        "only a day before your records begin holds one back.",
    );
    expect(rolloverWaitsSentence({ whose: "cash-only", ancestor: "Travel", cash }, REF)).toBe(
      "With no account of its own to wait on, this category is read as Travel is — Travel spent only from a cash " +
        "wallet since Apr 1 — so a closed period waits for no statement; only a day before your records begin holds " +
        "one back.",
    );
    const two = { spentFromSince: "2025-11-01", spentFromWallets: 2 };
    expect(rolloverWaitsSentence({ whose: "cash-only", ancestor: null, cash: two }, REF)).toContain(
      "has been spent only from cash wallets since Nov 1, 2025, so",
    );
  });
});
