import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposedChart, Line, type DotItemDotProps } from "recharts";
import { describe, expect, test, vi } from "vitest";
import type { CashFlow, CashFlowBucket, SpendingProjection } from "@/services/spending";
import { CashFlowBucketTooltip, CashFlowChart } from "./CashFlowChart";

// the readout never navigates; the chart's click handlers only need a router to exist
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

/**
 * September 2026 on the real ledger, 2026-09-14 (newest active row Sep 12): every
 * figure below is what `cashFlowByPeriod` and `spendingProjection` returned for
 * it, read-only. Its 30 day buckets and 7 of its 8 spending series are left out —
 * the readout reads none of them, and one series is what draws the card at all.
 */
const HEALTH = "019f4c7d-cc8b-7322-ab85-d15512376000";
const SEPTEMBER: CashFlow = {
  buckets: [],
  incomeSeries: [],
  spendingSeries: [{ key: HEALTH, label: "Health", categoryId: HEALTH, hue: "red" }],
  totals: { earnedCents: 0, spentCents: 143_105, refundsCents: 0, netCents: -143_105, savingsRatePct: null },
  pace: {
    elapsedFraction: 14 / 30,
    actualToDateCents: 143_105,
    upfrontToDateCents: 0,
    projectedCents: 306_654,
    avgPerBucketCents: 10_222,
  },
  spendingUnaccounted: null,
  incomeUnread: false,
};
const PROJECTION: SpendingProjection = {
  projectedSpendCents: 306_654,
  paceBasis: "pace from 14 of 30 days elapsed",
  paceConfidence: 0.65,
  pacePartlyRead: { uncoveredDays: 2, line: "spending imported through Sep 12 · 2 days of this period unaccounted" },
  prior: null,
};

/** the markup's text, which is what a screen reader reads: tags, attributes and comments stripped */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "");
const occurrences = (text: string, phrase: string): number => text.split(phrase).length - 1;

function render(): string {
  return renderToStaticMarkup(
    createElement(CashFlowChart, { data: SEPTEMBER, projection: PROJECTION }),
  );
}

describe("CashFlowChart's pace readout", () => {
  /**
   * 🔴 The basis — also the sr-only span after the figure — carried the
   * not-imported clause, and the clause was its own visible part as well. A
   * screen reader heard it twice: "On pace for at least $3,066.54 — pace from 14
   * of 30 days elapsed; 2 days of September 2026 not imported yet spent this
   * period · at least $1,431.05 so far · 2 days of September 2026 not imported yet".
   *
   * ⚖️ The clause is the period proof's line now (decision 72) — the words "Where it went" prints under its chip.
   */
  test("says the unaccounted days once, to the eye and to a screen reader alike", () => {
    const html = render();
    const text = textOf(html);
    expect(occurrences(text, "unaccounted")).toBe(1);
    expect(text).toContain("On pace for at least $3,066.54 — pace from 14 of 30 days elapsed spent this period");
    expect(text).toContain(
      "at least $1,431.05 so far · spending imported through Sep 12 · 2 days of this period unaccounted",
    );
    expect(text).not.toContain("not imported yet");

    const srOnly = /<span class="sr-only">(.*?)<\/span>/.exec(html)?.[1];
    expect(srOnly === undefined ? null : textOf(srOnly)).toBe(" — pace from 14 of 30 days elapsed");
  });

  test("the method stays on hover, without the clause the readout already shows", () => {
    expect(render()).toContain('title="pace from 14 of 30 days elapsed"');
  });

  /*
   * 🔴 Review of 4d799b6: `first-letter:uppercase` went on the readout's <p> in EVERY state, for the one that opens with
   * "nothing found so far". ::first-letter boxes the "O" of "On pace for…" apart from the "n", which breaks their
   * kerning: 398.90625px → 398.921875px in Chromium at 12px Geist, and every /spending baseline's readout shifted under
   * a commit reporting "no change" on his page. ⛔ The opening word is capitalised in the TEXT, where it opens the line.
   */
  test("opens with a capital in its words, and leaves every other readout's letters alone", () => {
    expect(render()).not.toContain("first-letter");
    const nothing: CashFlow = {
      ...SEPTEMBER,
      totals: { ...SEPTEMBER.totals, spentCents: 0, netCents: 0 },
      pace: { ...SEPTEMBER.pace!, actualToDateCents: 0, projectedCents: 0, avgPerBucketCents: 0 },
      spendingUnaccounted: "spending imported through Jun 20",
    };
    const html = renderToStaticMarkup(createElement(CashFlowChart, { data: nothing, projection: PROJECTION }));
    expect(html).not.toContain("first-letter");
    expect(textOf(html)).toContain("Nothing found so far — spending imported through Jun 20");
    expect(textOf(html)).not.toContain("$0.00");
  });
});

