import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { Mover } from "@/services/portfolio";
import { TopMovers } from "./TopMovers";

/**
 * 🔴 The strip dated every move with the PORTFOLIO's two covered days. Measured
 * on the real ledger, Tue 2026-09-15: the NAV series is carried to today, so
 * the heading read "Top movers · Today" over COKE's +5.77% — a move between
 * Fri Sep 11's and Mon Sep 14's closes, which COKE's own page dates "Last close
 * · Sep 14 vs Sep 11". The strip now dates the moves by the closes they were
 * measured between, and nothing else.
 *
 * ⚠️ Rendered here rather than in Playwright on purpose: the e2e fixture quotes
 * every symbol through its own fake today, so only the "Today" branch can paint
 * there — the one that was never wrong.
 */
const mover = (
  symbol: string,
  pct: number,
  quotedOn: string,
  previousQuotedOn: string,
  assetType: Mover["assetType"] = "stock",
): Mover => ({
  symbol,
  assetType,
  dayChangeCents: Math.round(pct * 100),
  dayChangePct: pct,
  valueCents: 10_000,
  quotedOn,
  previousQuotedOn,
});

const render = (winners: Mover[], losers: Mover[], today: string): string =>
  renderToStaticMarkup(createElement(TopMovers, { winners, losers, today }));

describe("TopMovers names the closes each move was measured between", () => {
  test("a Friday→Monday move read on Tuesday is 'Last close · Sep 14 vs Sep 11', never 'Today'", () => {
    const html = render(
      [mover("COKE", 5.77, "2026-09-14", "2026-09-11"), mover("WMT", 3.36, "2026-09-14", "2026-09-11")],
      [mover("AAPL", -0.27, "2026-09-14", "2026-09-11")],
      "2026-09-15",
    );
    expect(html).toContain("Last close");
    expect(html).toContain("Sep 14 vs Sep 11");
    expect(html).not.toContain("Today");
    // one shared pair is said once, at the top — never again on every chip
    expect(html.split("Sep 14 vs Sep 11")).toHaveLength(2);
  });

  test("when the two sides' closes differ, the heading claims no date and each chip carries its own", () => {
    // the winners share Sep 14 vs Sep 11; a coin among the LOSERS was quoted Sunday.
    // The heading sits over both sides of the toggle, so it may not name either pair.
    const html = render(
      [mover("COKE", 5.77, "2026-09-14", "2026-09-11")],
      [mover("ETH", -1.2, "2026-09-14", "2026-09-13", "crypto")],
      "2026-09-15",
    );
    expect(html).toContain("Day change");
    expect(html).not.toContain("Last close");
    expect(html).not.toContain("Today");
    // the winners side is the one painted first; its chip names its own closes
    expect(html).toMatch(/COKE[\s\S]*Sep 14 vs Sep 11/);
  });

  test("read on Monday, a coin's Sunday close does not take 'Today' off the strip and put it on every chip", () => {
    // 🔴 Measured on the real ledger read on Mon 2026-09-14: "Top movers · Day
    // change … COKE ▲ +5.77% today WMT ▲ +3.36% today MSFT ▲ +2.98% today ETH ▲
    // +2.26% today". Every move closed today; the rule names them all "Today".
    const html = render(
      [mover("COKE", 5.77, "2026-09-14", "2026-09-11"), mover("ETH", 2.26, "2026-09-14", "2026-09-13", "crypto")],
      [mover("AAPL", -0.27, "2026-09-14", "2026-09-11")],
      "2026-09-14",
    );
    expect(html).not.toContain("Day change");
    // said once, at the top
    expect(html.match(/today/gi)).toEqual(["Today"]);
  });

  test("closes quoted today keep the word the e2e fixture renders, with no dates", () => {
    const html = render(
      [mover("AAPL", 1.5, "2026-07-08", "2026-07-07")],
      [mover("MSFT", -1.3, "2026-07-08", "2026-07-07")],
      "2026-07-08",
    );
    expect(html).toContain("Today");
    expect(html).not.toContain(" vs ");
  });
});
