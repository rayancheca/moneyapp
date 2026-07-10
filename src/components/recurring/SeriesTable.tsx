import { confirmSeriesAction, dismissSeriesAction } from "@/app/recurring/actions";
import { Money } from "@/components/ui/Money";
import type { SeriesStatus } from "@/db/schema/recurring";
import type { SeriesView } from "@/services/recurring";
import { CADENCE_LABEL, KIND_LABEL, STATUS_LABEL, shortDate } from "./labels";

const STATUS_STYLE: Record<SeriesStatus, string> = {
  detected: "bg-accent-soft text-accent",
  confirmed: "bg-positive-soft text-positive",
  dismissed: "bg-surface-sunken text-ink-faint",
  ended: "bg-surface-sunken text-ink-faint",
};

interface SeriesTableProps {
  series: SeriesView[];
}

/** Detected/confirmed series with the stored statistics visible, not hidden. */
export function SeriesTable({ series }: SeriesTableProps) {
  return (
    <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface-raised">
      <table className="w-full text-sm">
        <caption className="sr-only">Recurring series with cadence, amounts, and status</caption>
        <thead>
          <tr className="border-b border-line text-left text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
            <th scope="col" className="px-4 py-2.5">Series</th>
            <th scope="col" className="px-3 py-2.5">Cadence</th>
            <th scope="col" className="px-3 py-2.5 text-right">Avg amount</th>
            <th scope="col" className="px-3 py-2.5">Next expected</th>
            <th scope="col" className="px-3 py-2.5 text-right">Confidence</th>
            <th scope="col" className="px-3 py-2.5">Status</th>
            <th scope="col" className="px-4 py-2.5 text-right">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => {
            const muted = s.status === "dismissed" || s.status === "ended";
            return (
              <tr
                key={s.id}
                className={`border-b border-line last:border-b-0 ${muted ? "opacity-55" : ""}`}
              >
                <th scope="row" className="px-4 py-3 text-left font-medium">
                  {s.name}
                  <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
                    {KIND_LABEL[s.kind]} · {s.matchedCount} matched
                  </span>
                </th>
                <td className="px-3 py-3 text-ink-muted">{CADENCE_LABEL[s.cadence]}</td>
                <td className="px-3 py-3 text-right">
                  {s.amountCentsAvg !== null ? (
                    <>
                      <Money cents={s.amountCentsAvg} flow />
                      {s.amountCentsStddev !== null && s.amountCentsStddev > 0 && (
                        <span className="figures block text-[10px] text-ink-faint">
                          ±{(s.amountCentsStddev / 100).toFixed(2)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  {s.nextExpectedOn ? (
                    <>
                      <span className="figures">{shortDate(s.nextExpectedOn)}</span>
                      {s.nextExpectedAmountCents !== null && (
                        <span className="ml-2 text-xs text-ink-muted">
                          <Money cents={s.nextExpectedAmountCents} />
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="figures px-3 py-3 text-right text-ink-muted">
                  {s.confidence !== null ? `${Math.round(s.confidence * 100)}%` : "—"}
                </td>
                <td className="px-3 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[s.status]}`}
                  >
                    {STATUS_LABEL[s.status]}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-1.5">
                    {s.status !== "confirmed" && (
                      <form action={confirmSeriesAction}>
                        <input type="hidden" name="seriesId" value={s.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-line px-2 py-1 text-xs font-medium text-accent transition-colors duration-(--duration-fast) hover:border-accent hover:bg-accent-soft"
                        >
                          Confirm
                        </button>
                      </form>
                    )}
                    {s.status !== "dismissed" && (
                      <form action={dismissSeriesAction}>
                        <input type="hidden" name="seriesId" value={s.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:border-line-strong hover:text-ink"
                        >
                          Dismiss
                        </button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
