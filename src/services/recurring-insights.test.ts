import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { recurringSeries, type Cadence, type SeriesKind, type SeriesStatus } from "@/db/schema/recurring";
import { seedDatabase } from "@/db/seed";
import { recurringInsights } from "./recurring-insights";

/**
 * A commitment's PLACE among the others, and the four ways that ranking can be
 * wrong in a way no figure on the page would reveal.
 *
 * The annualized cost itself is not tested here — `recurring` owns
 * `annualizedCentsOf` and does so already. What is new is the SET: which series
 * belong in the denominator, which direction they point, and what happens when
 * the set is too small to compare against.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-08-27";

let seq = 0;
function addSeries(opts: {
  id?: string;
  name: string;
  kind?: SeriesKind;
  status?: SeriesStatus;
  cadence?: Cadence;
  amountCents: number | null;
  lastMatchedOn?: string | null;
  intervalDaysAvg?: number | null;
}): string {
  seq += 1;
  const id = opts.id ?? `s-${seq}`;
  bundle.db
    .insert(recurringSeries)
    .values({
      id,
      name: opts.name,
      kind: opts.kind ?? "bill",
      cadence: opts.cadence ?? "monthly",
      intervalDaysAvg: opts.intervalDaysAvg ?? 30,
      toleranceDays: 3,
      nextExpectedOn: "2026-09-01",
      nextExpectedAmountCents: opts.amountCents,
      status: opts.status ?? "confirmed",
      lastMatchedOn: opts.lastMatchedOn === undefined ? "2026-08-01" : opts.lastMatchedOn,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

const texts = (id: string): string[] =>
  (recurringInsights(bundle.db, id, TODAY)?.insights ?? []).map((i) => i.text);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-rinsights-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("where a commitment sits", () => {
  test("ranks it by yearly cost and names the basis inside the sentence", () => {
    addSeries({ id: "rent", name: "Rent", amountCents: -100_000 });
    addSeries({ name: "Internet", amountCents: -5_000 });

    // ⛔ "by what they cost in a year" is not decoration. $1,000 a month is
    // $12,000 a year, and every other figure on this page is per occurrence —
    // a sentence reading "at $12,000.00" without the basis would be true of the
    // fact and wrong to the reader.
    expect(texts("rent")).toEqual([
      "Rent is the largest of your 2 scheduled commitments, by what they cost in a year, at $12,000.00.",
      "Rent is more than half of what your scheduled commitments cost in a year, at 95.2%.",
    ]);
  });

  test("a commitment below first place gets the ordinal, and below half the plain share", () => {
    addSeries({ name: "Rent", amountCents: -100_000 });
    addSeries({ id: "wifi", name: "Internet", amountCents: -5_000 });

    expect(texts("wifi")).toEqual([
      "Internet is the 2nd largest of your 2 scheduled commitments, by what they cost in a year, at $600.00.",
      "Internet is 4.8% of what your scheduled commitments cost in a year.",
    ]);
  });

  test("the shares across one side sum to a whole", () => {
    addSeries({ id: "a", name: "A", amountCents: -30_000 });
    addSeries({ id: "b", name: "B", amountCents: -10_000 });
    addSeries({ id: "c", name: "C", amountCents: -10_000 });

    const shares = ["a", "b", "c"].map((id) => {
      const text = texts(id).find((t) => t.includes("%"))!;
      return Number(/([\d.]+)%/.exec(text)![1]);
    });
    expect(shares.reduce((s, x) => s + x, 0)).toBeCloseTo(100, 1);
  });
});

describe("what it refuses to rank together", () => {
  test("money in and money out are separate sets", () => {
    // annualizedCents is a MAGNITUDE, so a big income would outrank the rent in
    // a single sort and the page would call his pay the largest thing he owes
    addSeries({ id: "rent", name: "Rent", amountCents: -100_000 });
    addSeries({ name: "Internet", amountCents: -5_000 });
    addSeries({ name: "Pay", kind: "income", amountCents: 400_000 });
    addSeries({ name: "Side pay", kind: "income", amountCents: 50_000 });

    expect(texts("rent")).toEqual([
      "Rent is the largest of your 2 scheduled commitments, by what they cost in a year, at $12,000.00.",
      // ⛔ 95.2% — of the two BILLS, not of all four series. A denominator that
      // swept the income in would publish 19.6% and read as "rent is a fifth of
      // your commitments", which is a sentence about a set he was never shown.
      "Rent is more than half of what your scheduled commitments cost in a year, at 95.2%.",
    ]);
  });

  test("an income series is ranked among deposits, in its own words", () => {
    addSeries({ id: "pay", name: "Pay", kind: "income", amountCents: 400_000 });
    addSeries({ name: "Side pay", kind: "income", amountCents: 50_000 });

    expect(texts("pay")).toEqual([
      "Pay is the largest of your 2 scheduled deposits, by what they bring in over a year, at $48,000.00.",
      "Pay is more than half of what your scheduled deposits bring in over a year, at 88.9%.",
    ]);
  });

  test("ended and dismissed series are not in the denominator", () => {
    addSeries({ id: "rent", name: "Rent", amountCents: -100_000 });
    addSeries({ name: "Internet", amountCents: -5_000 });
    addSeries({ name: "Old gym", status: "ended", amountCents: -8_000 });
    addSeries({ name: "Cancelled box", status: "dismissed", amountCents: -3_000 });

    const out = recurringInsights(bundle.db, "rent", TODAY)!;
    expect(out.insights[0]!.text).toContain("your 2 scheduled commitments");
    expect(out.windowNote).toBe("Ranked against the 2 still running. The 2 you have ended or dismissed are not counted.");
  });
});

describe("what gets no strip at all", () => {
  test("an ended series is not ranked last among the living", () => {
    addSeries({ name: "Rent", amountCents: -100_000 });
    addSeries({ name: "Internet", amountCents: -5_000 });
    const gym = addSeries({ name: "Old gym", status: "ended", amountCents: -8_000 });

    // ⛔ absent, not "0% of your commitments" — it is not a member of the set
    expect(recurringInsights(bundle.db, gym, TODAY)).toBeNull();
  });

  test("a lapsed money-out series stops being a commitment", () => {
    addSeries({ name: "Rent", amountCents: -100_000 });
    addSeries({ name: "Internet", amountCents: -5_000 });
    // last charged 449 days ago against a monthly cadence — the UBER *ONE case
    const dead = addSeries({ name: "Uber One", amountCents: -499, lastMatchedOn: "2025-06-04" });

    expect(recurringInsights(bundle.db, dead, TODAY)).toBeNull();
  });

  test("a lapsed INCOME series is still a deposit — money in does not lapse", () => {
    // his cash pay posts irregularly; dropping it the moment a deposit ran late
    // is the dishonesty `lapsedSeriesShouldStopForecasting` exists to prevent
    const late = addSeries({ name: "Cash job", kind: "income", amountCents: 104_700, lastMatchedOn: "2025-06-04" });
    addSeries({ name: "Tutoring", kind: "income", amountCents: 20_000 });

    expect(texts(late)[0]).toContain("is the largest of your 2 scheduled deposits");
  });

  test("a commitment registered but never posted still counts", () => {
    // the car lease starts 2026-09-11 and has no postings by definition —
    // isSeriesActive would call it inactive and delete it from the set
    addSeries({ name: "Rent", amountCents: -100_000 });
    const lease = addSeries({ name: "Car lease", amountCents: -55_989, lastMatchedOn: null });

    expect(texts(lease)[0]).toContain("Car lease is the 2nd largest of your 2 scheduled commitments");
  });

  test("a side of one says nothing — a rank of 1 among 1 is not a ranking", () => {
    const only = addSeries({ id: "pay", name: "Pay", kind: "income", amountCents: 400_000 });
    addSeries({ name: "Rent", amountCents: -100_000 });
    addSeries({ name: "Internet", amountCents: -5_000 });

    expect(recurringInsights(bundle.db, only, TODAY)).toBeNull();
  });

  test("a series with no expected amount cannot be ranked", () => {
    addSeries({ name: "Rent", amountCents: -100_000 });
    addSeries({ name: "Internet", amountCents: -5_000 });
    const vague = addSeries({ name: "Something", amountCents: null });

    expect(recurringInsights(bundle.db, vague, TODAY)).toBeNull();
  });

  test("an unknown id is null, not a throw", () => {
    addSeries({ name: "Rent", amountCents: -100_000 });
    expect(recurringInsights(bundle.db, "nope", TODAY)).toBeNull();
  });

  test("with nothing registered at all there is no strip", () => {
    expect(recurringInsights(bundle.db, "anything", TODAY)).toBeNull();
  });
});

describe("the ranking is stable", () => {
  test("two commitments at the same cost break the tie by name, both ways round", () => {
    addSeries({ id: "zeta", name: "Zeta", amountCents: -5_000 });
    addSeries({ id: "alpha", name: "Alpha", amountCents: -5_000 });

    // a tie resolved by insertion order would let the same series be "the
    // largest" on one render and second on the next
    // ⚠️ This pins the DIRECTION of the tiebreak, not its presence: `listSeries`
    // already ends its own sort with the same comparison and JS sort is stable,
    // so deleting the line in this module changes nothing. Reversing it does.
    expect(texts("alpha")[0]).toContain("is the largest of your 2");
    expect(texts("zeta")[0]).toContain("is the 2nd largest of your 2");
  });

  test("every sentence carries a proof", () => {
    addSeries({ id: "rent", name: "Rent", amountCents: -100_000 });
    addSeries({ name: "Internet", amountCents: -5_000 });

    const out = recurringInsights(bundle.db, "rent", TODAY)!;
    expect(out.insights.length).toBeGreaterThan(0);
    for (const insight of out.insights) expect(insight.provenance).not.toBeNull();
  });

  test("the ids are unique, so React cannot reuse the wrong node", () => {
    addSeries({ id: "rent", name: "Rent", amountCents: -100_000 });
    addSeries({ name: "Internet", amountCents: -5_000 });

    const ids = recurringInsights(bundle.db, "rent", TODAY)!.insights.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
