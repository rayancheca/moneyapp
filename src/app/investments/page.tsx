import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { listAccounts } from "@/services/accounts";
import { listPortfolio } from "@/services/holdings";
import { AllocationDonut } from "@/components/investments/AllocationDonut";
import { HoldingForm } from "@/components/investments/HoldingForm";
import { HoldingsTable } from "@/components/investments/HoldingsTable";
import { RefreshPricesButton } from "@/components/investments/RefreshPricesButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

export const metadata: Metadata = { title: "Investments" };
export const dynamic = "force-dynamic";

const STAMP_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatStamp(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : STAMP_FORMAT.format(new Date(t));
}

export default function InvestmentsPage() {
  const db = getDb();
  const investmentAccounts = listAccounts(db).filter((a) => a.type === "investment" && a.isActive);

  if (investmentAccounts.length === 0) {
    return (
      <>
        <PageHeader
          title="Investments"
          description="Holdings, live prices, gain/loss, and allocation. Market value drives net worth; average cost is for P/L only."
        />
        <EmptyState
          title="No investment accounts yet"
          description="Holdings attach to an investment account (brokerage or crypto). Add one under Accounts first — then enter positions here and refresh prices."
        />
        <p className="mt-4 text-sm">
          <Link
            href="/accounts"
            className="font-medium text-accent underline decoration-line underline-offset-4 transition-colors duration-(--duration-fast) hover:decoration-accent"
          >
            Go to Accounts →
          </Link>
        </p>
      </>
    );
  }

  const portfolio = listPortfolio(db);
  const slices = portfolio.rows
    .filter((r) => r.valueCents !== null && r.allocationPct !== null)
    .map((r) => ({
      symbol: r.symbol,
      valueCents: r.valueCents!,
      allocationPct: r.allocationPct!,
    }))
    .sort((a, b) => b.valueCents - a.valueCents);

  return (
    <>
      <PageHeader
        title="Investments"
        description="Holdings, live prices, gain/loss, and allocation. Market value drives net worth; average cost is for P/L only."
      />
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
          <SurfaceCard>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-medium">Portfolio</h2>
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-ink-faint">
                  {portfolio.latestFetchedAt
                    ? `as of ${formatStamp(portfolio.latestFetchedAt)}`
                    : "no prices cached yet"}
                </span>
                <RefreshPricesButton />
              </div>
            </div>
            <HoldingsTable portfolio={portfolio} />
          </SurfaceCard>

          <SurfaceCard className="h-fit">
            <h2 className="mb-4 text-sm font-medium">Allocation</h2>
            {slices.length > 0 ? (
              <AllocationDonut slices={slices} totalCents={portfolio.totals.valueCents} />
            ) : (
              <p className="text-sm text-ink-muted">
                Allocation appears once holdings have cached prices.
              </p>
            )}
          </SurfaceCard>
        </div>

        <SurfaceCard>
          <h2 className="mb-4 text-sm font-medium">Add or update a holding</h2>
          <HoldingForm
            accounts={investmentAccounts.map((a) => ({
              id: a.id,
              name: a.name,
              subtype: a.subtype,
            }))}
            defaultDate={todayIso()}
          />
        </SurfaceCard>
      </div>
    </>
  );
}
