import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { priceCache } from "@/db/schema/holdings";
import { importFiles } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type SeriesKind, type SeriesStatus } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { rebuildInvestmentHistory } from "./crypto-history";
import { upsertHolding } from "./holdings";
import {
  cashJobNaming,
  externalInvestmentFlows,
  gamblingLostFigure,
  gamblingNote,
  SUMMARY_DISCLAIMER,
  summaryYears,
  yearSummaryView,
} from "./year-summary";
import { yearInsightInput, yearSpendingView } from "./year-insights";

const TODAY = "2026-08-25";
const YEAR = 2025;

let dir: string;
let bundle: DbBundle;
let checkingId: string;
let savingsId: string;
let fileId: string;
let seq = 0;

function catId(name: string): string {
  return bundle.db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}

/**
 * ⚠️ `seedDatabase` predates four of the categories this page reads — Tutoring,
 * Financial Aid, Pass-through and Gambling were all added to the real
 * ledger by later passes. Creating them here rather than skipping them: a test
 * that quietly omitted the financial-aid line would pass on a database where
 * the partition this whole module exists for could never be exercised.
 */
function addMissingCategories(): void {
  const parentOf = (name: string): string => catId(name);
  const rows = [
    { name: "Tutoring", parentId: parentOf("Income"), kind: "income" as const },
    { name: "Financial Aid", parentId: parentOf("Income"), kind: "income" as const },
    { name: "Pass-through", parentId: parentOf("Transfers"), kind: "transfer" as const },
    { name: "Gambling", parentId: null, kind: "expense" as const },
  ];
  let order = 900;
  for (const r of rows) {
    bundle.db.insert(categories).values({ ...r, sortOrder: order++ }).run();
  }
}

function insert(opts: {
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  categoryName: string;
  accountId?: string;
  sourced?: boolean;
  /** the recurring series the row is attached to (`recurring_series_id`) */
  seriesId?: string;
}): void {
  seq += 1;
  const accountId = opts.accountId ?? checkingId;
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      importFileId: opts.sourced === false ? null : fileId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription: opts.rawDescription,
      normalizedDescription: normalizeDescription(opts.rawDescription),
      categoryId: catId(opts.categoryName),
      recurringSeriesId: opts.seriesId ?? null,
      dedupeHash: dedupeHash({
        accountId,
        postedOn: opts.postedOn,
        amountCents: opts.amountCents,
        rawDescription: `${opts.rawDescription}#${seq}`,
        occurrenceIndex: seq,
      }),
    })
    .run();
}

/** A recurring series rows can be attached to — weekly, as his pay is. */
function paySeries(name: string, kind: SeriesKind = "income", status: SeriesStatus = "confirmed"): string {
  return bundle.db
    .insert(recurringSeries)
    .values({ name, kind, cadence: "weekly", status })
    .returning({ id: recurringSeries.id })
    .get().id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-yearsum-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Chase Checking", type: "checking" });
  savingsId = createAccount(bundle.db, { institutionId: chase.id, name: "SoFi Savings", type: "savings" });
  fileId = bundle.db
    .insert(importFiles)
    .values({
      fileName: "chase-2025.pdf",
      fileSha256: "a".repeat(64),
      format: "pdf",
      institutionId: chase.id,
      status: "parsed",
      storagePath: "/tmp/chase-2025.pdf",
      importedAt: "2026-01-02T00:00:00Z",
    })
    .returning({ id: importFiles.id })
    .get().id;
  addMissingCategories();
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("yearSummaryView — the earned partition", () => {
  beforeEach(() => {
    insert({ postedOn: "2025-03-01", amountCents: 100000, rawDescription: "Direct Deposit FORDHAM UNIVERSI PAYROLL", categoryName: "Salary" });
    insert({ postedOn: "2025-04-01", amountCents: 50000, rawDescription: "ATM DEPOSIT", categoryName: "Salary" });
    insert({ postedOn: "2025-05-01", amountCents: 20000, rawDescription: "KNACK PAYOUT", categoryName: "Tutoring" });
    insert({ postedOn: "2025-06-01", amountCents: 1000, rawDescription: "INTEREST", categoryName: "Interest", accountId: savingsId });
  });

  test("Fordham wages and the cash job are separate lines, both earned", () => {
    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    const earned = v.summary.sections.find((s) => s.id === "earned")!;
    expect(earned.lines.map((l) => [l.id, l.amountCents])).toEqual([
      ["fordham", 100000],
      ["cash-job", 50000],
      ["knack", 20000],
      ["sofi-interest", 1000],
    ]);
    expect(v.summary.earnedCents).toBe(171000);
  });

  /**
   * The doc records that Fordham work-study ended and the cash job's deposits
   * were categorized `Salary` on the owner's instruction, so `Salary` is no
   * longer pure Fordham. Splitting on the descriptor is what keeps the two
   * answers apart; a category-only split would report the cash job as wages.
   */
  test("a non-Fordham salary row never lands in the Fordham line", () => {
    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    const fordham = v.summary.sections
      .flatMap((s) => s.lines)
      .find((l) => l.id === "fordham")!;
    expect(fordham.amountCents).toBe(100000);
    expect(fordham.rowCount).toBe(1);
  });

  test("savings interest is earned; brokerage cash interest is not", () => {
    const rh = createAccount(bundle.db, {
      institutionId: bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id,
      name: "Robinhood Cash",
      type: "checking",
    });
    insert({ postedOn: "2025-07-01", amountCents: 700, rawDescription: "INT", categoryName: "Interest", accountId: rh });
    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    expect(v.summary.earnedCents).toBe(171000);
    expect(v.summary.investmentCents).toBe(700);
  });

  /**
   * 🔴 THE TWO INTEREST LINES SPLIT ON ACCOUNT NAME, so interest credited to a
   * THIRD account belonged to neither and was counted in no total — on a page
   * headed "All money in". Measured on the real ledger 2026-09-11: 7 rows of
   * SoFi CHECKING interest across 2023-2026, absent from every year's headline.
   *
   * ⛔ And the line that claimed to cover them — "Other income: Income-kind
   * rows that fit none of the named sources above" — is the category literally
   * named "Other Income", so it never could.
   */
  test("interest on a third account lands somewhere rather than nowhere", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
    const other = createAccount(bundle.db, { institutionId: chase, name: "SoFi Checking", type: "checking" });
    insert({ postedOn: "2025-08-01", amountCents: 4, rawDescription: "Interest Earned", categoryName: "Interest", accountId: other });

    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    const ids = v.summary.sections.flatMap((sec) => sec.lines.map((l) => l.id));
    expect(ids).toContain("other-interest");
    const line = v.summary.sections.flatMap((sec) => sec.lines).find((l) => l.id === "other-interest")!;
    expect(line.amountCents).toBe(4);
    // …and it is in the page's total, which is the whole point
    expect(v.summary.totalReceivedCents).toBe(171000 + 4);
    // the earnings definition is untouched: this is not wages
    expect(v.summary.earnedCents).toBe(171000);
  });

  test("no third-account interest renders no such line", () => {
    const ids = yearSummaryView(bundle.db, YEAR, TODAY).summary.sections.flatMap((sec) =>
      sec.lines.map((l) => l.id),
    );
    expect(ids).not.toContain("other-interest");
  });
});

