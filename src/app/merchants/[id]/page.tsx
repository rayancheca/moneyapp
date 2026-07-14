import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { merchantSummary } from "@/services/merchants";
import { categories } from "@/db/schema/categories";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { MerchantDefaultCategory } from "@/components/merchants/MerchantDefaultCategory";
import { MerchantNameHeading } from "@/components/merchants/MerchantNameHeading";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";

export const metadata: Metadata = { title: "Merchant" };
export const dynamic = "force-dynamic";

/**
 * Merchant detail (ux-overhaul-plan §3.6). Stage-1 v1: name, this-year total,
 * recent activity, and drill-in to the merchant-filtered ledger. Alias editing,
 * monthly-spend bars, linked recurring series, and merge-into are follow-ups.
 */
export default async function MerchantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const summary = (() => {
    try {
      return merchantSummary(db, id);
    } catch {
      notFound();
    }
  })();

  return (
    <>
      <Breadcrumbs
        className="mb-3"
        items={[{ label: "Transactions", href: "/transactions" }, { label: summary.name }]}
      />
      <MerchantNameHeading
        merchantId={id}
        name={summary.name}
        description={`${summary.txnCount} transactions`}
      />

      <div className="space-y-6">
        <header>
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">This year</div>
          <p className="figures mt-1 text-4xl font-semibold tracking-tight">
            <Money cents={summary.totalCentsThisYear} flow />
          </p>
        </header>

        <MerchantDefaultCategory
          merchantId={id}
          defaultCategoryId={summary.defaultCategoryId}
          uncategorizedCount={summary.uncategorizedCount}
          categories={buildCategoryPickerOptions(db.select().from(categories).all())}
        />

        <SurfaceCard>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-medium">Recent activity</h2>
            <Link
              href={`/transactions?merchant=${id}`}
              className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
            >
              View all {summary.txnCount} →
            </Link>
          </div>
          {summary.recent.length === 0 ? (
            <p className="text-sm text-ink-muted">No transactions.</p>
          ) : (
            <ul className="space-y-1.5">
              {summary.recent.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="figures shrink-0 text-xs text-ink-muted">{t.postedOn}</span>
                  <span className="min-w-0 flex-1 truncate">{t.normalizedDescription || t.rawDescription}</span>
                  <Money cents={t.amountCents} flow />
                </li>
              ))}
            </ul>
          )}
        </SurfaceCard>

        <Link href="/transactions" className="text-sm text-ink-muted hover:text-ink">
          ← All transactions
        </Link>
      </div>
    </>
  );
}
