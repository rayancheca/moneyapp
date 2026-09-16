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
 * kept", and the transfer legs on each side are counted: the five kept stay
 * linked, and a deleted leg's partner is unlinked only if nothing is left in
 * its transfer — all four of that file's deleted legs are surviving
 * duplicates, whose restored copies take their links (duplicate-lifecycle,
 * 2026-09-16), so their Chase Checking partners stay linked.
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
  /** statement periods the un-import removes — not the ones another download of the statement takes */
  periods: number;
  /** statement periods another download of the statement, still imported, takes (`unimportPeriodsByFile`) */
  periodsHandedOver?: number;
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
/*
 * 🔴 …and it named the hand-categorization and the hand recurring links as the only losses, and listed transfer
 * detection among what re-importing re-runs, as if the links came back that way. A round trip also deletes every note
 * on the rows it takes (20260812-statements-3522-.pdf: 9, on a copy of the real ledger, 2026-09-16), and detection never
 * paired the 7 transfers that file lost — the owner had linked them by hand because it could not. A transfer now comes
 * back through its own lines (`unimported-transfers`), and the sentence says exactly when.
 *
 * 🔴 …"its other leg is still in the ledger" did not hold when the other leg's statement was un-imported too, and the
 * "Transfer legs deleted" line promised the link back with no condition at all. Both now name the same condition, and
 * the other leg's own round trip no longer breaks it (20260812-statements-3522-.pdf with Statement_082026_4208.pdf, on a
 * copy of the real ledger, 2026-09-16: two-leg groups 757 -> 755 before, 757 -> 757 after).
 */
const REASSURANCE =
  "The statement file itself stays on disk. Re-importing brings the rows back and re-runs the rules, the merchant map and recurring-series linking over them — but a charge links again only where its series still recognises it: by another charge with the same description, or as a registered commitment's first charge on its date and amount. A transfer is linked again once the same line and its other leg are both in the ledger again — the other leg kept, or imported again from its own statement — unless that leg was deleted by hand or linked elsewhere in the meantime. What is lost is the hand-categorization, the notes, and the recurring links you attached or removed by hand.";

/**
 * 🔴 A statement downloaded twice keeps ONE period and one set of rows, filed under whichever download came first, and
 * un-importing that one said — and did — "deletes every row it brought in" while the other download still printed
 * them (20230810-statements-3522-.pdf, 2026-09-16). What another download prints goes to it (`statement-copies`), and
 * the headline says so first.
 */
function handOverHeadline(subject: string, { deleted, kept, handedOver, keptRefiled }: UnimportCounts): string {
  const takes = [
    ...(handedOver > 0 ? [`the ${countPhrase(handedOver, "row")} it also prints`] : []),
    ...(keptRefiled > 0 ? [`the ${countPhrase(keptRefiled, "row")} filed under this one by hand on its days`] : []),
  ].join(" and ");
  const detached = kept - keptRefiled;
  const rest =
    detached === 0
      ? ""
      : ` The ${countPhrase(detached, "other row")} filed under it by hand ${detached === 1 ? "stays" : "stay"}, detached from the file.`;
  const deletes = deleted === 0 ? "deletes no transactions" : `deletes the ${countPhrase(deleted, "row")} only it brought in`;
  return `Un-importing ${subject} ${deletes}: another download of the same statement is still imported, and it keeps ${takes}.${rest} ${NO_UNDO}`;
}

function headline(subject: string, counts: UnimportCounts): string {
  const { deleted, kept } = counts;
  if (counts.handedOver > 0 || counts.keptRefiled > 0) return handOverHeadline(subject, counts);
  // a second download of a statement owns no row: "every row it brought in" read as if it had some
  if (kept === 0 && deleted === 0) return `Un-importing ${subject} deletes no transactions. ${NO_UNDO}`;
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

function keptClause(counts: UnimportCounts): string {
  // the rows another download's period takes are filed under it now, not waiting for a statement to come back
  const kept = counts.kept - counts.keptRefiled;
  if (kept === 0) return "";
  const [keeps, them] = kept === 1 ? ["keeps its", "it"] : ["keep their", "them"];
  return ` The ${countPhrase(kept, "row")} filed under it by hand ${keeps} money, category, transfer and recurring links and notes, and importing a statement for the same period files ${them} under it again.`;
}

export function unimportRadius({ subject, counts, balances, periods, periodsHandedOver = 0 }: UnimportRadiusInput): BlastRadius {
  const optional = (show: boolean, line: BlastRadiusLine): BlastRadiusLine[] => (show ? [line] : []);
  const detached = counts.kept - counts.keptRefiled;
  const underCopy = [
    ...(counts.handedOver > 0 ? [`${countPhrase(counts.handedOver, "transaction")} it also prints`] : []),
    ...(counts.keptRefiled > 0 ? [`${countPhrase(counts.keptRefiled, "transaction")} filed by hand on its days`] : []),
  ];
  return {
    headline: headline(subject, counts),
    lines: [
      { label: "Transactions deleted", value: countPhrase(counts.deleted, "transaction"), irreversible: counts.deleted > 0 },
      ...optional(counts.transferLegsDeleted > 0, {
        label: "Transfer legs deleted",
        value: `${countPhrase(counts.transferLegsDeleted, "leg")} — a partner left alone in its transfer is unlinked, and linked again once the same line is imported again — unless by then the partner was deleted by hand or linked elsewhere`,
      }),
      {
        label: "Categorized by you",
        value: countPhrase(counts.userCategorizedDeleted, "transaction"),
        irreversible: counts.userCategorizedDeleted > 0,
      },
      ...optional(counts.notesDeleted > 0, {
        label: "Notes on deleted transactions",
        value: countPhrase(counts.notesDeleted, "note"),
        irreversible: true,
      }),
      {
        label: "Money leaving the ledger",
        value: `${formatCents(counts.inflowCents)} in · ${formatCents(counts.outflowCents)} out`,
      },
      ...optional(counts.duplicateSurvivors > 0, {
        label: "…of which comes back",
        value: `${countPhrase(counts.duplicateSurvivors, "row")} whose retired duplicate is restored`,
      }),
      ...optional(underCopy.length > 0, {
        label: "Transactions kept under another download of this statement",
        value: underCopy.join(" and "),
      }),
      ...optional(detached > 0, {
        label: "Transactions kept, detached from the file",
        value: `${countPhrase(detached, "transaction")} filed under it by hand`,
      }),
      ...optional(counts.transferLegsKept > 0, {
        label: "Transfer legs kept",
        value: keptLegs(counts),
      }),
      { label: "Recorded balances removed", value: countPhrase(balances, "balance") },
      { label: "Statement periods removed", value: countPhrase(periods, "period") },
      ...optional(periodsHandedOver > 0, {
        label: "Statement periods kept under another download",
        value: countPhrase(periodsHandedOver, "period"),
      }),
    ],
    reassurance: REASSURANCE + keptClause(counts),
  };
}

/** A file that deletes rows costs work to lose; one that deletes none does not earn a checkbox. */
export function unimportAcknowledgement(counts: UnimportCounts): string | undefined {
  return counts.deleted > 0 ? "I understand these transactions are deleted" : undefined;
}
