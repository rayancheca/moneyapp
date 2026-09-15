import { describe, expect, test } from "vitest";
import { blastRadiusSentence, type BlastRadius } from "@/components/ui/blast-radius";
import type { UnimportCounts } from "@/services/import/unimport-counts";
import { unimportAcknowledgement, unimportRadius } from "./unimport-radius";

/**
 * ⛔ Not reachable from the e2e suite: the dialog lives inside a closed
 * `<dialog>` no spec opens, and the fixture holds no attached row. The counts
 * are the owner's own files, measured read-only on the real ledger on
 * 2026-09-15; that each one is exactly what `unimportFile` deletes or keeps is
 * pinned in services/import/import.test.ts, over rows the importer produced.
 */

/** Statement_082026_4208.pdf — nothing attached to it */
const VENTURE_X_AUG: UnimportCounts = {
  deleted: 50,
  kept: 0,
  userCategorizedDeleted: 8,
  inflowCents: 1_302_366,
  outflowCents: 237_120,
  duplicateSurvivors: 0,
  transferLegsDeleted: 3,
  transferLegsKept: 0,
};

/** 20260302-statements-9805-.pdf — 4 parsed rows, every one a surviving duplicate; 5 attached */
const SAPPHIRE_MAR: UnimportCounts = {
  deleted: 4,
  kept: 5,
  userCategorizedDeleted: 0,
  inflowCents: 79_848,
  outflowCents: 0,
  duplicateSurvivors: 4,
  transferLegsDeleted: 4,
  transferLegsKept: 5,
};

/** 20260702-statements-9805-.pdf — 2 parsed rows, neither a transfer leg; 4 attached */
const SAPPHIRE_JUL: UnimportCounts = {
  deleted: 2,
  kept: 4,
  userCategorizedDeleted: 0,
  inflowCents: 5_102,
  outflowCents: 0,
  duplicateSurvivors: 0,
  transferLegsDeleted: 0,
  transferLegsKept: 4,
};

const radius = (subject: string, counts: UnimportCounts, balances: number, periods: number): BlastRadius =>
  unimportRadius({ subject, counts, balances, periods });
const valueOf = (r: BlastRadius, label: string) => r.lines?.find((l) => l.label === label)?.value;
const labels = (r: BlastRadius) => (r.lines ?? []).map((l) => l.label);

const KEPT = "Transactions kept, detached from the file";

describe("unimportRadius — what un-importing a statement deletes, and what stays", () => {
  test("a file with nothing attached keeps its headline, and counts the transfer legs it deletes", () => {
    const r = radius("Statement_082026_4208.pdf", VENTURE_X_AUG, 1, 1);

    expect(r.headline).toBe(
      "Un-importing Statement_082026_4208.pdf deletes every row it brought in. There is no undo for this inside the app.",
    );
    expect(valueOf(r, "Transactions deleted")).toBe("50 transactions");
    expect(valueOf(r, "Transfer legs deleted")).toBe("3 legs — a partner left alone in its transfer is unlinked");
    expect(valueOf(r, "Categorized by you")).toBe("8 transactions");
    expect(valueOf(r, "Money leaving the ledger")).toBe("$13,023.66 in · $2,371.20 out");
    expect(labels(r)).not.toContain(KEPT);
    expect(labels(r)).not.toContain("Transfer legs kept");
    expect(r.reassurance).not.toContain("filed under it by hand");
    expect(unimportAcknowledgement(VENTURE_X_AUG)).toBe("I understand these transactions are deleted");
  });

  test("a statement with rows filed under it by hand counts both halves, and its money is the deleted rows' alone", () => {
    const r = radius("20260302-statements-9805-.pdf", SAPPHIRE_MAR, 2, 1);

    expect(r.headline).toBe(
      "Un-importing 20260302-statements-9805-.pdf deletes the 4 rows it brought in and keeps the 5 rows filed under it by hand, detached from the file. There is no undo for this inside the app.",
    );
    expect(r.lines).toEqual([
      { label: "Transactions deleted", value: "4 transactions", irreversible: true },
      { label: "Transfer legs deleted", value: "4 legs — a partner left alone in its transfer is unlinked" },
      { label: "Categorized by you", value: "no transactions", irreversible: false },
      { label: "Money leaving the ledger", value: "$798.48 in · $0.00 out" },
      { label: "…of which comes back", value: "4 rows whose retired duplicate is restored" },
      { label: KEPT, value: "5 transactions filed under it by hand" },
      { label: "Transfer legs kept", value: "5 legs, still linked" },
      { label: "Recorded balances removed", value: "2 balances" },
      { label: "Statement periods removed", value: "1 period" },
    ]);
    expect(r.reassurance).toContain(
      "The 5 rows filed under it by hand keep their money, category, transfer and recurring links and notes, and importing a statement for the same period files them under it again.",
    );
  });

  test("no transfer-leg line where no leg is counted", () => {
    const r = radius("20260702-statements-9805-.pdf", SAPPHIRE_JUL, 0, 1);

    expect(labels(r)).not.toContain("Transfer legs deleted");
    expect(valueOf(r, KEPT)).toBe("4 transactions filed under it by hand");
    expect(valueOf(r, "Transfer legs kept")).toBe("4 legs, still linked");
  });

  test("a file whose every row was filed by hand deletes nothing, and asks for no acknowledgement", () => {
    // 20260702's attached half on its own
    const onlyAttached: UnimportCounts = { ...SAPPHIRE_JUL, deleted: 0, inflowCents: 0, outflowCents: 0 };
    const r = radius("20260702-statements-9805-.pdf", onlyAttached, 0, 1);

    expect(r.headline).toBe(
      "Un-importing 20260702-statements-9805-.pdf deletes no transactions: the 4 rows under it were filed by hand, and they stay, detached from the file. There is no undo for this inside the app.",
    );
    expect(valueOf(r, "Transactions deleted")).toBe("no transactions");
    expect(unimportAcknowledgement(onlyAttached)).toBeUndefined();
  });

  test("one kept row reads in the singular", () => {
    const r = radius("x.pdf", { ...SAPPHIRE_JUL, kept: 1, transferLegsKept: 1 }, 0, 1);

    expect(r.headline).toContain("keeps the 1 row filed under it by hand");
    expect(r.reassurance).toContain("The 1 row filed under it by hand keeps its money");
  });

  test("the sentence a screen reader hears carries both halves", () => {
    const sentence = blastRadiusSentence(radius("20260302-statements-9805-.pdf", SAPPHIRE_MAR, 2, 1));

    expect(sentence).toContain("Transactions deleted: 4 transactions");
    expect(sentence).toContain(`${KEPT}: 5 transactions filed under it by hand`);
  });
});
