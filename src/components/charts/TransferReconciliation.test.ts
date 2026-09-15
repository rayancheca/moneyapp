import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { TransferFlowTotals } from "@/services/transfer-flow";
import { TransferReconciliation } from "./TransferReconciliation";

const NO_REASONS = { "single-leg": 0, "multi-leg": 0, "same-account": 0 } as const;

/** the owner's ledger over Mar–Aug 2026 after answer (1): 90 paired, 1 single-leg Sapphire payment */
const totals = (partial: Partial<TransferFlowTotals>): TransferFlowTotals => ({
  grossCents: 67_367_97,
  netCents: 50_905_03,
  churnCents: 16_462_94,
  pairedGroupCount: 90,
  groupCount: 91,
  unattributedGroupCount: 1,
  unattributedCents: 24_27,
  unattributedByReason: { ...NO_REASONS, "single-leg": 1 },
  cancelledGroupCount: 0,
  cancelledCents: 0,
  ...partial,
});

const html = (t: TransferFlowTotals) => renderToStaticMarkup(createElement(TransferReconciliation, { totals: t }));

describe("/flow's reconciliation card — every group the diagram does not draw is named", () => {
  test("a cancelled transfer is named cancelled, not listed as a pairing gap", () => {
    // …and after answer (2): Chase Checking's cancelled $115.00 card payment
    const out = html(totals({ groupCount: 92, cancelledGroupCount: 1, cancelledCents: 115_00 }));
    expect(out).toContain("1 of 92 transfer groups ($24.27) could not be matched to a pair of accounts");
    expect(out).toContain(
      "1 cancelled transfer — $115.00 — left an account and came back to it, so it moved nothing and is not shown above.",
    );
    expect(out).not.toMatch(/<dd>[^<]*cancelled/);
  });

  test("with nothing cancelled it reads exactly as before", () => {
    const out = html(totals({}));
    expect(out).toContain("Not shown above");
    expect(out).toContain("1 of 91 transfer groups ($24.27) could not be matched");
    expect(out).toContain("<dd>only one side was found</dd>");
    expect(out).not.toContain("cancelled");
  });

  test("a cancelled transfer alone still gets the card and its sentence — and no unmatched paragraph", () => {
    const out = html(
      totals({ unattributedGroupCount: 0, unattributedCents: 0, unattributedByReason: NO_REASONS, cancelledGroupCount: 1, cancelledCents: 115_00 }),
    );
    expect(out).toContain("Not shown above");
    expect(out).toContain("1 cancelled transfer — $115.00");
    expect(out).not.toContain("could not be matched");
  });

  test("nothing unmatched and nothing cancelled renders nothing", () => {
    expect(html(totals({ unattributedGroupCount: 0, unattributedCents: 0, unattributedByReason: NO_REASONS }))).toBe("");
  });
});
