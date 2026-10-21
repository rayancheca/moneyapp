import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { recurringSeries } from "@/db/schema/recurring";
import { seedHisCarSeries, type OneChargeLedger } from "@/services/one-charge-fixture";
import { seedHisRent } from "@/services/rent-fixture";
import { forecastCurrentMonth } from "@/services/forecast";
import { listSeries, type SeriesView } from "@/services/recurring";

// the server actions pull in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({ confirmSeriesAction: vi.fn(), dismissSeriesAction: vi.fn() }));

const { AllSeriesView } = await import("./AllSeriesView");
const { ForecastCard } = await import("./ForecastCard");

function series(over: Partial<SeriesView> & Pick<SeriesView, "id" | "name" | "status">): SeriesView {
  return {
    merchantName: null,
    accountId: null,
    kind: "subscription",
    cadence: "monthly",
    intervalDaysAvg: 30,
    amountCentsAvg: -1549,
    amountCentsStddev: 0,
    toleranceDays: 5,
    nextExpectedOn: "2026-10-01",
    storedNextExpectedOn: "2026-10-01",
    nextExpectedAmountCents: -1549,
    confidence: 0.9,
    lastMatchedOn: "2026-09-01",
    matchedCount: 6,
    isActive: true,
    evidence: "active",
    annualizedCents: 18588,
    postedAvgCents: -1549,
    endsOn: null,
    // 🔴 left out, every fixture here read "Once": `cadenceLabel` asks `=== null`, and undefined is not
    oneChargeOn: null,
    billedWith: null,
    carries: [],
    ...over,
  } as SeriesView;
}

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * 🔴 The accessible name must contain the words a sighted user reads on the
 * button (WCAG 2.5.3) — a voice-control user says what they see. Measured
 * 2026-09-14 on `/recurring?tab=all`: all 12 table-row buttons read "Dismiss"
 * and were named "Mark <series> as not recurring", copied from the suggestion
 * card whose visible text really is "Not recurring".
 */
describe("AllSeriesView — every action button is named by what it says and what it acts on", () => {
  const fixture = [
    series({ id: "s1", name: "Spotify", status: "detected" }),
    series({ id: "s2", name: "Gym", status: "confirmed" }),
    series({ id: "s3", name: "Rent utilities & fees", status: "confirmed" }),
  ];
  const html = renderToStaticMarkup(
    createElement(AllSeriesView, { series: fixture, overdueBySeries: new Map(), today: "2026-09-14" }),
  );
  const buttons = [...html.matchAll(/<button[^>]*\baria-label="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({
    name: decode(m[1] as string),
    visible: decode((m[2] as string).replace(/<[^>]+>/g, "")).trim(),
  }));

  test("the render has the buttons it is judged on — two per suggestion, one per confirmed row", () => {
    expect(buttons).toHaveLength(4);
  });

  test("every name contains its visible label", () => {
    for (const b of buttons) expect(b.name.toLowerCase(), `"${b.visible}"`).toContain(b.visible.toLowerCase());
  });

  test("every name says which series, and no two names are the same", () => {
    for (const b of buttons) expect(fixture.some((s) => b.name.includes(s.name)), b.name).toBe(true);
    expect(new Set(buttons.map((b) => b.name)).size).toBe(buttons.length);
  });

  test("⛔ no dismissing button's name contains 'confirm' — e2e clicks Confirm by substring", () => {
    const dismissing = buttons.filter((b) => /dismiss|not recurring/i.test(b.visible));
    expect(dismissing.length).toBe(3);
    for (const b of dismissing) expect(b.name.toLowerCase()).not.toContain("confirm");
  });
});

/**
 * 🔴 "Car insurance | Monthly | -$357.58 | Dec 11 | ~$715.16/yr" and "Car
 * insurance — Nov 11 balance … | Monthly | -$72.74 | Nov 11 | ~$72.74/yr" —
 * measured on `/recurring?tab=all` against the real ledger 2026-09-15. A
 * monthly $357.58 bill annualizing to $715.16 with nothing on the row saying
 * why is this view's own 🔴 shape: two numbers on one row that cannot both be
 * true of one bill. `/recurring/<id>` qualifies the same figure with
 * `annualizedCaveat`; the row did not, because `SeriesView` had no end date.
 */
