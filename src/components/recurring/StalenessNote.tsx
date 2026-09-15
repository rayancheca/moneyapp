import { Badge } from "@/components/ui/Badge";
import type { SeriesStaleness } from "@/services/recurring";
import {
  staleFooterHint,
  staleFooterIsWarning,
  staleLabel,
  staleMarkTone,
  stalenessSentence,
  staleSummaryLabel,
  type StaleEntry,
} from "./labels";

/**
 * Staleness disclosure (item 13a). The forecast and the upcoming list keep
 * every detected|confirmed series — filtering the stale ones out would silently
 * delete the owner's weekly cash income the first time a deposit posted late.
 * So the number stays and the age of its evidence rides next to it: say what
 * you know and how old it is, the same contract the derivation layer honours
 * when it stamps a `gap` instead of inventing a slope.
 */

/**
 * Inline marker beside a projected amount. Renders nothing when fresh — an
 * always-on marker carries no signal. The label alone ("last seen 22d ago") is
 * the load-bearing text; the tooltip adds the why for pointer users, and the
 * footer below repeats it in keyboard-reachable form.
 */
export function StaleMark({
  staleness,
  className,
}: {
  staleness?: SeriesStaleness;
  className?: string;
}) {
  if (!staleness?.isStale) return null;
  return (
    <span title={stalenessSentence(staleness)}>
      {/* ⛔ Neutral for a series the bank has never billed — see `staleMarkTone` */}
      <Badge tone={staleMarkTone(staleness)} className={`whitespace-nowrap ${className ?? ""}`.trim()}>
        {staleLabel(staleness)}
      </Badge>
    </span>
  );
}

/**
 * Collapsed footer naming every stale series and why. Renders nothing when
 * nothing is stale — an always-present "0 stale" row would train the eye to
 * skip the one time it matters.
 */
export function StaleFooter({
  entries,
  window,
  className,
}: {
  entries: StaleEntry[];
  /** ⛔ REQUIRED. Two of these render on `/recurring` over different windows and
   *  disagreed about the same count — see `staleSummaryLabel`. */
  window: string;
  className?: string;
}) {
  if (entries.length === 0) return null;
  return (
    <details className={`group rounded-md border border-line bg-surface ${className ?? ""}`.trim()}>
      <summary
        className={`cursor-pointer select-none px-4 py-2.5 text-xs font-medium ${
          staleFooterIsWarning(entries) ? "text-warning" : "text-ink-muted"
        } transition-colors duration-(--duration-fast) hover:text-ink`}
      >
        {/* ⛔ The count and the WORD for it: a series that has never been billed
            is not late, and three of the four on the owner's ledger are not even
            due yet — and it says "billed", the badges' verb, not "charged".
            `staleSummaryLabel` owns the split — see its docstring. */}
        {staleSummaryLabel(entries, window)}
        {/* ⛔ …and the hint does not call "no evidence" old — `staleFooterHint` */}
        <span className="ml-2 font-normal text-ink-faint group-open:hidden">{staleFooterHint(entries)}</span>
      </summary>
      <ul className="divide-y divide-line border-t border-line">
        {entries.map((e) => (
          <li key={e.key} className="px-4 py-2.5 text-xs">
            <span className="font-medium">{e.name}</span>
            <span className="text-ink-muted"> — {stalenessSentence(e.staleness)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
