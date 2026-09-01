import Link from "next/link";
import type { CategoryPickerOption } from "@/components/transactions/CategoryPicker";
import { RecentTransactions } from "@/components/transactions/RecentTransactions";
import type { LedgerRow } from "@/components/transactions/TransactionsLedger";
import { Icon } from "@/components/shell/Icon";

/**
 * The To-Review teaser (ux-overhaul-plan §7.1): a count, the three newest rows
 * awaiting review (opening the same Sheet in place), and a "Review all" that
 * hands off to the clustered inbox. When the queue is empty it stays present and
 * calm — an "all clear" state, never a dead-end.
 */
export function ToReviewCard({
  count,
  href,
  rows,
  categories,
  uncategorizedCount,
  uncategorizedHref,
}: {
  count: number;
  href: string;
  rows: readonly LedgerRow[];
  categories: readonly CategoryPickerOption[];
  /** active rows with NO category — a different backlog from `count` */
  uncategorizedCount: number;
  uncategorizedHref: string;
}) {
  return (
    <section aria-labelledby="to-review-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="to-review-heading" className="flex items-baseline gap-2 text-sm font-medium">
          To review
          {count > 0 && (
            <span className="figures rounded-full bg-info/15 px-2 py-0.5 text-xs font-medium text-info">
              {count}
            </span>
          )}
        </h2>
        {count > 0 && (
          <Link
            href={href}
            className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
          >
            Review all →
          </Link>
        )}
      </div>

      {/* ⛔ THE COUNT AND THE CLAIM. `count` is the REVIEW FLAG; "every
          transaction is categorized" is a claim about CATEGORIES, and a flag
          count cannot know it. Measured on the real ledger at today =
          2026-09-01: 0 rows flagged and NINE active rows with no category —
          nine real purchases from early August, in the same Uncategorized
          bucket /spending prints one page over. The all-clear is now the state
          where BOTH backlogs are empty; an empty review queue with
          uncategorized rows left says so, and links to them. */}
      {count === 0 ? (
        <div className="flex items-center gap-2 rounded-(--radius-card) border border-line bg-surface-raised px-4 py-5 text-sm text-ink-muted">
          <Icon
            name="check"
            className={`size-4 ${uncategorizedCount === 0 ? "text-positive" : "text-ink-faint"}`}
          />
          {uncategorizedCount === 0 ? (
            "Nothing to review — every transaction is categorized and confirmed."
          ) : (
            <span>
              Nothing flagged for review —{" "}
              <Link href={uncategorizedHref} className="text-ink underline underline-offset-2">
                {uncategorizedCount} transaction{uncategorizedCount === 1 ? " has" : "s have"} no
                category
              </Link>{" "}
              yet.
            </span>
          )}
        </div>
      ) : (
        <RecentTransactions rows={rows} categories={categories} />
      )}
    </section>
  );
}
