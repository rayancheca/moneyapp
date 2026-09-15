import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { cancelledTransferNote } from "@/lib/cancelled-transfer-note";
import { formatCents } from "@/lib/money";
import type { TransferFlowTotals } from "@/services/transfer-flow";

/**
 * /flow's "Not shown above" — every transfer group the diagram and the matrix
 * do not draw, named rather than swallowed. On the real database the detector
 * once left 134 groups unpaired — including every Chase Sapphire card payment —
 * and a view that quietly dropped 21% of the groups would be lying by omission.
 *
 * Two kinds, said apart:
 *
 *  - groups that could not be matched to a pair of accounts — a gap in
 *    PAIRING, counted by reason;
 *  - CANCELLED transfers — money that left an account and came back to it.
 *    Not a gap in pairing, so not in that paragraph, its count or its money.
 *    🔴 Measured 2026-09-15: filed there, Chase Checking's cancelled $115.00
 *    card payment raised the unmatched money over Mar–Aug $24.27 → $254.27
 *    (both legs) while the dashboard's card said it "moved nothing".
 *
 * Moved here from the page unchanged, so with nothing cancelled the markup is
 * the page's own, element for element.
 */
export function TransferReconciliation({ totals }: { totals: TransferFlowTotals }) {
  const cancelledNote = cancelledTransferNote(totals.cancelledGroupCount, totals.cancelledCents, formatCents, "shown above");
  if (totals.unattributedGroupCount === 0 && cancelledNote === null) return null;

  return (
    <SurfaceCard>
      <h2 className="text-sm font-medium text-ink-display">Not shown above</h2>
      {totals.unattributedGroupCount > 0 && (
        <>
          <p className="pt-1 text-sm text-ink-muted">
            {totals.unattributedGroupCount} of {totals.groupCount} transfer groups (
            {formatCents(totals.unattributedCents)}) could not be matched to a pair of
            accounts, so they are excluded from the diagram and the matrix. They are still
            categorised as transfers, so they are already kept out of spending and income —
            this is a gap in pairing, not in the money.
          </p>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 pt-2 text-xs text-ink-muted">
            {(
              [
                ["single-leg", "only one side was found"],
                ["multi-leg", "more than two legs"],
                ["same-account", "both legs in one account"],
              ] as const
            ).map(([key, why]) =>
              totals.unattributedByReason[key] > 0 ? (
                <div key={key} className="flex gap-1">
                  <dt className="figures font-medium">{totals.unattributedByReason[key]}</dt>
                  <dd>{why}</dd>
                </div>
              ) : null,
            )}
          </dl>
        </>
      )}
      {cancelledNote !== null && <p className="pt-2 text-sm text-ink-muted">{cancelledNote}</p>}
    </SurfaceCard>
  );
}
