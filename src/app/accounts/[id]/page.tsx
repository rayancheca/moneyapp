import type { Metadata } from "next";
import type { AnchorSource } from "@/db/schema/balances";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { isLiability } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { addDays, compareDates, todayIso } from "@/lib/dates";
import { accountSubtypeLabel, accountTypeLabel } from "@/lib/account-label";
import { dayWindowLabel } from "@/lib/period";
import { formatDayShort } from "@/lib/format-date";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { balanceDeltaAccent, balanceHeading, type BalanceDeltaAccent } from "@/lib/side-magnitude";
import { accountDayChange } from "@/services/account-day-change";
import { accountInsights } from "@/services/account-insights";
import { getAccount, listAccounts, listInstitutions, ownPortfolioAccountIds } from "@/services/accounts";
import { anchorRemovalEffects, listAnchors, takesTypedBalance } from "@/services/anchors";
import { observedSeries } from "@/services/derivation";
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
import { removeBalanceControls, removeBalanceRadius } from "@/components/accounts/remove-balance-radius";
import { BalanceFigure } from "@/components/accounts/BalanceFigure";
import { ErrorBanner, errorParam } from "@/components/ui/ErrorBanner";
import { BalanceChartPanel } from "@/components/accounts/BalanceChartPanel";
import { EditAccountButton } from "@/components/accounts/EditAccountButton";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";
import { RecentTransactions } from "@/components/transactions/RecentTransactions";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { countPhrase } from "@/components/ui/blast-radius";
import { ConfirmActionButton } from "@/components/ui/Confirm";
import { provenanceFor } from "@/services/provenance";
import { balanceDayIsExact } from "@/services/coverage";
import { Money } from "@/components/ui/Money";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { deleteAnchorAction, setAccountActiveAction } from "../actions";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

const RECENT_TXN_LIMIT = 10;

const SOURCE_LABEL: Record<AnchorSource, string> = {
  statement: "statement",
  ofx_ledger: "bank export",
  // ⚖️ "counted" is the one verb for a balance he typed — the badge's own word (§6A 33, 50)
  manual: "you counted it",
  live: "live",
  // ⚖️ owner decision 20: the opening of a statement he un-imported, kept — never read as a statement that checks
  unimported_statement: "opening of a statement you un-imported · not checked",
};

