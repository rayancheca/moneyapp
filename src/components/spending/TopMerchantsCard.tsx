import Link from "next/link";
import { Icon } from "@/components/shell/Icon";
import { Money } from "@/components/ui/Money";
import type { TopMerchants } from "@/services/spending";

/**
 * Top merchants (ux-overhaul-plan §5.4). Groups by linked merchant AND by
 * stripped-key for the still-unlinked rows (rendered distinctly, no icon), with
 * the linkage coverage stated honestly until the backfill pushes it high. Each
 * row drills to its filtered ledger.
 */
export function TopMerchantsCard({ data }: { data: TopMerchants }) {
  if (data.entries.length === 0) {
    return <p className="text-sm text-ink-muted">No merchant spending in this period.</p>;
  }
  return (
    <div>
      <ul className="space-y-0.5">
        {data.entries.map((entry) => (
          <li key={`${entry.kind}:${entry.id ?? entry.name}`}>
            <Link
              href={entry.href}
              className="group flex items-center gap-3 rounded-md px-1.5 py-2 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
            >
              <span
                className={`grid size-8 shrink-0 place-items-center rounded-full ${
                  entry.kind === "merchant" ? "bg-accent-soft text-accent" : "bg-surface-sunken text-ink-faint"
                }`}
                aria-hidden
              >
                <Icon name={entry.kind === "merchant" ? "shopping-bag" : "tag"} className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{entry.name}</span>
                <span className="block text-xs text-ink-faint">
                  {entry.txnCount} {entry.txnCount === 1 ? "transaction" : "transactions"}
                  {entry.kind === "unlinked" && " · unlinked"}
                </span>
              </span>
              <Money cents={entry.spentCents} className="shrink-0 text-sm font-medium" />
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-line pt-2 text-xs text-ink-faint">
        {data.coveragePct}% of spending rows are linked to a merchant
        {data.unlinkedCount > 0 && ` · ${data.unlinkedCount} still grouped by name`}
      </p>
    </div>
  );
}
