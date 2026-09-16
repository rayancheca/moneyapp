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
  handedOver: 0,
  keptByPrinters: 0,
  kept: 0,
  keptRefiled: 0,
  userCategorizedDeleted: 8,
  notesDeleted: 0,
  inflowCents: 1_302_366,
  outflowCents: 237_120,
  duplicateSurvivors: 0,
  transferLegsDeleted: 3,
  transferLegsKept: 0,
  transferLegsKeptLinked: 0,
};

/**
 * 20260302-statements-9805-.pdf — 4 parsed rows, every one a surviving
 * duplicate; 5 attached, and one of those five (+$115.00, 2026-03-02) alone in
 * its transfer group — the file's counts as read on 2026-09-15, before
 * `link-sapphire-one-leg-groups-2026-09-15.ts` linked that leg
 */
const SAPPHIRE_MAR: UnimportCounts = {
  deleted: 4,
  handedOver: 0,
  keptByPrinters: 0,
  kept: 5,
  keptRefiled: 0,
  userCategorizedDeleted: 0,
  notesDeleted: 0,
  inflowCents: 79_848,
  outflowCents: 0,
  duplicateSurvivors: 4,
  transferLegsDeleted: 4,
  transferLegsKept: 5,
  transferLegsKeptLinked: 4,
};

/** 20260702-statements-9805-.pdf — 2 parsed rows, neither a transfer leg; 4 attached, all linked */
const SAPPHIRE_JUL: UnimportCounts = {
  deleted: 2,
  handedOver: 0,
  keptByPrinters: 0,
  kept: 4,
  keptRefiled: 0,
  userCategorizedDeleted: 0,
  notesDeleted: 0,
  inflowCents: 5_102,
  outflowCents: 0,
  duplicateSurvivors: 0,
  transferLegsDeleted: 0,
  transferLegsKept: 4,
  transferLegsKeptLinked: 4,
};

/**
 * 20250702-statements-9805-.pdf — 11 parsed rows; 2 attached, and the +$20.00
 * of 2025-06-10 alone in its transfer group — as read on 2026-09-15, before
 * `link-sapphire-one-leg-groups-2026-09-15.ts` linked it
 */
const SAPPHIRE_JUL_2025: UnimportCounts = {
  deleted: 11,
  handedOver: 0,
  keptByPrinters: 0,
  kept: 2,
  keptRefiled: 0,
  userCategorizedDeleted: 1,
  notesDeleted: 0,
  inflowCents: 336_699,
  outflowCents: 0,
  duplicateSurvivors: 8,
  transferLegsDeleted: 8,
  transferLegsKept: 2,
  transferLegsKeptLinked: 1,
};

const radius = (subject: string, counts: UnimportCounts, balances: number, periods: number): BlastRadius =>
  unimportRadius({ subject, counts, balances, periods });
const valueOf = (r: BlastRadius, label: string) => r.lines?.find((l) => l.label === label)?.value;
const labels = (r: BlastRadius) => (r.lines ?? []).map((l) => l.label);

const KEPT = "Transactions kept, detached from the file";
const PRINTED_ELSEWHERE = "Transactions kept under another file that prints them";

