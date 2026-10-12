import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { seedDatabase } from "@/db/seed";
import { seedHisCarSeries } from "./one-charge-fixture";
import { postedAveragesBySeries } from "./posted-average";
import { provenanceFor } from "./provenance";
import { listSeries } from "./recurring";
import { seriesDetail } from "./recurring-detail";
import { seedHisRent, type RentLedger } from "./rent-fixture";

/**
 * A series with a schedule averages what each OCCURRENCE was paid: the rows of one payment are one sample. One
 * reading for the series page's Per charge, the All tab's "posted avg" and the amount popover.
 *
 * 🔴 Read on his ledger 2026-10-12: the rent's page and the All tab printed "posted avg -$1,849.76 ± $583.58" under
 * "-$2,109.00", though every month he paid MORE — Jun 16's one payment, posted by the card as -$1,100.00 and -$1,334.80,
 * counted as two samples. Per payment: -$2,434.80, -$2,285.70, -$2,237.11, -$2,291.21 — -$2,312.20 ± $85.27.
 */
describe("the posted average, per occurrence — his rent on the page, the All tab and the popover", () => {
  const TODAY = "2026-10-12";
  let dir: string;
  let bundle: DbBundle;
  let rent: RentLedger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-posted-average-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    rent = seedHisRent(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const surfaces = (id: string) => {
    const d = seriesDetail(bundle.db, id, TODAY)!;
    const row = listSeries(bundle.db, TODAY).find((s) => s.id === id)!;
    return {
      page: [d.postedAvgCents, d.postedStddevCents, d.carries],
      allTab: [row.postedAvgCents, row.carries],
      popover: provenanceFor(bundle.db, { kind: "recurringSeries", id, today: TODAY })!.headline,
    };
  };

  test("Jun 16's two rows are one payment: -$2,312.20 ± $85.27 on all three", () => {
    const s = surfaces(rent.rentId);
    expect(s.page.slice(0, 2)).toEqual([-231_220, 8_527]);
    expect(s.allTab[0]).toBe(-231_220);
    expect(s.popover).toContain("average of what actually posted is -$2,312.20, which is not what you set");
    expect(s.popover).not.toContain("-$1,849.76");
  });

  /* ⚖️ §6A 59: every rent payment carries the utilities — the line that names the average says so. */
  test("the rent's average names what its payments carry, on all three", () => {
    const s = surfaces(rent.rentId);
    expect(s.page[2]).toEqual(["Rent utilities & fees"]);
    expect(s.allTab[1]).toEqual(["Rent utilities & fees"]);
    expect(s.popover).toContain(
      "is -$2,312.20, which is not what you set — its payments carry Rent utilities & fees too.",
    );
  });

  /*
   * ⛔ The sentence before the average counts and ranges what the average is OF — four payments, not five rows. 🔴 At
   * af5b0fa the popover read "Its 5 tagged postings since Jun 16, 2026 were 5 different amounts, from -$2,291.21 to
   * -$1,100.00 … ⚠️ The ledger's own average of what actually posted is -$2,312.20": an average outside the range the
   * sentence before it had just stated (review of af5b0fa, provenanceFor on a copy of his ledger, 2026-10-12).
   */
  test("the popover counts and ranges the four payments, and its average lies inside that range", () => {
    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: rent.rentId, today: TODAY })!;
    expect(p.headline).toContain(
      "Its 4 payments since Jun 16, 2026 (5 tagged postings: Jun 16's posted as 2) were 4 different amounts, from " +
        "-$2,434.80 to -$2,237.11 — so any single figure for it is an average, not a repeat.",
    );
    const cents = (s: string): number => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
    const [, lo, hi] = /from (-?\$[\d,.]+) to (-?\$[\d,.]+)/.exec(p.headline)!;
    const avg = cents(/actually posted is (-?\$[\d,.]+[\d])/.exec(p.headline)![1]!);
    expect(avg).toBeGreaterThanOrEqual(cents(lo!));
    expect(avg).toBeLessThanOrEqual(cents(hi!));
    // the evidence list counts the same way: five documents, four payments
    expect(p.sources[1]).toMatchObject({
      label: "5 tagged postings in the ledger",
      detail: "4 payments (Jun 16's posted as 2): 4 different amounts, -$2,434.80 to -$2,237.11",
    });
  });

  /*
   * ⛔ …and grades them so: a bill whose every PAYMENT was $50.00 is a repeat, however the bank split one of them. 🔴 Row
   * by row, Jul 5's $20.00 and $30.00 badged it "3 different amounts" — the "N different amounts" badge any series not
   * set by hand wears when one payment posts as two rows (review of af5b0fa).
   */
  test("a bill not set by hand: one payment posted as two rows is still one $50.00", () => {
    // its forecast -$50.00, as linking Jun 5's row by hand seeds it (`recurring-links`): what "adds up" grades
    const { id } = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Breezeline",
        kind: "bill",
        cadence: "monthly",
        status: "confirmed",
        toleranceDays: 3,
        nextExpectedAmountCents: -5_000,
      })
      .returning({ id: recurringSeries.id })
      .get();
    const rows = [
      ["2026-06-05", -5_000],
      ["2026-07-05", -2_000],
      ["2026-07-05", -3_000],
      ["2026-08-05", -5_000],
    ] as const;
    for (const [day, c] of rows) rent.charge(day, c, id);
    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id, today: TODAY })!;
    expect([p.verdict, p.badgeWord]).toEqual(["derived", undefined]);
    expect(p.headline).toContain(
      "All 3 payments since Jun 5, 2026 (4 tagged postings: Jul 5's posted as 2) were -$50.00, exactly.",
    );
    const history = seriesDetail(bundle.db, id, TODAY)!.amountHistory;
    expect(history.map((h) => [h.date, h.amountCents, h.postings ?? 1])).toEqual([
      ["2026-06-05", -5_000, 1],
      ["2026-07-05", -5_000, 2],
      ["2026-08-05", -5_000, 1],
    ]);

    /*
     * ⛔ …but a repeat of -$50.00 does not "add up" to a forecast of another amount: detection's, the mean of the four
     * ROWS (`analyzeGroup`), is -$37.50 — what no payment paid (review of 442de07, 2026-10-12).
     */
    bundle.db.update(recurringSeries).set({ nextExpectedAmountCents: -3_750 }).where(eq(recurringSeries.id, id)).run();
    const rowMean = provenanceFor(bundle.db, { kind: "recurringSeries", id, today: TODAY })!;
    expect([rowMean.verdict, rowMean.badgeWord]).toEqual(["unverified", "paid -$50.00 each time"]);
    expect(rowMean.headline).toContain("were -$50.00, exactly. None of the 3 paid the -$37.50 forecast here.");
  });

  /* a day's rows that are the series' only payment are one payment — never "All 1 payments" */
  test("three rows of one day read as one payment, in the singular", () => {
    const { id } = bundle.db
      .insert(recurringSeries)
      .values({ name: "Parking", kind: "bill", cadence: "monthly", status: "confirmed", toleranceDays: 3 })
      .returning({ id: recurringSeries.id })
      .get();
    for (const c of [-1_000, -1_000, -500]) rent.charge("2026-09-05", c, id);
    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id, today: TODAY })!;
    expect(p.headline).toContain("Its 3 tagged postings are one payment, of -$25.00 on Sep 5, 2026.");
    expect(p.sources[0]).toMatchObject({
      label: "3 tagged postings in the ledger",
      detail: "one payment (Sep 5's posted as 3): it was -$25.00",
    });
    // …and beside a forecast it did not pay — the three rows' mean, as detection reads them — says so, singular too
    bundle.db.update(recurringSeries).set({ nextExpectedAmountCents: -833 }).where(eq(recurringSeries.id, id)).run();
    const off = provenanceFor(bundle.db, { kind: "recurringSeries", id, today: TODAY })!;
    expect([off.verdict, off.badgeWord]).toEqual(["unverified", "paid -$25.00 each time"]);
    expect(off.headline).toContain("of -$25.00 on Sep 5, 2026. It did not pay the -$8.33 forecast here.");
  });

  test("the utilities carry nothing, and once unlinked the rent carries nothing either", () => {
    expect(surfaces(rent.utilitiesId).page[2]).toEqual([]);
    bundle.db
      .update(recurringSeries)
      .set({ userBilledWithSeriesId: null })
      .where(eq(recurringSeries.id, rent.utilitiesId))
      .run();
    const s = surfaces(rent.rentId);
    expect([s.page[2], s.allTab[1]]).toEqual([[], []]);
    expect(s.popover).toContain("is -$2,312.20, which is not what you set.");
  });

  /* Aug 12's $357.58 and Sep 3's $1,000.00 early payment are one occurrence each: it reads exactly as before. */
  test("Car insurance reads as it always has: -$678.79 ± $454.26", () => {
    const car = seedHisCarSeries(bundle.db);
    const s = surfaces(car.insuranceId);
    expect(s.page).toEqual([-67_879, 45_426, []]);
    expect(s.allTab).toEqual([-67_879, []]);
  });

  /* ⛔ No schedule, no occurrence: he said it is not recurring. CC Vending's purchases of one day are purchases. */
  test("a dismissed series reads its rows as they posted", () => {
    const { id } = bundle.db
      .insert(recurringSeries)
      .values({ name: "CC Vending", kind: "bill", cadence: "biweekly", status: "dismissed", toleranceDays: 2 })
      .returning({ id: recurringSeries.id })
      .get();
    rent.charge("2024-11-11", -240, id);
    rent.charge("2024-11-11", -260, id);
    expect(postedAveragesBySeries(bundle.db, [series(id)], TODAY).get(id)).toMatchObject({
      avgCents: -250,
      stddevCents: 14,
    });
  });

  /* ⛔ The pay rule stands: money in is read per payday while paid (§6A 55), and as it posted once it ends. */
  test("ended pay reads its deposits as they posted — Fordham's two Jul 9 deposits stay two", () => {
    const { id } = bundle.db
      .insert(recurringSeries)
      .values({ name: "Fordham Payroll", kind: "income", cadence: "biweekly", status: "ended", toleranceDays: 3 })
      .returning({ id: recurringSeries.id })
      .get();
    rent.charge("2025-06-25", 90_888, id);
    rent.charge("2025-07-09", 80_037, id);
    rent.charge("2025-07-09", 8_717, id);
    expect(postedAveragesBySeries(bundle.db, [series(id)], TODAY).get(id)!.avgCents).toBe(
      Math.round((90_888 + 80_037 + 8_717) / 3),
    );
  });

  const series = (id: string) => bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get()!;
});