/**
 * 🔴 S11, the chart lens. Hovering a bucket nobody has read printed "Earned
 * $0.00 · Spent $0.00 · Net $0.00" — the same measured zero the table lens
 * printed. September 2026 on the owner's ledger, 2026-09-14: Sep 12 holds $4.75
 * spent (the newest active row), Sep 13 has not been imported, Sep 15 has not
 * happened.
 */
describe("CashFlowChart's tooltip — a bucket the ledger has not reached", () => {
  const bucket = (key: string, label: string, over: Partial<CashFlowBucket> = {}): CashFlowBucket => ({
    key,
    label,
    from: key,
    to: key,
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
  const tooltip = (b: CashFlowBucket, ghostCents: number | null = null): string =>
    textOf(renderToStaticMarkup(createElement(CashFlowBucketTooltip, { bucket: b, ghostCents })));

  test("a reached bucket states its figures", () => {
    const text = tooltip(bucket("2026-09-12", "12", { spendingCents: 475, netCents: -475 }));
    expect(text).toContain("Spent$4.75");
    expect(text).toContain("Income$0.00");
    expect(text).not.toContain("Earned");
  });

  test("an unreached bucket says which world it is in, and prints no figure", () => {
    const text = tooltip(bucket("2026-09-13", "13", { unreached: "after-records" }));
    expect(text).toContain("not imported yet");
    expect(text).not.toContain("$0.00");
    expect(text).not.toContain("Income");
    expect(tooltip(bucket("2026-09-15", "15", { unreached: "future" }))).toContain("has not happened yet");
    expect(tooltip(bucket("2022-08-24", "24", { unreached: "before-records" }))).toContain("before your records begin");
  });

  /* ⛔ the prior period's bucket is a fact about THAT period (owner decision E1a) */
  test("the prior period's bucket is still given beside an unreached one", () => {
    const text = tooltip(bucket("2026-09-13", "13", { unreached: "after-records" }), 3_451);
    expect(text).toContain("Prior period, this point$34.51");
  });

  /*
   * ⚖️ Decisions 64 + 72. 🔴 On his ledger copy 2026-10-13 (review of 2fce458) `/spending?period=2026-09`'s default chart
   * hovered Sep 15 "Income $0.00 · Spent $0.00 · Net $0.00" and Sep 23 "Spent $0.00" beside its $4,567.68, under a
   * heatmap whose cells for the same days read "nothing found so far — spending imported through Aug 12".
   */
  test("a day past the day all his spending is read through, with nothing found, says that in the heatmap's words", () => {
    const text = tooltip(bucket("2026-09-15", "15", { spendingUnaccounted: "spending imported through Aug 12" }), 3_451);
    expect(text).toBe("15nothing found so far — spending imported through Aug 12Prior period, this point$34.51");
  });

  test("…and with its pay found, prints the pay and a dash under Spent and Net, and says why", () => {
    const pay = { incomeCents: 456_768, netCents: 456_768, spendingUnaccounted: "spending imported through Aug 12" };
    const text = tooltip(bucket("2026-09-23", "23", pay));
    expect(text).toContain("Income$4,567.68");
    expect(text).toContain("Spent—");
    expect(text).toContain("Net—");
    expect(text).toContain("nothing found so far — spending imported through Aug 12");
    expect(text).not.toContain("$0.00");
  });
});

/*
 * ⚖️ §6A 68 on /spending's buckets (2026-10-21): a bucket with no income found, not one of whose days is checked where
 * his pay lands, has no Income and no Net (`CashFlowBucket.incomeUnread`, the dashboard's rule). 🔴 On his ledger copy
 * 2026-10-21 `/spending` hovered Oct 14 "Income $0.00 · Spent $48.19 · Net -$48.19", Wells Fargo — where his pay lands —
 * checked through Sep 24, under a dashboard printing "—" for October's income.
 */
describe("CashFlowChart's tooltip — a bucket no day of which is checked where the pay lands", () => {
  const bucket = (key: string, over: Partial<CashFlowBucket> = {}): CashFlowBucket => ({
    key,
    label: key.length === 7 ? "Oct" : key.slice(8),
    from: key.length === 7 ? `${key}-01` : key,
    to: key.length === 7 ? `${key}-31` : key,
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
  const tooltip = (b: CashFlowBucket): string =>
    textOf(renderToStaticMarkup(createElement(CashFlowBucketTooltip, { bucket: b, ghostCents: null })));

  test("prints its spending, and a dash under Income and Net, and says why", () => {
    const text = tooltip(bucket("2026-10-14", { spendingCents: 4_819, netCents: -4_819, incomeUnread: true }));
    expect(text).toContain("Income—");
    expect(text).toContain("Spent$48.19");
    expect(text).toContain("Net—");
    expect(text).toContain("the day has not been checked in the accounts that pay lands in");
    expect(text).not.toContain("$0.00");
    // a month says it of the month
    const october = tooltip(bucket("2026-10", { spendingCents: 160_300, netCents: -160_300, incomeUnread: true }));
    expect(october).toContain("not one day of the month has been checked in the accounts that pay lands in");
  });

  test("with no spending found either, it says both", () => {
    const text = tooltip(bucket("2026-10-04", { spendingUnaccounted: "spending imported through Aug 12", incomeUnread: true }));
    expect(text).toBe(
      "04nothing found so far — spending imported through Aug 12the day has not been checked in the accounts that pay lands in",
    );
  });
});

/*
 * ⚖️ The Net line draws a bucket's Net only where its hover and the table print one (`bucketNetMeasured`): not past the
 * ledger's ends (S11), not where no spending was found past the day all of it is read through (decisions 64 + 72), not
 * where no income was found and not one day is checked where his pay lands (§6A 68). 🔴 His ledger copy 2026-10-29
 * (`cashFlowByPeriod` at today 2026-10-29; Wells Fargo checked through Sep 24, spending imported through Aug 12):
 * `/spending` drew October's Net through Oct 1–14 at −$216.61 … −$48.19 and on flat at $0.00 through Oct 15–31, and
 * `?period=2026-08` drew Aug 30 at $0.00 — each a bucket its hover and its table give no Net. Every figure below is that
 * reading's.
 */
describe("CashFlowChart's Net line — drawn only where its hover prints a Net", () => {
  type LineProps = { dataKey: string; stroke: string; dot: unknown };
  type ChartRow = { key: string; net: number | null };

  /** the element tree's elements of one component, in the order the chart declares them — read off the tree, no DOM */
  function elementsOf<P>(node: ReactNode, type: unknown): ReactElement<P>[] {
    if (Array.isArray(node)) return node.flatMap((n: ReactNode) => elementsOf<P>(n, type));
    if (!isValidElement<{ children?: ReactNode }>(node)) return [];
    const own = node.type === type ? [node as unknown as ReactElement<P>] : [];
    return [...own, ...elementsOf<P>(node.props.children, type)];
  }

  const day = (key: string, over: Partial<CashFlowBucket> = {}): CashFlowBucket => ({
    key,
    label: key.slice(8),
    from: key,
    to: key,
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
  const month = (key: string, over: Partial<CashFlowBucket> = {}): CashFlowBucket => ({
    ...day(key, over),
    label: key === "2026-10" ? "Oct" : key === "2026-11" ? "Nov" : "Dec",
    from: `${key}-01`,
    to: `${key}-${key === "2026-11" ? 30 : 31}`,
  });
  const dataOf = (buckets: CashFlowBucket[]): CashFlow => ({ ...SEPTEMBER, buckets, pace: null });
  const chartOf = (buckets: CashFlowBucket[]): ReactNode => CashFlowChart({ data: dataOf(buckets), projection: null });
  const netsOf = (buckets: CashFlowBucket[]): (number | null)[] => {
    const charts = elementsOf<{ data: ChartRow[] }>(chartOf(buckets), ComposedChart);
    expect(charts).toHaveLength(1);
    return charts[0]!.props.data.map((r) => r.net);
  };
  const netLineOf = (buckets: CashFlowBucket[]): ReactElement<LineProps> =>
    elementsOf<LineProps>(chartOf(buckets), Line).find((l) => l.props.dataKey === "net")!;
  /** what the line's `dot` draws at one point, given the props recharts passes it */
  function dotAt(line: ReactElement<LineProps>, index: number): string {
    expect(typeof line.props.dot).toBe("function");
    const props: DotItemDotProps = {
      index,
      cx: 40 + index * 10,
      cy: 20,
      points: [],
      payload: {},
      dataKey: "net",
      value: null,
    };
    const drawn = (line.props.dot as (p: DotItemDotProps) => ReactNode)(props);
    return renderToStaticMarkup(createElement("svg", null, drawn));
  }
  const hoverOf = (b: CashFlowBucket): string =>
    textOf(renderToStaticMarkup(createElement(CashFlowBucketTooltip, { bucket: b, ghostCents: null })));

  const FOUND_NOTHING = "spending imported through Aug 12";
  const october = [
    day("2026-10-01", { spendingCents: 21_661, netCents: -21_661, incomeUnread: true }),
    day("2026-10-04", { spendingUnaccounted: FOUND_NOTHING, incomeUnread: true }),
    day("2026-10-14", { spendingCents: 4_819, netCents: -4_819, incomeUnread: true }),
    day("2026-10-15", { unreached: "after-records" }),
    day("2026-10-30", { unreached: "future" }),
  ];
  const september = [
    day("2026-09-23", { incomeCents: 456_768, spendingCents: 3_440, netCents: 453_328 }),
    day("2026-09-24", { incomeCents: 114_192, spendingCents: 25_261, netCents: 88_931 }),
    day("2026-09-25", { spendingCents: 5_863, netCents: -5_863, incomeUnread: true }),
    day("2026-09-26", { spendingCents: 42_259, netCents: -42_259, incomeUnread: true }),
  ];
  const august = [
    day("2026-08-28", { spendingCents: 9_412, netCents: -9_412 }),
    day("2026-08-29", { spendingCents: 20_713, netCents: -20_713 }),
    day("2026-08-30", { spendingUnaccounted: FOUND_NOTHING }),
    day("2026-08-31", { incomeCents: 90, spendingCents: 33_703, netCents: -33_613 }),
  ];

  test("a bucket its hover gives no Net carries no point, and every Net it prints is drawn", () => {
    expect(netsOf(october)).toEqual([null, null, null, null, null]);
    expect(netsOf(september)).toEqual([453_328, 88_931, null, null]);
    expect(netsOf(august)).toEqual([-9_412, -20_713, null, -33_613]);
    // the day before his records begin (his first row is Aug 25, 2022) draws no $0.00 either
    expect(netsOf([day("2022-08-24", { unreached: "before-records" })])).toEqual([null]);
  });

  // ⛔ the one rule (`bucketNetMeasured`): the line draws a point exactly where the hover prints a Net figure
  test("the hover prints a Net figure exactly where the line draws one", () => {
    const buckets = [day("2022-08-24", { unreached: "before-records" }), ...august, ...september, ...october];
    const printed = buckets.map((b) => {
      const hover = hoverOf(b);
      return hover.includes("Net") && !hover.includes("Net—");
    });
    expect(printed).toEqual(netsOf(buckets).map((n) => n !== null));
  });

  test("a Net between two undrawn ones is marked, as the graph lens marks a lone point", () => {
    // Aug 30 holds no spending past Aug 12, so Aug 31's Net is a point no segment reaches
    const net = netLineOf(august);
    expect([0, 1, 2, 3].map((i) => dotAt(net, i).includes("<circle"))).toEqual([false, false, false, true]);
    expect(dotAt(net, 3)).toContain(`fill="${net.props.stroke}"`);
  });

  /* ⚖️ §6A 68: a legend naming a line left undrawn says why, as the graph lens's does — in the table's words */
  test("a Net left undrawn for income nobody has looked for says why under the legend", () => {
    const captionOf = (buckets: CashFlowBucket[]): string =>
      textOf(renderToStaticMarkup(createElement(CashFlowChart, { data: dataOf(buckets), projection: null })));
    expect(captionOf(october)).toContain(
      "Net is not drawn where the day has not been checked in the accounts that pay lands in.",
    );
    // a year's or a quarter's months say it of the month — his copy's Q4 2026
    const q4 = [
      month("2026-10", { spendingCents: 160_300, netCents: -160_300, incomeUnread: true }),
      month("2026-11", { unreached: "future" }),
      month("2026-12", { unreached: "future" }),
    ];
    expect(captionOf(q4)).toContain(
      "Net is not drawn where not one day of the month has been checked in the accounts that pay lands in.",
    );
    // past the ledger's ends the line simply ends, as the graph's do, and a day skipped for spending its hover says
    expect(captionOf(august)).not.toContain("is not drawn");
    const toTheFrontier = [...september.slice(0, 2), day("2026-09-27", { unreached: "after-records" })];
    expect(captionOf(toTheFrontier)).not.toContain("is not drawn");
  });
});
