import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { isLiability } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { transactions } from "@/db/schema/transactions";
import { addDays, compareDates, todayIso } from "@/lib/dates";
import { formatCentsSigned } from "@/lib/money";
import { getAccount } from "@/services/accounts";
import { listAnchors } from "@/services/anchors";
import { accountSeries } from "@/services/derivation";
import { formatQuantityE8, listAccountHoldings } from "@/services/holdings";
import { AnchorForm } from "@/components/accounts/AnchorForm";
import { BalanceChart } from "@/components/accounts/BalanceChart";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { deleteAnchorAction, setAccountActiveAction } from "../actions";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

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

  const recentTxns = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      rawDescription: transactions.rawDescription,
      amountCents: transactions.amountCents,
      categoryName: categories.name,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    // superseded/quarantined ghosts must never render as live money
    .where(and(eq(transactions.accountId, id), eq(transactions.status, "active")))
    .orderBy(desc(transactions.postedOn))
    .limit(10)
    .all();

  const anchors = [...listAnchors(db, id)].reverse();

  return (
    <>
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
            <BalanceChart points={series.map((p) => ({ ...p, balanceCents: sign * p.balanceCents }))} />
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
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="py-2 font-medium">Symbol</th>
                    <th className="py-2 text-right font-medium">Quantity</th>
                    <th className="py-2 text-right font-medium">Price</th>
                    <th className="py-2 text-right font-medium">Day</th>
                    <th className="py-2 text-right font-medium">Value</th>
                    <th className="py-2 text-right font-medium">P/L</th>
                    <th className="py-2 text-right font-medium">Alloc</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h) => {
                    const dayTone =
                      h.dayChangeCents === null || h.dayChangeCents === 0
                        ? "text-ink-muted"
                        : h.dayChangeCents > 0
                          ? "text-positive"
                          : "text-negative";
                    return (
                      <tr key={h.symbol} className="border-b border-line/60 last:border-0">
                        <td className="py-2">
                          <span className="figures font-medium">{h.symbol}</span>
                          <span className="ml-2 text-[11px] text-ink-faint">{h.assetType}</span>
                        </td>
                        <td className="figures py-2 text-right">{formatQuantityE8(h.quantityE8)}</td>
                        <td className="py-2 text-right">
                          {h.latestClose !== null ? (
                            <>
                              <Money cents={Math.round(h.latestClose * 100)} />
                              {h.quotedOn && (
                                <div className="text-[10px] text-ink-faint">{h.quotedOn}</div>
                              )}
                            </>
                          ) : (
                            <span className="text-xs text-ink-faint">—</span>
                          )}
                        </td>
                        <td className={`figures py-2 text-right text-xs ${dayTone}`}>
                          {h.dayChangeCents !== null ? (
                            <>
                              {formatCentsSigned(h.dayChangeCents)}
                              {h.dayChangePct !== null && (
                                <div className="text-[10px] opacity-80">
                                  {h.dayChangePct > 0 ? "+" : ""}
                                  {h.dayChangePct.toFixed(2)}%
                                </div>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-2 text-right">
                          {h.valueCents !== null ? <Money cents={h.valueCents} /> : "—"}
                        </td>
                        <td className="py-2 text-right">
                          {h.plCents !== null ? (
                            <>
                              <Money cents={h.plCents} flow className="text-xs" />
                              {h.plPct !== null && (
                                <div className="text-[10px] text-ink-faint">
                                  {h.plPct > 0 ? "+" : ""}
                                  {h.plPct.toFixed(1)}%
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-xs text-ink-faint">no cost basis</span>
                          )}
                        </td>
                        <td className="figures py-2 text-right text-xs text-ink-muted">
                          {h.allocationPct !== null ? `${h.allocationPct.toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </SurfaceCard>
        )}

        {recentTxns.length > 0 && (
          <SurfaceCard>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">Recent transactions</h2>
              <Link
                href={`/transactions?account=${id}`}
                className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
              >
                All transactions →
              </Link>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="py-2 font-medium">Posted</th>
                  <th className="py-2 font-medium">Description</th>
                  <th className="hidden py-2 font-medium sm:table-cell">Category</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {recentTxns.map((t) => (
                  <tr key={t.id} className="border-b border-line/60 last:border-0">
                    <td className="figures py-2 text-xs text-ink-muted">{t.postedOn}</td>
                    <td className="max-w-64 truncate py-2 pr-3">{t.rawDescription}</td>
                    <td className="hidden py-2 text-xs text-ink-muted sm:table-cell">
                      {t.categoryName ?? "—"}
                    </td>
                    <td className="py-2 text-right">
                      <Money cents={t.amountCents} flow />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </SurfaceCard>
        )}

        <SurfaceCard>
          <h2 className="mb-1 text-sm font-medium">Record a balance</h2>
          <p className="mb-4 text-xs text-ink-muted">
            {liability
              ? "Enter the amount you owe — it counts against your net worth."
              : "A known balance on a known date anchors this account's history."}
          </p>
          <AnchorForm accountId={id} isCredit={liability} defaultDate={todayIso()} />
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
