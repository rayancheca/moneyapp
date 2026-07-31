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

/**
 * Tab links — the view lives in the URL, current filters are preserved.
 *
 * The four tabs measure ~391px together, so below ~440px they used to run off the
 * page and take the whole document with them (87px past a 320px viewport). They
 * scroll instead of wrapping because wrapping would strand the active tab's accent
 * underline in the middle of the nav, disconnected from the bottom rule that the
 * links' `-mb-px` deliberately sits on.
 *
 * The scroller is the WRAPPER, not the nav, for two reasons:
 *  - `overflow-x: auto` forces the other axis from `visible` to `auto`, and the
 *    links' `-mb-px` puts their border box 1px below the nav's content box — enough
 *    to trip a vertical scrollbar. With the nav inside, that 1px lands on the nav's
 *    own bottom border instead, inside its border box, so nothing overflows.
 *  - `w-max min-w-full` lets the nav grow to its content so `border-b` spans the
 *    full scrollable width; a plain block nav would stop its rule at the viewport
 *    edge while the tabs scrolled past it.
 */
export function ViewTabs({ filters, counts }: ViewTabsProps) {
  return (
    <div className="overflow-x-auto">
      <nav
        aria-label="Transaction views"
        className="flex w-max min-w-full gap-1 border-b border-line"
      >
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
    </div>
  );
}