/**
 * 🔴 A YEAR HAS TWO ENDS AND NEITHER WAS PINNED.
 *
 * `yearBounds(2025)` is `[2025-01-01, 2025-12-31]`, and both mutations survived
 * the suite: moving `from` to the 2nd, and moving `to` to the 30th. Every
 * fixture above dates its rows to the 1st of a middle month, so a January-1st
 * paycheque or a December-31st one could be silently dropped from the year's
 * headline and nothing would go red.
 *
 * Written as one test over four rows: the two days INSIDE that are easiest to
 * lose, and the two days OUTSIDE that are easiest to gain.
 */
describe("yearSummaryView — the year includes 1 January and 31 December", () => {
  test("a deposit on each end of the year is counted, and neither neighbour is", () => {
    insert({ postedOn: "2024-12-31", amountCents: 400, rawDescription: "KNACK PAYOUT", categoryName: "Tutoring" });
    insert({ postedOn: "2025-01-01", amountCents: 1100, rawDescription: "KNACK PAYOUT", categoryName: "Tutoring" });
    insert({ postedOn: "2025-12-31", amountCents: 2200, rawDescription: "KNACK PAYOUT", categoryName: "Tutoring" });
    insert({ postedOn: "2026-01-01", amountCents: 800, rawDescription: "KNACK PAYOUT", categoryName: "Tutoring" });

    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    expect(v.summary.earnedCents).toBe(1100 + 2200);
  });
});

/**
 * 🔴 A DESCRIPTION IS A CLAIM, and this one was printed on every year.
 *
 * Measured on `/summary/2022`: "Cash job $1,388.10 — Salary rows that are not
 * Fordham payroll. **Work-study ended 2026-05-13 and these deposits are the job
 * that replaced it.**" The row behind that figure is one `Deposit 1183713709`
 * from 2022-08-25. It cannot be from a job that replaced something ending four
 * years later.
 */
describe("yearSummaryView — the cash job's story is only told where it happened", () => {
  test("a year before work-study ended says so instead of claiming the cash job", () => {
    insert({ postedOn: "2022-08-25", amountCents: 138810, rawDescription: "Deposit 1183713709", categoryName: "Salary" });

    const v = yearSummaryView(bundle.db, 2022, TODAY);
    const cashJob = v.summary.sections
      .flatMap((sec) => sec.lines)
      .find((l) => l.id === "cash-job")!;
    expect(cashJob.basis).toContain("Salary rows that are not Fordham payroll.");
    expect(cashJob.basis).not.toContain("the job that replaced it");
    expect(cashJob.basis).toContain("Work-study ran until May 13, 2026, so in 2022");
    // it says an earlier job existed and refuses to name it, rather than
    // naming one the ledger cannot support
    expect(cashJob.basis).toContain("this ledger does not say");
  });

  test("the year work-study ended, and after it, keeps the history", () => {
    const pay = paySeries("It America LLC (weekly pay)");
    insert({ postedOn: "2026-06-05", amountCents: 104700, rawDescription: "Deposit 999", categoryName: "Salary", seriesId: pay });

    const v = yearSummaryView(bundle.db, 2026, TODAY);
    const cashJob = v.summary.sections
      .flatMap((sec) => sec.lines)
      .find((l) => l.id === "cash-job")!;
    expect(cashJob.basis).toContain("the job that replaced it");
    expect(cashJob.basis).toContain("Work-study ended May 13, 2026, and");
    expect(cashJob.label).toBe("It America LLC (weekly pay)");
  });

  /*
   * 🔴 AND THE LABEL IS A CLAIM TOO — the half the first fix left behind.
   * `/summary/2022` read, on two adjacent lines:
   *
   *     Cash job                                          $1,388.10
   *     Salary rows that are not Fordham payroll. In 2022 that is not yet
   *     the cash job — work-study ran until 2026-05-13.
   *
   * The row denies its own name. A caveat underneath does not undo a wrong
   * heading on top, and the heading is the part a reader scanning the page
   * actually takes away.
   */
  test("a year before the cash job existed does not head the row with its name", () => {
    insert({ postedOn: "2022-08-25", amountCents: 138810, rawDescription: "Deposit 1183713709", categoryName: "Salary" });

    const v = yearSummaryView(bundle.db, 2022, TODAY);
    const cashJob = v.summary.sections
      .flatMap((sec) => sec.lines)
      .find((l) => l.id === "cash-job")!;
    expect(cashJob.label).not.toBe("Cash job");
    // it names the RULE, which is true of every year, and claims no job at all
    expect(cashJob.label).toBe("Salary, not Fordham payroll");
    // …and the basis no longer has to deny the heading above it
    expect(cashJob.basis).not.toContain("not yet the cash job");
    expect(cashJob.basis).toContain("May 13, 2026");
    /*
     * 🔴 …and the CAVEAT is the third claim about the same job, the one both
     * fixes left behind. /summary/2022 printed, in red under a basis that says
     * the ledger cannot name the job, "Deposited irregularly, so a calendar
     * year captures what reached the bank rather than what was worked." — a
     * deposit pattern read off ONE row, and a claim about work, measured
     * 2026-09-15 on the owner's ledger.
     */
    expect(cashJob.caveat).toBeUndefined();
  });

  /* ⛔ ONE decision, not two that agree. The label and the sentence are chosen
     together, so a future edit cannot move one and leave the other.

     🔴 And the sentence is PROSE: both branches printed the raw constant,
     "Work-study ended 2026-05-13 and these deposits…", on /summary/2026 and
     /summary/2022 — a machine date inside a sentence, where `formatDayFull`
     is the app's rule. */
  test("the label and the basis are chosen from the same fact", () => {
    for (const year of [2021, 2025, 2026, 2027]) {
      // his 2026 shape, moved to each year: two cash lumps in June, a payroll lump in September
      const postedOn = [`${year}-06-04`, `${year}-06-05`, `${year}-09-23`, `${year}-09-24`];
      for (const seriesName of ["It America LLC (weekly pay)", null]) {
        const naming = cashJobNaming(year, { seriesName, postedOn });
        const early = year < 2026;
        const named = seriesName !== null;
        const at = `${year}, ${named ? "named" : "unattached"}`;
        expect(naming.label, `label for ${at}`).toBe(seriesName ?? "Salary, not Fordham payroll");
        expect(naming.basis.includes("the job that replaced it"), `basis for ${at}`).toBe(!early && named);
        expect(naming.basis.includes("this ledger does not say"), `basis for ${at}`).toBe(!named);
        expect((naming.caveat ?? "").includes("Deposited irregularly"), `caveat for ${at}`).toBe(!early);
        expect(naming.basis, `basis for ${at}`).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
        expect(naming.basis, `basis for ${at}`).toContain("May 13, 2026");
      }
    }
  });
});

