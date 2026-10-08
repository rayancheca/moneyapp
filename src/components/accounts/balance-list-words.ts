import type { CountRefusal } from "@/services/anchors";

/**
 * The /accounts/[id] balance list's own words — its heading, its line when it holds nothing — and the header's line
 * when the account has no balance at all, from the ONE rule that decides whether "Add a balance you counted" is on
 * the page (`countRefusal`, the rule `addManualAnchor` refuses by). The page gates the form on `takesCount`, so the
 * form and every line that points at it answer the same question.
 *
 * ⚖️ His answer, 2026-10-07 (§6A 50): "No balances counted yet" where he can add one. A statement's balance keeps
 * "recorded" and a balance he typed reads "you counted it" — the list holds both, and the Source column names which.
 */
export interface BalanceListWords {
  /** whether the page offers "Add a balance you counted" */
  takesCount: boolean;
  heading: string;
  /** the list's line when it holds no balance */
  empty: string;
  /** the header's line when the account has no balance at all */
  noBalanceYet: string;
}

/*
 * 🔴 The list was headed "Recorded balances" over statement balances, bank exports, live readings, the openings of
 * statements he un-imported and his own counts — while "recorded" is the word his decision keeps for a statement's,
 * and his own read "you counted it" one column over. It names what they all are.
 */
const HEADING = "Balances";

/** `refusal` is `countRefusal`'s answer for the account: null where he may count a balance. */
export function balanceListWords(refusal: Pick<CountRefusal, "why"> | null): BalanceListWords {
  if (refusal === null) {
    return {
      takesCount: true,
      heading: HEADING,
      empty: "No balances counted yet.",
      noBalanceYet: "No balance yet — add one you counted below, or import a statement.",
    };
  }
  /*
   * 🔴 A brokerage book has no form to count with — the import makes it and values it from the positions its
   * statements prove, and `addManualAnchor` refuses a typed balance there — yet both lines invited one: "No balances
   * counted yet." and "add one you counted below". Each of its statements writes a value anchor, so an empty list is
   * the edge of a book's life, not its usual state — and there it says what the account is instead. ⚖️ §6A 58: so
   * does an account priced from its holdings, whose curve never reads a balance.
   */
  return {
    takesCount: false,
    heading: HEADING,
    empty: `No balances yet — ${refusal.why}.`,
    noBalanceYet: `No balance yet — ${refusal.why}.`,
  };
}
