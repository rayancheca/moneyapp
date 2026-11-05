import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { seedDatabase } from "@/db/seed";
import { provenanceFor } from "./provenance";
import { listSeries } from "./recurring";
import { seriesDetail } from "./recurring-detail";
import { seedHisRent, type RentLedger } from "./rent-fixture";

/**
 * ⚖️ default built, not asked (2026-11-04) — MONEY BACK IS NO PAYMENT THE POSTED AVERAGE AVERAGES
 * (`averagedPayments`), as his pay's leaves out a row toward no payday: the days that paid a charge are every grader's
 * one rule (`daysThatPaid`), the Amount history beside the average draws the others "toward no due day", and the
 * popover names them so its counts still add up to the rows (`SeriesPostedAverage.moneyBack`). On the series page, the
 * All tab and the popover alike — one reading (`postedAveragesBySeries`). Its own file by subject, beside
 * posted-average.test.ts, which nears the 800-line cap.
 *
 * 🔴 Review of 23e9c5d1: +$50.00 linked to Breezeline (internet) on Oct 12 — its page drew the bar "toward no due day"
 * beside "posted avg -$31.72 ± $40.22", the All tab read -$31.72, and the popover "Its 6 tagged postings since Jun 20,
 * 2026 were 3 different amounts, from -$50.00 to $50.00 …": six "payments", the credit among them (his ledger copy
 * 2026-11-04, the credit added on Venture X, read Nov 4). Latent on his ledger: no day of any series of his read per
 * occurrence nets to $0.00 or against its rate (0 of 28 series, 2026-11-04).
 */
describe("the posted average leaves money back out — the page, the All tab, the history and the popover", () => {
  const NOV4 = "2026-11-04";
  let dir: string;
  let bundle: DbBundle;
  let rent: RentLedger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-posted-average-money-back-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    rent = seedHisRent(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** a monthly bill at the rate he set, these rows linked to it */
  const seed = (name: string, rate: number, rows: readonly (readonly [string, number])[]): string => {
    const { id } = bundle.db
      .insert(recurringSeries)
      .values({ name, kind: "bill", cadence: "monthly", status: "confirmed", toleranceDays: 3, userAmountCents: rate })
      .returning({ id: recurringSeries.id })
      .get();
    for (const [day, c] of rows) rent.charge(day, c, id);
    return id;
  };
  const popover = (id: string) => provenanceFor(bundle.db, { kind: "recurringSeries", id, today: NOV4 })!;

  test("Breezeline's $50.00 back on Oct 12 is named, and its five payments average -$48.06 — on all three", () => {
    const breezeline = seed("Breezeline (internet)", -5_000, [
      ["2026-06-20", -4_032],
      ...["07", "08", "09", "10"].map((m) => [`2026-${m}-10`, -5_000] as const),
      ["2026-10-12", 5_000],
    ]);
    const d = seriesDetail(bundle.db, breezeline, NOV4)!;
    expect([d.postedAvgCents, d.postedStddevCents]).toEqual([-4_806, 433]);
    expect(listSeries(bundle.db, NOV4).find((s) => s.id === breezeline)!.postedAvgCents).toBe(-4_806);
    // …the bar still drawn, against nothing
    expect(d.amountHistory.map((p) => [p.date, p.expectedCents, p.towardNoDueDay ?? false]).at(-1)).toEqual([
      "2026-10-12",
      null,
      true,
    ]);
    const p = popover(breezeline);
    expect(p.headline).toContain(
      "Its 5 payments since Jun 20, 2026 were 2 different amounts, from -$50.00 to -$40.32 — so any single figure " +
        "for it is an average, not a repeat. Oct 12's $50.00 was money back, toward no due day, and is not counted. " +
        "⚠️ The ledger's own average of what actually posted is -$48.06, which is not what you set.",
    );
    expect(p.sources[1]).toMatchObject({
      label: "6 tagged postings in the ledger",
      detail: "5 payments: 2 different amounts, -$50.00 to -$40.32 · one on Oct 12, toward no due day",
    });
  });

  /* …beside ONE payment, the two tagged postings are not "one payment" either */
  test("one payment and money back: 'Its one payment was -$40.00', the credit named — never one payment of two", () => {
    const gym = seed("Gym", -4_000, [
      ["2026-10-05", -4_000],
      ["2026-10-09", 4_000],
    ]);
    const p = popover(gym);
    expect(p.headline).toContain(
      "Its one payment was -$40.00, on Oct 5, 2026. That is one payment — below the 3 this app requires before " +
        "calling a repeat a pattern, so it is an anecdote rather than a statistic. Oct 9's $40.00 was money back, " +
        "toward no due day, and is not counted.",
    );
    expect(p.headline).not.toContain("tagged postings are one payment");
    expect(p.sources[1]).toMatchObject({
      label: "2 tagged postings in the ledger",
      detail: "one payment: it was -$40.00 · one on Oct 9, toward no due day",
    });
  });

  /*
   * ⚖️ …and with a rate history (§6A 63) money back is no payment of an earlier rate either: the rent raised Aug 1
   * (hypothetical, -$2,000.00 through Jul 31) with +$50.00 back on Sep 20 — two payments at today's rate, two before
   * it, and the credit named apart, so the line still adds up to the six rows.
   */
  test("the rent raised Aug 1, $50.00 back Sep 20: neither a payment at today's rate nor one before it", () => {
    bundle.db
      .update(recurringSeries)
      .set({ userAmountHistory: [{ throughOn: "2026-07-31", amountCents: -200_000 }] })
      .where(eq(recurringSeries.id, rent.rentId))
      .run();
    rent.charge("2026-09-20", 5_000, rent.rentId);
    expect(seriesDetail(bundle.db, rent.rentId, NOV4)!.postedAvgCents).toBe(-226_416);
    const p = popover(rent.rentId);
    expect(p.headline).toContain(
      "Its 2 payments before Aug 1, 2026 were at an earlier rate, and are not counted. Sep 20's $50.00 was money " +
        "back, toward no due day, and is not counted.",
    );
    expect(p.sources[1]).toMatchObject({
      label: "6 tagged postings in the ledger",
      detail:
        "2 payments at the rate in force since Aug 1: 2 different amounts, -$2,291.21 to -$2,237.11 · 2 before it " +
        "(Jun 16's posted as 2), at an earlier rate · one on Sep 20, toward no due day",
    });
  });
});