/**
 * 🔴 THE LABEL NAMED A JOB THAT HAD BEEN RENAMED.
 *
 * Measured on his `/summary/2026`, 2026-10-07: "Cash job $7,156.60 — Salary rows
 * that are not Fordham payroll. Work-study ended May 13, 2026, and these
 * deposits are the job that replaced it." Every one of the 4 rows is attached
 * to the series he renamed on 2026-09-28 to name the payer — "It America LLC
 * (weekly pay)" — and two of them are ACH payroll into Wells Fargo, not cash.
 * Every other surface printed the series' name; this one printed a literal.
 */
describe("yearSummaryView — the pay line names the job its rows are attached to", () => {
  const payLine = (year: number) =>
    yearSummaryView(bundle.db, year, "2026-10-07")
      .summary.sections.flatMap((sec) => sec.lines)
      .find((l) => l.id === "cash-job")!;

  /** his four 2026 rows, as the ledger holds them */
  function hisTwentyTwentySix(seriesId: string | undefined): void {
    insert({ postedOn: "2026-06-04", amountCents: 40000, rawDescription: "ATM CASH DEPOSIT", categoryName: "Salary", seriesId });
    insert({ postedOn: "2026-06-05", amountCents: 104700, rawDescription: "ATM CASH DEPOSIT", categoryName: "Salary", seriesId });
    insert({ postedOn: "2026-09-23", amountCents: 456768, rawDescription: "It America LLC Payroll 260923", categoryName: "Salary", seriesId });
    insert({ postedOn: "2026-09-24", amountCents: 114192, rawDescription: "It America LLC Payroll 260924", categoryName: "Salary", seriesId });
  }

  test("his 2026: the four rows of one pay series are headed by that series' name", () => {
    hisTwentyTwentySix(paySeries("It America LLC (weekly pay)"));

    const line = payLine(2026);
    expect(line.label).toBe("It America LLC (weekly pay)");
    expect(line.label).not.toBe("Cash job");
    // the money rule is untouched
    expect(line.amountCents).toBe(715660);
    expect(line.rowCount).toBe(4);
    expect(line.basis).toContain("Salary rows that are not Fordham payroll");
    expect(line.basis).toContain("attached to this pay series");
    expect(line.basis).toContain("Work-study ended May 13, 2026, and these deposits are the job that replaced it.");
    // two June cash lumps, then a four-week payroll lump: the rows DO show irregular deposits
    expect(line.caveat).toBe(
      "Deposited irregularly, so a calendar year captures what reached the bank rather than what was worked.",
    );
  });

  test("a renamed series renames the line — the label is read, not written", () => {
    const pay = paySeries("Cash job (weekly pay)");
    hisTwentyTwentySix(pay);
    expect(payLine(2026).label).toBe("Cash job (weekly pay)");

    bundle.db.update(recurringSeries).set({ name: "It America LLC (weekly pay)" }).where(eq(recurringSeries.id, pay)).run();
    expect(payLine(2026).label).toBe("It America LLC (weekly pay)");
  });

  /*
   * ⛔ "Deposited irregularly" is a claim about the rows. A weekly payroll that
   * lands every Thursday is not irregular, and the caveat would be false on it.
   */
  test("a payroll deposited every week carries no irregular-deposits caveat", () => {
    const pay = paySeries("It America LLC (weekly pay)");
    for (const day of ["2027-01-07", "2027-01-14", "2027-01-21", "2027-01-28", "2027-02-04"]) {
      insert({ postedOn: day, amountCents: 114192, rawDescription: "It America LLC Payroll", categoryName: "Salary", seriesId: pay });
    }

    const line = payLine(2027);
    expect(line.label).toBe("It America LLC (weekly pay)");
    expect(line.caveat).toBeUndefined();
  });

  test("a payday a bank holiday moved by a day is still regular", () => {
    const pay = paySeries("It America LLC (weekly pay)");
    for (const day of ["2027-01-07", "2027-01-14", "2027-01-22", "2027-01-28", "2027-02-04"]) {
      insert({ postedOn: day, amountCents: 114192, rawDescription: "It America LLC Payroll", categoryName: "Salary", seriesId: pay });
    }
    expect(payLine(2027).caveat).toBeUndefined();
  });

  test("rows in no series name the rule, and claim no job", () => {
    hisTwentyTwentySix(undefined);

    const line = payLine(2026);
    expect(line.label).toBe("Salary, not Fordham payroll");
    expect(line.basis).not.toContain("the job that replaced it");
    expect(line.basis).toContain("this ledger does not say");
    expect(line.amountCents).toBe(715660);
  });

  test("rows split across two series name the rule, and claim no job", () => {
    const a = paySeries("It America LLC (weekly pay)");
    const b = paySeries("Somebody else (weekly pay)");
    insert({ postedOn: "2026-09-23", amountCents: 456768, rawDescription: "It America LLC Payroll", categoryName: "Salary", seriesId: a });
    insert({ postedOn: "2026-09-24", amountCents: 114192, rawDescription: "Other Payroll", categoryName: "Salary", seriesId: b });

    const line = payLine(2026);
    expect(line.label).toBe("Salary, not Fordham payroll");
    expect(line.basis).not.toContain("the job that replaced it");
  });

  test("one attached row and one loose row is not one series", () => {
    const pay = paySeries("It America LLC (weekly pay)");
    insert({ postedOn: "2026-09-23", amountCents: 456768, rawDescription: "It America LLC Payroll", categoryName: "Salary", seriesId: pay });
    insert({ postedOn: "2026-09-24", amountCents: 114192, rawDescription: "Deposit", categoryName: "Salary" });

    expect(payLine(2026).label).toBe("Salary, not Fordham payroll");
  });

  /*
   * ⛔ Only a series he STANDS BEHIND names his pay. Dismissing flips the
   * status and leaves every row attached (the re-detection sink), and the repo
   * reads dismissed as "not recurring" (`seriesDrawsAsRecurring`); a detected
   * series is the detector's suggestion, labelled "suggested" (`seriesRowLabel`).
   * Neither is his word, so neither heads the line — or lets the basis name the
   * job that replaced work-study.
   */
  test("a dismissed pay series does not name the line", () => {
    hisTwentyTwentySix(paySeries("It America LLC (weekly pay)", "income", "dismissed"));
    const line = payLine(2026);
    expect(line.label).toBe("Salary, not Fordham payroll");
    expect(line.basis).not.toContain("the job that replaced it");
    expect(line.amountCents).toBe(715660);
  });

  test("a detected — suggested, not confirmed — pay series does not name the line", () => {
    hisTwentyTwentySix(paySeries("It America LLC (weekly pay)", "income", "detected"));
    const line = payLine(2026);
    expect(line.label).toBe("Salary, not Fordham payroll");
    expect(line.basis).not.toContain("the job that replaced it");
  });

  test("an ended pay series still names the line — a job that stopped was still that job", () => {
    hisTwentyTwentySix(paySeries("It America LLC (weekly pay)", "income", "ended"));
    const line = payLine(2026);
    expect(line.label).toBe("It America LLC (weekly pay)");
    expect(line.basis).toContain("the job that replaced it");
  });

  test("a series that is not income does not name pay", () => {
    hisTwentyTwentySix(paySeries("Mystery transfer", "transfer"));
    expect(payLine(2026).label).toBe("Salary, not Fordham payroll");
  });

  /*
   * ⛔ The label names the rows the line MEASURED — not the year's, not the
   * category's. A Fordham row and last year's row in other series sit outside
   * the line, so they cannot unname it.
   */
  test("rows outside the line do not decide its name", () => {
    const pay = paySeries("It America LLC (weekly pay)");
    const fordham = paySeries("Fordham payroll");
    const old = paySeries("An old job");
    hisTwentyTwentySix(pay);
    insert({ postedOn: "2026-05-01", amountCents: 50000, rawDescription: "FORDHAM UNIVERSI PAYROLL", categoryName: "Salary", seriesId: fordham });
    insert({ postedOn: "2025-12-31", amountCents: 50000, rawDescription: "Deposit", categoryName: "Salary", seriesId: old });

    expect(payLine(2026).label).toBe("It America LLC (weekly pay)");
  });
});

