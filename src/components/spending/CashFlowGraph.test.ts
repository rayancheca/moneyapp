import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Line, LineChart, Tooltip, type DotItemDotProps } from "recharts";
import { describe, expect, test } from "vitest";
import type { CashCumulativePoint, PlottedRunningTotal } from "@/lib/cash-flow-cumulative";
import type { UnreachedKind } from "@/lib/empty-period";
import type { CashFlow, CashFlowBucket } from "@/services/spending";
import { CashFlowGraph, RunningTotalTooltip } from "./CashFlowGraph";

const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");

/**
 * September 2026 on the owner's ledger, read-only: $1,431.05 spent through
 * Sep 12, the newest active row, 8¢ earned and nothing refunded — a running Net
 * of -$1,430.97 (`cashFlowByPeriod` → `cashFlowCumulative`, read 2026-09-15).
 * Sep 13 and later carry the same running totals, because nothing past Sep 12
 * has been imported — and the tooltip said "Through 13 … Spent $1,431.05" of a
 * day no import has reached, "Through 30" of one that has not happened.
 *
 * 🔴 This fixture said "nothing earned" and put Net at -$1,431.05; the
 * ledger's Sep 12 row reads earnedCum 8, netCum -143,097.
 */
const point = (key: string, label: string): CashCumulativePoint => ({
  key,
  label,
  earnedCum: 8,
  refundsCum: 0,
  spentCum: 143_105,
  netCum: -143_097,
  ghostCum: null,
  ghostWhole: false,
});

function render(
  p: CashCumulativePoint,
  unreached: Parameters<typeof RunningTotalTooltip>[0]["unreached"],
  incomeUnread: Parameters<typeof RunningTotalTooltip>[0]["incomeUnread"] = null,
): string {
  return textOf(
    renderToStaticMarkup(
      createElement(RunningTotalTooltip, { point: p, unreached, incomeUnread, hasRefunds: false, priorLabel: null }),
    ),
  );
}

/**
 * ⚖️ §6A 68 on the graph lens: through a point no income has been found by and not one of whose days is checked where
 * his pay lands (`runningIncomeUnread`), the running Income is no measurement — and Net, its arithmetic, with it. 🔴 On
 * his ledger copy 2026-10-21 `/spending?cash=graph` hovered Oct 14 "Through 14 · Income $0.00 · Spent $1,603.00 · Net
 * −$1,603.00" (`cashFlowByPeriod` → `cashFlowCumulative`), Wells Fargo checked through Sep 24, beside cards, a table and
 * a chart hover printing "—" for both; `?period=2026-Q4` said the same "Through Oct".
 */
describe("CashFlowGraph's tooltip — a running Income nobody has looked for", () => {
  const oct14: CashCumulativePoint = {
    key: "2026-10-14",
    label: "14",
    earnedCum: 0,
    refundsCum: 0,
    spentCum: 160_300,
    netCum: -160_300,
    ghostCum: null,
    ghostWhole: false,
  };

  test("dashes Income and Net, keeps Spent, and says why of the days it sums", () => {
    const text = render(oct14, null, { from: "2026-10-01", to: "2026-10-14" });
    expect(text).toContain("Through 14");
    expect(text).toContain("$1,603.00");
    expect(text).not.toContain("$0.00");
    expect(text).not.toMatch(/[−-]\$1,603\.00/);
    expect(text.match(/—/g)).toHaveLength(2);
    expect(text).toContain("not one day of Oct 1 – 14, 2026 has been checked in the accounts that pay lands in");
  });

  /*
   * ⚖️ …named by the days it sums, never by its bucket's axis label (2026-10-29). 🔴 His ledger copy 2026-10-29:
   * `?from=2026-09-26&to=2026-12-31` hovered "not one day through Sep 26–30 has been checked …" and "… through Oct …",
   * `?period=2026-Q4` "… through Oct …", and `?from=2026-09-25&to=2027-03-31` "… through Sep 25–30 '26 …".
   */
  test("a month's point, or a clipped one, names the days from the run's first through its own last", () => {
    const oct: CashCumulativePoint = { ...oct14, key: "2026-10", label: "Oct" };
    const text = render(oct, null, { from: "2026-09-26", to: "2026-10-31" });
    expect(text).toContain("Through Oct");
    expect(text).toContain("not one day of Sep 26 – Oct 31, 2026 has been checked in the accounts that pay lands in");
    expect(text).not.toMatch(/through Oct has/);
    const sep = { ...oct14, key: "2026-09", label: "Sep 26–30" };
    const clipped = render(sep, null, { from: "2026-09-26", to: "2026-09-30" });
    expect(clipped).toContain("not one day of Sep 26 – 30, 2026 has been checked in the accounts that pay lands in");
    expect(clipped).not.toContain("through Sep 26–30");
  });

  test("a point summing one day says that day has not been checked, as the table says of it", () => {
    const text = render({ ...oct14, key: "2026-10-01", label: "1" }, null, { from: "2026-10-01", to: "2026-10-01" });
    expect(text).toContain("Oct 1, 2026 has not been checked in the accounts that pay lands in");
    expect(text).not.toContain("not one day");
  });

  test("a running Income that is a figure prints it, as before", () => {
    const text = render(oct14, null, null);
    expect(text).toContain("$0.00");
    expect(text).not.toContain("pay lands in");
  });
});

