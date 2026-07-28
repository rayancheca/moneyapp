import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { listAccounts, listInstitutions } from "@/services/accounts";
import { listCashWallets } from "@/services/cash-wallets";
import { institutionGroups } from "@/services/institution-groups";
import { CASH_INSTITUTION_NAME } from "@/services/manual-transactions";
import { todayIso } from "@/lib/dates";
import { AccountForm } from "@/components/accounts/AccountForm";
import { AddInstitution } from "@/components/accounts/AddInstitution";
import { CashWallets } from "@/components/accounts/CashWallets";
import { ManagedAccounts } from "@/components/accounts/ManagedAccounts";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

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
  const error = typeof raw.error === "string" ? raw.error : null;

  const db = getDb();
  // cash wallets have their own dedicated card below — keep them out of the
  // institution list so they aren't managed (and rendered) in two places
  const groups = institutionGroups(db).filter((g) => g.institutionName !== CASH_INSTITUTION_NAME);
  const institutions = listInstitutions(db).map((i) => ({ id: i.id, name: i.name }));
  const archived = listAccounts(db).filter((a) => !a.isActive);
  const cashWallets = listCashWallets(db).map((w) => ({
    id: w.id,
    name: w.name,
    balanceCents: w.balance?.balanceCents ?? null,
  }));
  const categoryOptions = buildCategoryPickerOptions(db.select().from(categories).all());

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Deposit, credit, and investment accounts grouped by institution. Reorder with the arrows or drag the grip; edit a name, institution, or last-4 from the pencil. Debit cards spend from checking; they don't hold balances."
      />

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-(--radius-card) border border-negative/40 bg-surface-raised px-4 py-3 text-sm text-negative"
        >
          {error}
        </div>
      )}
      <div className="space-y-6">
        {groups.length > 0 && <ManagedAccounts groups={groups} institutions={institutions} />}

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