const BASIS_LABEL: Record<string, string> = {
  anchored: "anchored",
  derived: "derived",
  derived_unverified: "derived (unverified)",
  carried: "carried",
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
  // balance was refused — "Add a balance you counted" is the form most likely to be
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

  /*
   * 🔴 S24: THE HEADER NAMED THE REBUILD DAY. `daily_balances` walks to whatever
   * `today` stood at the last rebuild, so Chase Checking read "as of Aug 14,
   * 2026 · carried" on 2026-09-14 while its newest row and its statement both
   * end Aug 12 — the same rebuild day the dashboard's card named. The series is
   * cut at the day the balance was observed BEFORE anything reads it, so the
   * header, both change chips, the balance proof and the chart name one day. The
   * balance itself does not move.
   */
  const series = observedSeries(db, id);
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
  /*
   * 🔴 …and for an account priced from holdings both days sit past its newest
   * close, because `rebuildInvestmentHistory` carries the series to today.
   * Measured on the real ledger, Tue 2026-09-15: Robinhood Brokerage read
   * "Today $0.00" — Sep 14 against Sep 15, both at Monday's closes — directly
   * above the Holdings card's Day column dated "Sep 14 vs Sep 11", whose nine
   * rows sum to +$1,110.27; Robinhood Crypto "Today $0.00" above ETH's
   * +$794.72. `accountDayChange` is the rule the account's card reads too.
   */
  const change = accountDayChange(
    db,
    account,
    series.map((p) => ({ day: p.day, cents: p.balanceCents })),
    today,
    formatDayShort,
  );
  const dayChange = change.cents === null ? null : sign * change.cents;
  /*
   * ⛔ The FOURTH surface to ask "what do I call this figure", and the one the
   * dashboard's own row links to. `daily_balances` is a cached derivation that
   * stops wherever `today` stood at the last rebuild, so these two days are
   * routinely weeks old: measured on the real ledger at today = 2026-09-01,
   * Cash on Hand's move is between 2026-08-10 and 2026-08-11 and this chip
   * called it "Today −$5,000.00" — the very figure the fix one page up quotes
   * as the defect it was closing.
   */
  const dayTerm = change.heading.interval ?? change.heading.label;

  /*
   * 🔴 THE WINDOW, NAMED — because `/accounts?view=table` answers the same
   * question over a window one day different, and on Chase Checking the two
   * disagree in SIGN. This chip walks back 30 CALENDAR days from the account's
   * last covered day (Aug 14 → Jul 15, $997.69, giving +$2,009.91); the table
   * takes the last 30 COVERED POINTS (Jul 16 → Aug 14, $5,244.69, giving
   * -$2,237.09) and prints both endpoints under "The balance series, printed".
   * The balance jumped $4,247.00 on Jul 16, so that one day is the whole
   * difference.
   *
   * Both figures are right for their own window and neither was labelled: the
   * chip said "30 days" and the table's column says "Change". The chip names
   * the day it measured from, so a reader can see which is which — and so the
   * two can be put side by side and decided on rather than guessed at.
   */
  let monthChange: number | null = null;
  let monthFrom: string | null = null;
  if (latest) {
    const cutoff = addDays(latest.day, -30);
    const base = [...series].reverse().find((p) => compareDates(p.day, cutoff) <= 0);
    if (base) {
      monthChange = sign * (latest.balanceCents - base.balanceCents);
      monthFrom = base.day;
    }
  }

  const holdings = account.type === "investment" ? listAccountHoldings(db, id) : [];
  const holdingsValue = holdings.reduce((sum, h) => sum + (h.valueCents ?? 0), 0);

  const ledgerRows = recentLedgerRows(db, { accountId: id, limit: RECENT_TXN_LIMIT });
  const pickerOptions = buildCategoryPickerOptions(db.select().from(categories).all());

  // newest first
  const anchors = [...listAnchors(db, id)].reverse();
  /*
   * ⛔ What removing each manual or live balance would change, from ONE load of
   * the account's replay inputs — the rows below only look their answer up.
   * `rebuildAccount`'s own branch decides "priced from holdings" here, not the
   * provenance verdict above: `market_value` covers every investment account,
   * and the rebuild skips balances only for one with holding events.
   */
  const removalEffects = anchorRemovalEffects(db, id, today);
  // the remove control's words are the dialog's rule's: a balance he typed is one he counted (§6A 50)
  const anchorRows = anchors.map((a) => ({
    a,
    removal: removalEffects.get(a.id),
    controls: removeBalanceControls(a.source, a.anchoredOn),
  }));

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
          /* ⛔ the subtype is a LABEL too — `lib/account-label` owns both, and
             the Edit sheet a button away has always said "Brokerage". */
          description={[
            accountTypeLabel(account.type),
            accountSubtypeLabel(account.subtype),
            account.last4 ? `····${account.last4}` : null,
            account.isActive ? null : "archived",
          ]
            .filter(Boolean)
            .join(" · ")}
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
                <ChangeChip
                  label={monthFrom ? `since ${formatDayShort(monthFrom)}` : "30 days"}
                  cents={monthChange}
                  liability={liability}
                />
                {/* ⛔ This line read "since Aug 12 +$211.71 as of 2026-09-11 ·
                    derived" — one sentence, two date formats. `/accounts`' two
                    lenses now both say "as of Sep 11, 2026" through
                    `asOfSpanTerm`, which reads `dayWindowLabel`; this is the
                    third surface on the same rule. The YEAR stays: a balance
                    last true in a previous year must not read as this one. */}
                <span className="text-xs text-ink-faint">
                  as of {dayWindowLabel(latest.day, latest.day)} · {BASIS_LABEL[latest.basis] ?? latest.basis}
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
              points={series.map((p) => ({
                day: p.day,
                balanceCents: sign * p.balanceCents,
                basis: p.basis,
                exact: balanceDayIsExact(account.type, p.basis),
              }))}
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
            {/* ⚖️ the holding page is HIS holding — the agent's book's rows would open a page about other shares */}
            <AccountHoldingsTable rows={holdings} today={today} opensHoldingPages={ownPortfolioAccountIds(db).has(id)} />
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

        {/* ⛔ a brokerage book is valued by what its statements prove — a typed balance is refused (`takesTypedBalance`) */}
        {/* ⚖️ "counted" is the one verb for a balance he typed, and the controls say it too (§6A 50) */}
        {takesTypedBalance(account) && (
          <SurfaceCard>
            <h2 className="mb-1 text-sm font-medium">Add a balance you counted</h2>
            <p className="mb-4 text-xs text-ink-muted">
              {liability
                ? "Enter the amount you owe — it counts against your net worth."
                : "A known balance on a known date anchors this account's history."}
            </p>
            <AnchorForm accountId={id} isCredit={liability} defaultDate={today} />
          </SurfaceCard>
        )}

        <SurfaceCard>
          <h2 className="mb-3 text-sm font-medium">Recorded balances</h2>
          {anchors.length === 0 ? (
            <p className="text-sm text-ink-muted">No balances counted yet.</p>
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
                {anchorRows.map(({ a, removal, controls }) => (
                  <tr key={a.id} className="border-b border-line/60 last:border-0">
                    <td className="figures py-2">{a.anchoredOn}</td>
                    <td className="py-2 text-xs text-ink-muted">{SOURCE_LABEL[a.source]}</td>
                    <td className="py-2 text-right">
                      {/* 🔴 `liability ? -balanceCents : balanceCents` under a
                          column headed "Owed": Chase Sapphire's own history read
                          "2026-09-02 · statement · -$82.72" and "2026-07-02 ·
                          -$70.89" — two statements on which the bank owed HIM,
                          printed as negative debts. A column header cannot carry
                          a per-row verdict, so the ROW does, through the
                          component both accounts lenses already read: the
                          magnitude, "in credit" beside it, and the debt-red kept
                          for the rows that are debts. */}
                      <BalanceFigure
                        balanceCents={a.balanceCents}
                        isLiability={liability}
                        className="text-sm"
                      />
                    </td>
                    <td className="py-2 text-right">
                      {removal && (
                        <ConfirmActionButton
                          action={deleteAnchorAction}
                          fields={{ anchorId: a.id, accountId: id }}
                          formClassName="inline"
                          triggerLabel="remove"
                          triggerAriaLabel={controls.triggerAriaLabel}
                          triggerClassName="text-xs text-ink-faint transition-colors duration-(--duration-fast) hover:text-negative"
                          title={controls.title}
                          confirmLabel={controls.confirmLabel}
                          /* 🔴 An account PRICED FROM HOLDINGS does not verify
                             anything with a recorded balance, and removing one
                             changes nothing at all. `rebuildAccount` short-
                             circuits for an investment account with holding
                             events (derivation.ts:280-296) into
                             `rebuildInvestmentHistory`, which deletes every
                             daily_balances row and rebuilds it from cumulative
                             holding_events × stored closes — `balance_anchors`
                             is not queried in that file — and `deleteAnchor`
                             calls exactly that rebuild. Both Robinhood accounts
                             take that branch, and this dialog told them
                             "Removing it leaves those days to be derived from
                             transactions alone · Days that stop being verified:
                             1 day" while the badge at the top of the same page
                             read "market value — priced from holdings, not
                             checked by arithmetic". */
                          /* 🔴 …AND A BALANCE THAT PINS NOTHING IS NOT WHAT
                             VERIFIES ANYTHING. The headline asserted it over a
                             dialog whose own line, two fields below, correctly
                             read "Days that stop being verified: no days".
                             Measured 2026-09-10: `Discover` holds TWO anchors
                             on 2024-08-18, one manual and one from a statement,
                             and the day stays `anchored` after the manual row
                             goes — the statement anchor holds it. (The old
                             date-range count reached that answer only because
                             SQLite returned the statement row first; see
                             `removalEffect`.) One of the 21 remove-balance
                             dialogs on this ledger. */
                          /* ⛔ Every sentence is `removeBalanceRadius`'s, tested
                             branch by branch there — this page only hands it
                             the measured effect. */
                          radius={removeBalanceRadius({
                            accountName: account.name,
                            effect: removal,
                            source: a.source,
                            /* the same rule, and the same hand-rolled copy: an
                               anchor is stored in the net-worth frame, so a card
                               in credit is a POSITIVE `balanceCents` and
                               negating it printed a negative amount owed. Chase
                               Sapphire's 2026-09-02 statement anchor is exactly
                               that; only its `statement` source keeps this
                               dialog off the screen. */
                            recorded: {
                              label: balanceHeading(a.balanceCents, liability).label,
                              value: formatCents(balanceHeading(a.balanceCents, liability).cents),
                            },
                            balancesLeft: anchors.length - 1,
                          })}
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
                          /* 🔴 `liability ? "Owed" : "Balance"` is `balanceHeading`
                             re-decided by hand, two hundred lines under the call
                             that gets it right — and it read "Owed, leaving the
                             totals · -$82.72" for Chase Sapphire on 2026-09-08,
                             a card that owes nothing. Six surfaces said "in
                             credit" about that balance on that day, and this one
                             is a confirmation for an action that moves money out
                             of every total. */
                          label: `${balanceHeading(latest.balanceCents, liability).label}, leaving the totals`,
                          value: formatCents(balanceHeading(latest.balanceCents, liability).cents),
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