describe("CashFlowGraph's tooltip — a running total is only as far as the ledger reads", () => {
  test("the newest imported day states its running totals", () => {
    const text = render(point("2026-09-12", "12"), null);
    expect(text).toContain("Through 12");
    expect(text).toContain("Income");
    expect(text).not.toContain("Earned");
    expect(text).toContain("$1,431.05");
    expect(text).toContain("$0.08");
    expect(text).toContain("$1,430.97");
  });

  test("a day not imported yet does not claim a running total through it", () => {
    const text = render(point("2026-09-13", "13"), "after-records");
    expect(text).not.toContain("Through");
    expect(text).not.toContain("$1,431.05");
    expect(text).toContain("not imported yet");
  });

  test("nor does a day that has not happened, or one before the records begin", () => {
    expect(render(point("2026-09-30", "30"), "future")).toContain("has not happened yet");
    expect(render(point("2026-09-30", "30"), "future")).not.toContain("Through");
    expect(render(point("2022-08-24", "24"), "before-records")).toContain("before your records begin");
  });

  /**
   * ⛔ The prior period's figure is a fact about THAT period, and stays (owner
   * decision E1a).
   *
   * 🔴 This fixture put 3,451¢ in the slot — Aug 13, 2026's spend ALONE — under
   * "Spent by here", which names a RUNNING total, in a file whose figures are
   * said to be the owner's ledger. August 2026's running spend through Aug 13 is
   * 993,587¢ (`cashFlowByPeriod` over 2026-08 → `cashFlowCumulative`, read
   * 2026-09-15); Aug 13 on its own is the 3,451.
   *
   * ⚠️ The STATE is constructed: the ledger refuses September's comparison with
   * August, so no prior-period line stands beside Sep 13 there. The figure is
   * the one it would carry at that position — index-aligned, Aug 1–13.
   */
  test("the prior period's running total is still given beside an unreached point", () => {
    const text = renderToStaticMarkup(
      createElement(RunningTotalTooltip, {
        point: { ...point("2026-09-13", "13"), ghostCum: 993_587 },
        unreached: "after-records",
        incomeUnread: null,
        hasRefunds: false,
        priorLabel: "August 2026",
      }),
    );
    expect(textOf(text)).toContain("Spent by here, August 2026");
    expect(textOf(text)).toContain("$9,935.87");
  });
});

/**
 * 🔴 ONE BUCKET READ, NO LINE AT ALL. The lines end where the ledger does
 * (`plottedRunningTotals`), and every one of them was `dot={false}` — so a
 * window with exactly one bucket read showed axes and a legend naming Earned,
 * Spent and Net over no line at all. Reachable on the e2e fixture at
 * `?period=2026-Q3` (fake today 2026-07-08, newest row 2026-07-04: July alone
 * read of three months). See `isLonePoint`.
 */