describe("unimportRadius — what un-importing a statement deletes, and what stays", () => {
  test("a file with nothing attached keeps its headline, and counts the transfer legs it deletes", () => {
    const r = radius("Statement_082026_4208.pdf", VENTURE_X_AUG, 1, 1);

    expect(r.headline).toBe(
      "Un-importing Statement_082026_4208.pdf deletes every row it brought in. There is no undo for this inside the app.",
    );
    expect(valueOf(r, "Transactions deleted")).toBe("50 transactions");
    expect(valueOf(r, "Transfer legs deleted")).toBe("3 legs — a partner left alone in its transfer is unlinked, and linked again once the same line is imported again — unless by then the partner was deleted by hand or linked elsewhere");
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
      { label: "Transfer legs deleted", value: "4 legs — a partner left alone in its transfer is unlinked, and linked again once the same line is imported again — unless by then the partner was deleted by hand or linked elsewhere" },
      { label: "Categorized by you", value: "no transactions", irreversible: false },
      { label: "Money leaving the ledger", value: "$798.48 in · $0.00 out" },
      { label: "…of which comes back", value: "4 rows whose retired duplicate is restored" },
      { label: KEPT, value: "5 transactions filed under it by hand" },
      { label: "Transfer legs kept", value: "5 legs — 4 still linked, 1 not linked to any other leg" },
      { label: "Recorded balances removed", value: "2 balances" },
      { label: "Statement periods removed", value: "1 period" },
    ]);
    expect(r.reassurance).toContain(
      "The 5 rows filed under it by hand keep their money, category, transfer and recurring links and notes, and importing a statement for the same period files them under it again.",
    );
  });

  test("no transfer-leg line where no leg is counted, and every kept leg linked reads as linked", () => {
    const r = radius("20260702-statements-9805-.pdf", SAPPHIRE_JUL, 0, 1);

    expect(labels(r)).not.toContain("Transfer legs deleted");
    expect(valueOf(r, KEPT)).toBe("4 transactions filed under it by hand");
    expect(valueOf(r, "Transfer legs kept")).toBe("4 legs, still linked");
  });

  test("a kept leg alone in its transfer is never called linked", () => {
    const r = radius("20250702-statements-9805-.pdf", SAPPHIRE_JUL_2025, 1, 1);

    expect(valueOf(r, "Transfer legs kept")).toBe("2 legs — 1 still linked, 1 not linked to any other leg");
    // …and when none of them is linked, the line says that, not a split of zero
    const alone = radius("x.pdf", { ...SAPPHIRE_JUL_2025, kept: 1, transferLegsKept: 1, transferLegsKeptLinked: 0 }, 1, 1);
    expect(valueOf(alone, "Transfer legs kept")).toBe("1 leg, not linked to any other leg");
    const twoAlone = radius("x.pdf", { ...SAPPHIRE_JUL_2025, transferLegsKeptLinked: 0 }, 1, 1);
    expect(valueOf(twoAlone, "Transfer legs kept")).toBe("2 legs, none linked to any other leg");
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
    const r = radius("x.pdf", { ...SAPPHIRE_JUL, kept: 1, transferLegsKept: 1, transferLegsKeptLinked: 1 }, 0, 1);

    expect(r.headline).toContain("keeps the 1 row filed under it by hand");
    expect(r.reassurance).toContain("The 1 row filed under it by hand keeps its money");
    expect(valueOf(r, "Transfer legs kept")).toBe("1 leg, still linked");
  });

  /**
   * 20230810-statements-3522-.pdf, the download holding the statement (read-only on a copy of the real ledger,
   * 2026-09-16): 85 rows and one period, which two other downloads, still imported, print too.
   */
  test("a statement another download still prints deletes nothing it prints, and says where its rows and period go", () => {
    const firstDownload: UnimportCounts = { ...VENTURE_X_AUG, deleted: 0, handedOver: 85, userCategorizedDeleted: 0, inflowCents: 0, outflowCents: 0, transferLegsDeleted: 0 };
    const r = unimportRadius({ subject: "20230810-statements-3522-.pdf", counts: firstDownload, balances: 0, periods: 0, periodsHandedOver: 1 });

    expect(r.headline).toBe(
      "Un-importing 20230810-statements-3522-.pdf deletes no transactions: another download of the same statement is still imported, and it keeps the 85 rows it also prints. There is no undo for this inside the app.",
    );
    expect(valueOf(r, "Transactions deleted")).toBe("no transactions");
    expect(valueOf(r, "Transactions kept under another download of this statement")).toBe("85 transactions it also prints");
    expect(valueOf(r, "Statement periods removed")).toBe("no periods");
    expect(valueOf(r, "Statement periods kept under another download")).toBe("1 period");
    expect(labels(r)).not.toContain(KEPT);
    expect(unimportAcknowledgement(firstDownload)).toBeUndefined();

    // …a row filed by hand on its days goes with the period; one on another day stays detached, and only that one is
    // promised a statement to file it under again
    const mixed = unimportRadius({
      subject: "x.pdf",
      counts: { ...firstDownload, deleted: 2, handedOver: 3, kept: 3, keptRefiled: 2 },
      balances: 0,
      periods: 0,
      periodsHandedOver: 1,
    });
    expect(mixed.headline).toBe(
      "Un-importing x.pdf deletes the 2 rows only it brought in: another download of the same statement is still imported, and it keeps the 3 rows it also prints and the 2 rows filed under this one by hand on its days. The 1 other row filed under it by hand stays, detached from the file. There is no undo for this inside the app.",
    );
    expect(valueOf(mixed, "Transactions kept under another download of this statement")).toBe(
      "3 transactions it also prints and 2 transactions filed by hand on its days",
    );
    expect(valueOf(mixed, KEPT)).toBe("1 transaction filed under it by hand");
    expect(mixed.reassurance).toContain("The 1 row filed under it by hand keeps its money");
  });

  /**
   * 🔴 The reassurance named the hand-categorization and the hand recurring links as the only losses, and said
   * re-importing "re-runs … transfer detection" as if the links came back. A round trip also loses every note on the
   * rows it deletes (20260812-statements-3522-.pdf: 9, on a copy of the real ledger, 2026-09-16), and a transfer comes
   * back only through its own lines and its other leg — not through detection.
   */
  test("the notes a deletion takes are counted, and a transfer is promised back only with its lines and its partner", () => {
    const withNotes: UnimportCounts = { ...VENTURE_X_AUG, notesDeleted: 9 };
    const r = radius("20260812-statements-3522-.pdf", withNotes, 2, 1);

    expect(r.lines).toContainEqual({ label: "Notes on deleted transactions", value: "9 notes", irreversible: true });
    expect(valueOf(r, "Transfer legs deleted")).toBe(
      "3 legs — a partner left alone in its transfer is unlinked, and linked again once the same line is imported again — unless by then the partner was deleted by hand or linked elsewhere",
    );
    expect(r.reassurance).toContain("What is lost is the hand-categorization, the notes, and the recurring links you attached or removed by hand.");
    expect(r.reassurance).toContain(
      "A transfer is linked again once the same line and its other leg are both in the ledger again — the other leg kept, or imported again from its own statement — unless that leg was deleted by hand or linked elsewhere in the meantime.",
    );
    expect(r.reassurance).not.toContain("transfer detection");
    // no line where no note goes
    expect(labels(radius("x.pdf", VENTURE_X_AUG, 0, 1))).not.toContain("Notes on deleted transactions");
  });

  /**
   * 🔴 An export whose rows record the lines of statements imported after it said it "deletes every row it brought in",
   * and did: un-importing Spending Report PDF (1).pdf put 8 reconciled Chase Sapphire periods into gap (a copy of the
   * real ledger, 2026-09-16). Those rows now stay under the statement that prints them, and the dialog says so.
   */
  test("rows another imported file prints are counted as kept under it, and the headline says so first", () => {
    // Spending Report PDF (1).pdf, on a copy of the real ledger with the backfills applied, 2026-09-16
    const report: UnimportCounts = { ...VENTURE_X_AUG, deleted: 0, keptByPrinters: 356, userCategorizedDeleted: 0, inflowCents: 0, outflowCents: 0, transferLegsDeleted: 0 };
    const r = radius("Spending Report PDF (1).pdf", report, 0, 1);
    expect(r.headline).toBe(
      "Un-importing Spending Report PDF (1).pdf deletes no transactions: the 356 rows it brought in are printed by other imported files too, and stay, filed under them. There is no undo for this inside the app.",
    );
    expect(r.lines).toContainEqual({ label: PRINTED_ELSEWHERE, value: "356 transactions" });
    expect(unimportAcknowledgement(report)).toBeUndefined();

    // Discover-AllAvailable-20260710.csv, the same copy: some rows go, some stay
    const discover: UnimportCounts = { ...VENTURE_X_AUG, deleted: 188, keptByPrinters: 437 };
    expect(radius("Discover-AllAvailable-20260710.csv", discover, 0, 0).headline).toBe(
      "Un-importing Discover-AllAvailable-20260710.csv deletes the 188 rows only it prints: the 437 other rows it brought in are printed by other imported files too, and stay, filed under them. There is no undo for this inside the app.",
    );
    // …and with rows filed by hand, and a download of the same statement, each clause keeps its place
    const mixed: UnimportCounts = { ...SAPPHIRE_MAR, handedOver: 3, keptByPrinters: 1 };
    expect(radius("x.pdf", mixed, 0, 1).headline).toBe(
      "Un-importing x.pdf deletes the 4 rows only it brought in: another download of the same statement is still imported, and it keeps the 3 rows it also prints. The 5 other rows filed under it by hand stay, detached from the file. The 1 other row it brought in is printed by another imported file too, and stays, filed under it. There is no undo for this inside the app.",
    );
    expect(labels(radius("x.pdf", SAPPHIRE_MAR, 0, 1))).not.toContain(PRINTED_ELSEWHERE);
  });

  test("a download that owns no row says it deletes none", () => {
    // 20230810-statements-3522-.pdf's third download, on a copy of the real ledger, 2026-09-16
    const nothing: UnimportCounts = { ...VENTURE_X_AUG, deleted: 0, userCategorizedDeleted: 0, inflowCents: 0, outflowCents: 0, transferLegsDeleted: 0 };
    expect(radius("20230810-statements-3522-.pdf", nothing, 0, 0).headline).toBe(
      "Un-importing 20230810-statements-3522-.pdf deletes no transactions. There is no undo for this inside the app.",
    );
  });

  test("the sentence a screen reader hears carries both halves", () => {
    const sentence = blastRadiusSentence(radius("20260302-statements-9805-.pdf", SAPPHIRE_MAR, 2, 1));

    expect(sentence).toContain("Transactions deleted: 4 transactions");
    expect(sentence).toContain(`${KEPT}: 5 transactions filed under it by hand`);
    expect(sentence).toContain("Transfer legs kept: 5 legs — 4 still linked, 1 not linked to any other leg");
  });
});
