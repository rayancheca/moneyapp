import { formatCents } from "@/lib/money";
import type { TransferFlowData } from "@/services/transfer-flow";

/**
 * The table lens — a real directed flow MATRIX, not a flat list of edges.
 *
 * Rows send, columns receive. A matrix is the natural shape of directed flow, so
 * this is genuinely a better table than a list would be: the bidirectional pairs
 * that drive all the churn are visible as two filled cells mirrored across the
 * diagonal, which a list scatters.
 *
 * The footer carries the conservation proof — Out total must equal In total, and
 * the Net column must sum to exactly zero. That is not decoration: it is the
 * same reconciliation discipline the rest of the app holds itself to, made
 * visible to the reader rather than asserted only in a test.
 *
 * No "use client": this renders on the server with the rest of the page, so the
 * numbers are on screen before any JavaScript arrives.
 */

export interface TransferMatrixProps {
  data: TransferFlowData;
  measure: "gross" | "net";
  caption?: string;
}

export function TransferMatrix({ data, measure, caption }: TransferMatrixProps) {
  const edges = measure === "net" ? data.netEdges : data.edges;
  const accounts = data.accounts;

  if (accounts.length === 0) {
    return <p className="text-sm text-ink-muted">No transfers between your accounts in this period.</p>;
  }

  const cell = new Map<string, { cents: number; count: number }>();
  for (const e of edges) {
    cell.set(`${e.fromAccountId}>${e.toAccountId}`, { cents: e.cents, count: e.count });
  }

  const outOf = (id: string) => edges.filter((e) => e.fromAccountId === id).reduce((s, e) => s + e.cents, 0);
  const inTo = (id: string) => edges.filter((e) => e.toAccountId === id).reduce((s, e) => s + e.cents, 0);

  const totalOut = accounts.reduce((s, a) => s + outOf(a.id), 0);
  const totalIn = accounts.reduce((s, a) => s + inTo(a.id), 0);
  const totalNet = accounts.reduce((s, a) => s + (inTo(a.id) - outOf(a.id)), 0);

  const defaultCaption =
    measure === "net"
      ? `Net transfers between accounts. Rows send, columns receive; only the winning direction of each pair is shown. ${formatCents(data.totals.netCents)} net of ${formatCents(data.totals.grossCents)} gross.`
      : `All transfers between accounts. Rows send, columns receive. ${formatCents(data.totals.grossCents)} across ${data.totals.pairedGroupCount} transfers.`;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="pb-3 text-left text-sm text-ink-muted">{caption ?? defaultCaption}</caption>
        <thead>
          <tr>
            <th scope="col" className="border-b border-line px-3 py-2 text-left text-xs font-medium text-ink-muted">
              From ↓ / To →
            </th>
            {accounts.map((a) => (
              <th
                key={a.id}
                scope="col"
                className="border-b border-line px-3 py-2 text-right text-xs font-medium text-ink-muted"
              >
                {a.label}
              </th>
            ))}
            <th scope="col" className="border-b border-line px-3 py-2 text-right text-xs font-medium text-ink-display">
              Out
            </th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((from) => (
            <tr key={from.id}>
              <th scope="row" className="border-b border-line px-3 py-2 text-left text-xs font-medium">
                {from.label}
              </th>
              {accounts.map((to) => {
                const v = cell.get(`${from.id}>${to.id}`);
                return (
                  <td
                    key={to.id}
                    className={`figures border-b border-line px-3 py-2 text-right ${
                      v ? "text-ink" : "text-ink-muted/40"
                    }`}
                  >
                    {v ? (
                      <>
                        {formatCents(v.cents)}
                        <span className="ml-1 text-[10px] text-ink-muted">×{v.count}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                );
              })}
              <td className="figures border-b border-line px-3 py-2 text-right font-medium">
                {formatCents(outOf(from.id))}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="px-3 py-2 text-left text-xs font-medium text-ink-display">
              In
            </th>
            {accounts.map((a) => (
              <td key={a.id} className="figures px-3 py-2 text-right font-medium">
                {formatCents(inTo(a.id))}
              </td>
            ))}
            <td className="figures px-3 py-2 text-right font-medium">{formatCents(totalIn)}</td>
          </tr>
          <tr>
            <th scope="row" className="px-3 py-2 text-left text-xs font-medium text-ink-display">
              Net
            </th>
            {accounts.map((a) => {
              const net = inTo(a.id) - outOf(a.id);
              return (
                <td
                  key={a.id}
                  className={`figures px-3 py-2 text-right ${net < 0 ? "text-negative" : net > 0 ? "text-positive" : "text-ink-muted"}`}
                >
                  {formatCents(net)}
                </td>
              );
            })}
            <td className="figures px-3 py-2 text-right font-medium">{formatCents(totalNet)}</td>
          </tr>
        </tfoot>
      </table>

      <p className="px-3 pt-2 text-xs text-ink-muted">
        Out {formatCents(totalOut)} = In {formatCents(totalIn)}; net across all accounts{" "}
        {formatCents(totalNet)}.
        {data.totals.unattributedGroupCount > 0 && (
          <>
            {" "}
            A further {data.totals.unattributedGroupCount} transfer groups (
            {formatCents(data.totals.unattributedCents)}) could not be matched to a pair of accounts
            and are excluded from this matrix.
          </>
        )}
      </p>
    </div>
  );
}
