import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { TransferEdge, TransferFlowData, TransferFlowTotals } from "@/services/transfer-flow";
import { TransferMatrix } from "./TransferMatrix";

const EDGE: TransferEdge = {
  id: "a>b",
  fromAccountId: "a",
  toAccountId: "b",
  cents: 100_00,
  count: 1,
  grossCents: 100_00,
  returnedCents: 0,
  monthCents: [100_00],
  monthCounts: [1],
};

function data(totals: Partial<TransferFlowTotals>): TransferFlowData {
  return {
    accounts: [
      { id: "a", label: "Alpha", color: "var(--cat-blue)", netCents: -100_00, inCents: 0, outCents: 100_00, href: "/transactions?account=a" },
      { id: "b", label: "Bravo", color: "var(--cat-red)", netCents: 100_00, inCents: 100_00, outCents: 0, href: "/transactions?account=b" },
    ],
    edges: [EDGE],
    netEdges: [EDGE],
    months: ["2026-03"],
    totals: {
      grossCents: 100_00,
      netCents: 100_00,
      churnCents: 0,
      pairedGroupCount: 1,
      groupCount: 2,
      unattributedGroupCount: 1,
      unattributedCents: 24_27,
      unattributedByReason: { "single-leg": 1, "multi-leg": 0, "same-account": 0 },
      cancelledGroupCount: 0,
      cancelledCents: 0,
      ...totals,
    },
  };
}

const html = (d: TransferFlowData) => renderToStaticMarkup(createElement(TransferMatrix, { data: d, measure: "gross" }));

describe("the matrix footer names what the matrix leaves out", () => {
  test("a cancelled transfer is said to be cancelled, not folded into the groups that could not be matched", () => {
    const out = html(data({ groupCount: 3, cancelledGroupCount: 1, cancelledCents: 115_00 }));
    expect(out).toContain("A further 1 transfer groups ($24.27) could not be matched to a pair of accounts");
    expect(out).toContain(
      "1 cancelled transfer — $115.00 — left an account and came back to it, so it moved nothing and is not in this matrix.",
    );
  });

  test("with nothing cancelled the footer reads exactly as before", () => {
    const out = html(data({}));
    expect(out).toContain("A further 1 transfer groups ($24.27) could not be matched to a pair of accounts and are excluded from this matrix.");
    expect(out).not.toContain("cancelled");
  });

  test("a cancelled transfer alone is still named, with no unmatched clause", () => {
    const out = html(
      data({
        unattributedGroupCount: 0,
        unattributedCents: 0,
        unattributedByReason: { "single-leg": 0, "multi-leg": 0, "same-account": 0 },
        cancelledGroupCount: 1,
        cancelledCents: 115_00,
      }),
    );
    expect(out).toContain("1 cancelled transfer — $115.00");
    expect(out).not.toContain("could not be matched");
  });
});
