import type { Metadata } from "next";

import { TransferFlowPanel } from "@/components/charts/TransferFlowPanel";
import { TransferReconciliation } from "@/components/charts/TransferReconciliation";
import { FLOW_SURFACE, FLOW_VIEW_SPEC } from "@/components/charts/transfer-flow-view-spec";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { getDb } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { resolveViewState } from "@/lib/view-state";
import { readSettings } from "@/services/settings";
import { transferFlow } from "@/services/transfer-flow";

export const metadata: Metadata = { title: "Flow" };
export const dynamic = "force-dynamic";

/**
 * /flow — money moving between the owner's OWN accounts.
 *
 * This is the one part of his financial life the app deliberately renders
 * nowhere else: `spendingSankey` excludes transfers so it does not double-count
 * every dollar, which is correct there and leaves 12–28 transfers a month with
 * no home. This route is purely ADDITIVE — no existing chart, total or feed
 * changes because it exists.
 *
 * RSC-first: the service runs on the server and the summary rail, the spine and
 * the matrix stream as HTML, so the numbers are on screen before any client JS.
 */

const START_OF_TIME = "2000-01-01";

export default async function FlowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const db = getDb();
  const settings = readSettings(db);
  const range = { from: START_OF_TIME, to: todayIso() };
  const data = transferFlow(db, range);

  // Every dimension the spec declares must be named here too. A dimension
  // missing from this map still works from its pill (setView persists, then
  // navigates, and the persisted value wins) — so it LOOKS fine, and only a
  // shared link or a hard reload exposes that the `?param=` was ignored.
  const view = resolveViewState(
    FLOW_VIEW_SPEC,
    { measure: one(raw.measure), shape: one(raw.shape), towerView: one(raw.towerView), lens: one(raw.lens) },
    settings.viewPreferences[FLOW_SURFACE],
  );

  const churnPct =
    data.totals.grossCents > 0
      ? Math.round((data.totals.churnCents / data.totals.grossCents) * 1000) / 10
      : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Flow"
        description="Money moving between your own accounts — where it settles, and how much of it is just churn."
      />

      {data.edges.length === 0 ? (
        <EmptyState
          title="No transfers yet"
          description="Once two of your accounts move money between each other, this is where that shows up. Transfers are deliberately kept out of spending so they are never counted twice."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Gross moved"
              value={formatCents(data.totals.grossCents)}
              delta={`${data.totals.pairedGroupCount} transfers`}
            />
            <StatCard
              label="Net moved"
              value={formatCents(data.totals.netCents)}
              delta="what actually changed hands"
              emphasis="key"
            />
            <StatCard
              label="Round-tripped"
              value={formatCents(data.totals.churnCents)}
              /* 🔴 `churnCents` counts BOTH legs — `2 * min(out, back)` in
                 transfer-flow.ts — so of the $107,852.26 on this card only
                 $53,926.13 came back; the rest is the money that went out to
                 make it a round trip. "came back" named half the figure it was
                 mounted on. The edge tooltips are right: `returnedCents` there
                 really is one leg. */
              delta={`${churnPct}% of gross went out and came back`}
            />
            <StatCard
              label="Accounts"
              value={String(data.accounts.length)}
              delta={`${data.edges.length} routes · ${data.months.length} months`}
            />
          </div>

          <SurfaceCard>
            <TransferFlowPanel data={data} state={view} range={range} />
          </SurfaceCard>

          {/* Reconciliation is shown, never swallowed — see TransferReconciliation. */}
          <TransferReconciliation totals={data.totals} />
        </>
      )}
    </div>
  );
}