describe("yearSummaryView — money in that was not earned", () => {
  test("a financial-aid refund is never added to earnings", () => {
    insert({ postedOn: "2025-01-28", amountCents: 1010000, rawDescription: "FORDHAM UNIVERSI INVOICE", categoryName: "Financial Aid" });
    insert({ postedOn: "2025-03-01", amountCents: 100000, rawDescription: "Direct Deposit FORDHAM UNIVERSI PAYROLL", categoryName: "Salary" });
    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    // the whole point: $10,100 of aid must not inflate $1,000 of wages
    expect(v.summary.earnedCents).toBe(100000);
    expect(v.summary.notEarnedCents).toBe(1010000);
    expect(v.summary.totalReceivedCents).toBe(1110000);
  });

  test("the aid line says WHY it is not earned", () => {
    insert({ postedOn: "2025-01-28", amountCents: 1010000, rawDescription: "FORDHAM UNIVERSI INVOICE", categoryName: "Financial Aid" });
    const aid = yearSummaryView(bundle.db, YEAR, TODAY).summary.sections
      .flatMap((s) => s.lines)
      .find((l) => l.id === "aid")!;
    expect(aid.basis).toMatch(/not earned/i);
  });
});

describe("yearSummaryView — the pass-through shows both legs", () => {
  beforeEach(() => {
    insert({ postedOn: "2025-02-01", amountCents: 500000, rawDescription: "WISE INC", categoryName: "Pass-through" });
    insert({ postedOn: "2025-02-10", amountCents: -300000, rawDescription: "WIRE OUT", categoryName: "Pass-through" });
  });

  test("the inbound leg is the figure and the return leg travels beside it", () => {
    const line = yearSummaryView(bundle.db, YEAR, TODAY).summary.sections
      .find((s) => s.id === "excluded")!
      .lines[0]!;
    expect(line.amountCents).toBe(500000);
    expect(line.counterCents).toBe(300000);
    expect(line.counterLabel).toMatch(/sent back/);
  });

  /*
   * 🔴 "sent back over 1 rows". The counter spelled its noun plural at every
   * count, and this describe's own year sends back exactly one. Not live on the
   * owner's ledger (2025 and 2026 each send back 4, measured 2026-09-15), but a
   * year with one return leg is the shape 2022 had inbound.
   */
  test("one row sent back is one row, and more keep the plural", () => {
    const counter = (): string | undefined =>
      yearSummaryView(bundle.db, YEAR, TODAY).summary.sections.find((s) => s.id === "excluded")!.lines[0]!.counterLabel;
    expect(counter()).toBe("sent back over 1 row");

    insert({ postedOn: "2025-02-20", amountCents: -100000, rawDescription: "WIRE OUT", categoryName: "Pass-through" });
    expect(counter()).toBe("sent back over 2 rows");
  });

  test("neither leg reaches a total the page adds up", () => {
    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    expect(v.summary.totalReceivedCents).toBe(0);
    expect(v.summary.excludedCents).toBe(500000);
  });

  test("a year that really did send money back describes both legs", () => {
    const line = yearSummaryView(bundle.db, YEAR, TODAY).summary.sections
      .find((s) => s.id === "excluded")!
      .lines[0]!;
    expect(line.basis).toContain("both legs largely cancel");
  });

  /*
   * 🔴 That description printed UNCONDITIONALLY, including on /summary/2022 and
   * /summary/2023 — years holding ONE and THREE inbound rows and not a single
   * outbound one. Pass-through money first went back out of these accounts in
   * 2025. The gate was already here, one line below, deciding whether to print
   * the "sent back over N rows" counter; the sentence now reads the same test.
   */
  test("a year with no outbound leg does not claim one", () => {
    insert({ postedOn: "2024-03-01", amountCents: 97_419, rawDescription: "WISE INC", categoryName: "Pass-through" });
    const line = yearSummaryView(bundle.db, 2024, TODAY).summary.sections
      .find((s) => s.id === "excluded")!
      .lines[0]!;
    expect(line.amountCents).toBe(97_419);
    expect(line.counterLabel).toBeUndefined();
    expect(line.basis).toContain("only the arriving leg");
    expect(line.basis).not.toContain("both legs largely cancel");
  });
});