/**
 * ⚖️ Owner decision 2026-10-12 (§6A 63): a bill or subscription with a rate history (`user_amount_history`) averages
 * ONLY the payments made at the rate in force now, as his pay does (§6A 55) — on the series page, the All tab and the
 * popover alike, and the popover's sentence counts the payments that average is of. No payment at the rate in force now
 * is no posted average, never the old rate's.
 *
 * Latent on his ledger (2026-10-12), where only his pay has a history: the rent's increase here is hypothetical —
 * -$2,000.00 through the day named, -$2,109.00 (his own figure) since.
 */
describe("the posted average of a bill with a rate history — the payments at the rate in force now", () => {
  const TODAY = "2026-10-12";
  let dir: string;
  let bundle: DbBundle;
  let rent: RentLedger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-posted-average-era-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    rent = seedHisRent(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** the rent as if it had been -$2,000.00 through `throughOn` */
  const raise = (throughOn: string): void => {
    bundle.db
      .update(recurringSeries)
      .set({ userAmountHistory: [{ throughOn, amountCents: -200_000 }] })
      .where(eq(recurringSeries.id, rent.rentId))
      .run();
  };
  const surfaces = () => {
    const d = seriesDetail(bundle.db, rent.rentId, TODAY)!;
    const row = listSeries(bundle.db, TODAY).find((s) => s.id === rent.rentId)!;
    const p = provenanceFor(bundle.db, { kind: "recurringSeries", id: rent.rentId, today: TODAY })!;
    return { page: [d.postedAvgCents, d.postedStddevCents], allTab: row.postedAvgCents, popover: p, detail: d };
  };

  test("raised Aug 1: Aug 4's and Sep 2's payments — -$2,264.16 ± $38.25 on all three, not -$2,312.20", () => {
    raise("2026-07-31");
    const s = surfaces();
    expect(s.page).toEqual([-226_416, 3_825]);
    expect(s.allTab).toBe(-226_416);
    expect(s.popover.headline).toContain("average of what actually posted is -$2,264.16, which is not what you set");
    expect(s.popover.headline).not.toContain("-$2,312.20");
  });

  /*
   * ⛔ The sentence before the average counts and ranges what the average is OF: the two payments at the rate in force
   * now — and says where the other two went. Jun 16's two card rows are at the old rate, so no "posted as 2" is named.
   */
  test("the popover counts the two payments the average is of, and names the two before the change", () => {
    raise("2026-07-31");
    const p = surfaces().popover;
    expect(p.headline).toContain(
      "Its 2 payments at the rate in force since Aug 1, 2026 were 2 different amounts, from -$2,291.21 to " +
        "-$2,237.11 — so any single figure for it is an average, not a repeat. Its 2 payments before Aug 1, 2026 were " +
        "at an earlier rate, and are not counted.",
    );
    expect(p.headline).not.toContain("posted as 2");
    const cents = (s: string): number => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
    const [, lo, hi] = /from (-?\$[\d,.]+) to (-?\$[\d,.]+)/.exec(p.headline)!;
    const avg = cents(/actually posted is (-?\$[\d,.]+[\d])/.exec(p.headline)![1]!);
    expect(avg).toBeGreaterThanOrEqual(cents(lo!));
    expect(avg).toBeLessThanOrEqual(cents(hi!));
    // the documents are still five rows; what they paid is counted as the average counts it
    expect(p.sources[1]).toMatchObject({
      label: "5 tagged postings in the ledger",
      detail:
        "2 payments at the rate in force since Aug 1: 2 different amounts, -$2,291.21 to -$2,237.11 · 2 before it, " +
        "at an earlier rate",
      on: "2026-06-16",
    });
  });

  /* the boundary's other end: Aug 4's payment, on the first day of the rate in force now, is counted everywhere */
  test("raised Aug 4, the day he paid: that payment is the new rate's — -$2,264.16 on all three", () => {
    raise("2026-08-03");
    const s = surfaces();
    expect(s.page).toEqual([-226_416, 3_825]);
    expect(s.allTab).toBe(-226_416);
    expect(s.popover.headline).toContain(
      "Its 2 payments at the rate in force since Aug 4, 2026 were 2 different amounts, from -$2,291.21 to -$2,237.11",
    );
    expect(s.popover.headline).toContain("average of what actually posted is -$2,264.16");
  });

  test("raised Sep 1: its one payment since, -$2,291.21, and no spread", () => {
    raise("2026-08-31");
    const s = surfaces();
    expect(s.page).toEqual([-229_121, null]);
    expect(s.allTab).toBe(-229_121);
    expect(s.popover.headline).toContain(
      "Its one payment at the rate in force since Sep 1, 2026 was -$2,291.21, on Sep 2, 2026. Its 3 payments before " +
        "Sep 1, 2026 were at an earlier rate, and are not counted.",
    );
  });

  /* ⛔ never the old rate's average in its place */
  test("raised Oct 1, nothing paid since: NO posted average on the page, the All tab or the popover", () => {
    raise("2026-09-30");
    const s = surfaces();
    expect(s.page).toEqual([null, null]);
    expect(s.allTab).toBeNull();
    expect(s.popover.headline).not.toContain("average of what actually posted");
    expect(s.popover.headline).toContain(
      "Its 4 payments before Oct 1, 2026 were at an earlier rate, and nothing has posted at the rate in force since — " +
        "so there is no average of it yet.",
    );
    expect(s.popover.sources[1]).toMatchObject({
      label: "5 tagged postings in the ledger",
      detail: "4 payments, all before Oct 1, at an earlier rate",
      on: "2026-06-16",
    });
    expect(JSON.stringify(s.popover)).not.toMatch(/undefined|NaN|Infinity/);
  });

  /* the history is a history: every payment is drawn, each against its own time's rate (§6A 55), as his pay's is */
  test("the Amount history still draws all four payments, the two before Aug 1 against -$2,000.00", () => {
    raise("2026-07-31");
    expect(surfaces().detail.amountHistory.map((h) => [h.date, h.amountCents, h.expectedCents, h.postings])).toEqual([
      ["2026-06-16", -243_480, -200_000, 2],
      ["2026-07-08", -228_570, -200_000, 1],
      ["2026-08-04", -223_711, -210_900, 1],
      ["2026-09-02", -229_121, -210_900, 1],
    ]);
  });

  /*
   * ⚖️ "the rate in force NOW" is the rate of Oct 12 (§6A 63): an increase recorded before its first day — -$2,300.00
   * from Nov 1, his -$2,109.00 through Oct 31 — is not in force yet, and his four payments were made at the rate that
   * is. 🔴 Held to the last era recorded, a copy of his ledger with that history (review of 442de07, 2026-10-12) printed
   * no posted average on the page or the All tab, and the popover read "Its 4 payments before Nov 1, 2026 were at an
   * earlier rate, and nothing has posted at the rate in force since" — beside an Amount history drawing all four
   * against -$2,109.00, the rate `rateOn` reads for Oct 12.
   */
  test("recorded Oct 12, raised from Nov 1: his four payments still count — -$2,312.20 on all three", () => {
    bundle.db
      .update(recurringSeries)
      .set({ userAmountCents: -230_000, userAmountHistory: [{ throughOn: "2026-10-31", amountCents: -210_900 }] })
      .where(eq(recurringSeries.id, rent.rentId))
      .run();
    const s = surfaces();
    expect(s.page).toEqual([-231_220, 8_527]);
    expect(s.allTab).toBe(-231_220);
    expect(s.popover.headline).toContain("average of what actually posted is -$2,312.20, which is not what you set");
    expect(s.popover.headline).toContain("Its 4 payments since Jun 16, 2026 (5 tagged postings: Jun 16's posted as 2)");
    expect(JSON.stringify(s.popover)).not.toMatch(/Nov 1|earlier rate|no average of it yet/);
    expect(s.detail.amountHistory.map((h) => h.expectedCents)).toEqual([-210_900, -210_900, -210_900, -210_900]);
  });

  /* …and with a period before it too, the rate in force is the middle one: Aug 4's and Sep 2's payments */
  test("raised Aug 1, and again from Nov 1: the payments since Aug 1 — -$2,264.16 on all three", () => {
    bundle.db
      .update(recurringSeries)
      .set({
        userAmountCents: -230_000,
        userAmountHistory: [
          { throughOn: "2026-07-31", amountCents: -200_000 },
          { throughOn: "2026-10-31", amountCents: -210_900 },
        ],
      })
      .where(eq(recurringSeries.id, rent.rentId))
      .run();
    const s = surfaces();
    expect(s.page).toEqual([-226_416, 3_825]);
    expect(s.allTab).toBe(-226_416);
    expect(s.popover.headline).toContain(
      "Its 2 payments at the rate in force since Aug 1, 2026 were 2 different amounts, from -$2,291.21 to -$2,237.11",
    );
    expect(s.popover.headline).toContain(
      "Its 2 payments before Aug 1, 2026 were at an earlier rate, and are not counted.",
    );
    expect(s.popover.headline).not.toContain("Nov 1");
  });

  /* a history that ends before his first payment changes nothing anyone reads */
  test("raised before Jun 16: every surface reads exactly as with no history", () => {
    const before = surfaces();
    raise("2026-05-31");
    const after = surfaces();
    expect(after.page).toEqual(before.page);
    expect(after.allTab).toBe(before.allTab);
    expect(after.popover).toEqual(before.popover);
    expect(after.detail.amountHistory.map((h) => h.amountCents)).toEqual(
      before.detail.amountHistory.map((h) => h.amountCents),
    );
  });
});
