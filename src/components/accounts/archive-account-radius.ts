import { countPhrase, type BlastRadius, type BlastRadiusLine } from "@/components/ui/blast-radius";
import { formatCents } from "@/lib/money";
import { balanceHeading } from "@/lib/side-magnitude";

/**
 * The /accounts/[id] "Archive account" confirmation: what leaves the totals, and what the account's page keeps. Pure,
 * so every line is tested — no spec opens the dialog.
 */
export interface ArchiveAccountInput {
  accountName: string;
  isLiability: boolean;
  /** the figure the page's header prints, in the net-worth frame — null when the account has no balance */
  latestCents: number | null;
  /** how many balances the page's list holds — every kind, which the list heads "Balances" */
  balances: number;
}

export function archiveAccountRadius(input: ArchiveAccountInput): BlastRadius {
  const leaving: BlastRadiusLine[] = [];
  if (input.latestCents !== null) {
    const cents = input.latestCents;
    /*
     * 🔴 `liability ? "Owed" : "Balance"` was `balanceHeading` re-decided by hand, two hundred lines under the call
     * that gets it right — and it read "Owed, leaving the totals · -$82.72" for Chase Sapphire on 2026-09-08, a card
     * that owes nothing. Six surfaces said "in credit" about that balance on that day, and this one is a confirmation
     * for an action that moves money out of every total.
     */
    const heading = balanceHeading(cents, input.isLiability);
    leaving.push(
      {
        label: "Net worth will read",
        value: cents === 0 ? "unchanged" : `${formatCents(Math.abs(cents))} ${cents > 0 ? "lower" : "higher"}`,
      },
      { label: `${heading.label}, leaving the totals`, value: formatCents(heading.cents) },
    );
  }
  return {
    headline:
      `Archiving takes ${input.accountName} out of net worth, the assets and owed totals, and every analytic. ` +
      "Nothing is deleted.",
    lines: [
      ...leaving,
      /*
       * 🔴 "Balance, leaving the totals" directly above "Balances kept": one line said the balance leaves and the next
       * that the balances stay. The first is the figure the totals lose, this one the dated list on the page — so it
       * names where they are kept, and calls them what the list's heading does, never "recorded" (a statement's,
       * §6A 50).
       */
      { label: "Kept on its page", value: countPhrase(input.balances, "balance") },
    ],
    reassurance:
      "Restore account puts it back exactly as it is now — transactions, balances and history are untouched.",
  };
}