describe("AllSeriesView — an annualized figure says when the series stops inside the year", () => {
  const TODAY = "2026-09-15";
  const html = decode(
    renderToStaticMarkup(
      createElement(AllSeriesView, {
        series: [
          series({ id: "i", name: "Car insurance", status: "confirmed", nextExpectedAmountCents: -35758, postedAvgCents: -35758, annualizedCents: 71516, endsOn: "2027-01-11" }),
          series({ id: "l", name: "Car lease", status: "confirmed", nextExpectedAmountCents: -69504, postedAvgCents: -69504, annualizedCents: 834048, endsOn: "2028-08-15" }),
          series({ id: "g", name: "Gym", status: "confirmed", nextExpectedAmountCents: -10000, postedAvgCents: -10000, annualizedCents: 120000, endsOn: null }),
        ],
        overdueBySeries: new Map(),
        today: TODAY,
      }),
    ),
  );
  const rowOf = (name: string): string => {
    const at = html.indexOf(`>${name}</a>`);
    return html.slice(at, html.indexOf("</tr>", at));
  };

  test("a policy that stops inside the year says so under its annualized figure", () => {
    expect(rowOf("Car insurance")).toContain("$715.16");
    expect(rowOf("Car insurance")).toContain("ends Jan 11, 2027");
  });

  test("a lease that outlives the year, and a bill with no end, say nothing", () => {
    expect(rowOf("Car lease")).not.toContain("ends ");
    expect(rowOf("Gym")).not.toContain("ends ");
  });
});

/**
 * 🔴 "Suggestions — detected, not yet confirmed — and already in the forecast above" stood over Amazon Prime on a copy
 * of the owner's ledger 2026-10-08: "· lapsed" on its own card, in no figure above it (Committed $3,569.98 over 8
 * lines, no Amazon). True of the other suggestion, Rocket Money, running late and forecast; false of this one.
 */
describe("AllSeriesView — the suggestions note claims the forecast only for the suggestions it carries", () => {
  const noteOf = (fixture: SeriesView[]): string => {
    const html = decode(
      renderToStaticMarkup(createElement(AllSeriesView, { series: fixture, overdueBySeries: new Map(), today: "2026-10-08" })),
    );
    const at = html.indexOf('id="rec-suggestions"');
    return html.slice(at, html.indexOf("</h2>", at)).replace(/<[^>]+>/g, "");
  };
  const rocket = series({ id: "r", name: "Rocket Money", status: "detected", evidence: "running-late" });
  const amazon = series({
    id: "a",
    name: "Amazon Prime",
    status: "detected",
    evidence: "lapsed",
    nextExpectedOn: null,
    annualizedCents: null,
    lastMatchedOn: "2026-07-05",
  });

  test("over a lapsed suggestion the note names the exception, in the word the card marks it with", () => {
    const note = noteOf([rocket, amazon]);
    expect(note).toContain("not yet confirmed");
    expect(note).toContain("unless marked lapsed");
    expect(note).not.toContain("and already in the forecast above");
  });

  test("over suggestions the forecast all carries, the note is the one it always was", () => {
    expect(noteOf([rocket])).toContain("detected, not yet confirmed — and already in the forecast above");
    expect(noteOf([rocket])).not.toContain("unless");
  });
});

