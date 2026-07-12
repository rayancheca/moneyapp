import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { isLiability } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { addDays, compareDates, todayIso } from "@/lib/dates";
import { formatCentsSigned } from "@/lib/money";
import { getAccount } from "@/services/accounts";
import { listAnchors } from "@/services/anchors";
import { accountSeries } from "@/services/derivation";
import { listAccountHoldings } from "@/services/holdings";
import { recentLedgerRows } from "@/services/ledger-rows";
import { AccountHoldingsTable } from "@/components/accounts/AccountHoldingsTable";
import { AnchorForm } from "@/components/accounts/AnchorForm";
import { BalanceChartPanel } from "@/components/accounts/BalanceChartPanel";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";
import { RecentTransactions } from "@/components/transactions/RecentTransactions";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { deleteAnchorAction, setAccountActiveAction } from "../actions";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

const RECENT_TXN_LIMIT = 10;

const SOURCE_LABEL: Record<string, string> = {
  statement: "statement",
  ofx_ledger: "bank export",
  manual: "manual",
  live: "live",
};

const BASIS_LABEL: Record<string, string> = {
  anchored: "anchored",
  derived: "derived",
  derived_unverified: "derived (unverified)",
  carried: "carried",
};

const TYPE_LABEL: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  investment: "Investment",
};

function ChangeChip({ label, cents, liability = false }: { label: string; cents: number | null; liability?: boolean }) {
  if (cents === null) return null;
  // owed-frame chips: MORE debt is bad (red), paying down is good (green)
  const good = liability ? cents < 0 : cents > 0;
  const tone = cents === 0 ? "text-ink-muted" : good ? "text-positive" : "text-negative";
  return (
    <span className="text-xs text-ink-faint">
      {label} <span className={`figures font-medium ${tone}`}>{formatCentsSigned(cents)}</span>
    </span>
  );
}

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const account = getAccount(db, id);
  if (!account) notFound();

  const liability = isLiability(account.type);
  const sign = liability ? -1 : 1;
  const today = todayIso();

  const series = accountSeries(db, id);
  const latest = series.at(-1) ?? null;
  const previous = series.length > 1 ? series[series.length - 2]! : null;
  const dayChange = latest && previous ? sign * (latest.balanceCents - previous.balanceCents) : null;

  let monthChange: number | null = null;
  if (latest) {
    const cutoff = addDays(latest.day, -30);
    const base = [...series].reverse().find((p) => compareDates(p.day, cutoff) <= 0);
    if (base) monthChange = sign * (latest.balanceCents - base.balanceCents);
  }

  const holdings = account.type === "investment" ? listAccountHoldings(db, id) : [];
  const holdingsValue = holdings.reduce((sum, h) => sum + (h.valueCents ?? 0), 0);

  const ledgerRows = recentLedgerRows(db, { accountId: id, limit: RECENT_TXN_LIMIT });
  const pickerOptions = buildCategoryPickerOptions(db.select().from(categories).all());

  const anchors = [...listAnchors(db, id)].reverse();

  return (
    <>
      <Breadcrumbs
        className="mb-3"
        items={[{ label: "Accounts", href: "/accounts" }, { label: account.name }]}
      />
      <PageHeader
        title={account.name}
        description={`${TYPE_LABEL[account.type] ?? account.type}${account.subtype ? ` · ${account.subtype}` : ""}${account.last4 ? ` · ····${account.last4}` : ""}${account.isActive ? "" : " · archived"}`}
      />
      <div className="space-y-6">
        <header>
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
            {liability ? "Amount owed" : "Balance"}
          </div>
          {latest ? (
            <>
              <p className="figures mt-1 text-4xl font-semibold tracking-tight">
                <Money cents={sign * latest.balanceCents} className={liability ? "text-negative" : ""} />
              </p>
              <p className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <ChangeChip label="Today" cents={dayChange} liability={liability} />
                <ChangeChip label="30 days" cents={monthChange} liability={liability} />
                <span className="text-xs text-ink-faint">
                  as of {latest.day} · {BASIS_LABEL[latest.basis] ?? latest.basis}
                </span>
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-ink-muted">
              No balance yet — record one below or import a statement.
            </p>
          )}
        </header>

        {series.length > 1 && (
          <SurfaceCard>
            <h2 className="mb-3 text-sm font-medium">Balance history</h2>
            <BalanceChartPanel
              points={series.map((p) => ({ day: p.day, balanceCents: sign * p.balanceCents, basis: p.basis }))}
              today={today}
            />
          </SurfaceCard>
        )}

        {holdings.length > 0 && (
          <SurfaceCard>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">Holdings</h2>
              <span className="text-xs text-ink-faint">
                market value <Money cents={holdingsValue} className="font-medium text-ink" />
              </span>
            </div>
            <AccountHoldingsTable rows={holdings} />
          </SurfaceCard>
        )}

        {ledgerRows.length > 0 && (
          <section aria-labelledby="account-recent-heading">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 id="account-recent-heading" className="text-sm font-medium">
                Recent transactions
              </h2>
              <Link
                href={`/transactions?account=${id}`}
                className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
              >
                All transactions →
              </Link>
            </div>
            <RecentTransactions rows={ledgerRows} categories={pickerOptions} />
          </section>
        )}

        <SurfaceCard>
          <h2 className="mb-1 text-sm font-medium">Record a balance</h2>
          <p className="mb-4 text-xs text-ink-muted">
            {liability
              ? "Enter the amount you owe — it counts against your net worth."
              : "A known balance on a known date anchors this account's history."}
          </p>
          <AnchorForm accountId={id} isCredit={liability} defaultDate={today} />
        </SurfaceCard>

        <SurfaceCard>
          <h2 className="mb-3 text-sm font-medium">Recorded balances</h2>
          {anchors.length === 0 ? (
            <p className="text-sm text-ink-muted">No balances recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="py-2 font-medium">Date</th>
                  <th className="py-2 font-medium">Source</th>
                  <th className="py-2 text-right font-medium">{liability ? "Owed" : "Balance"}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {anchors.map((a) => (
                  <tr key={a.id} className="border-b border-line/60 last:border-0">
                    <td className="figures py-2">{a.anchoredOn}</td>
                    <td className="py-2 text-xs text-ink-muted">{SOURCE_LABEL[a.source]}</td>
                    <td className="py-2 text-right">
                      <Money cents={liability ? -a.balanceCents : a.balanceCents} />
                    </td>
                    <td className="py-2 text-right">
                      {(a.source === "manual" || a.source === "live") && (
                        <form action={deleteAnchorAction} className="inline">
                          <input type="hidden" name="anchorId" value={a.id} />
                          <input type="hidden" name="accountId" value={id} />
                          <button
                            type="submit"
                            className="text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:text-negative"
                          >
                            remove
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SurfaceCard>

        <div className="flex items-center justify-between">
          <Link href="/accounts" className="text-sm text-ink-muted hover:text-ink">
            ← All accounts
          </Link>
          <form action={setAccountActiveAction}>
            <input type="hidden" name="accountId" value={id} />
            <input type="hidden" name="isActive" value={account.isActive ? "false" : "true"} />
            <button
              type="submit"
              className="text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink"
            >
              {account.isActive ? "Archive account" : "Restore account"}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