describe("yearSummaryView — gambling is kept out of every total", () => {
  test("wins and losses are reported, and summed into nothing", () => {
    insert({ postedOn: "2025-05-01", amountCents: 15804, rawDescription: "DRAFTKINGS", categoryName: "Gambling" });
    insert({ postedOn: "2025-05-02", amountCents: -44250, rawDescription: "DRAFTKINGS", categoryName: "Gambling" });
    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    expect(v.gambling).toMatchObject({ wonCents: 15804, lostCents: 44250, netCents: -28446, rowCount: 2 });
    expect(v.summary.totalReceivedCents).toBe(0);
    expect(v.summary.sections.every((s) => s.lines.length === 0)).toBe(true);
  });

  test("a year with no gambling reports zeroes rather than nothing", () => {
    expect(yearSummaryView(bundle.db, YEAR, TODAY).gambling).toMatchObject({ rowCount: 0, netCents: 0 });
  });
});

/**
 * ⚖️ Owner decision 2026-10-02 (§6A 34): what the agent's own account pays is not his spending — so its Gambling
 * loss is in no "What you spent" of his. 🔴 The block under it read every account, and says his losses "sit inside
 * the figure under What you spent": a loss on the agent's cash was in Lost and in no Spent, the sentence false of it.
 * The block reads the page's one scope (`lineFor`'s): the agent's cash is none of his gambling. Hypothetical — no
 * such row exists.
 */
describe("yearSummaryView — the gambling block is his, as every line on the page is", () => {
  function agentic(): { agentic: string; book: string } {
    const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const id = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
    const book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: id }).where(eq(accounts.id, book)).run();
    return { agentic: id, book };
  }

  test("⛔ a loss or a win on the agent's cash is no gambling of his — and every cent he lost is in What you spent", () => {
    const { agentic: agent } = agentic();
    insert({ postedOn: "2025-05-01", amountCents: 15804, rawDescription: "DRAFTKINGS", categoryName: "Gambling" });
    insert({ postedOn: "2025-05-02", amountCents: -44250, rawDescription: "DRAFTKINGS", categoryName: "Gambling" });
    insert({ postedOn: "2025-06-01", amountCents: 500, rawDescription: "DRAFTKINGS", categoryName: "Gambling", accountId: agent });
    insert({ postedOn: "2025-06-02", amountCents: -2000, rawDescription: "DRAFTKINGS", categoryName: "Gambling", accountId: agent });

    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    expect(v.gambling).toMatchObject({ wonCents: 15804, lostCents: 44250, netCents: -28446, rowCount: 2 });
    // the sentence's claim: Lost sits inside the figure under What you spent — here all of it
    const spent = yearInsightInput(bundle.db, YEAR, TODAY)!.facts.find((f) => f.id === "f1")!;
    expect(spent.kind === "scalar" && spent.value).toBe(v.gambling.lostCents);
  });

  test("the rule's own edge: unpaired, the account is his, and so is its gambling", () => {
    const { agentic: agent, book } = agentic();
    insert({ postedOn: "2025-06-02", amountCents: -2000, rawDescription: "DRAFTKINGS", categoryName: "Gambling", accountId: agent });
    expect(yearSummaryView(bundle.db, YEAR, TODAY).gambling.rowCount).toBe(0);
    bundle.db.update(accounts).set({ cashAccountId: null }).where(eq(accounts.id, book)).run();
    expect(yearSummaryView(bundle.db, YEAR, TODAY).gambling).toMatchObject({ wonCents: 0, lostCents: 2000, netCents: -2000, rowCount: 1 });
  });
});

/**
 * 🔴 On a RUNNING year the block said its losses "sit inside the figure under What you spent" while it read Jan 1 –
 * Dec 31, and What you spent stops on the last day every account you spend from has been imported through
 * (`yearSpendingWindow`, /spending's cut of the same year): a loss posted past that day was in Lost and in no Spent.
 * The block reads What you spent's own window now, and names it where the year is cut short.
 */
