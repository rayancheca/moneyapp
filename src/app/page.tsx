import Link from "next/link";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { todayIso } from "@/lib/dates";
import { coverageLabel } from "@/lib/coverage-label";
import { dashboardData } from "@/services/dashboard";
import { recentLedgerRows } from "@/services/ledger-rows";
import { institutionGroups } from "@/services/institution-groups";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";
import { RecentTransactions } from "@/components/transactions/RecentTransactions";
import { InstitutionCard } from "@/components/accounts/InstitutionCard";
import { DashboardWindowProvider } from "@/components/dashboard/DashboardWindowContext";
import { InvestmentsTeaser } from "@/components/dashboard/InvestmentsTeaser";
import { NetWorthChartPanel } from "@/components/dashboard/NetWorthChartPanel";
import { PeriodActivityPanel } from "@/components/dashboard/PeriodActivityPanel";
import { SpendingPaceWidget } from "@/components/dashboard/SpendingPaceWidget";
import { ToReviewCard } from "@/components/dashboard/ToReviewCard";
import { UpcomingBillsStrip } from "@/components/dashboard/UpcomingBillsStrip";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

export const dynamic = "force-dynamic";

const RECENT_TXN_LIMIT = 5;
const REVIEW_PREVIEW_LIMIT = 3;

const SETUP_STEPS = [
  {
    step: "01",
    title: "Add your accounts",
    detail:
      "Chase, Discover, Capital One, SoFi, Robinhood — typed as checking, savings, credit, or investment.",
  },
  {
    step: "02",
    title: "Enter current balances",
    detail: "Net worth appears instantly: assets minus liabilities, credit cards counted against you.",
  },
  {
    step: "03",
    title: "Upload statements",
    detail: "Two years of history reconstructed and reconciled to the cent, statement by statement.",
  },
];

export default function DashboardPage() {
  const db = getDb();
  const today = todayIso();
  const data = dashboardData(db, today);
  const { netWorth } = data;
  // on a partial "today", name whichever list is more concise (covered vs missing)
  const heroCoverage = coverageLabel(netWorth.coveredAccountNames, netWorth.missingAccounts);

  if (netWorth.totalAccounts === 0) {
    return (
      <div className="space-y-8">
        <header>
          <h1 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">Net worth</h1>
          <p aria-hidden className="figures mt-2 text-5xl font-semibold tracking-tight text-ink-faint">
            $&thinsp;—
          </p>
          <p className="mt-3 max-w-prose text-sm text-ink-muted">
            No accounts yet. Add your accounts and balances to see your net worth today — upload
            statements to reconstruct the last two years.
          </p>
        </header>
        <div className="grid gap-4 md:grid-cols-3">
          {SETUP_STEPS.map((s) => (
            <SurfaceCard key={s.step} className="space-y-2">
              <span className="figures text-xs text-accent">{s.step}</span>
              <h2 className="text-sm font-medium">{s.title}</h2>
              <p className="text-[13px] leading-relaxed text-ink-muted">{s.detail}</p>
            </SurfaceCard>
          ))}
        </div>
      </div>
    );
  }

  const groups = institutionGroups(db);
  const pickerOptions = buildCategoryPickerOptions(db.select().from(categories).all());
  const reviewRows = recentLedgerRows(db, { limit: REVIEW_PREVIEW_LIMIT, needsReviewOnly: true });
  const recentRows = recentLedgerRows(db, { limit: RECENT_TXN_LIMIT });

  return (
    <DashboardWindowProvider>
    <div className="space-y-8">
      {/* 1 · net worth hero */}
      <section aria-labelledby="net-worth-heading">
        <header>
          <h1 id="net-worth-heading" className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
            Net worth
          </h1>
          <p className="figures mt-2 text-5xl font-semibold tracking-tight">
            <Money cents={netWorth.latestCents} />
          </p>
          <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-muted">
            <span>
              Assets <Money cents={netWorth.assetsCents} className="font-medium text-ink" />
            </span>
            <span>
              Liabilities{" "}
              <Money
                cents={netWorth.liabilitiesCents === 0 ? 0 : -netWorth.liabilitiesCents}
                className={`font-medium ${netWorth.liabilitiesCents === 0 ? "text-ink" : "text-negative"}`}
              />
            </span>
            {!netWorth.complete && (
              <span className="text-warning">
                partial · {netWorth.coveredAccounts}/{netWorth.totalAccounts} covered
                {heroCoverage && (
                  <span className="text-ink-faint">
                    {" "}· {heroCoverage.kind} {heroCoverage.text}
                  </span>
                )}
              </span>
            )}
          </p>
        </header>

        {netWorth.series.length > 1 && (
          <>
            <SurfaceCard className="mt-4">
              <NetWorthChartPanel points={netWorth.series} today={today} />
            </SurfaceCard>
            <PeriodActivityPanel categories={pickerOptions} />
          </>
        )}
      </section>

      {/* 2 · teaser bento: review (list) beside the pace + investments stack */}
      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <ToReviewCard
          count={data.reviewCount}
          href={data.reviewHref}
          rows={reviewRows}
          categories={pickerOptions}
        />
        <div className="space-y-6">
          {data.pace && <SpendingPaceWidget pace={data.pace} />}
          {data.investments && <InvestmentsTeaser data={data.investments} />}
        </div>
      </div>

      {/* 3 · upcoming bills rail */}
      <UpcomingBillsStrip data={data.upcoming} />

      {/* 4 · accounts */}
      <section aria-labelledby="accounts-overview-heading">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 id="accounts-overview-heading" className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
            Accounts
          </h2>
          <Link href="/accounts" className="text-xs text-ink-muted hover:text-ink">
            Manage →
          </Link>
        </div>
        <div className="space-y-3">
          {groups.map((g) => (
            <InstitutionCard key={g.institutionName} group={g} />
          ))}
        </div>
      </section>

      {/* 5 · recent transactions */}
      {recentRows.length > 0 && (
        <section aria-labelledby="recent-txns-heading">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 id="recent-txns-heading" className="text-sm font-medium">
              Recent transactions
            </h2>
            <Link
              href="/transactions"
              className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
            >
              All →
            </Link>
          </div>
          <RecentTransactions rows={recentRows} categories={pickerOptions} />
        </section>
      )}
    </div>
    </DashboardWindowProvider>
  );
}
