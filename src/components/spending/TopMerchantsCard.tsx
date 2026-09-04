import Link from "next/link";
import { Icon } from "@/components/shell/Icon";
import { Money } from "@/components/ui/Money";
import type { TopMerchants } from "@/services/spending";

/**
 * Top merchants (ux-overhaul-plan §5.4). Groups by linked merchant AND by
 * stripped-key for the still-unlinked rows (rendered distinctly, no icon), with
 * the linkage coverage stated honestly until the backfill pushes it high. Each
 * row drills to its filtered ledger.
 *
 * A linked merchant also carries a SECOND, sibling link to its own page — the
 * only route to `/merchants/[id]` used to be a transaction row's sheet, which
 * pass 65 named as the reason the richest page in the app went unvisited. It is
 * a sibling and not a wrapper because the row is already a link, and a link
 * inside a link is invalid HTML and an axe `nested-interactive` violation.
 */
export function TopMerchantsCard({ data, emptyText }: { data: TopMerchants; emptyText?: string }) {
  if (data.entries.length === 0) {
    /* ⚠️ "No merchant spending in this period" is a claim of ABSENCE, and over
       a window nobody has imported it is really a claim about coverage — the
       error `lib/empty-period` exists to stop. The caller that knows which
       world the window is in passes the sentence. */
    return <p className="text-sm text-ink-muted">{emptyText ?? "No merchant spending in this period."}</p>;
  }
  return (
    <div>
      <ul className="space-y-0.5">
        {data.entries.map((entry) => (
          <li key={`${entry.kind}:${entry.id ?? entry.name}`} className="flex items-center gap-1">
            <Link
              href={entry.href}
              className="group flex min-w-0 flex-1 items-center gap-3 rounded-md px-1.5 py-2 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
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
            {entry.profileHref && (
              <Link
                href={entry.profileHref}
                aria-label={`${entry.name} merchant page`}
                className="shrink-0 rounded-md p-1.5 text-ink-faint transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink"
              >
                <Icon name="chevron-right" className="size-4" />
              </Link>
            )}
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
