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
import { listSeries, type SeriesView } from "@/services/recurring";

// the server actions pull in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({ confirmSeriesAction: vi.fn(), dismissSeriesAction: vi.fn() }));

const { AllSeriesView } = await import("./AllSeriesView");

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
});
