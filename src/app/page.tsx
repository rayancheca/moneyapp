import Link from "next/link";
import { getDb } from "@/db/client";
import { listAccounts } from "@/services/accounts";
import { netWorthSeries } from "@/services/derivation";
import { institutionGroups } from "@/services/institution-groups";
import { InstitutionCard } from "@/components/accounts/InstitutionCard";
import { NetWorthChart } from "@/components/dashboard/NetWorthChart";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

export const dynamic = "force-dynamic";

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
  const accounts = listAccounts(db).filter((a) => a.isActive);
  const groups = institutionGroups(db);
  const series = netWorthSeries(db);
  const latest = series.at(-1);

  const assets = accounts
    .filter((a) => !a.isLiability && a.balance)
    .reduce((sum, a) => sum + (a.balance?.balanceCents ?? 0), 0);
  const liabilities = accounts
    .filter((a) => a.isLiability && a.balance)
    .reduce((sum, a) => sum + (a.balance?.balanceCents ?? 0), 0);

  if (accounts.length === 0) {
    return (
      <div className="space-y-8">
        <header>
          <h1 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
            Net worth
          </h1>
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

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">Net worth</h1>
        <p className="figures mt-2 text-5xl font-semibold tracking-tight">
          <Money cents={latest?.totalCents ?? 0} />
        </p>
        <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-muted">
          <span>
            Assets <Money cents={assets} className="font-medium text-ink" />
          </span>
          <span>
            Liabilities{" "}
            <Money
              cents={liabilities === 0 ? 0 : -liabilities}
              className={`font-medium ${liabilities === 0 ? "text-ink" : "text-negative"}`}
            />
          </span>
          {latest && !latest.complete && (
            <span className="text-warning">
              partial · {latest.coveredAccounts}/{latest.totalAccounts} accounts covered
            </span>
          )}
        </p>
      </header>

      {series.length > 1 && (
        <SurfaceCard>
          <NetWorthChart points={series} />
        </SurfaceCard>
      )}

      <section aria-label="Accounts overview">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
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
    </div>
  );
}
