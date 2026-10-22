import { describe, expect, test } from "vitest";
import {
  allTabOf,
  isListedSeries,
  namedSeriesOf,
  SERIES_LIST_PARAM,
  seriesBehindHref,
  seriesFilterSentence,
  seriesListed,
  seriesListHref,
} from "./recurring-list";

const PAY = "019f72da-1fbc-7000-a434-6840bae2d231";
const TUTORING = "019f72da-1fbf-7000-9f10-575f1ea7e589";

/**
 * 🔴 A rate summed from more than one pay schedule linked to a bare `/recurring?tab=all` — every series the ledger
 * lists, bills and a schedule that stopped paying among them (review of the dashboard links, 2026-10-12). The link
 * names its series, and the All tab reads the names back: written and read here, so neither side spells it alone.
 */
describe("seriesListHref ↔ namedSeriesOf — the All tab narrowed to the series a link names", () => {
  test("the link names each series, in order, and reads back as that set", () => {
    const href = seriesListHref([PAY, TUTORING]);
    expect(href).toBe(`/recurring?tab=all&series=${PAY},${TUTORING}`);
    const named = namedSeriesOf(new URL(href, "http://moneyapp.test").searchParams.get(SERIES_LIST_PARAM));
    expect(named).toEqual(new Set([PAY, TUTORING]));
  });

  test("naming nothing is the whole tab", () => {
    expect(seriesListHref([])).toBe("/recurring?tab=all");
    expect(namedSeriesOf(null)).toBeNull();
    expect(namedSeriesOf("")).toBeNull();
    expect(namedSeriesOf(" , ,")).toBeNull();
  });

  // ⛔ a typed or mangled URL narrows by the ids it really holds, and a value that holds none narrows nothing
  test("only id-shaped names are read", () => {
    expect(namedSeriesOf(` ${PAY} ,<script>, ${TUTORING}`)).toEqual(new Set([PAY, TUTORING]));
    expect(namedSeriesOf("<script>alert(1)</script>")).toBeNull();
    expect(namedSeriesOf("x".repeat(65))).toBeNull();
  });
});

/*
 * ONE rule for a link over a figure summed from series — the earn row's, the car card's, the subscriptions card's. 🔴
 * The two cards' header links opened a bare `/recurring` (review of the dashboard links, 2026-10-13).
 */
describe("seriesBehindHref — where a figure summed from series is checked", () => {
  test("one series: its own page", () => {
    expect(seriesBehindHref([PAY])).toBe(`/recurring/${PAY}`);
  });

  test("more than one: the All tab narrowed to exactly them", () => {
    expect(seriesBehindHref([PAY, TUTORING])).toBe(seriesListHref([PAY, TUTORING]));
  });
});

describe("seriesListed — what the All tab lists, and how much of it a link left", () => {
  const rows = [
    { id: PAY, name: "Salary", status: "confirmed" },
    { id: TUTORING, name: "Tutoring", status: "detected" },
    { id: "rent", name: "Rent", status: "confirmed" },
    { id: "old", name: "Old job", status: "ended" },
    { id: "coke", name: "STOCK LENDING (COKE)", status: "dismissed" },
  ] as const;

  test("the tab's own population — what its badge counts — is every series not dismissed or ended", () => {
    expect(rows.filter(isListedSeries).map((s) => s.name)).toEqual(["Salary", "Tutoring", "Rent"]);
  });

  test("unnarrowed, every row goes to the view and nothing is said", () => {
    const listed = seriesListed(rows, null);
    expect(listed.rows).toEqual(rows);
    expect(listed.narrowed).toBeNull();
  });

  test("narrowed, the named rows alone, counted by the badge's own rule", () => {
    const listed = seriesListed(rows, new Set([PAY, TUTORING]));
    expect(listed.rows.map((s) => s.name)).toEqual(["Salary", "Tutoring"]);
    expect(listed.narrowed).toEqual({ shown: 2, of: 3 });
  });

  // a series the link named that has since been dismissed is in no section of the tab, so it is not "shown"
  test("a named series the tab no longer lists is not counted as shown", () => {
    expect(seriesListed(rows, new Set([PAY, "coke"])).narrowed).toEqual({ shown: 1, of: 3 });
    expect(seriesListed(rows, new Set(["coke", "gone"])).narrowed).toEqual({ shown: 0, of: 3 });
  });
});

/*
 * 🔴 /recurring's wiring was pinned by matching the page's SOURCE TEXT (`page.test.ts`): a reflow or a renamed local
 * broke it with nothing changed (review of the dashboard links, 2026-10-12). The page now makes ONE call, and what the
 * call returns is pinned here by behaviour — the param read, the rows cut and the badge counted by one rule.
 */
describe("allTabOf — the All tab the page hands its view, from the `?series=` value it was given", () => {
  const rows = [
    { id: PAY, name: "Salary", status: "confirmed" },
    { id: TUTORING, name: "Tutoring", status: "detected" },
    { id: "rent", name: "Rent", status: "confirmed" },
    { id: "coke", name: "STOCK LENDING (COKE)", status: "dismissed" },
  ] as const;

  test("no param: every row, nothing narrowed, the badge the tab's population", () => {
    expect(allTabOf(rows, null)).toEqual({ rows, narrowed: null, badge: 3 });
  });

  test("a param: the rows it names, read by namedSeriesOf, and the badge beside 'of' the same count", () => {
    const tab = allTabOf(rows, `${TUTORING},${PAY}`);
    expect(tab.rows.map((s) => s.name)).toEqual(["Salary", "Tutoring"]);
    expect(tab.narrowed).toEqual({ shown: 2, of: 3 });
    expect(tab.badge).toBe(tab.narrowed!.of);
  });

  test("a mangled param narrows nothing", () => {
    expect(allTabOf(rows, "<script>").narrowed).toBeNull();
  });
});

/*
 * 🔴 "the ones behind the figure you followed" — said after the car card's "Commitments →" and the subscriptions
 * card's "Recurring →", header links over a whole card (review of 89f235d, his ledger copy 2026-10-13: "Showing 3 of 14
 * series — the ones behind the figure you followed."). Every narrowing link is a link; not every one stands on a figure.
 */
describe("seriesFilterSentence — the line over a narrowed All tab", () => {
  test("says how many of the tab's series are on screen, and which", () => {
    expect(seriesFilterSentence({ shown: 2, of: 14 })).toBe(
      "Showing 2 of 14 series — the ones behind the link you followed.",
    );
  });

  // ⛔ never "Showing 0 of 14" over an empty tab that then reads "No active series"
  test("none of them still listed says so", () => {
    expect(seriesFilterSentence({ shown: 0, of: 14 })).toBe(
      "None of the series behind the link you followed is listed any more.",
    );
  });
});
