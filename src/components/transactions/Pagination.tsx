import Link from "next/link";
import { filtersToQuery, type TxnFilters } from "./query";

interface PaginationProps {
  filters: TxnFilters;
  totalRows: number;
  pageSize: number;
}

const LINK =
  "rounded-md border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium transition-colors duration-(--duration-fast) hover:border-line-strong";
const DISABLED = "rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink-faint opacity-60";

/** Prev/next paging — the page number lives in the URL like every filter. */
export function Pagination({ filters, totalRows, pageSize }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  if (totalPages <= 1) return null;

  const page = filters.page;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
      <p className="text-xs text-ink-muted">
        Page <span className="figures">{page}</span> of <span className="figures">{totalPages}</span>
        {" · "}
        <span className="figures">{totalRows}</span> transactions
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={`/transactions${filtersToQuery(filters, { page: page - 1 })}`} className={LINK}>
            Previous
          </Link>
        ) : (
          <span aria-disabled="true" className={DISABLED}>
            Previous
          </span>
        )}
        {page < totalPages ? (
          <Link href={`/transactions${filtersToQuery(filters, { page: page + 1 })}`} className={LINK}>
            Next
          </Link>
        ) : (
          <span aria-disabled="true" className={DISABLED}>
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
