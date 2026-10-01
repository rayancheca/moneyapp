"use client";

import { useCallback, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveViewPreferenceAction } from "@/app/settings/actions";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { SankeyChart } from "@/components/charts/SankeyChart";
import { NetWorthBridge } from "@/components/charts/NetWorthBridge";
import { CATEGORY_HUE_NAMES, categoryHueVar } from "@/lib/category-palette";
import { DAILY_SERIES_RANGES, rangeLabel, type ChartRange } from "@/lib/chart-range";
import type { SankeyGraph } from "@/lib/sankey-layout";
import { viewHrefQuery, type ViewState } from "@/lib/view-state";
import { DASHBOARD_CHART_DIMENSION, DASHBOARD_SURFACE, DASHBOARD_VIEW_SPEC } from "./dashboard-view-spec";
import type { NetWorthPoint } from "@/services/derivation";
import type { DashboardAccountOption, DashboardChartData } from "@/services/dashboard-series";
import type { NetWorthAttribution } from "@/services/attribution";
import { useViewState } from "@/hooks/useViewState";
import { ChartFocus } from "@/components/charts/ChartFocus";
import { NetWorthTerrain } from "@/components/charts/NetWorthTerrain";
import { DashboardModePanel } from "./DashboardModePanel";
import { NetWorthChartPanel } from "./NetWorthChartPanel";

const EMPTY_GRAPH: SankeyGraph = { nodes: [], links: [] };

/**
 * The hero chart's view modes (pass-17 ask C): a ViewSwitcher flips the single
 * net-worth line into assets / liabilities-owed / split / per-account layered
 * lines. Mode "combined" renders the EXACT pre-existing NetWorthChartPanel
 * (coverage naming, live dot, in-transit marks — byte-identical default); the
 * other modes render the multi-series engine's output. The same panel renders
 * inside ChartFocus's inline card AND its dialog, so focus mode carries the
 * view structurally. Mode persists via view-state (URL > preference > default);
 * the account selection rides a sibling `accts` param validated server-side.
 */

const MODE_LABELS: Record<string, string> = {
  combined: "Net worth",
  assets: "Assets",
  liabilities: "Owed",
  split: "Split",
  accounts: "Accounts",
  sankey: "Flow",
  terrain: "Terrain",
  bridge: "Bridge",
};

/** stride-5 walk over the 12-hue ramp — adjacent accounts get distant hues
 *  (same trick as the allocation donut) */
export function accountColor(index: number): string {
  return categoryHueVar(CATEGORY_HUE_NAMES[(index * 5) % CATEGORY_HUE_NAMES.length]!);
}

interface DashboardChartSectionProps {
  /** the combined-mode series (rich coverage annotations) */
  netWorthPoints: readonly (NetWorthPoint & { inTransitCents?: number })[];
  /** non-combined mode data; null when mode === "combined" */
  chartData: DashboardChartData | null;
  state: ViewState;
  accounts: readonly DashboardAccountOption[];
  /** the validated selection the RSC built the series with */
  selectedAccountIds: readonly string[];
  /** the durable account selection (URL ?? persisted), independent of mode, so
   *  it can be carried on the URL across mode switches even from non-accounts
   *  modes where the RSC returns no selection */
  acctsParam: string;
  /** money-flow graphs precomputed per range pill; present only in sankey mode */
  sankeyByRange: Record<ChartRange, SankeyGraph> | null;
  /** one net-worth decomposition per range pill; present only in bridge mode */
  bridgeByRange: Record<ChartRange, NetWorthAttribution> | null;
  today: string;
}