describe("yearSummaryView — a running year's gambling reads the days What you spent reads", () => {
  /** 2026 on checking runs to Aug 21; savings has been imported through Jul 31 and no further */
  function running(): void {
    insert({ postedOn: "2026-07-31", amountCents: 12, rawDescription: "INTEREST EARNED", categoryName: "Interest", accountId: savingsId });
    insert({ postedOn: "2026-03-01", amountCents: -44250, rawDescription: "DRAFTKINGS", categoryName: "Gambling" });
    insert({ postedOn: "2026-08-20", amountCents: -5000, rawDescription: "DRAFTKINGS", categoryName: "Gambling" });
    insert({ postedOn: "2026-08-21", amountCents: 2000, rawDescription: "DRAFTKINGS", categoryName: "Gambling" });
  }

  test("⛔ a loss past the day every account you spend from is imported through is in no Lost, and the block names the window", () => {
    running();
    expect(yearSpendingView(bundle.db, 2026, TODAY)!.windowLabel).toBe("Jan 1 – Jul 31, 2026");

    const { gambling } = yearSummaryView(bundle.db, 2026, TODAY);
    expect(gambling).toEqual({
      wonCents: 0,
      lostCents: 44250,
      netCents: -44250,
      rowCount: 1,
      window: { from: "2026-01-01", to: "2026-07-31", label: "Jan 1 – Jul 31, 2026", truncated: true },
    });
    // the sentence's claim, measured: every cent of Lost is inside the figure under What you spent
    const spent = yearInsightInput(bundle.db, 2026, TODAY)!.facts.find((f) => f.id === "f1")!;
    expect(spent.kind === "scalar" && spent.value).toBe(gambling.lostCents);
    expect(gamblingNote(gambling, true)).toBe(
      "Counted in none of the money-in totals above: winnings are not treated as income here. Losses are spending — " +
        "your categories file Gambling as an expense — and they sit inside the figure under What you spent, over the " +
        "same days: 2026 is still being imported, so both stop on Jul 31, the last day every account you spend from " +
        "has been imported through.",
    );
  });

  test("a finished year reads Jan 1 – Dec 31, and its sentence says nothing of importing", () => {
    running();
    insert({ postedOn: "2025-12-31", amountCents: -1000, rawDescription: "DRAFTKINGS", categoryName: "Gambling" });
    const { gambling } = yearSummaryView(bundle.db, 2025, TODAY);
    expect(gambling).toMatchObject({ lostCents: 1000, rowCount: 1 });
    expect(gambling.window).toEqual({ from: "2025-01-01", to: "2025-12-31", label: "2025", truncated: false });
    expect(gamblingNote(gambling, true)).toBe(
      "Counted in none of the money-in totals above: winnings are not treated as income here. Losses are spending — " +
        "your categories file Gambling as an expense — and they sit inside the figure under What you spent.",
    );
  });

  test("a year What you spent has not reached prints no gambling at all, rather than a loss it is not inside", () => {
    // Jan 2027 has posted on checking; savings is imported through Dec 31, 2026
    insert({ postedOn: "2026-12-31", amountCents: 12, rawDescription: "INTEREST EARNED", categoryName: "Interest", accountId: savingsId });
    insert({ postedOn: "2027-01-05", amountCents: -5000, rawDescription: "DRAFTKINGS", categoryName: "Gambling" });
    expect(yearSpendingView(bundle.db, 2027, "2027-01-20")).toBeNull();
    expect(yearSummaryView(bundle.db, 2027, "2027-01-20").gambling).toEqual({
      wonCents: 0,
      lostCents: 0,
      netCents: 0,
      rowCount: 0,
      window: null,
    });
  });
});

/**
 * 🔴 The block prints whenever it holds a row, and "What you spent" only when the year measured spending above zero
 * (`yearSpendingView`). A year whose only Gambling row is a win printed the block alone, saying its losses "sit inside
 * the figure under What you spent" — a figure not on the page — over a Lost of "−$0.00".
 */
describe("yearSummaryView — a gambling block with no What you spent beside it", () => {
  test("a year whose only gambling is a win prints no What you spent, and the block does not point at one", () => {
    insert({ postedOn: "2025-06-02", amountCents: 15804, rawDescription: "DRAFTKINGS", categoryName: "Gambling" });
    expect(yearSpendingView(bundle.db, YEAR, TODAY)).toBeNull();

    const { gambling } = yearSummaryView(bundle.db, YEAR, TODAY);
    expect(gambling).toMatchObject({ wonCents: 15804, lostCents: 0, netCents: 15804, rowCount: 1 });
    // the ledger runs to that win, so 2025 is cut short there: the block still names its days, and no absent figure
    expect(gamblingNote(gambling, false)).toBe(
      "Counted in none of the money-in totals above: winnings are not treated as income here. Losses are spending — " +
        "your categories file Gambling as an expense. 2025 is still being imported, so these figures stop on Jun 2, " +
        "the last day every account you spend from has been imported through.",
    );
    expect(gamblingNote(gambling, false)).not.toContain("What you spent");
    expect(gamblingLostFigure(gambling.lostCents)).toBe("$0.00");
  });

  test("a finished year with no What you spent says what losses are, and points at nothing", () => {
    const gambling = {
      wonCents: 2000,
      lostCents: 0,
      netCents: 2000,
      rowCount: 1,
      window: { from: "2025-01-01", to: "2025-12-31", label: "2025", truncated: false },
    };
    expect(gamblingNote(gambling, false)).toBe(
      "Counted in none of the money-in totals above: winnings are not treated as income here. Losses are spending — " +
        "your categories file Gambling as an expense.",
    );
  });

  test("a loss reads as one, and no loss reads $0.00 with no sign", () => {
    expect(gamblingLostFigure(44250)).toBe("−$442.50");
    expect(gamblingLostFigure(0)).toBe("$0.00");
  });
});

