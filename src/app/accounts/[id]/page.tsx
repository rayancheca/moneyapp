import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { isLiability } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { addDays, compareDates, todayIso } from "@/lib/dates";
import { dayChangeLabel } from "@/lib/day-change-label";
import { formatDayShort } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { balanceDeltaAccent, balanceHeading, type BalanceDeltaAccent } from "@/lib/side-magnitude";
import { accountInsights } from "@/services/account-insights";
import { getAccount, listAccounts, listInstitutions } from "@/services/accounts";
import { listAnchors } from "@/services/anchors";
import { accountSeries } from "@/services/derivation";
import { listAccountHoldings } from "@/services/holdings";
import { CASH_INSTITUTION_NAME } from "@/services/manual-transactions";
import { recentLedgerRows } from "@/services/ledger-rows";
import { readSettings } from "@/services/settings";
import { resolveViewState } from "@/lib/view-state";
import { ACCOUNT_SURFACE, ACCOUNT_VIEW_SPEC } from "@/components/accounts/accounts-view-spec";
import { AccountHoldingsTable } from "@/components/accounts/AccountHoldingsTable";
import { InsightList } from "@/components/insights/InsightList";
import { AccountNameHeading } from "@/components/accounts/AccountNameHeading";
import { AnchorForm } from "@/components/accounts/AnchorForm";
import { ErrorBanner, errorParam } from "@/components/ui/ErrorBanner";
import { BalanceChartPanel } from "@/components/accounts/BalanceChartPanel";
import { EditAccountButton } from "@/components/accounts/EditAccountButton";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";
import { RecentTransactions } from "@/components/transactions/RecentTransactions";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { countPhrase } from "@/components/ui/blast-radius";
import { ConfirmActionButton } from "@/components/ui/Confirm";
import { provenanceFor } from "@/services/provenance";
import { Money } from "@/components/ui/Money";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
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

const CHANGE_TONE: Record<BalanceDeltaAccent, string> = {
  gain: "text-positive",
  loss: "text-negative",
  flat: "text-ink-muted",
};

function ChangeChip({ label, cents, liability = false }: { label: string; cents: number | null; liability?: boolean }) {
  if (cents === null) return null;
  // owed-frame chips: MORE debt is bad (red), paying down is good (green). The
  // chart below reads the same function — held apart, the two disagreed about
  // all three cards on 2026-09-04.
  const tone = CHANGE_TONE[balanceDeltaAccent(cents, liability)];
  return (
    <span className="text-xs text-ink-faint">
      {label} <span className={`figures font-medium ${tone}`}>{formatCentsSigned(cents)}</span>
    </span>
  );
}

/**
 * The days one recorded balance currently pins: its own date up to (but not
 * including) the next one. Counted on the DERIVED series rather than
 * re-deriving the span here — the number in a confirmation has to be the
 * ledger's own, never a second implementation of it.
 */