export function DashboardChartSection({
  netWorthPoints,
  chartData,
  state,
  accounts,
  selectedAccountIds,
  acctsParam,
  sankeyByRange,
  bridgeByRange,
  today,
}: DashboardChartSectionProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // "sankey" is a hero-chart view but not a net-worth series MODE, so keep it a
  // plain string; only the ScrubChart branch narrows to DashboardMode.
  const mode = state.chart ?? "combined";

  // the accts selection must SURVIVE a mode switch (it's not a spec dimension,
  // so setView/persistence don't carry it) — thread the durable resolved value
  // onto every mode-switch URL so returning to accounts keeps the curated set
  const baseParams = useMemo<Record<string, string>>(() => {
    const params: Record<string, string> = {};
    if (acctsParam) params.accts = acctsParam;
    return params;
  }, [acctsParam]);
  const { setView } = useViewState({
    surface: DASHBOARD_SURFACE,
    spec: DASHBOARD_VIEW_SPEC,
    state,
    basePath: "/",
    baseParams,
  });

  // color identity is stable per ACCOUNT (its position in the full account
  // list), not per selection — deselecting one never recolors the rest
  const colorByKey = useMemo(() => {
    const colors: Record<string, string> = {};
    accounts.forEach((a, i) => {
      colors[a.id] = accountColor(i);
    });
    // fixed hues for the rollup overlays
    colors["liabilities"] = categoryHueVar("red");
    colors["assets"] = categoryHueVar("teal");
    return colors;
  }, [accounts]);

  const toggleAccount = useCallback(
    (id: string) => {
      const current = new Set(selectedAccountIds);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      if (current.size === 0) return; // an empty chart is never a valid target
      const ordered = accounts.filter((a) => current.has(a.id)).map((a) => a.id);
      const accts = ordered.join(",");
      const href = `/${viewHrefQuery(DASHBOARD_VIEW_SPEC, state, { accts })}`;
      startTransition(async () => {
        try {
          await saveViewPreferenceAction(DASHBOARD_SURFACE, { ...state, accts });
        } catch {
          /* persistence is best-effort — the URL drives the render */
        }
        router.push(href, { scroll: false });
      });
    },
    [accounts, selectedAccountIds, state, router],
  );

  const series = chartData?.series ?? [];

  return (
    <ChartFocus
      label={MODE_LABELS[mode] ?? "Net worth"}
      renderPanel={({ heightClass, activeRange, onRangeChange }) => (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <ViewSwitcher
              dimension={DASHBOARD_CHART_DIMENSION}
              value={mode}
              onSelect={(v) => setView("chart", v)}
              labels={MODE_LABELS}
              ariaLabel="Net worth chart view"
            />
            {mode === "accounts" && (
              <div role="group" aria-label="Accounts shown" className="flex flex-wrap gap-1">
                {accounts.map((a) => {
                  const active = selectedAccountIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleAccount(a.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors duration-(--duration-fast) ${
                        active
                          ? "border-line-strong bg-surface-raised font-medium text-ink"
                          : "border-line text-ink-faint hover:text-ink"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="inline-block size-2 rounded-full"
                        style={{ background: colorByKey[a.id], opacity: active ? 1 : 0.35 }}
                      />
                      {a.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {mode === "bridge" ? (
            <div>
              {/* Same shape as the Sankey below: no scrubbable time axis, so the
                  bridge carries its OWN range pills driven by the
                  ChartFocus-lifted range, and reads a server-precomputed
                  decomposition per pill so a click costs no round-trip. */}
              <div
                role="group"
                aria-label="Bridge range"
                className="mb-3 flex w-fit flex-wrap gap-1 rounded-full bg-surface-sunken p-1"
              >
                {DAILY_SERIES_RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={activeRange === r}
                    aria-label={rangeLabel(r)}
                    onClick={() => onRangeChange(r)}
                    className={`rounded-full px-3 py-1 text-xs transition-colors duration-(--duration-fast) ${
                      activeRange === r ? "bg-surface-raised font-medium shadow-sm" : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {bridgeByRange?.[activeRange] ? (
                <NetWorthBridge
                  attribution={bridgeByRange[activeRange]}
                  windowLabel={rangeLabel(activeRange).toLowerCase()}
                  lens={state.bridgeLens ?? "chart"}
                  onSelectLens={(v) => setView("bridgeLens", v)}
                  {...(heightClass ? { heightClass } : {})}
                />
              ) : (
                <p className="py-8 text-center text-sm text-ink-muted">
                  Net worth has not moved in this range.
                </p>
              )}
            </div>
          ) : mode === "sankey" ? (
            <div>
              {/* the Sankey has no scrubbable time axis, so it carries its OWN
                  range pills (same windows as the chart), controlled by the
                  ChartFocus-lifted range so focus mode keeps the selection.
                  `flex-wrap` for the same reason ViewSwitcher carries it: seven
                  pills are 327px of min-content and the 320 floor gives 288, so
                  without it this row pushes the whole page sideways. Wrapping
                  makes the row's minimum one pill, so appending an eighth range
                  costs a second line and never a scrollbar. */}
              <div
                role="group"
                aria-label="Flow range"
                className="mb-3 flex w-fit flex-wrap gap-1 rounded-full bg-surface-sunken p-1"
              >
                {DAILY_SERIES_RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={activeRange === r}
                    aria-label={rangeLabel(r)}
                    onClick={() => onRangeChange(r)}
                    className={`rounded-full px-3 py-1 text-xs transition-colors duration-(--duration-fast) ${
                      activeRange === r ? "bg-surface-raised font-medium shadow-sm" : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <SankeyChart
                graph={sankeyByRange?.[activeRange] ?? EMPTY_GRAPH}
                heightClass={heightClass}
                ariaLabel={`Money flow · ${rangeLabel(activeRange)}`}
                emptyLabel="No money flow in this range."
                lens={state.sankeyLens ?? "flow"}
                onSelectLens={(v) => setView("sankeyLens", v)}
              />
            </div>
          ) : mode === "terrain" ? (
            /* the SAME per-account series `accounts` draws as lines, drawn
               spatially instead — one ribbon per account over time, assets
               above the zero plane and what is owed below it. `netWorthPoints`
               is the in-flight-bridged hero series, which is exactly the
               reference the terrain reconciles itself against and states the
               result of; it carries `complete` and `inTransitCents` already,
               so nothing is recomputed for a second opinion. No range pills:
               the terrain's whole subject is the full two years at once. */
            <NetWorthTerrain
              series={series}
              reference={netWorthPoints}
              today={today}
              colorByKey={colorByKey}
              /* the terrain's lens and camera are this surface's view state,
                 resolved by the RSC and written back through the same
                 `setView` the chart pills use — so both are linkable and both
                 survive a reload */
              lens={state.terrainLens ?? "relief"}
              viewpoint={state.terrainView ?? "quarter"}
              onSelectLens={(v) => setView("terrainLens", v)}
              onSelectViewpoint={(v) => setView("terrainView", v)}
              {...(heightClass ? { heightClass } : {})}
            />
          ) : mode === "combined" ? (
            <NetWorthChartPanel
              points={netWorthPoints}
              today={today}
              heightClass={heightClass}
              activeRange={activeRange}
              onRangeChange={onRangeChange}
            />
          ) : (
            <DashboardModePanel
              series={series}
              colorByKey={colorByKey}
              colorPrimary={mode === "accounts"}
              pickLongestPrimary={mode === "accounts"}
              today={today}
              heightClass={heightClass}
              activeRange={activeRange}
              onRangeChange={onRangeChange}
            />
          )}
        </div>
      )}
    />
  );
}
