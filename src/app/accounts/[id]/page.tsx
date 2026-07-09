import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { isLiability } from "@/db/schema/accounts";
import { todayIso } from "@/lib/dates";
import { getAccount } from "@/services/accounts";
import { listAnchors } from "@/services/anchors";
import { AnchorForm } from "@/components/accounts/AnchorForm";
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
  const anchors = [...listAnchors(db, id)].reverse();

  return (
    <>
      <PageHeader
        title={account.name}
        description={`${account.type}${account.subtype ? ` · ${account.subtype}` : ""}${account.last4 ? ` · ····${account.last4}` : ""}${account.isActive ? "" : " · archived"}`}
      />
      <div className="space-y-6">
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
          <h2 className="mb-3 text-sm font-medium">Balance history</h2>
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
