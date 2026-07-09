import { Money } from "@/components/ui/Money";
import { CategoryCell, CategoryOptionsProvider, type CategoryOption } from "./CategoryCell";

export interface TxnRowView {
  id: string;
  postedOn: string;
  rawDescription: string;
  normalizedDescription: string;
  accountName: string;
  amountCents: number;
  categoryId: string | null;
  categoryLabel: string | null;
  hasMerchant: boolean;
  isTransfer: boolean;
  isRecurring: boolean;
  lowConfidence: boolean;
}

interface TransactionsTableProps {
  rows: readonly TxnRowView[];
  categoryOptions: readonly CategoryOption[];
  /** current filter query string — category corrections return here */
  returnQuery: string;
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">
      {children}
    </span>
  );
}

/** Semantic, data-dense ledger table. Raw description shown; normalized on hover. */
export function TransactionsTable({ rows, categoryOptions, returnQuery }: TransactionsTableProps) {
  return (
    <CategoryOptionsProvider options={categoryOptions}>
      <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface-raised shadow-[0_1px_2px_oklch(0%_0_0/0.04)]">
        <table className="w-full text-sm">
          <caption className="sr-only">Transactions matching the current filters</caption>
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              <th scope="col" className="px-4 py-2.5 font-medium">
                Posted
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Description
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Account
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Category
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-line transition-colors duration-(--duration-fast) last:border-b-0 hover:bg-surface-sunken"
              >
                <td className="figures whitespace-nowrap px-4 py-2.5 align-top text-xs text-ink-muted">
                  {r.postedOn}
                </td>
                <td className="max-w-96 px-4 py-2.5 align-top">
                  <span title={r.normalizedDescription} className="block truncate">
                    {r.rawDescription}
                  </span>
                  {r.isTransfer || r.isRecurring ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {r.isTransfer ? <Badge>transfer</Badge> : null}
                      {r.isRecurring ? <Badge>recurring</Badge> : null}
                    </span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 align-top text-xs text-ink-muted">
                  {r.accountName}
                </td>
                <td className="px-4 py-2 align-top">
                  <CategoryCell
                    transactionId={r.id}
                    categoryId={r.categoryId}
                    categoryLabel={r.categoryLabel}
                    hasMerchant={r.hasMerchant}
                    lowConfidence={r.lowConfidence}
                    returnQuery={returnQuery}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right align-top">
                  <Money cents={r.amountCents} flow />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CategoryOptionsProvider>
  );
}
