import { describe, expect, test } from "vitest";
import { rolloverHeldBackSentence, rolloverWaitsSentence } from "./rollover-held-back";

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
    expect(rolloverWaitsSentence({ whose: "category", ancestor: null })).toBe(
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
describe("rolloverWaitsSentence — whose day the carry waits on, as it asked it", () => {
  test("on an ancestor's accounts, it names the ancestor", () => {
    expect(rolloverWaitsSentence({ whose: "category", ancestor: "Utilities" })).toBe(
      "With no account of its own to wait on, a period of this category adds nothing until the accounts Utilities has " +
        "lately been spent from are imported through its last day, so a missing statement on one of them cannot bank " +
        "itself as savings.",
    );
  });

  test("on the ledger's day, it says that — and promises nothing of a missing statement the day does not wait for", () => {
    const sentence = rolloverWaitsSentence({ whose: "ledger", ancestor: null });
    expect(sentence).toBe(
      "With no account of its own to wait on, a period of this category adds nothing until the ledger is imported " +
        "through its last day.",
    );
    // `ledgerReaches` is the newest day ANY account reaches: a statement missing on another account does not hold it
    expect(sentence).not.toContain("missing statement");
  });

  test("⚖️ spent only from cash wallets — its own or its ancestor's — a closed period waits for no statement", () => {
    expect(rolloverWaitsSentence({ whose: "cash-only", ancestor: null })).toBe(
      "This category is spent only from cash wallets, so a closed period waits for no statement — none will ever " +
        "cover it.",
    );
    expect(rolloverWaitsSentence({ whose: "cash-only", ancestor: "Travel" })).toBe(
      "With no account of its own to wait on, this category is read as Travel is, spent only from cash wallets, so a " +
        "closed period waits for no statement — none will ever cover it.",
    );
  });
});
