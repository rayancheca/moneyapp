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