/** 🔴 "quiet past the point a bill stops" over whatever lapsed — a live transfer lapses too (`lapsedSectionNote`). */
describe("AllSeriesView — the Lapsed section's note is worded by what it holds", () => {
  const lapsedNoteOf = (fixture: SeriesView[]): string => {
    const html = decode(
      renderToStaticMarkup(createElement(AllSeriesView, { series: fixture, overdueBySeries: new Map(), today: "2026-10-12" })),
    );
    const at = html.indexOf(">Lapsed");
    return at < 0 ? "" : html.slice(at, html.indexOf("</h2>", at)).replace(/<[^>]+>/g, "");
  };
  const lapsed = { status: "confirmed", evidence: "lapsed", nextExpectedOn: null, annualizedCents: null } as const;

  test("a lapsed transfer is said to have stopped as a transfer, a subscription as a bill", () => {
    const savings = series({ id: "t", name: "Savings sweep", kind: "transfer", nextExpectedAmountCents: -5_000, ...lapsed });
    const prime = series({ id: "p", name: "Amazon Prime", ...lapsed });
    expect(lapsedNoteOf([savings])).toContain("no longer forecast — quiet past the point a transfer stops");
    expect(lapsedNoteOf([savings])).not.toContain("a bill");
    expect(lapsedNoteOf([prime])).toContain("no longer forecast — quiet past the point a bill stops");
  });
});

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 56): the one-time Nov 11 car-insurance balance reads "Once" in the cadence slot —
 * its day is the Next cell beside it — and Car insurance, a monthly bill in its last months, reads "Monthly". 🔴 It read
 * "Monthly" in this tab on a copy of his ledger that morning; and review of 3044ea6 put both slots back on the stored
 * cadence with every component test still green. From his two series as stored (`seedHisCarSeries`), through the
 * reading the page itself asks (`listSeries`).
 */
