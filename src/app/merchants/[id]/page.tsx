import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { merchantInsights } from "@/services/merchant-insights";
import { merchantIntelligence, merchantSummary } from "@/services/merchants";
import { categories } from "@/db/schema/categories";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { MerchantDefaultCategory } from "@/components/merchants/MerchantDefaultCategory";
import { MerchantNameHeading } from "@/components/merchants/MerchantNameHeading";
import { InsightList } from "@/components/insights/InsightList";
import { MerchantProfileCards } from "@/components/merchants/MerchantProfileCards";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";
import { countPhrase } from "@/components/ui/blast-radius";

export const metadata: Metadata = { title: "Merchant" };
export const dynamic = "force-dynamic";

/**
 * Merchant detail (ux-overhaul-plan §3.6).
 *
 * Pass 65 gave it the number it exists for — "you spend $X a month here" — plus
 * the typical visit, the year-on-year and the category mix. All of the
 * arithmetic, and every refusal in it, lives in `lib/merchant-profile` at 100%;
 * this page renders what it is handed.
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
  const intelligence = merchantIntelligence(db, id);
  /*
   * PHASE III-B. Only what the cards below cannot say — where this merchant
   * sits among the rest, and how much of a category it accounts for. Its own
   * figures are `MerchantProfileCards`' job and are not restated here.
   */
  const insights = merchantInsights(db, id);

  return (
    <>
      <Breadcrumbs
        className="mb-3"
        items={[{ label: "Transactions", href: "/transactions" }, { label: summary.name }]}
      />
      <MerchantNameHeading
        merchantId={id}
        name={summary.name}
        /* 🔴 "1 transactions" under every merchant seen once — 60 of them on
           the owner's ledger. `countPhrase` also turns an empty merchant into
           "no transactions", which is what the list below it already says. */
        description={countPhrase(summary.txnCount, "transaction")}
      />

      <div className="space-y-6">
        <MerchantProfileCards intelligence={intelligence} />

        {insights && <InsightList data={insights} heading={`What the ledger says about ${summary.name}`} />}

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