describe("yearSummaryView — provenance", () => {
  test("a row with no import file is counted as unsourced and its line named", () => {
    insert({ postedOn: "2025-03-01", amountCents: 100000, rawDescription: "Direct Deposit FORDHAM UNIVERSI PAYROLL", categoryName: "Salary" });
    insert({ postedOn: "2025-03-15", amountCents: 50000, rawDescription: "Direct Deposit FORDHAM UNIVERSI PAYROLL", categoryName: "Salary", sourced: false });
    const p = yearSummaryView(bundle.db, YEAR, TODAY).summary.provenance;
    expect(p).toMatchObject({ rowCount: 2, sourcedRowCount: 1, unsourcedRowCount: 1, complete: false });
    expect(p.unsourcedLines).toEqual(["Fordham work-study wages"]);
  });

  test("the source documents behind the year are listed", () => {
    insert({ postedOn: "2025-03-01", amountCents: 100000, rawDescription: "Direct Deposit FORDHAM UNIVERSI PAYROLL", categoryName: "Salary" });
    expect(yearSummaryView(bundle.db, YEAR, TODAY).summary.provenance.documents).toEqual(["chase-2025.pdf"]);
  });
});

describe("yearSummaryView — the money-weighted return", () => {
  test("is withheld, with a reason, when there is no portfolio history", () => {
    const m = yearSummaryView(bundle.db, YEAR, TODAY).moneyWeightedReturn;
    expect(m.computed).toBe(false);
    if (!m.computed) expect(m.reason).toMatch(/portfolio/i);
  });
});

describe("yearSummaryView — the page's own words", () => {
  test("carries a disclaimer that names what it is not", () => {
    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    expect(v.disclaimer).toBe(SUMMARY_DISCLAIMER);
    expect(v.disclaimer).toMatch(/not tax advice/i);
    expect(v.disclaimer).toMatch(/not a tax document/i);
  });
});

describe("summaryYears", () => {
  test("lists every year with activity, newest first", () => {
    insert({ postedOn: "2024-03-01", amountCents: 100, rawDescription: "X", categoryName: "Salary" });
    insert({ postedOn: "2025-03-01", amountCents: 100, rawDescription: "X", categoryName: "Salary" });
    insert({ postedOn: "2026-03-01", amountCents: 100, rawDescription: "X", categoryName: "Salary" });
    expect(summaryYears(bundle.db)).toEqual([2026, 2025, 2024]);
  });

  test("an empty ledger has no years", () => {
    expect(summaryYears(bundle.db)).toEqual([]);
  });
});

describe("yearSummaryView — an empty year", () => {
  test("is empty rather than an error", () => {
    const v = yearSummaryView(bundle.db, 2019, TODAY);
    expect(v.summary.isEmpty).toBe(true);
    expect(v.summary.totalReceivedCents).toBe(0);
  });

  test("a year's rows do not leak into its neighbour", () => {
    insert({ postedOn: "2024-12-31", amountCents: 100000, rawDescription: "Direct Deposit FORDHAM UNIVERSI PAYROLL", categoryName: "Salary" });
    insert({ postedOn: "2026-01-01", amountCents: 100000, rawDescription: "Direct Deposit FORDHAM UNIVERSI PAYROLL", categoryName: "Salary" });
    expect(yearSummaryView(bundle.db, YEAR, TODAY).summary.isEmpty).toBe(true);
  });
});

describe("externalInvestmentFlows — only money that CROSSES the boundary", () => {
  /*
   * 🔴 The exclusion was `type in (checking, savings)`, and a brokerage's own
   * settlement sleeve is typed `checking`. `lib/account-side` exists for
   * exactly this and says "detection's descriptor rules + pair categories key
   * off this classification, NOT the raw account type"; this was the one caller
   * still using the type.
   *
   * Both legs of every contribution were therefore selected. They land on the
   * same day, the caller nets them to zero, and `money-weighted-return` drops
   * zeroed days — so `/summary/2026` printed "Investment return 115.42 % a year
   * · Money-weighted" of a window in which $25,554.42 of new money went in.
   * The honest figure is 36.15%.
   */
  test("the brokerage's own settlement cash is not an external flow", () => {
    const rh =
      bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get() ??
      bundle.db.insert(institutions).values({ name: "Robinhood" }).returning().get();
    createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Brokerage", type: "investment" });
    const sleeve = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Cash", type: "checking" });

    // one movement, two legs, same day — exactly the shape that netted to zero
    insert({
      postedOn: "2025-05-01",
      amountCents: -500_00,
      rawDescription: "ACH TO ROBINHOOD",
      categoryName: "Investment Contribution",
      accountId: checkingId,
    });
    insert({
      postedOn: "2025-05-01",
      amountCents: 500_00,
      rawDescription: "ACH FROM CHASE",
      categoryName: "Investment Contribution",
      accountId: sleeve,
    });

    const flows = externalInvestmentFlows(bundle.db, "2025-01-01", "2025-12-31");
    expect(flows).toEqual([{ day: "2025-05-01", amountCents: -500_00 }]);
  });

  test("an ordinary savings account IS external", () => {
    insert({
      postedOn: "2025-06-01",
      amountCents: -200_00,
      rawDescription: "ACH TO ROBINHOOD",
      categoryName: "Investment Contribution",
      accountId: savingsId,
    });
    expect(externalInvestmentFlows(bundle.db, "2025-01-01", "2025-12-31")).toEqual([
      { day: "2025-06-01", amountCents: -200_00 },
    ]);
  });
});

/**
 * ⚖️ Owner decisions: Robinhood Agentic is kept OUT of his own brokerage returns (2026-09-14), and its positions live
 * in a brokerage book paired with it (2026-09-15).
 *
 * 🔴 Measured in the design's rehearsal on a copy of the real ledger: the book's first position made /summary
 * withhold 2026's return — "the portfolio's value on Dec 31, 2025 covers only 2 of 3 investment accounts" — because
 * a book that opens mid-year counts as missing on the opening day. A book that is not his is not in that count.
 */
