import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { listAccounts, listInstitutions } from "@/services/accounts";
import { listCashWalletSummaries } from "@/services/cash-wallets";
import { institutionGroups } from "@/services/institution-groups";
import { CASH_INSTITUTION_NAME } from "@/services/manual-transactions";
import { readSettings } from "@/services/settings";
import { todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { resolveViewState, type ViewSpec } from "@/lib/view-state";
import { AccountForm } from "@/components/accounts/AccountForm";
import {
  AccountsListSwitcher,
  AccountsTable,
  type AccountsTableAccount,
} from "@/components/accounts/AccountsTable";
import { AddInstitution } from "@/components/accounts/AddInstitution";
import { CashWallets } from "@/components/accounts/CashWallets";
import { ManagedAccounts } from "@/components/accounts/ManagedAccounts";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner, errorParam } from "@/components/ui/ErrorBanner";

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

/**
 * The accounts list is switchable (NS#2 Pillar 2): the institution CARDS this
 * page has always shown, and A+'s dense ruled TABLE beside them. `cards` is the
 * first option and therefore the default, so a visit with no param and no saved
 * preference lands exactly where it always did.
 *
 * The spec lives here rather than in the component because the server has to
 * resolve the active view before rendering, and a "use client" module's
 * constants cannot be read on the server — the switcher takes it as a prop.
 */
const ACCOUNTS_LIST_SURFACE = "accounts";
const ACCOUNTS_LIST_SPEC: ViewSpec = [{ key: "view", options: ["cards", "table"] }];
const ACCOUNTS_LIST_LABELS: Record<string, string> = { cards: "Cards", table: "Table" };

const TYPE_LABEL: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  investment: "Investment",
};

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // deleteAnchorAction and setAccountActiveAction are `Promise<void>` form
  // actions, so their failures land here as ?error= (the /budgets pattern).
  // Unread, a removal refused because its restore point could not be written
  // was indistinguishable from one that quietly did nothing.
  const raw = await searchParams;
  const error = errorParam(raw);

  const db = getDb();
  // cash wallets have their own dedicated card below — keep them out of the
  // institution list so they aren't managed (and rendered) in two places
  const groups = institutionGroups(db).filter((g) => g.institutionName !== CASH_INSTITUTION_NAME);
  // Cash is filtered here too, for the same reason: picking it in the generic
  // "add an account" form would anchor a wallet on today instead of asking for
  // an opening date. The action rejects it as a backstop; this keeps the owner
  // from choosing a dead end in the first place.
  const institutions = listInstitutions(db)
    .filter((i) => i.name !== CASH_INSTITUTION_NAME)
    .map((i) => ({ id: i.id, name: i.name }));
  const archived = listAccounts(db).filter((a) => !a.isActive);
  const cashWallets = listCashWalletSummaries(db);
  const categoryOptions = buildCategoryPickerOptions(db.select().from(categories).all());

  // switchable-view state (NS#2 Pillar 2): URL > persisted preference > default
  const listView = resolveViewState(
    ACCOUNTS_LIST_SPEC,
    { view: Array.isArray(raw.view) ? raw.view[0] : raw.view },
    readSettings(db).viewPreferences[ACCOUNTS_LIST_SURFACE],
  );
  const showTable = listView.view === "table";

  // the table reads the SAME cards the institution view renders — one service,
  // one set of figures, two lenses on it. Balances stay in the net-worth frame
  // daily_balances stores them in, so the table's own total can be their sum.
  const tableAccounts: AccountsTableAccount[] = groups.flatMap((group) =>
    group.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      institution: group.institutionName,
      meta: [TYPE_LABEL[a.type] ?? a.type, a.last4 ? `····${a.last4}` : null, a.holdingsSummary]
        .filter(Boolean)
        .join(" · "),
      isLiability: a.isLiability,
      balanceCents: a.balanceCents,
      asOf: a.asOf,
      spark: a.spark,
      unreviewedCount: a.unreviewedCount,
    })),
  );
  const cashWalletCents = cashWallets.reduce((sum, w) => sum + (w.balanceCents ?? 0), 0);
  const cashWalletNote =
    cashWallets.length === 0
      ? undefined
      : `Cash wallets (${formatCents(cashWalletCents)}) keep their own card below and are not in this total.`;

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Deposit, credit, and investment accounts grouped by institution. Reorder with the arrows or drag the grip; edit a name, institution, or last-4 from the pencil. Debit cards spend from checking; they don't hold balances."
      />

      {error && <ErrorBanner message={error} />}
      <div className="space-y-6">
        {groups.length > 0 && (
          <section aria-labelledby="accounts-list-heading">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2
                id="accounts-list-heading"
                className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint"
              >
                All accounts
              </h2>
              <AccountsListSwitcher
                surface={ACCOUNTS_LIST_SURFACE}
                spec={ACCOUNTS_LIST_SPEC}
                state={listView}
                labels={ACCOUNTS_LIST_LABELS}
              />
            </div>
            {showTable ? (
              <AccountsTable accounts={tableAccounts} cashWalletNote={cashWalletNote} />
            ) : (
              <ManagedAccounts groups={groups} institutions={institutions} />
            )}
          </section>
        )}

        {archived.length > 0 && (
          <section aria-label="Archived accounts">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              Archived
            </h2>
            <ul className="divide-y divide-line overflow-hidden rounded-(--radius-card) border border-line bg-surface-sunken/40">
              {archived.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/accounts/${a.id}`}
                    className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-sunken hover:text-ink"
                  >
                    <span className="truncate">{a.name}</span>
                    <span className="shrink-0 text-[11px] text-ink-faint">{a.institutionName}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <SurfaceCard>
          <div className="mb-3">
            <h2 className="text-sm font-medium">Cash wallets</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              Track cash the statements never see — add transactions by hand. Balances derive from
              those entries; they don&apos;t need a bank connection.
            </p>
          </div>
          <CashWallets wallets={cashWallets} categories={categoryOptions} today={todayIso()} />
        </SurfaceCard>

        <SurfaceCard>
          <h2 className="mb-4 text-sm font-medium">Add an account</h2>
          <AccountForm institutions={institutions} />
          <div className="mt-5 border-t border-line pt-5">
            <AddInstitution />
          </div>
        </SurfaceCard>
      </div>
    </>
  );
}
