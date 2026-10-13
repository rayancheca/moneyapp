import { describe, expect, test } from "vitest";
import { blastRadiusSentence } from "@/components/ui/blast-radius";
import { archiveAccountRadius } from "./archive-account-radius";

/**
 * ⛔ Not reachable from the e2e suite: the Archive dialog lives inside a closed `<dialog>`, and no spec opens it. Its
 * words are pinned here, for each label the page's header can carry (`balanceHeading`).
 */

/** the labels' first words, singular — two lines opening on the same noun read as one subject */
const openings = (labels: readonly string[]) =>
  labels.map((label) => label.split(/[\s,]/)[0]!.toLowerCase().replace(/s$/, ""));

describe("archiveAccountRadius — what archiving takes out of the totals, and what its page keeps", () => {
  /*
   * 🔴 "Balance, leaving the totals · $3,007.60" directly above "Balances kept · 50 balances" — measured 2026-10-12 on
   * a copy of his ledger, Chase Checking's dialog: one line says the balance leaves, the next that the balances stay.
   * The first is the figure the totals lose, the second the dated list on the page; the second names its place now.
   */
  test("an asset: the figure leaving the totals, and the balances its page keeps, on lines that do not collide", () => {
    const radius = archiveAccountRadius({
      accountName: "Chase Checking",
      isLiability: false,
      latestCents: 300_760,
      balances: 50,
    });

    expect(radius.headline).toBe(
      "Archiving takes Chase Checking out of net worth, the assets and owed totals, and every analytic. " +
        "Nothing is deleted.",
    );
    expect(radius.lines).toEqual([
      { label: "Net worth will read", value: "$3,007.60 lower" },
      { label: "Balance, leaving the totals", value: "$3,007.60" },
      { label: "Kept on its page", value: "50 balances" },
    ]);
    expect(radius.reassurance).toBe(
      "Restore account puts it back exactly as it is now — transactions, balances and history are untouched.",
    );
    expect(blastRadiusSentence(radius)).toContain(
      "Balance, leaving the totals: $3,007.60. Kept on its page: 50 balances.",
    );
  });

  test("no two lines open on the same noun, whichever label the header carries", () => {
    for (const [isLiability, latestCents] of [
      [false, 300_760],
      [false, -1_250], // overdrawn: still "Balance"
      [true, -112_693], // a card that owes
      [true, 8_272], // a card in credit
      [true, 0],
    ] as const) {
      const labels = archiveAccountRadius({ accountName: "A", isLiability, latestCents, balances: 3 }).lines!.map(
        (l) => l.label,
      );
      expect(new Set(openings(labels)).size).toBe(labels.length);
    }
  });

  /*
   * 🔴 `liability ? "Owed" : "Balance"` read "Owed, leaving the totals · -$82.72" for Chase Sapphire on 2026-09-08, a
   * card that owes nothing: the label and the figure are `balanceHeading`'s, one call, as the page header's are.
   */
  test("a card reads what it owes, or the credit it holds, as the page's header does", () => {
    const card = (accountName: string, latestCents: number, balances: number) =>
      archiveAccountRadius({ accountName, isLiability: true, latestCents, balances });
    const owes = card("Venture X", -112_693, 9);
    expect(owes.lines).toEqual([
      { label: "Net worth will read", value: "$1,126.93 higher" },
      { label: "Amount owed, leaving the totals", value: "$1,126.93" },
      { label: "Kept on its page", value: "9 balances" },
    ]);

    const credit = card("Chase Sapphire", 8_272, 20);
    expect(credit.lines!.slice(0, 2)).toEqual([
      { label: "Net worth will read", value: "$82.72 lower" },
      { label: "In credit, leaving the totals", value: "$82.72" },
    ]);
  });

  test("an account with no balance moves no total, and says only what its page keeps", () => {
    const radius = archiveAccountRadius({
      accountName: "Capital One 360 Checking",
      isLiability: false,
      latestCents: null,
      balances: 0,
    });
    expect(radius.lines).toEqual([{ label: "Kept on its page", value: "no balances" }]);

    const zero = archiveAccountRadius({ accountName: "Cash on Hand", isLiability: false, latestCents: 0, balances: 1 });
    expect(zero.lines![0]).toEqual({ label: "Net worth will read", value: "unchanged" });
  });

  test("every kind the list holds is a balance — the dialog never calls them \"recorded\"", () => {
    const radius = archiveAccountRadius({ accountName: "A", isLiability: false, latestCents: 100, balances: 2 });
    expect(blastRadiusSentence(radius)).not.toMatch(/recorded/i);
  });
});
