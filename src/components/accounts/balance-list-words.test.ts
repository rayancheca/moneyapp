import { describe, expect, test } from "vitest";
import { balanceListWords } from "./balance-list-words";

/**
 * ⛔ The page is a server component no unit test renders, and no e2e fixture holds a brokerage book with no
 * balance — so the words the list and the header say, and the rule that decides them, are pinned here.
 */
describe("balanceListWords — the list's words follow the rule that offers the form", () => {
  const checking = { name: "Capital One 360 Checking", cashAccountId: null };
  // a brokerage book: the import makes it, values it from what its statements prove, and takes no typed balance
  const book = { name: "Robinhood Agentic Brokerage", cashAccountId: "agentic-cash" };

  test("an account that takes a balance he counts is invited to add one, in his words (§6A 50)", () => {
    expect(balanceListWords(checking)).toEqual({
      takesCount: true,
      heading: "Balances",
      empty: "No balances counted yet.",
      noBalanceYet: "No balance yet — add one you counted below, or import a statement.",
    });
  });

  /*
   * 🔴 "No balances counted yet." — and, over the header, "add one you counted below" — on the one kind of
   * account whose page has no form to count with: `takesTypedBalance` hides "Add a balance you counted" from a
   * brokerage book, and `addManualAnchor` refuses it, while both empty lines kept inviting it.
   */
  test("a brokerage book takes no balance he counts, so neither empty line invites one", () => {
    const words = balanceListWords(book);

    expect(words.takesCount).toBe(false);
    const why = "Robinhood Agentic Brokerage holds only what its statements prove.";
    expect(words.empty).toBe(`No balances yet — ${why}`);
    expect(words.noBalanceYet).toBe(`No balance yet — ${why}`);
    for (const line of [words.empty, words.noBalanceYet]) expect(line).not.toMatch(/count|add one|below/i);
  });

  /*
   * 🔴 "Recorded balances" over a list holding statement balances, bank exports, live readings and his counts —
   * while his decision keeps "recorded" for a statement's balance and names his own "you counted it" (§6A 50). The
   * Source column names each row's kind; the heading names what they all are.
   */
  test("the heading names every kind the list holds, on every account", () => {
    expect(balanceListWords(checking).heading).toBe("Balances");
    expect(balanceListWords(book).heading).toBe("Balances");
  });
});
