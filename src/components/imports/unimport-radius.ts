import { countPhrase, type BlastRadius, type BlastRadiusLine } from "@/components/ui/blast-radius";
import { formatCents } from "@/lib/money";
import type { UnimportCounts } from "@/services/import/unimport-counts";

/**
 * The /imports "un-import" confirmation, read off `unimportCountsByFile` —
 * the rows `unimportFile` deletes and the rows it keeps, counted with the
 * predicates the delete itself uses.
 *
 * 🔴 It said "deletes every row it brought in" over every file. Since
 * 2026-09-15 a statement can hold rows it never brought in — 34 Chase Sapphire
 * payments are filed under 12 of its statements — and un-importing keeps them
 * (owner's decision). 20260302-statements-9805-.pdf reads "4 rows deleted, 5
 * kept", and the transfer legs on each side are counted: the four deleted legs
 * each leave a Chase Checking partner that loses its link, the five kept stay
 * linked.
 *
 * 🔴 …"5 legs, still linked" was a claim about every kept leg, and on 2026-09-15
 * one of those five (+$115.00, 2026-03-02) was alone in its transfer group, as
 * was one of 20250702's two, until `link-sapphire-one-leg-groups-2026-09-15.ts`
 * linked both the same day. A kept leg reads as linked only where its group
 * still holds another live row after the un-import (`transferLegsKeptLinked`).
 */
export interface UnimportRadiusInput {
  /** which file, as the row names it (`importRowSubject`) */
  subject: string;
  counts: UnimportCounts;
  /** recorded balances un-importing the file removes — not the ones another statement still prints (`balancesRemovedByFile`) */
  balances: number;
  /** statement periods the file owns */
  periods: number;
}

const NO_UNDO = "There is no undo for this inside the app.";

/*
 * 🔴 "uncategorized" is the opposite of what happens. `importStatementFiles`
 * runs `categorizeAll` and `detectTransfers` on every import that touched an
 * account, so the rules, the merchant map, the bank categories and transfer
 * detection all re-apply at once. Measured 2026-09-10 over the rows the 130
 * row-carrying files own: 5,987 of 10,289 currently hold a categorization from
 * exactly those engines — rule 2,437 · merchant map 1,263 · transfer detection
 * 1,108 · bank category 1,092 — and 127 of the 130 files have no uncategorized
 * row at all. Only the hand-categorized rows lose anything, which the second
 * clause already said.
 *
 * 🔴 …and it left out the recurring links, which an import now writes too
 * (2026-09-14): a charge joins the live series already carrying its exact
 * description, and a commitment that has never posted takes its exact first
 * charge. Before that, re-importing a statement brought its bills back
 * UNLINKED, and every surface that decides "paid" from links called them owed.
 *
 * 🔴 …but "re-runs recurring-series linking" alone promised every link back,
 * and a link comes back only where its series still RECOGNISES the charge:
 * absorption needs another row of that series with the same description, and a
 * first posting needs a commitment with nothing posted whose date is still
 * ahead. Measured 2026-09-14 by the review on a copy of the real ledger:
 * un-importing and re-importing Statement_082026_4208.pdf left Car insurance
 * and HBO Max at 0 linked rows (1 each before). Read-only on the ledger the
 * same day: each has exactly one linked row, both in that file (2026-08-12
 * -$357.58, 2026-07-18 -$260.26), and Venture X annual fee's only one is in
 * capitalone-venturex-statement-2026-02.pdf. A detach goes with its row too:
 * the charge the owner said was not that bill comes back linked, if its series
 * still carries the description.
 */
const REASSURANCE =
  "The statement file itself stays on disk. Re-importing brings the rows back and re-runs the rules, the merchant map, transfer detection and recurring-series linking over them — but a charge links again only where its series still recognises it: by another charge with the same description, or as a registered commitment's first charge on its date and amount. What is lost is the hand-categorization, and the recurring links you attached or removed by hand.";

function headline(subject: string, { deleted, kept }: UnimportCounts): string {
  if (kept === 0) return `Un-importing ${subject} deletes every row it brought in. ${NO_UNDO}`;
  const keptRows = countPhrase(kept, "row");
  if (deleted === 0) {
    const [was, stays] = kept === 1 ? ["was", "it stays"] : ["were", "they stay"];
    return `Un-importing ${subject} deletes no transactions: the ${keptRows} under it ${was} filed by hand, and ${stays}, detached from the file. ${NO_UNDO}`;
  }
  return `Un-importing ${subject} deletes the ${countPhrase(deleted, "row")} it brought in and keeps the ${keptRows} filed under it by hand, detached from the file. ${NO_UNDO}`;
}

function keptLegs({ transferLegsKept: legs, transferLegsKeptLinked: linked }: UnimportCounts): string {
  const phrase = countPhrase(legs, "leg");
  if (linked === legs) return `${phrase}, still linked`;
  if (linked === 0) return legs === 1 ? `${phrase}, not linked to any other leg` : `${phrase}, none linked to any other leg`;
  return `${phrase} — ${linked} still linked, ${legs - linked} not linked to any other leg`;
}

function keptClause({ kept }: UnimportCounts): string {
  if (kept === 0) return "";
  const [keeps, them] = kept === 1 ? ["keeps its", "it"] : ["keep their", "them"];
  return ` The ${countPhrase(kept, "row")} filed under it by hand ${keeps} money, category, transfer and recurring links and notes, and importing a statement for the same period files ${them} under it again.`;
}

export function unimportRadius({ subject, counts, balances, periods }: UnimportRadiusInput): BlastRadius {
  const optional = (show: boolean, line: BlastRadiusLine): BlastRadiusLine[] => (show ? [line] : []);
  return {
    headline: headline(subject, counts),
    lines: [
      { label: "Transactions deleted", value: countPhrase(counts.deleted, "transaction"), irreversible: counts.deleted > 0 },
      ...optional(counts.transferLegsDeleted > 0, {
        label: "Transfer legs deleted",
        value: `${countPhrase(counts.transferLegsDeleted, "leg")} — a partner left alone in its transfer is unlinked`,
      }),
      {
        label: "Categorized by you",
        value: countPhrase(counts.userCategorizedDeleted, "transaction"),
        irreversible: counts.userCategorizedDeleted > 0,
      },
      {
        label: "Money leaving the ledger",
        value: `${formatCents(counts.inflowCents)} in · ${formatCents(counts.outflowCents)} out`,
      },
      ...optional(counts.duplicateSurvivors > 0, {
        label: "…of which comes back",
        value: `${countPhrase(counts.duplicateSurvivors, "row")} whose retired duplicate is restored`,
      }),
      ...optional(counts.kept > 0, {
        label: "Transactions kept, detached from the file",
        value: `${countPhrase(counts.kept, "transaction")} filed under it by hand`,
      }),
      ...optional(counts.transferLegsKept > 0, {
        label: "Transfer legs kept",
        value: keptLegs(counts),
      }),
      { label: "Recorded balances removed", value: countPhrase(balances, "balance") },
      { label: "Statement periods removed", value: countPhrase(periods, "period") },
    ],
    reassurance: REASSURANCE + keptClause(counts),
  };
}

/** A file that deletes rows costs work to lose; one that deletes none does not earn a checkbox. */
export function unimportAcknowledgement(counts: UnimportCounts): string | undefined {
  return counts.deleted > 0 ? "I understand these transactions are deleted" : undefined;
}
