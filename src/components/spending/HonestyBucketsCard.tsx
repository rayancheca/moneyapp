import Link from "next/link";
import { Icon } from "@/components/shell/Icon";
import { Money } from "@/components/ui/Money";
import type { HonestyBuckets } from "@/services/spending";

/**
 * The honesty buckets (ux-overhaul-plan §5.4): Uncategorized spending and
 * Excluded rows never vanish from the report — they stay explicit and clickable,
 * so the period's numbers always account for every dollar.
 */
export function HonestyBucketsCard({ data }: { data: HonestyBuckets }) {
  const { uncategorized, excluded } = data;
  if (uncategorized.txnCount === 0 && excluded.txnCount === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-muted">
        <Icon name="circle-check" className="size-4 text-positive" />
        Everything this period is categorized and accounted for.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {uncategorized.txnCount > 0 && (
        <li>
          <Link
            href={uncategorized.href}
            className="flex items-center gap-3 rounded-md px-1.5 py-2 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
          >
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-warning-soft text-warning">
              <Icon name="circle-alert" className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm">Uncategorized</span>
              <span className="block text-xs text-ink-faint">
                {uncategorized.txnCount} {uncategorized.txnCount === 1 ? "transaction" : "transactions"} — categorize to sharpen the report
              </span>
            </span>
            <Money cents={uncategorized.spentCents} className="shrink-0 text-sm font-medium" />
          </Link>
        </li>
      )}
      {excluded.txnCount > 0 && (
        <li>
          <Link
            href={excluded.href}
            className="flex items-center gap-3 rounded-md px-1.5 py-2 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
          >
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-sunken text-ink-faint">
              <Icon name="close" className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm">Excluded</span>
              <span className="block text-xs text-ink-faint">
                {excluded.txnCount} {excluded.txnCount === 1 ? "row" : "rows"} deliberately kept out of spending
              </span>
            </span>
            <Icon name="chevron-right" className="size-4 shrink-0 text-ink-faint" />
          </Link>
        </li>
      )}
    </ul>
  );
}