describe("CashFlowGraph — a line with one point read still shows that point", () => {
  type LineProps = { dataKey: string; stroke: string; dot: unknown; children?: ReactNode };

  /** the chart's <Line> elements, in the order it declares them — read off the element tree, no DOM */
  function linesIn(node: ReactNode): ReactElement<LineProps>[] {
    if (Array.isArray(node)) return node.flatMap(linesIn);
    if (!isValidElement<LineProps>(node)) return [];
    return node.type === Line ? [node] : linesIn(node.props.children);
  }

  /** the points the chart is handed (`LineChart`'s data) — what each line draws */
  function chartDataIn(node: ReactNode): PlottedRunningTotal[] {
    const found: PlottedRunningTotal[][] = [];
    const walk = (n: ReactNode): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!isValidElement<{ data?: PlottedRunningTotal[]; children?: ReactNode }>(n)) return;
      if (n.type === LineChart) found.push(n.props.data!);
      walk(n.props.children);
    };
    walk(node);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  /** what a line's `dot` draws at one point, given the props recharts passes it */
  function dotAt(line: ReactElement<LineProps>, index: number): string {
    expect(typeof line.props.dot).toBe("function");
    const props: DotItemDotProps = {
      index,
      cx: 40 + index * 10,
      cy: 20,
      points: [],
      payload: {},
      dataKey: line.props.dataKey,
      value: null,
    };
    const drawn = (line.props.dot as (p: DotItemDotProps) => ReactNode)(props);
    return renderToStaticMarkup(createElement("svg", null, drawn));
  }

  const monthBucket = (
    key: string,
    incomeCents: number,
    spendingCents: number,
    unreached: UnreachedKind | null,
  ): CashFlowBucket => ({
    key,
    label: key,
    from: `${key}-01`,
    to: `${key}-28`,
    income: {},
    spending: {},
    incomeCents,
    spendingCents,
    refundsCents: 0,
    netCents: incomeCents - spendingCents,
    unreached,
    spendingUnaccounted: null,
    incomeUnread: false,
  });

  const linesOf = (buckets: CashFlowBucket[]) => {
    const data: CashFlow = {
      buckets,
      incomeSeries: [],
      spendingSeries: [],
      totals: {} as CashFlow["totals"],
      pace: null,
      spendingUnaccounted: null,
      incomeUnread: false,
    };
    return linesIn(CashFlowGraph({ data, projection: null }));
  };

  // the SHAPE of the fixture's `?period=2026-Q3`; the cents are constructed
  const quarter = [
    monthBucket("2026-07", 100_000, 40_000, null),
    monthBucket("2026-08", 0, 0, "future"),
    monthBucket("2026-09", 0, 0, "future"),
  ];

  test("each of the period's own lines marks its one point, and nothing else", () => {
    const lines = linesOf(quarter);
    expect(lines.map((l) => l.props.dataKey)).toEqual(["earnedCum", "spentCum", "netCum"]);
    for (const line of lines) {
      expect(dotAt(line, 0)).toContain("<circle");
      expect(dotAt(line, 1)).toBe("<svg></svg>");
      expect(dotAt(line, 2)).toBe("<svg></svg>");
    }
  });

  test("the mark sits where recharts places the point, in the line's own colour", () => {
    const spent = linesOf(quarter).find((l) => l.props.dataKey === "spentCum")!;
    const markup = dotAt(spent, 0);
    expect(markup).toContain('cx="40"');
    expect(markup).toContain('cy="20"');
    expect(markup).toContain(`fill="${spent.props.stroke}"`);
  });

  /* ⚖️ §6A 68: the lines draw what the tooltip prints — no running Income or Net through days nobody has looked at */
  test("a window whose income nobody has looked for draws Spent alone, and its caption says why", () => {
    const unread = (key: string, spendingCents: number): CashFlowBucket => ({
      ...monthBucket(key, 0, spendingCents, null),
      incomeUnread: true,
    });
    const october = [unread("2026-10-01", 21_661), unread("2026-10-02", 19_758)];
    const data: CashFlow = {
      buckets: october,
      incomeSeries: [],
      spendingSeries: [],
      totals: {} as CashFlow["totals"],
      pace: null,
      spendingUnaccounted: null,
      incomeUnread: true,
    };
    const tree = CashFlowGraph({ data, projection: null });
    const plotted = chartDataIn(tree);
    expect(plotted.map((p) => [p.earnedCum, p.netCum])).toEqual([[null, null], [null, null]]);
    expect(plotted.map((p) => p.spentCum)).toEqual([21_661, 41_419]);
    const caption = (d: CashFlow) =>
      textOf(renderToStaticMarkup(createElement(CashFlowGraph, { data: d, projection: null })));
    expect(caption(data)).toContain(
      "Income and Net are not drawn while not one day has been checked in the accounts that pay lands in.",
    );
    // a window read as before carries no such caption
    expect(caption({ ...data, buckets: quarter, incomeUnread: false })).not.toContain("pay lands in");
  });

  test("a line with a segment to draw carries no marks", () => {
    const lines = linesOf([
      monthBucket("2026-06", 90_000, 30_000, null),
      monthBucket("2026-07", 100_000, 40_000, null),
      monthBucket("2026-08", 0, 0, "future"),
    ]);
    for (const line of lines) for (const i of [0, 1, 2]) expect(dotAt(line, i)).toBe("<svg></svg>");
  });
});