describe("AllSeriesView — a schedule of one charge reads Once in the cadence slot", () => {
  const TODAY = "2026-10-08";
  const BALANCE = "Car insurance — Nov 11 balance after the $1,000 early payment";
  let dir: string;
  let bundle: DbBundle;
  let his: OneChargeLedger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-all-series-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    his = seedHisCarSeries(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const page = (): string =>
    decode(
      renderToStaticMarkup(
        createElement(AllSeriesView, { series: listSeries(bundle.db, TODAY), overdueBySeries: new Map(), today: TODAY }),
      ),
    );

  /** the cell after the row's name — the table's Cadence column */
  const cadenceCellOf = (html: string, name: string): string | undefined => {
    const at = html.indexOf(`>${name}</a>`);
    if (at < 0) return undefined;
    const row = html.slice(at, html.indexOf("</tr>", at));
    return /<\/th><td[^>]*>([^<]*)<\/td>/.exec(row)?.[1];
  };

  test("the balance's row reads Once, and Car insurance's reads Monthly", () => {
    const html = page();
    expect(cadenceCellOf(html, BALANCE)).toBe("Once");
    expect(cadenceCellOf(html, "Car insurance")).toBe("Monthly");
  });

  test("detected, not yet confirmed, its suggestion card reads 'Detected: Bill · Once'", () => {
    bundle.db.update(recurringSeries).set({ status: "detected" }).where(eq(recurringSeries.id, his.balanceId)).run();
    const html = page();
    const at = html.indexOf(`>${BALANCE}</a>`);
    expect(at).toBeGreaterThan(-1);
    const card = html.slice(at, html.indexOf("</li>", at)).replace(/<[^>]+>/g, "");
    expect(card).toContain("Detected: Bill · Once");
    expect(card).not.toContain("Monthly");
  });

  /*
   * ⚖️ §6A 56 in the Annualized column too: its one charge, never a year of it. 🔴 His ledger copy 2026-10-13: "Once |
   * -$72.74 | Nov 11 | ~$72.74/yr ends Nov 11, 2026" — a year, and when it stops inside it, of a charge due once.
   */
  test("the balance's Annualized cell is its one charge, 'once · $72.74' — Car insurance keeps its year", () => {
    const html = page();
    const cellsOf = (name: string): string => {
      const at = html.indexOf(`>${name}</a>`);
      return html.slice(at, html.indexOf("</tr>", at)).replace(/<[^>]+>/g, "|");
    };
    expect(cellsOf(BALANCE)).toContain("once · |$72.74|");
    expect(cellsOf(BALANCE)).not.toContain("/yr");
    expect(cellsOf(BALANCE)).not.toContain("ends Nov 11, 2026");
    expect(cellsOf("Car insurance")).toContain("~|$715.16|/yr");
    expect(cellsOf("Car insurance")).toContain("ends Jan 11, 2027");
  });

  /* 🔴 From Nov 12 its one day has passed, and its row read "~$0.00/yr" (a copy of his ledger, 2026-10-12). */
  test("from Nov 12, its day passed, its row prints no year ahead of it", () => {
    const html = decode(
      renderToStaticMarkup(
        createElement(AllSeriesView, {
          series: listSeries(bundle.db, "2026-11-12"),
          overdueBySeries: new Map(),
          today: "2026-11-12",
        }),
      ),
    );
    const at = html.indexOf(`>${BALANCE}</a>`);
    const row = html.slice(at, html.indexOf("</tr>", at)).replace(/<[^>]+>/g, "|");
    expect(row).not.toContain("/yr");
    expect(html).not.toContain("$0.00");
  });

  /*
   * 🔴 Review of 0af5689: a month past its one day the row sat under "Never billed — registered by hand and forecast —
   * the bank has not charged them yet", of money nothing forecasts from Dec 1 (a copy of his ledger, 2026-10-12, asked
   * about 2026-12-12). It is filed where the subscriptions card files it: ended.
   */
  test("a month past its day it is filed Ended — never under 'registered by hand and forecast'", () => {
    const DEC12 = "2026-12-12";
    const html = decode(
      renderToStaticMarkup(
        createElement(AllSeriesView, { series: listSeries(bundle.db, DEC12), overdueBySeries: new Map(), today: DEC12 }),
      ),
    );
    const section = (id: string): string => html.split(`id="${id}"`)[1]?.split("</section>")[0] ?? "";
    expect(section("rec-ended")).toContain(BALANCE);
    expect(section("rec-ended")).toMatch(/^[^>]*>Ended<span[^>]*>— nothing more forecast — every date their schedules hold has come</);
    expect(section("rec-never-billed")).not.toContain(BALANCE);
    // Car insurance, a premium still to come on Jan 11, is not
    expect(section("rec-ended")).not.toContain(">Car insurance</a>");
  });

  /*
   * 🔴 Review of 49cc98f: on one /recurring page, Nov 12–30, the forecast called the balance "never billed" — its chip,
   * "$172.74 of it never billed" in the money-out band, "2 series have never been billed … still projected" in the
   * footer — and the All tab below filed it "Ended — nothing more forecast" (a copy of his ledger, 2026-10-12, asked
   * about 2026-11-12). The page renders both; so does this. The $72.74 it came due as stays a line of the forecast.
   */
  test("Nov 12: the forecast above the All tab calls it nothing the All tab does not — its $72.74 still counted", () => {
    const NOV12 = "2026-11-12";
    const card = (today: string): string =>
      decode(renderToStaticMarkup(createElement(ForecastCard, { forecast: forecastCurrentMonth(bundle.db, today) })));
    const forecast = card(NOV12);
    const all = decode(
      renderToStaticMarkup(
        createElement(AllSeriesView, { series: listSeries(bundle.db, NOV12), overdueBySeries: new Map(), today: NOV12 }),
      ),
    );
    const section = (id: string): string => all.split(`id="${id}"`)[1]?.split("</section>")[0] ?? "";
    expect(section("rec-ended")).toContain(BALANCE);
    // the fixture's one never-billed series is the balance: the forecast names no never-billed money at all
    const text = forecast.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain(`${BALANCE} Fixed (series) 1 × -$72.74 (once), came due Nov 11`);
    expect(text).not.toMatch(/never billed|never been billed|still projected, on the schedule alone/);
    // …and on its day, still projected and never billed, it is both the forecast's and the All tab's never billed
    const NOV11 = "2026-11-11";
    expect(card(NOV11).replace(/<[^>]+>/g, " ")).toMatch(/never billed/);
    expect(listSeries(bundle.db, NOV11).find((s) => s.id === his.balanceId)!.evidence).toBe("never-billed");
  });
});

/**
 * 🔴 His ledger 2026-10-08: the pay and Rocket Money sat under "Running late" for charges due after the last day
 * their accounts had been checked through. Awaiting statements is its own quiet section — never filed as late.
 */
describe("AllSeriesView — awaiting statements is its own section, never Running late", () => {
  const html = renderToStaticMarkup(
    createElement(AllSeriesView, {
      series: [
        series({ id: "p", name: "It America LLC (weekly pay)", status: "confirmed", evidence: "awaiting-statements" }),
        series({ id: "r", name: "Rocket Money", status: "detected", evidence: "awaiting-statements" }),
        series({ id: "l", name: "Streaming", status: "confirmed", evidence: "running-late" }),
      ],
      overdueBySeries: new Map(),
      today: "2026-10-08",
    }),
  );
  const section = (id: string): string => html.split(`id="${id}"`)[1]?.split("</section>")[0] ?? "";

  test("the pay is under Awaiting statements, the truly late series under Running late", () => {
    expect(section("rec-awaiting-statements")).toContain("It America LLC (weekly pay)");
    expect(section("rec-awaiting-statements")).not.toContain("Streaming");
    expect(section("rec-running-late")).toContain("Streaming");
    expect(section("rec-running-late")).not.toContain("It America");
  });

  /*
   * 🔴 Review of 2026-10-08: the evidence words said "charge" of his payroll deposit. A section's note words what it
   * holds — `seriesEvidenceNote`, by kind.
   */
  test("a section holding his pay says deposited; one of bills says charged, as it always has", () => {
    const words = decode(
      renderToStaticMarkup(
        createElement(AllSeriesView, {
          series: [
            series({ id: "p", name: "It America LLC (weekly pay)", status: "confirmed", kind: "income", evidence: "running-late" }),
            series({ id: "b", name: "Breezeline", status: "confirmed", kind: "bill" }),
            series({ id: "w", name: "Wages", status: "confirmed", kind: "income" }),
          ],
          overdueBySeries: new Map(),
          today: "2026-10-08",
        }),
      ).replace(/<[^>]+>/g, ""),
    );
    expect(words).toContain("charged or deposited within their cadence, and forecast");
    expect(words).toContain("still forecast — the last deposit is older than the cadence allows");
    expect(words).not.toContain("the last charge");
  });

  test("a suggestion says it is awaiting statements, not late", () => {
    expect(decode(html.replace(/<[^>]+>/g, ""))).toContain(
      "Detected: Subscription · Monthly · about -$15.49 · awaiting statements",
    );
  });
});

/*
 * ⚖️ His decision 59 (2026-10-08): `Rent utilities & fees` is paid inside the rent. 🔴 It sat under "Never billed"
 * with "0 matched"; it is filed by the rent's evidence, and its row says why it has matched nothing of its own.
 */
describe("AllSeriesView — a series billed inside another's payment says so on its row", () => {
  const rent = { id: "rent", name: "Flamingo South Beach (rent)", lastMatchedOn: "2026-09-02" };
  const text = decode(
    renderToStaticMarkup(
      createElement(AllSeriesView, {
        series: [
          series({ id: "u", name: "Rent utilities & fees", status: "confirmed", kind: "bill", matchedCount: 0, billedWith: rent }),
          series({ id: "g", name: "Gym", status: "confirmed", kind: "bill", matchedCount: 0, evidence: "never-billed" }),
        ],
        overdueBySeries: new Map(),
        today: "2026-10-08",
      }),
    ).replace(/<[^>]+>/g, "|"),
  );

  test("its row reads billed with the rent; the gym's does not", () => {
    expect(text).toContain("Rent utilities & fees||Bill · 0 matched · billed with the rent|");
    expect(text).toContain("Gym||Bill · 0 matched|");
    expect(text.match(/billed with/g)).toHaveLength(1);
  });
});

/*
 * The rent's "posted avg" is what each payment paid — Jun 16's two card rows one payment — and its payments carry
 * the utilities (§6A 59). 🔴 His row read "posted avg -$1,849.76" under "-$2,109.00" (a copy of his ledger,
 * 2026-10-12). From his rent as stored (`seedHisRent`), through the reading the page itself asks (`listSeries`).
 */
describe("AllSeriesView — the rent's posted avg is per payment, and names what its payments carry", () => {
  const TODAY = "2026-10-12";
  let dir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-all-series-rent-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    seedHisRent(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** the row's amount cell, its words only */
  const amountCellOf = (name: string): string => {
    const series = listSeries(bundle.db, TODAY);
    const html = decode(
      renderToStaticMarkup(createElement(AllSeriesView, { series, overdueBySeries: new Map(), today: TODAY })),
    );
    const at = html.indexOf(`>${name}</a>`);
    const row = html.slice(at, html.indexOf("</tr>", at));
    const cell = /<td class="px-3 py-3 text-right">(.*?)<\/td>/.exec(row)?.[1] ?? "";
    return cell.replace(/<[^>]+>/g, "");
  };

  test("the rent: -$2,109.00, posted avg -$2,312.20 · its payments carry Rent utilities & fees too", () => {
    expect(amountCellOf("Flamingo South Beach (rent)")).toBe(
      "-$2,109.00posted avg -$2,312.20 · its payments carry Rent utilities & fees too",
    );
  });

  test("the utilities, which post nothing of their own, print no average and carry nothing", () => {
    expect(amountCellOf("Rent utilities & fees")).toBe("-$182.21");
  });
});

/**
 * 🔴 "Oct 1 — not posted", in warning colour, under rent and its utilities in the Next column on a copy of his ledger
 * 2026-10-08 — a day no import had reached (rent posts from Wells Fargo, read through Sep 24), while the runway said
 * "no import has covered it yet" of the same $2,291.21. ⚖️ Staleness between uploads is never a warning.
 */
describe("AllSeriesView — the Next column's late note follows the runway's read/unread split", () => {
  const noteOf = (unreadCents: number): string => {
    const html = decode(
      renderToStaticMarkup(
        createElement(AllSeriesView, {
          series: [series({ id: "rent", name: "Rent", status: "confirmed", nextExpectedOn: "2026-11-01" })],
          overdueBySeries: new Map([["rent", { date: "2026-10-01", occurrenceCount: 1, owedCents: 210900, unreadCents }]]),
          today: "2026-10-08",
        }),
      ),
    );
    const at = html.lastIndexOf("<span", html.indexOf("Oct 1 —"));
    return html.slice(at, html.indexOf("</span>", at));
  };

  test("unread: quiet, and in the runway's words", () => {
    const note = noteOf(210900);
    expect(note).toContain("Oct 1 — no statement has covered it yet");
    expect(note).not.toContain("text-warning");
  });

  test("read and unposted: still the warning", () => {
    const note = noteOf(0);
    expect(note).toContain("Oct 1 — not posted");
    expect(note).toContain("text-warning");
  });
});

/**
 * 🔴 A rate summed from more than one pay schedule opened a bare `/recurring?tab=all` (review of the dashboard links,
 * 2026-10-12). Narrowed to the series its link names (`seriesListed`), the tab says so over them and offers the rest:
 * the badge over it still counts every series, and two rows under "All 14" would say nothing of the other twelve.
 */
describe("AllSeriesView — narrowed by a link, it says what it shows and how to see the rest", () => {
  const fixture = [
    series({ id: "pay", name: "Salary", status: "confirmed", kind: "income", nextExpectedAmountCents: 200000 }),
    series({ id: "gig", name: "Tutoring", status: "confirmed", kind: "income", nextExpectedAmountCents: 30000 }),
  ];
  const text = (html: string): string => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const render = (props: { series: SeriesView[]; narrowed?: { shown: number; of: number } | null }): string =>
    renderToStaticMarkup(createElement(AllSeriesView, { ...props, overdueBySeries: new Map(), today: "2026-10-13" }));

  test("the line over the rows, and a link to every series", () => {
    const html = render({ series: fixture, narrowed: { shown: 2, of: 14 } });
    expect(text(html)).toContain("Showing 2 of 14 series — the ones behind the figure you followed. Show all 14");
    expect(html).toMatch(/<a[^>]*href="\/recurring\?tab=all"[^>]*>Show all 14<\/a>/);
    // above the rows it describes
    expect(html.indexOf("the figure you followed")).toBeLessThan(html.indexOf("Salary"));
    expect(text(html)).toContain("Tutoring");
  });

  test("unnarrowed, nothing is said", () => {
    expect(text(render({ series: fixture }))).not.toContain("the figure you followed");
    expect(text(render({ series: fixture, narrowed: null }))).not.toContain("the figure you followed");
  });

  /*
   * 🔴 Review of a9384a7: narrowed to his pay schedules, none of them active, the tab printed "Active — charged within
   * their cadence, and forecast · 0 · No active series yet — confirm a suggestion above." over two rows of pay — a
   * bill's word over a drill-down of pay, an empty section's default, and no suggestion above. Measured on his ledger
   * copy 2026-10-13 with Fordham Payroll standing in for a second schedule: the ledger holds 8 active series, and It
   * America LLC is awaiting statements. A schedule registered by hand starts never billed, so his first second job
   * would print it.
   */
  test("none of the named schedules active: no empty Active section over them", () => {
    const awaiting = fixture.map((s) => ({ ...s, evidence: "awaiting-statements" as const }));
    const html = render({ series: awaiting, narrowed: { shown: 2, of: 15 } });
    expect(html).not.toContain('id="rec-active"');
    expect(text(html)).not.toContain("No active series yet");
    expect(text(html)).not.toMatch(/charged/);
    // the two schedules are still there, under the section their evidence files them in
    const section = html.split('id="rec-awaiting-statements"')[1]?.split("</section>")[0] ?? "";
    expect(section).toContain("Salary");
    expect(section).toContain("Tutoring");
  });

  // unnarrowed, an empty Active is where a confirmed suggestion goes, and says so under the suggestion it means
  test("unnarrowed, an empty Active still stands under a suggestion", () => {
    const html = render({
      series: [
        series({ id: "s", name: "Streaming", status: "detected" }),
        { ...fixture[0]!, evidence: "awaiting-statements" as const },
      ],
    });
    expect(html).toContain('id="rec-active"');
    expect(text(html)).toContain("No active series yet — confirm a suggestion above.");
  });

  /*
   * 🔴 …and with no suggestion above it said the same: "No active series yet — confirm a suggestion above." over a tab
   * with nothing to confirm (review of 4c1b032, pre-existing since cf37bb3). Latent on his ledger copy 2026-10-13: 8
   * active series, 1 suggestion. It says what is true: none is active yet.
   */
  test("unnarrowed, an empty Active with no suggestion above points at none", () => {
    const html = render({ series: [{ ...fixture[0]!, evidence: "awaiting-statements" as const }] });
    expect(html).toContain('id="rec-active"');
    expect(text(html)).toContain("No active series yet.");
    expect(text(html)).not.toContain("suggestion");
  });

  test("narrowed, an Active section that holds a schedule is still printed, in pay words", () => {
    const mixed = [fixture[0]!, { ...fixture[1]!, evidence: "awaiting-statements" as const }];
    const html = render({ series: mixed, narrowed: { shown: 2, of: 15 } });
    const section = html.split('id="rec-active"')[1]?.split("</section>")[0] ?? "";
    expect(section).toContain("Salary");
    expect(text(section)).toContain("deposited within their cadence");
  });

  // ⛔ never "No active series" — "Run Detect now" — over a ledger of fourteen
  test("none of the named series still listed: the line and the link, and no empty state", () => {
    const html = render({ series: [], narrowed: { shown: 0, of: 14 } });
    expect(text(html)).toContain("None of the series behind the figure you followed is listed any more. Show all 14");
    expect(text(html)).not.toContain("No active series");
  });
});
