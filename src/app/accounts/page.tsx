import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db/client";
import { listAccounts, listInstitutions } from "@/services/accounts";
import { AccountForm } from "@/components/accounts/AccountForm";
import { Money } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  investment: "Investment",
};

export default function AccountsPage() {
  const db = getDb();
  const accounts = listAccounts(db);
  const institutions = listInstitutions(db);

  const byInstitution = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const list = byInstitution.get(a.institutionName) ?? [];
    byInstitution.set(a.institutionName, [...list, a]);
  }

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Deposit, credit, and investment accounts. Debit cards spend from checking — they don't hold balances."
      />
      <div className="space-y-6">
        {byInstitution.size > 0 && (
          <div className="space-y-5">
            {[...byInstitution.entries()].map(([institution, list]) => (
              <section key={institution} aria-label={institution}>
                <h2 className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                  {institution}
                </h2>
                <div className="grid gap-3 md:grid-cols-2">
                  {list.map((a) => (
                    <Link
                      key={a.id}
                      href={`/accounts/${a.id}`}
                      className="group rounded-(--radius-card) border border-line bg-surface-raised p-4 transition-colors duration-(--duration-fast) hover:border-line-strong"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium group-hover:text-accent">
                            {a.name}
                            {!a.isActive && (
                              <span className="ml-2 text-[11px] text-ink-faint">archived</span>
                            )}
                          </div>
                          <div className="mt-0.5 text-[11px] text-ink-faint">
                            {TYPE_LABEL[a.type]}
                            {a.subtype ? ` · ${a.subtype}` : ""}
                            {a.last4 ? ` · ····${a.last4}` : ""}
                          </div>
                        </div>
                        <div className="text-right">
                          {a.balance ? (
                            <>
                              <Money
                                cents={a.isLiability ? -a.balance.balanceCents! : a.balance.balanceCents!}
                                className={`text-sm font-medium ${a.isLiability ? "text-negative" : ""}`}
                              />
                              <div className="text-[10px] text-ink-faint">
                                {a.isLiability ? "owed · " : ""}
                                as of {a.balance.asOf}
                              </div>
                            </>
                          ) : (
                            <span className="text-xs text-ink-faint">no balance yet</span>
                          )}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <SurfaceCard>
          <h2 className="mb-4 text-sm font-medium">Add an account</h2>
          <AccountForm institutions={institutions} />
        </SurfaceCard>
      </div>
    </>
  );
}
