import Link from "next/link";
import { filtersToQuery, TXN_VIEWS, type TxnFilters, type TxnView } from "./query";

const VIEW_LABELS: Record<TxnView, string> = {
  all: "All",
  review: "Review",
  quarantined: "Quarantined",
  excluded: "Excluded",
};

interface ViewTabsProps {
  filters: TxnFilters;
  counts: Record<TxnView, number>;
}

/** Tab links — the view lives in the URL, current filters are preserved. */
export function ViewTabs({ filters, counts }: ViewTabsProps) {
  return (
    <nav aria-label="Transaction views" className="flex gap-1 border-b border-line">
      {TXN_VIEWS.map((view) => {
        const isActive = filters.view === view;
        return (
          <Link
            key={view}
            href={`/transactions${filtersToQuery(filters, { view, page: 1 })}`}
            aria-current={isActive ? "page" : undefined}
            className={`-mb-px inline-flex items-baseline gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors duration-(--duration-fast) ${
              isActive
                ? "border-accent font-medium text-ink"
                : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink"
            }`}
          >
            {VIEW_LABELS[view]}
            <span className="figures text-[11px] text-ink-faint">{counts[view]}</span>
          </Link>
        );
      })}
    </nav>
  );
}
