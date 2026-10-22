import type { EmptyFigure } from "@/lib/empty-period";
import { Money } from "@/components/ui/Money";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import type { Provenance } from "@/services/provenance";

interface CategoryHeadlineProps {
  /** the kind's word (`categoryFlowLabel`): "Spent", "Received", "Net" */
  flowLabel: string;
  /** the period's own name — "October 2026" */
  periodLabel: string;
  /** the window's total, already in the headline's frame (`categoryFlowSign`) */
  flowCents: number;
  txnCount: number;
  /**
   * the page's empty window (`categoryEmptyCopy`) — its heading and the world it is written in, and, where the import
   * stops inside it, what its $0.00 is (`zeroIs`) — or null when the window holds rows
   */
  empty:
    | { title: string; figure: Exclude<EmptyFigure, "lower-bound"> }
    | { title: string; figure: "lower-bound"; zeroIs: string }
    | null;
  /** what backs the total — "the proof of the rows underneath it" */
  provenance: Provenance | null;
}

/**
 * `/categories/<id>`'s headline: the window's total, in the world its own empty state is written in.
 *
 * ⛔ An em dash, not a $0.00, where not one elapsed day of the window was read (`emptyFigure`) — the dashboard's pace
 * tile's rule, and the trend's on this same page, which draws no bar for that month. 🔴 On his ledger copy 2026-10-12
 * `/categories/<Housing>?period=2026-10` headlined "SPENT · OCTOBER 2026  $0.00  0 transactions" directly above its own
 * "October 2026 has not been imported yet … spending in Housing is imported through Wed, Aug 12, 2026".
 *
 * ⚖️ DEFAULT, BUILT, NOT ASKED (2026-10-12; never his decision) …and a month that has not begun is dashed too, under
 * "November 2026 has not happened yet": it holds nothing YET,
 * and its words say so — never "not imported" (`emptyFigure`; review of b2c9db7, 2026-10-12).
 *
 * The quiet line under the dash is the empty state's own heading, so the headline and the cards below it say one
 * thing in one set of words. ⛔ No proof is offered beside a dash: the popover proves a rendered figure, and its
 * empty-total panel says "this zero" of a zero the dash refuses to print.
 *
 * A window imported only in part keeps its $0.00 and is called what the cards below call it (`zeroIs`): a lower bound,
 * or — a Net's, a sum of both signs — neither a measurement nor a bound (decision 72's `partReadTotal`). 🔴 Review of
 * b356d57, his ledger copy 2026-10-21: `/categories/<Buys>?period=2026-09` headlined "$0.00 0 transactions — a lower
 * bound rather than a measurement" over a Net the days still to import push below $0.00. A measured zero, and every
 * window holding rows, print their figure as they always have.
 */
export function CategoryHeadline({
  flowLabel,
  periodLabel,
  flowCents,
  txnCount,
  empty,
  provenance,
}: CategoryHeadlineProps) {
  const dash = empty?.figure === "dash";
  return (
    <div className="text-right">
      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        {flowLabel} · {periodLabel}
        {/* the total's proof is the proof of the rows underneath it, and its
            weakest row sets the verdict */}
        {!dash && provenance && (
          <ProvenancePopover
            label={`this ${flowLabel.toLowerCase()} total`}
            provenance={provenance}
            placement="bottom-end"
          />
        )}
      </div>
      {dash ? (
        <>
          <div className="figures text-2xl font-semibold text-ink-faint">—</div>
          <div className="text-xs text-ink-muted">{empty.title}</div>
        </>
      ) : (
        <>
          <Money cents={flowCents} className="figures text-2xl font-semibold" />
          <div className="text-xs text-ink-faint">
            {txnCount} {txnCount === 1 ? "transaction" : "transactions"}
            {empty?.figure === "lower-bound" && ` — ${empty.zeroIs}`}
          </div>
          {/* ⚖️ decision 72: the days the chip calls partly read, as its /budgets row prints them — words and tone */}
          {provenance?.partlyRead && <div className="text-xs text-ink-faint">{provenance.partlyRead.line}</div>}
        </>
      )}
    </div>
  );
}