/*
 * ⚖️ §6A 68: the graph hands each hover the days its running Income sums (`runningIncomeUnreadDays`, the lines' own
 * rule), so a month's point and a clipped one read as cleanly as a day's (2026-10-29). His ledger copy 2026-10-29,
 * `?from=2026-09-26&to=2026-12-31` (`cashFlowByPeriod`), Wells Fargo checked through Sep 24.
 */
describe("CashFlowGraph — each hover is handed the days its running Income sums", () => {
  type HoverContent = (props: { active: boolean; payload: unknown[]; label: string }) => ReactNode;

  /** what hovering the point keyed `label` renders — the chart's own <Tooltip> content, read off the element tree */
  function hoverOf(node: ReactNode): (label: string) => string {
    const found: HoverContent[] = [];
    const walk = (n: ReactNode): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!isValidElement<{ content?: HoverContent; children?: ReactNode }>(n)) return;
      if (n.type === Tooltip && n.props.content !== undefined) found.push(n.props.content);
      walk(n.props.children);
    };
    walk(node);
    expect(found).toHaveLength(1);
    return (label) =>
      textOf(renderToStaticMarkup(createElement("div", null, found[0]!({ active: true, payload: [{}], label }))));
  }

  const month = (
    key: string,
    from: string,
    to: string,
    label: string,
    over: Partial<CashFlowBucket>,
  ): CashFlowBucket => ({
    key,
    label,
    from,
    to,
    income: {},
    spending: {},
    incomeCents: 0,
    spendingCents: 0,
    refundsCents: 0,
    netCents: 0,
    unreached: null,
    spendingUnaccounted: null,
    incomeUnread: false,
    ...over,
  });

  test("his copy's Sep 26 – Dec 31: the clipped September and October name their days, not their axis labels", () => {
    const buckets = [
      month("2026-09", "2026-09-26", "2026-09-30", "Sep 26–30", {
        spendingCents: 124_150,
        refundsCents: 1_516,
        netCents: -122_634,
        incomeUnread: true,
      }),
      month("2026-10", "2026-10-01", "2026-10-31", "Oct", {
        spendingCents: 160_300,
        netCents: -160_300,
        incomeUnread: true,
      }),
      month("2026-11", "2026-11-01", "2026-11-30", "Nov", { unreached: "future" }),
      month("2026-12", "2026-12-01", "2026-12-31", "Dec", { unreached: "future" }),
    ];
    const data: CashFlow = {
      buckets,
      incomeSeries: [],
      spendingSeries: [],
      totals: {} as CashFlow["totals"],
      pace: null,
      spendingUnaccounted: null,
      incomeUnread: true,
    };
    const hover = hoverOf(CashFlowGraph({ data, projection: null }));
    expect(hover("2026-09")).toContain(
      "not one day of Sep 26 – 30, 2026 has been checked in the accounts that pay lands in",
    );
    expect(hover("2026-10")).toContain(
      "not one day of Sep 26 – Oct 31, 2026 has been checked in the accounts that pay lands in",
    );
    for (const key of ["2026-09", "2026-10"]) expect(hover(key)).not.toMatch(/through (Sep 26–30|Oct) has/);
    // a month not reached says its own world, and no running total
    expect(hover("2026-11")).toContain("has not happened yet");
  });
});
