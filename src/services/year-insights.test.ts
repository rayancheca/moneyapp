import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { candidateKey } from "./insights";
import { writeSetting } from "./settings";
import { yearInsightInput, yearInsights, yearSpendingView } from "./year-insights";

/**
 * The three gates that decide whether a year gets a spending sentence at all,
 * and the one thing every sentence has to carry: its own window.
 *
 * The arithmetic is not tested here — `periodTotals` owns it and does so
 * already. What is new is the WINDOW: where it stops, which year it may be
 * compared against, and whether a reader can tell from the sentence alone that
 * eight months are not being set beside twelve.
 */

let dir: string;
let bundle: DbBundle;
let institutionId: string;
let expenseCategoryId: string;

const now = () => new Date().toISOString();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-year-insights-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(categories)
    .values({ id: "c-food", name: "Fixture Food", parentId: null, kind: "expense", sortOrder: 0, createdAt: now(), updatedAt: now() })
    .run();
  expenseCategoryId = "c-food";
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addAccount(id: string): string {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name: `Fixture ${id}`,
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return id;
}

let txnSeq = 0;
function spend(accountId: string, day: string, cents: number): void {
  txnSeq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `txn-${txnSeq}`,
      accountId,
      importFileId: null,
      postedOn: day,
      amountCents: -cents,
      rawDescription: "COFFEE",
      normalizedDescription: "COFFEE",
      categoryId: expenseCategoryId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `hash-${txnSeq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/**
 * Pushes an account's observation frontier out without adding any spending — a
 * statement that covered a stretch in which nothing was charged, which is the
 * second of the frontier's two arbiters and the only way to test a window that
 * ends after the last transaction.
 */
let periodSeq = 0;
function shownThrough(accountId: string, day: string): void {
  periodSeq += 1;
  const fileId = `f-${periodSeq}`;
  bundle.db
    .insert(importFiles)
    .values({
      id: fileId,
      fileName: `${day}.pdf`,
      fileSha256: `sha-${fileId}`,
      format: "pdf",
      institutionId,
      parserProfile: "chase-checking-statement-pdf",
      parserVersion: 1,
      status: "parsed",
      storagePath: `/tmp/${fileId}.pdf`,
      importedAt: `${day}T00:00:00.000Z`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  bundle.db
    .insert(statementPeriods)
    .values({
      id: `sp-${periodSeq}`,
      accountId,
      importFileId: fileId,
      periodStart: day,
      periodEnd: day,
      reconciliation: "reconciled",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

const texts = (year: number): string[] => (yearInsights(bundle.db, year)?.insights ?? []).map((i) => i.text);

describe("yearInsights — a year against the one before it", () => {
  test("two whole years are compared as whole years, and say so", () => {
    const a = addAccount("a");
    spend(a, "2024-01-01", 10_000);
    spend(a, "2025-03-01", 15_000);
    shownThrough(a, "2026-01-31");

    const r = yearInsights(bundle.db, 2025)!;
    expect(r.windowLabel).toBe("2025");
    // the window needs no explaining, but the SUBJECT always does — every other
    // total on this page is money in
    expect(r.windowNote).toBe(
      "These are money out — counted in none of this page's totals, which are all money in.",
    );
    expect(texts(2025)).toEqual([
      "Spending in 2025 came to $150.00.",
      "Spending rose by $50.00 between 2024 and 2025.",
    ]);
  });

  test("a year that spent less says it fell", () => {
    const a = addAccount("a");
    spend(a, "2024-01-01", 15_000);
    spend(a, "2025-03-01", 10_000);
    shownThrough(a, "2026-01-31");
    expect(texts(2025)[1]).toBe("Spending fell by $50.00 between 2024 and 2025.");
  });

  /**
   * ⛔ The whole point. Eight months of one year beside twelve of another is not
   * a comparison, and the window has to be inside the SENTENCE — a reader
   * scanning the line must not be able to miss it.
   */
  test("a part-year names its own end day, in both labels and the note", () => {
    const a = addAccount("a");
    spend(a, "2025-01-01", 10_000);
    spend(a, "2025-11-01", 90_000); // after the cut — must not reach the comparison
    spend(a, "2026-03-01", 15_000);
    shownThrough(a, "2026-07-31");

    const r = yearInsights(bundle.db, 2026)!;
    expect(r.windowLabel).toBe("Jan 1 – Jul 31, 2026");
    expect(r.windowNote).toMatch(/2026 is still being imported.*through Jul 31/);
    expect(r.windowNote).toMatch(/counted in none of this page's totals/);
    expect(texts(2026)).toEqual([
      "Spending in Jan 1 – Jul 31, 2026 came to $150.00.",
      "Spending rose by $50.00 between Jan 1 – Jul 31, 2025 and Jan 1 – Jul 31, 2026.",
    ]);
  });

  /**
   * ⛔ The rows a proof names have to be the rows the figure was summed from.
   * Rows genuinely exist AFTER the frontier — on the real ledger Chase posts
   * through Aug 24 while SoFi has only been shown through Jul 31 — so a proof
   * reaching to the year's December would answer for 45 rows that are not in
   * the figure it sits beside. Caught by mutation; nothing else here saw it.
   */
  test("the proof stops where the sentence's window stops", () => {
    const a = addAccount("a");
    const b = addAccount("b");
    spend(a, "2025-01-01", 10_000);
    spend(a, "2026-03-01", 15_000);
    shownThrough(a, "2026-07-31");
    // b is shown further, so it keeps posting past the window the frontier sets
    spend(b, "2026-09-15", 70_000);

    const r = yearInsights(bundle.db, 2026)!;
    expect(r.windowLabel).toBe("Jan 1 – Jul 31, 2026");
    expect(r.insights[0]!.text).toBe("Spending in Jan 1 – Jul 31, 2026 came to $150.00.");
    expect(r.insights[0]!.provenance.headline).toMatch(/sum of 1 row\b/);
    // …and the comparison counts that same single row on the current side
    expect(r.insights[1]!.provenance.inputs[0]!.detail).toMatch(/^1 row, /);
  });

  /**
   * ⛔ The EARLIEST frontier, not the latest. Taking the latest lets the
   * best-reported account speak for one that has not sent a statement yet, and
   * on the real ledger that is the difference between a window every account has
   * been shown through and one missing two accounts for three weeks.
   */
  test("the window stops at the account that has been shown through least", () => {
    const behind = addAccount("behind");
    const ahead = addAccount("ahead");
    spend(behind, "2025-01-01", 10_000);
    spend(ahead, "2026-03-01", 15_000);
    shownThrough(behind, "2026-06-30");
    shownThrough(ahead, "2026-12-01");

    expect(yearInsights(bundle.db, 2026)!.windowLabel).toBe("Jan 1 – Jun 30, 2026");
  });

  /**
   * 🔴 ONE YEAR, TWO CUTS. /summary cut its year at the earliest frontier over
   * EVERY account, while /spending cuts at the last day every account he spends
   * from has been imported through. Measured on the real ledger 2026-09-14:
   * /summary/2026 read "Jan 1 – Jul 31, 2026" — SoFi's statements end Jul 31,
   * and SoFi last spent in May — while /spending?period=2026 read "Jan 1 – Aug
   * 12, 2026". Owner decision 2026-09-14: both pages name the same cut.
   *
   * ⚠️ The older tests above hold no account that spends in three of the six
   * baseline months, so they keep every-account's earliest — the rule for a
   * ledger with no habit yet — and cannot tell the two rules apart. This one can.
   */
  test("the year is cut where the accounts you spend from stop, not where a dormant one does", () => {
    const live = addAccount("live");
    const dormant = addAccount("dormant");
    spend(live, "2025-01-01", 15_000);
    for (const m of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) spend(live, `${m}-10`, 10_000);
    spend(dormant, "2026-02-05", 5_000); // one month of spending is not a habit
    shownThrough(live, "2026-08-12");
    shownThrough(dormant, "2026-07-31");

    const r = yearInsights(bundle.db, 2026, "2026-09-14")!;
    expect(r.windowLabel).toBe("Jan 1 – Aug 12, 2026");
    expect(r.windowNote).toContain(
      "both years are measured through Aug 12 — the last day every account you spend from has been imported through.",
    );
    expect(r.insights.map((i) => i.text)).toEqual([
      "Spending in Jan 1 – Aug 12, 2026 came to $650.00.",
      "Spending rose by $500.00 between Jan 1 – Aug 12, 2025 and Jan 1 – Aug 12, 2026.",
    ]);
  });

  /** An account with nothing in it at all does not drag the frontier backwards. */
  test("an account that was never imported does not bound the window", () => {
    const a = addAccount("a");
    addAccount("empty");
    spend(a, "2025-01-01", 10_000);
    spend(a, "2026-03-01", 15_000);
    shownThrough(a, "2026-07-31");

    expect(yearInsights(bundle.db, 2026)!.windowLabel).toBe("Jan 1 – Jul 31, 2026");
  });

  /**
   * ⛔ Gate three, and it bounds the COMPARISON alone. Without it, the first
   * full year of a ledger is compared against the months before the ledger
   * existed — on the real data that would have published "+622.8%" for 2023
   * against a 2022 the ledger holds four months of. That is a measurement of
   * when importing started.
   *
   * 🔴 It used to withhold the whole section, and the year's own total with it.
   * Measured on the owner's ledger 2026-09-04: /summary/2022 and /summary/2023
   * printed EARNED, ALL MONEY IN and PASSED THROUGH and said nothing at all
   * about $4,678.51 and $49,897.80 of money OUT — 265 and 1,162 rows — because
   * of a gate about a different year. The total stands on this year's own
   * documents and never needed the predecessor.
   */
  test("a year whose predecessor is only partly in the ledger keeps its total and loses its comparison", () => {
    const a = addAccount("a");
    spend(a, "2022-08-25", 10_000); // the ledger starts here, mid-2022
    spend(a, "2023-03-01", 90_000);
    shownThrough(a, "2024-01-31"); // both years whole, so neither label is cut

    // the total stands — and nothing else. No "rose"/"fell" against a year the
    // ledger only holds four months of.
    expect(texts(2023)).toEqual(["Spending in 2023 came to $900.00."]);
    // and the absence is explained rather than left as a hole
    expect(yearInsights(bundle.db, 2023)!.windowNote).toContain("There is no comparison with 2022");
    expect(texts(2022)).toEqual(["Spending in 2022 came to $100.00."]);
  });

  /*
   * ⛔ TWO DIFFERENT SENTENCES. A predecessor the ledger holds PART of is a
   * misleading baseline; one it holds NONE of is not a baseline at all, and
   * "only partly in it" would be false of it.
   *
   * ⚠️ And the date carries its year whenever it is not the subject year —
   * `formatDayShort` alone printed "Aug 25" on a page about 2023, the same trap
   * `coverage-detail` recorded when "Dec 5" read as this December.
   */
  test("a predecessor entirely before the ledger is not called 'partly in it'", () => {
    const a = addAccount("a");
    spend(a, "2022-08-25", 10_000);
    spend(a, "2023-03-01", 90_000);
    shownThrough(a, "2024-01-31");

    const y2022 = yearInsights(bundle.db, 2022)!.windowNote!;
    expect(y2022).toContain("There is no comparison with 2021");
    expect(y2022).toContain("after all of it");
    expect(y2022).not.toContain("only partly in it");

    const y2023 = yearInsights(bundle.db, 2023)!.windowNote!;
    expect(y2023).toContain("only partly in it");
    // the opening date is in a different year from the subject, so it says so
    expect(y2023).toContain("Aug 25, 2022");
  });

  /* The measured-zero guard still owns years with no spending at all — a total
     is the only claim left once the comparison is gone, so it must not be $0. */
  test("a year with no spending is still withheld entirely", () => {
    const a = addAccount("a");
    spend(a, "2023-03-01", 90_000);
    expect(yearInsights(bundle.db, 2022)).toBeNull();
  });

  test("a year the ledger has not reached is withheld", () => {
    const a = addAccount("a");
    spend(a, "2025-01-01", 10_000);
    spend(a, "2026-03-01", 15_000);
    expect(yearInsights(bundle.db, 2028)).toBeNull();
  });

  /**
   * ⛔ The route admits only the summary engine's [1900, 2200] now
   * (`parseSummaryYear`), but this module must still not throw on any integer
   * year a caller hands it — and the labels are built by string
   * concatenation, where `year - 1` at the bottom of the range produces `"0-…"`
   * and `"-1-…"` rather than a padded year. `sameDayIn` refusing an invalid date
   * is what keeps those out of a rendered label, and this pins it: a throw here
   * is a 500 on a page he prints.
   */
  test("no four-digit year throws, however far outside the ledger", () => {
    const a = addAccount("a");
    spend(a, "2025-01-01", 10_000);
    spend(a, "2026-03-01", 15_000);
    shownThrough(a, "2026-07-31");

    for (const y of [0, 1, 99, 100, 1899, 1900, 2021, 2027, 2200, 2201, 9999]) {
      expect(() => yearInsights(bundle.db, y)).not.toThrow();
      expect(yearInsights(bundle.db, y)).toBeNull();
    }
    expect(yearInsights(bundle.db, 2026)).not.toBeNull();
  });

  /**
   * ⛔ A measured zero is not a finding. `measured_total` has no `holds` guard —
   * a scalar is a quantity, full stop — so without this the page would print
   * "Spending in 2025 came to $0.00" as an insight.
   */
  test("a window with no spending in it says nothing", () => {
    const a = addAccount("a");
    // income only: a positive row in an income category is not spending
    bundle.db
      .insert(transactions)
      .values({
        id: "txn-income",
        accountId: a,
        importFileId: null,
        postedOn: "2025-03-01",
        amountCents: 50_000,
        rawDescription: "PAY",
        normalizedDescription: "PAY",
        categoryId: null,
        status: "active",
        needsReview: false,
        occurrenceIndex: 0,
        dedupeHash: "hash-income",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    spend(a, "2024-01-01", 10_000);
    shownThrough(a, "2026-01-31");

    expect(yearInsights(bundle.db, 2025)).toBeNull();
  });

  test("an empty ledger says nothing rather than throwing", () => {
    addAccount("a");
    expect(yearInsights(bundle.db, 2025)).toBeNull();
  });

  /**
   * ⛔ Feb 29 is the only day whose existence depends on the year. SQLite would
   * compare `'2027-02-29'` lexicographically without complaint — quietly meaning
   * "through the 28th" — while the label beside the figure printed a date that
   * has never existed.
   */
  test("a window ending on a leap day steps back to the 28th in a common year", () => {
    const a = addAccount("a");
    spend(a, "2027-01-01", 10_000);
    spend(a, "2028-01-15", 15_000);
    shownThrough(a, "2028-02-29");

    const r = yearInsights(bundle.db, 2028)!;
    expect(r.windowLabel).toBe("Jan 1 – Feb 29, 2028");
    expect(texts(2028)[1]).toBe("Spending rose by $50.00 between Jan 1 – Feb 28, 2027 and Jan 1 – Feb 29, 2028.");
  });

  /**
   * ⛔ A change stands on last year's documents exactly as much as on this
   * year's. The delta's badge has to answer for both windows, not for the half
   * that happens to be the page's subject.
   */
  test("the comparison's proof names both windows and the level's names one", () => {
    const a = addAccount("a");
    spend(a, "2024-01-01", 10_000);
    spend(a, "2025-03-01", 15_000);
    shownThrough(a, "2026-01-31");

    const [level, change] = yearInsights(bundle.db, 2025)!.insights;
    expect(level!.provenance.inputs).toEqual([]);
    expect(change!.provenance.inputs.map((i) => i.label)).toEqual(["2025", "2024"]);
    expect(change!.provenance.headline).toMatch(/compares two windows/);
  });
});

/**
 * 🔴 OFF WAS SUPPOSED TO REMOVE PROSE AND NOTHING ELSE — and on the year page
 * it removed the only money-out figures.
 *
 * /settings promises "Turning them off removes the prose and nothing else —
 * every figure keeps its badge". Measured on the owner's ledger 2026-09-15,
 * /summary/2026's spending total ($66,477.60) and its change (+$42,950.02)
 * existed ONLY inside the two sentences, so switching insights off (globally
 * or "A year in review") took both figures and both badges off all five year
 * pages — every other figure there is money in.
 *
 * ⛔ The invariant: every figure the year measured is on the page exactly once,
 * either inside an accepted sentence or as a plain figure with its own proof.
 */
describe("yearSpendingView — turning insights off removes the prose and never a figure", () => {
  const seedTwoYears = (): void => {
    const a = addAccount("a");
    spend(a, "2024-01-01", 10_000);
    spend(a, "2025-03-01", 15_000);
    shownThrough(a, "2026-01-31");
  };
  const carried = (year: number): string[] => {
    const v = yearSpendingView(bundle.db, year)!;
    return [...(v.insights?.insights.map((i) => i.id) ?? []), ...v.figures.map((f) => f.key)].sort();
  };
  const measured = (year: number): string[] => yearInsightInput(bundle.db, year)!.candidates.map(candidateKey).sort();

  test("on: the sentences carry both figures, so neither is printed twice", () => {
    seedTwoYears();
    const v = yearSpendingView(bundle.db, 2025)!;
    expect(v.insights!.insights.map((i) => i.text)).toEqual([
      "Spending in 2025 came to $150.00.",
      "Spending rose by $50.00 between 2024 and 2025.",
    ]);
    expect(v.figures).toEqual([]);
    expect(carried(2025)).toEqual(measured(2025));
  });

  const switches: [string, () => void][] = [
    ["the global switch", () => writeSetting(bundle.db, "insightsEnabled", false)],
    ["A year in review", () => writeSetting(bundle.db, "insightSurfaces", { year: false })],
  ];
  for (const [name, turnOff] of switches) {
    test(`off by ${name}: the total and the change stay, each with its own proof`, () => {
      seedTwoYears();
      turnOff();
      expect(yearInsights(bundle.db, 2025)).toBeNull();

      const v = yearSpendingView(bundle.db, 2025)!;
      expect(v.insights).toBeNull();
      expect(v.figures.map((f) => [f.label, f.cents])).toEqual([
        ["Spent", 15_000],
        ["Change from 2024", 5_000],
      ]);
      // the change stands on both years' documents, exactly as its sentence did
      expect(v.figures[0]!.provenance!.inputs).toEqual([]);
      expect(v.figures[1]!.provenance!.inputs.map((i) => i.label)).toEqual(["2025", "2024"]);
      // the window and the direction note are not prose about the ledger — they
      // define the figure, and a spending total beside money-in totals needs both
      expect(v.windowLabel).toBe("2025");
      expect(v.windowNote).toContain("counted in none of this page's totals");
      expect(carried(2025)).toEqual(measured(2025));
    });
  }

  test("off on a year with no comparison keeps its total and its reason for no change", () => {
    const a = addAccount("a");
    spend(a, "2025-03-01", 15_000);
    shownThrough(a, "2026-01-31");
    writeSetting(bundle.db, "insightsEnabled", false);

    const v = yearSpendingView(bundle.db, 2025)!;
    expect(v.figures.map((f) => [f.label, f.cents])).toEqual([["Spent", 15_000]]);
    expect(v.windowNote).toContain("There is no comparison with 2024");
  });

  test("a year with nothing measured has no view, on or off", () => {
    seedTwoYears();
    expect(yearSpendingView(bundle.db, 2028)).toBeNull();
    writeSetting(bundle.db, "insightsEnabled", false);
    expect(yearSpendingView(bundle.db, 2028)).toBeNull();
  });
});