function daysPinnedBy(
  series: readonly { day: string }[],
  anchoredOn: string,
  nextAnchoredOn: string | undefined,
): number {
  return series.filter(
    (p) =>
      compareDates(p.day, anchoredOn) >= 0 &&
      (nextAnchoredOn === undefined || compareDates(p.day, nextAnchoredOn) < 0),
  ).length;
}

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  // `addAnchorAction` (accounts/actions.ts:174) redirects HERE with the reason a
  // balance was refused — "Record a balance" is the form most likely to be
  // rejected on this page, and until this was read the refusal was invisible.
  const error = errorParam(raw);
  const db = getDb();
  const account = getAccount(db, id);
  if (!account) notFound();

  // switchable-view state (NS#2 Pillar 2): URL > persisted preference > default
  const balanceView = resolveViewState(
    ACCOUNT_VIEW_SPEC,
    { lens: Array.isArray(raw.lens) ? raw.lens[0] : raw.lens },
    readSettings(db).viewPreferences[ACCOUNT_SURFACE],
  );

  const liability = isLiability(account.type);
  const sign = liability ? -1 : 1;
  const today = todayIso();

  const series = accountSeries(db, id);
  const latest = series.at(-1) ?? null;
  // the label and the figure out of one call — `lib/side-magnitude`
  const heading = balanceHeading(latest?.balanceCents ?? 0, liability);
  // asked for the day the figure is FOR, so a balance carried forward answers
  // with the document that actually pins it
  /*
   * PHASE III-B — checked claims about this account's PLACE, never its own
   * figures. Its balance, chart and rows are already on this page; restating
   * them would say the same thing twice (see `merchant-insights`, which made
   * exactly that mistake first).
   */
  const insights = accountInsights(db, id, today);

  const balanceProvenance = provenanceFor(db, {
    kind: "accountBalance",
    accountId: account.id,
    day: latest?.day,
  });
  const previous = series.length > 1 ? series[series.length - 2]! : null;
  const dayChange = latest && previous ? sign * (latest.balanceCents - previous.balanceCents) : null;
  /*
   * ⛔ The FOURTH surface to ask "what do I call this figure", and the one the
   * dashboard's own row links to. `daily_balances` is a cached derivation that
   * stops wherever `today` stood at the last rebuild, so these two days are
   * routinely weeks old: measured on the real ledger at today = 2026-09-01,
   * Cash on Hand's move is between 2026-08-10 and 2026-08-11 and this chip
   * called it "Today −$5,000.00" — the very figure the fix one page up quotes
   * as the defect it was closing.
   */
  const dayTerm =
    latest && previous
      ? (dayChangeLabel(latest.day, previous.day, today, formatDayShort).interval ?? "Today")
      : "Today";

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

  // newest first, so anchors[i - 1] is the NEXT recorded balance in time
  const anchors = [...listAnchors(db, id)].reverse();

  return (
    <>
      <Breadcrumbs
        className="mb-3"
        items={[{ label: "Accounts", href: "/accounts" }, { label: account.name }]}
      />
      {error && <ErrorBanner message={error} />}
      <div className="flex items-start justify-between gap-4">
        <AccountNameHeading
          accountId={account.id}
          name={account.name}
          description={`${TYPE_LABEL[account.type] ?? account.type}${account.subtype ? ` · ${account.subtype}` : ""}${account.last4 ? ` · ····${account.last4}` : ""}${account.isActive ? "" : " · archived"}`}
        />
        <div className="mt-1">
          <EditAccountButton
            account={{
              id: account.id,
              name: account.name,
              institutionId: account.institutionId,
              last4: account.last4,
              type: account.type,
              subtype: account.subtype,
              paymentSourceAccountId: account.paymentSourceAccountId,
            }}
            // Cash is hidden so an ordinary account cannot be MOVED under it
            // (it would then be a wallet anchored on the wrong day), but it
            // stays listed for an account already there — the edit sheet's
            // Select is controlled, and dropping the current value would leave
            // the owner's own wallet with no matching option.
            institutions={listInstitutions(db).filter(
              (i) => i.name !== CASH_INSTITUTION_NAME || i.id === account.institutionId,
            )}
            fundingCandidates={listAccounts(db)
              .filter((a) => (a.type === "checking" || a.type === "savings") && a.id !== account.id)
              .map((a) => ({ id: a.id, name: a.name }))}
          />
        </div>
      </div>
      <div className="space-y-6">
        <header>
          {/* 🔴 THE HEADING FOLLOWS THE SIGN. This read "Amount owed -$82.72",
              in red, of a card the bank had owed HIM $82.72 on since the 09-02
              statement — while the terrain said "Owed · in credit", the cards
              card "$82.72 in credit" and the accounts table "in credit — no
              share of the debt" about the same balance on the same day. The
              label and the figure come out of one call so they cannot describe
              different things, and the tone follows the label rather than the
              account type. */}
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
            {heading.label}
            {/* the day this figure is FOR, not today — a balance carried forward
                from Aug 12 is proven by Aug 12's document, and asking about
                today would answer a different question than the one on screen */}
            {balanceProvenance && (
              <ProvenancePopover label={heading.subject} provenance={balanceProvenance} />
            )}
          </div>
          {latest ? (
            <>
              <p className="figures mt-1 text-4xl font-semibold tracking-tight">
                <Money cents={heading.cents} className={heading.isAgainstYou ? "text-negative" : ""} />
              </p>
              <p className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <ChangeChip label={dayTerm} cents={dayChange} liability={liability} />
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

        {/* PHASE III-B. Where this account sits among the others and how much of
            what he holds it is — neither is a figure this page prints, and the
            balance above is deliberately not restated. */}
        {insights && <InsightList data={insights} heading={`What the ledger says about ${account.name}`} />}

        {series.length > 1 && (
          <section aria-labelledby="balance-history-heading">
            {/* the chart panel provides its own SurfaceCard (via ChartFocus), so
                the page no longer double-wraps it; the heading sits above the
                card, mirroring the dashboard hero's structure */}
            <h2 id="balance-history-heading" className="mb-2 text-sm font-medium">
              Balance history
            </h2>
            <BalanceChartPanel
              points={series.map((p) => ({ day: p.day, balanceCents: sign * p.balanceCents, basis: p.basis }))}
              today={today}
              viewState={balanceView}
              basePath={`/accounts/${id}`}
              isLiability={liability}
            />
          </section>
        )}

        {holdings.length > 0 && (
          <SurfaceCard>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">Holdings</h2>
              <span className="text-xs text-ink-faint">
                market value <Money cents={holdingsValue} className="font-medium text-ink" />
              </span>
            </div>
            <AccountHoldingsTable rows={holdings} today={today} />
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
                {anchors.map((a, i) => (
                  <tr key={a.id} className="border-b border-line/60 last:border-0">
                    <td className="figures py-2">{a.anchoredOn}</td>
                    <td className="py-2 text-xs text-ink-muted">{SOURCE_LABEL[a.source]}</td>
                    <td className="py-2 text-right">
                      <Money cents={liability ? -a.balanceCents : a.balanceCents} />
                    </td>
                    <td className="py-2 text-right">
                      {(a.source === "manual" || a.source === "live") && (
                        <ConfirmActionButton
                          action={deleteAnchorAction}
                          fields={{ anchorId: a.id, accountId: id }}
                          formClassName="inline"
                          triggerLabel="remove"
                          triggerAriaLabel={`remove the balance recorded on ${a.anchoredOn}`}
                          triggerClassName="text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:text-negative"
                          title="Remove this recorded balance"
                          confirmLabel="Remove this balance"
                          radius={{
                            headline: `This balance is what verifies ${account.name} on ${a.anchoredOn}. Removing it leaves those days to be derived from transactions alone.`,
                            lines: [
                              {
                                label: liability ? "Owed, as recorded" : "Balance, as recorded",
                                value: formatCents(liability ? -a.balanceCents : a.balanceCents),
                                irreversible: true,
                              },
                              {
                                label: "Days that stop being verified",
                                value: countPhrase(
                                  daysPinnedBy(series, a.anchoredOn, anchors[i - 1]?.anchoredOn),
                                  "day",
                                ),
                              },
                              {
                                label: "Recorded balances left on this account",
                                value: countPhrase(anchors.length - 1, "balance"),
                              },
                            ],
                            reassurance:
                              "No transaction is touched — the balance curve is derived, so it rebuilds from what is left. Record the balance again to re-verify these days.",
                          }}
                        />
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
          {/* restoring only ever ADDS an account back to the totals, so it
              stays a one-click form; archiving is the one that moves money */}
          {account.isActive ? (
            <ConfirmActionButton
              action={setAccountActiveAction}
              fields={{ accountId: id, isActive: "false" }}
              triggerLabel="Archive account"
              triggerClassName="text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink"
              title="Archive this account"
              confirmLabel="Archive it"
              radius={{
                headline: `Archiving takes ${account.name} out of net worth, the assets and owed totals, and every analytic. Nothing is deleted.`,
                lines: [
                  ...(latest
                    ? [
                        {
                          label: "Net worth will read",
                          value:
                            latest.balanceCents === 0
                              ? "unchanged"
                              : `${formatCents(Math.abs(latest.balanceCents))} ${
                                  latest.balanceCents > 0 ? "lower" : "higher"
                                }`,
                        },
                        {
                          label: liability ? "Owed, leaving the totals" : "Balance leaving the totals",
                          value: formatCents(sign * latest.balanceCents),
                        },
                      ]
                    : []),
                  {
                    label: "Recorded balances kept",
                    value: countPhrase(anchors.length, "balance"),
                  },
                ],
                reassurance:
                  "Restore account puts it back exactly as it is now — transactions, recorded balances and history are untouched.",
              }}
            />
          ) : (
            <form action={setAccountActiveAction}>
              <input type="hidden" name="accountId" value={id} />
              <input type="hidden" name="isActive" value="true" />
              <button
                type="submit"
                className="text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink"
              >
                Restore account
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
