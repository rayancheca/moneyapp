import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { listAccounts, listInstitutions } from "@/services/accounts";
import { listCashWallets } from "@/services/cash-wallets";
import { institutionGroups } from "@/services/institution-groups";
import { todayIso } from "@/lib/dates";
import { AccountForm } from "@/components/accounts/AccountForm";
import { CashWallets } from "@/components/accounts/CashWallets";
import { InstitutionCard } from "@/components/accounts/InstitutionCard";
import { buildCategoryPickerOptions } from "@/components/transactions/category-options";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

export default function AccountsPage() {
  const db = getDb();
  const groups = institutionGroups(db);
  const institutions = listInstitutions(db);
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
        description="Deposit, credit, and investment accounts grouped by institution — expand a card for the accounts inside. Debit cards spend from checking; they don't hold balances."
      />
      <div className="space-y-6">
        {groups.length > 0 && (
          <div className="space-y-3">
            {groups.map((g) => (
              <InstitutionCard key={g.institutionName} group={g} />
            ))}
          </div>
        )}

        {archived.length > 0 && (
          <section aria-label="Archived accounts">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              Archived
            </h2>
            <ul className="space-y-1">
              {archived.map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/accounts/${a.id}`}
                    className="text-sm text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
                  >
                    {a.name} <span className="text-[11px] text-ink-faint">· {a.institutionName}</span>
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
        </SurfaceCard>
      </div>
    </>
  );
}
