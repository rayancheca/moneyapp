import { inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { transactions } from "@/db/schema/transactions";
import { buildDashboardSeries, type AccountSeriesInput, type DashboardMode } from "@/lib/multi-series";
import { bridgeDashboardSeries, type BridgedDashboardSeries } from "@/lib/multi-series-bridge";
import { balanceDayIsExact } from "./coverage";
import { accountSeries } from "./derivation";
import { listAccounts } from "./accounts";
import { transferFloats } from "./in-flight";

/**
 * Data assembly for the dashboard chart's view modes (pass-17 ask C): feeds
 * lib/multi-series with every active account's daily curve and applies the
 * in-flight law per rollup — money in the air is the user's ASSET, so the
 * combined and assets rollups bridge (docs/inflight-dips.md); the
 * liabilities-owed rollup and per-account lines stay untouched (an individual
 * ledger honestly dipped/spiked while the money moved).
 *
 * NOTE the combined MODE here exists for completeness — the dashboard renders
 * mode "combined" through the richer netWorthSummary path (per-day coverage
 * naming, live dot), which multi-series matches point-for-point by
 * construction. The other four modes render from this service.
 */

export interface DashboardAccountOption {
  id: string;
  label: string;
  isLiability: boolean;
}

export interface DashboardChartData {
  mode: DashboardMode;
  series: BridgedDashboardSeries[];
  /** every active account, display order — the "accounts" mode multi-select */
  accounts: DashboardAccountOption[];
  /** the validated selection the series were built with (mode "accounts") */
  selectedAccountIds: string[];
}

function seriesInputs(db: AppDatabase): { inputs: AccountSeriesInput[]; options: DashboardAccountOption[] } {
  const active = listAccounts(db).filter((a) => a.isActive);
  /*
   * ⛔ The ledger's own answer to "does this account hold anything at all",
   * built the way `derivation` builds it — the same statuses, so the two
   * surfaces cannot disagree about whether `Capital One 360 Checking` is a hole
   * or an empty account. See `splitMissing`, and `rollupLine`'s docstring for
   * what the dashboard printed while this was missing.
   */
  const accountsWithRows = new Set(
    db
      .selectDistinct({ accountId: transactions.accountId })
      .from(transactions)
      .where(inArray(transactions.status, ["active", "excluded"]))
      .all()
      .map((r) => r.accountId),
  );
  const inputs: AccountSeriesInput[] = active.map((a) => ({
    id: a.id,
    label: a.name,
    isLiability: a.isLiability,
    hasHistory: accountsWithRows.has(a.id),
    points: accountSeries(db, a.id).map((p) => ({
      day: p.day,
      balanceCents: p.balanceCents,
      // ⛔ `coverage`'s rule, never a local set — see `balanceDayIsExact`
      exact: balanceDayIsExact(a.type, p.basis),
    })),
  }));
  const options = active.map((a) => ({ id: a.id, label: a.name, isLiability: a.isLiability }));
  return { inputs, options };
}

/**
 * Build the chart series for one view mode. `requestedAccountIds` (mode
 * "accounts" only) is validated against active accounts; an empty/invalid
 * selection falls back to every active account so the mode never renders
 * an empty chart from a stale URL or preference.
 */
export function dashboardChartData(
  db: AppDatabase,
  mode: DashboardMode,
  requestedAccountIds: readonly string[] = [],
): DashboardChartData {
  const { inputs, options } = seriesInputs(db);
  const validIds = new Set(options.map((o) => o.id));
  const selected = requestedAccountIds.filter((id) => validIds.has(id));
  const selectedAccountIds =
    mode === "accounts" ? (selected.length > 0 ? selected : options.map((o) => o.id)) : [];

  const built = buildDashboardSeries(inputs, { mode, accountIds: selectedAccountIds });

  // the in-flight law: bridge the rollups that hold the user's whole asset
  // picture; never the owed frame or an individual account's own ledger
  const floats = mode === "combined" || mode === "assets" || mode === "split" ? transferFloats(db) : [];
  const series = built.map((s) =>
    (s.key === "net" || s.key === "assets") && !s.owedFrame ? bridgeDashboardSeries(s, floats) : bridgeDashboardSeries(s, []),
  );

  return { mode, series, accounts: options, selectedAccountIds };
}
