import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CategorySeriesRow } from "@/services/category-detail";
import { CategorySeriesList } from "./CategorySeriesList";

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const TODAY = "2026-10-08";

/** The two rows of `/categories/<Car>` on a copy of his ledger 2026-10-08, as `seriesInCategory` builds them. */
const BALANCE: CategorySeriesRow = {
  id: "s-balance",
  name: "Car insurance — Nov 11 balance after the $1,000 early payment",
  cadence: "monthly",
  amountCents: -7274,
  nextExpectedOn: "2026-11-11",
  overdue: null,
  oneChargeOn: "2026-11-11",
  status: "confirmed",
  isActive: false,
  evidence: "never-billed",
  label: "never billed",
  href: "/recurring/s-balance",
};
const INSURANCE: CategorySeriesRow = {
  ...BALANCE,
  id: "s-insurance",
  name: "Car insurance",
  amountCents: -35758,
  nextExpectedOn: "2026-12-11",
  oneChargeOn: null,
  isActive: true,
  evidence: "active",
  label: null,
  href: "/recurring/s-insurance",
};

function rowText(rows: CategorySeriesRow[]): string[] {
  const html = renderToStaticMarkup(createElement(CategorySeriesList, { rows, today: TODAY }));
  return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) =>
    decode(m[1]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
  );
}

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 56). 🔴 `/categories/<Car>` read "monthly · next Nov 11 · never billed $72.74"
 * of the one-time Nov 11 balance — a monthly bill with a next charge, of a charge that happens once.
 */
describe("CategorySeriesList — a schedule of one charge reads once, on its day", () => {
  test("the Nov 11 balance reads 'once · Nov 11', and Car insurance stays monthly with its next date", () => {
    const [balance, insurance] = rowText([BALANCE, INSURANCE]);
    expect(balance).toContain("once · Nov 11 · never billed");
    expect(balance).not.toContain("monthly");
    expect(balance).not.toContain("next");
    expect(insurance).toContain("monthly · next Dec 11");
  });
});

function rent(unreadCents: number): CategorySeriesRow {
  return {
    id: "rent",
    name: "Flamingo South Beach (rent)",
    cadence: "monthly",
    amountCents: -210900,
    nextExpectedOn: "2026-11-01",
    overdue: { date: "2026-10-01", occurrenceCount: 1, owedCents: 210900, unreadCents },
    oneChargeOn: null,
    status: "confirmed",
    isActive: true,
    evidence: "active",
    label: null,
    href: "/recurring/rent",
  };
}

function noteOf(row: CategorySeriesRow): string {
  const html = renderToStaticMarkup(createElement(CategorySeriesList, { rows: [row], today: "2026-10-08" }));
  const at = html.lastIndexOf("<span", html.indexOf("Oct 1 —"));
  return html.slice(at, html.indexOf("</span>", at)).replace(/<!-- -->/g, "");
}

/**
 * 🔴 "monthly · next Nov 1 · Oct 1 — not posted", in warning colour, under `/categories/<Housing>` on a copy of his
 * ledger 2026-10-08 — of a day no import had reached, beside a runway saying "no import has covered it yet". The
 * note's second caller follows the same split as the first (`overdueNote`).
 */
describe("CategorySeriesList — the late note follows the runway's read/unread split", () => {
  test("unread: quiet, in the runway's words", () => {
    const note = noteOf(rent(210900));
    expect(note).toContain("Oct 1 — no import has covered it yet");
    expect(note).not.toContain("text-warning");
  });

  test("read and unposted: the warning stays", () => {
    const note = noteOf(rent(0));
    expect(note).toContain("Oct 1 — not posted");
    expect(note).toContain("text-warning");
  });
});