describe("yearSummaryView — the agent's book stays out of HIS money-weighted return", () => {
  const priced = (symbol: string, day: string, close: number): void => {
    bundle.db.insert(priceCache).values({ symbol, assetType: "stock", quotedOn: day, close, source: "yahoo", fetchedAt: `${day}T21:00:00.000Z` }).run();
  };

  test("⛔ a book paired with Robinhood Agentic that opens mid-year neither withholds the year nor moves the rate", () => {
    const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const brokerage = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Brokerage", type: "investment", subtype: "brokerage" });
    priced("AAPL", "2024-12-31", 100);
    priced("AAPL", "2025-12-31", 130);
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "AAPL", assetType: "stock", quantityE8: 10 * 100_000_000, avgCostCents: 10_000, occurredOn: "2024-12-31" });
    rebuildInvestmentHistory(bundle.db, brokerage, TODAY);
    const his = yearSummaryView(bundle.db, YEAR, TODAY).moneyWeightedReturn;
    expect(his).toMatchObject({ computed: true, openCents: 100_000, closeCents: 130_000 });

    const agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
    const book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
    priced("WMT", "2025-06-02", 100);
    priced("WMT", "2025-12-31", 90);
    upsertHolding(bundle.db, { accountId: book, symbol: "WMT", assetType: "stock", quantityE8: 25_000_000, avgCostCents: 10_000, occurredOn: "2025-06-02" });
    rebuildInvestmentHistory(bundle.db, book, TODAY);

    expect(yearSummaryView(bundle.db, YEAR, TODAY).moneyWeightedReturn).toEqual(his);
  });
});

/**
 * ⚖️ Owner decision 2026-09-14: Robinhood Agentic is kept OUT of his own brokerage returns. A dividend the agent's
 * shares pay posts to Agentic, filed Income > Dividends as the activity CSV files one.
 *
 * 🔴 The Investment section read its Dividends line from every account while its Realized line reads his books only
 * (`realizedSalesByDay`): the agent's $0.06 dividend was his, the agent's sale was not (measured 2026-09-16).
 */
describe("yearSummaryView — the Investment section reads one scope: the agent's returns are not his", () => {
  test("⛔ a dividend credited to the cash account of the agent's book is not in his Dividends line, as its sale is not in Realized", () => {
    const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const robinhoodCash = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Cash", type: "checking" });
    createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Brokerage", type: "investment", subtype: "brokerage" });
    insert({ postedOn: "2025-03-14", amountCents: 700, rawDescription: "CASH DIV AAPL", categoryName: "Dividends", accountId: robinhoodCash });
    const agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
    insert({ postedOn: "2025-09-08", amountCents: 6, rawDescription: "Cash Div: R/D 2025-08-21 P/D 2025-09-08 - 0.25 shares at 0.2475", categoryName: "Dividends", accountId: agentic });
    const lines = () => yearSummaryView(bundle.db, YEAR, TODAY).summary.sections.find((sec) => sec.id === "investment")!.lines;

    // no book yet: Agentic is a cash account like any other, and nothing says its money is not his
    expect(lines().map((l) => [l.id, l.amountCents, l.rowCount])).toEqual([["dividends", 706, 2]]);

    const book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();

    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    expect(lines().map((l) => [l.id, l.amountCents, l.rowCount])).toEqual([["dividends", 700, 1]]);
    expect(v.summary.investmentCents).toBe(700);
    // a book linked to a cash account on HIS side is his, and so is what that account is paid
    bundle.db.update(accounts).set({ cashAccountId: null }).where(eq(accounts.id, book)).run();
    const hisBook = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Cash Book", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: robinhoodCash }).where(eq(accounts.id, hisBook)).run();
    expect(lines().map((l) => [l.id, l.amountCents, l.rowCount])).toEqual([["dividends", 706, 2]]);
  });
});

/**
 * ⚖️ The same decision, asked of the page's OTHER lines. `agentsCash` gated the Dividends line and nothing else, so
 * every other line on "All money in" still read the agent's cash account.
 *
 * 🔴 Robinhood pays interest on uninvested cash, and the agent's cash is uninvested between its buys. That interest
 * is filed `Income > Interest` on an account named neither "SoFi Savings" nor "Robinhood Cash", so it fell into
 * "Interest on other accounts" — the agent's return, printed under "Money in that you did not earn" and added to
 * the year's total received, on the one page that already refuses the agent's dividends. Stock-lending pay, filed
 * "Other Income", did the same thing one line below it.
 */
describe("yearSummaryView — ONE scope for the whole page, not for one line", () => {
  test("⛔ interest and other income credited to the agent's cash account are on none of his lines", () => {
    const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const robinhoodCash = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Cash", type: "checking" });
    createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Brokerage", type: "investment", subtype: "brokerage" });
    const agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
    const book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();

    insert({ postedOn: "2025-02-28", amountCents: 900, rawDescription: "CASH INTEREST PAYMENT", categoryName: "Interest", accountId: robinhoodCash });
    insert({ postedOn: "2025-03-31", amountCents: 4, rawDescription: "CASH INTEREST PAYMENT", categoryName: "Interest", accountId: agentic });
    insert({ postedOn: "2025-04-30", amountCents: 11, rawDescription: "STOCK LENDING PAYMENT", categoryName: "Other Income", accountId: agentic });

    const v = yearSummaryView(bundle.db, YEAR, TODAY);
    const byId = new Map(v.summary.sections.flatMap((s) => s.lines).map((l) => [l.id, l]));
    // his brokerage cash interest, whole and alone
    expect([byId.get("brokerage-interest")!.amountCents, byId.get("brokerage-interest")!.rowCount]).toEqual([900, 1]);
    // the agent's $0.04 has no line to fall into, and neither does its $0.11 of lending pay
    expect(byId.has("other-interest")).toBe(false);
    expect(byId.has("other-income")).toBe(false);
    expect(v.summary.totalReceivedCents).toBe(900);
  });

  test("⛔ the same rows are his again once the book is no longer the agent's", () => {
    const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
    const book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
    insert({ postedOn: "2025-03-31", amountCents: 4, rawDescription: "CASH INTEREST PAYMENT", categoryName: "Interest", accountId: agentic });

    expect(yearSummaryView(bundle.db, YEAR, TODAY).summary.totalReceivedCents).toBe(0);
    bundle.db.update(accounts).set({ cashAccountId: null }).where(eq(accounts.id, book)).run();
    expect(yearSummaryView(bundle.db, YEAR, TODAY).summary.totalReceivedCents).toBe(4);
  });
});
