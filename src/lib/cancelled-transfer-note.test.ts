import { describe, expect, test } from "vitest";

import { formatCents } from "./money";
import { cancelledTransferNote } from "./cancelled-transfer-note";

/**
 * One sentence, four surfaces: the dashboard's transfers card, /flow's
 * reconciliation card, the matrix footer and the spine's screen-reader summary.
 * Each says where the cancelled money is NOT; the rest of the sentence is one
 * definition, so no two of them can describe the same cancellation differently.
 */
describe("cancelledTransferNote — a transfer that left an account and came back to it", () => {
  test("says nothing when nothing was cancelled", () => {
    expect(cancelledTransferNote(0, 0, formatCents, "counted above")).toBeNull();
  });

  test("one cancelled transfer names its money once, and where it is not", () => {
    expect(cancelledTransferNote(1, 115_00, formatCents, "in this matrix")).toBe(
      "1 cancelled transfer — $115.00 — left an account and came back to it, so it moved nothing and is not in this matrix.",
    );
  });

  test("several are counted as transfers, by the money that went out and came back", () => {
    expect(cancelledTransferNote(2, 155_00, formatCents, "counted above")).toBe(
      "2 cancelled transfers — $155.00 — each left an account and came back to it, so they moved nothing and are not counted above.",
    );
  });
});
