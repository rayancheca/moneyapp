import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { SeriesView } from "@/services/recurring";

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

  test("a suggestion says it is awaiting statements, not late", () => {
    expect(decode(html.replace(/<[^>]+>/g, ""))).toContain(
      "Detected: Subscription · Monthly · about -$15.49 · awaiting statements",
    );
  });
});
