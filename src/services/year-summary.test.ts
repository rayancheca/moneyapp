import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { importFiles } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import {
  cashJobNaming,
  externalInvestmentFlows,
  SUMMARY_DISCLAIMER,
  summaryYears,
  yearSummaryView,
} from "./year-summary";

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
    insert({ postedOn: "2026-06-05", amountCents: 104700, rawDescription: "Deposit 999", categoryName: "Salary" });

    const v = yearSummaryView(bundle.db, 2026, TODAY);
    const cashJob = v.summary.sections
      .flatMap((sec) => sec.lines)
      .find((l) => l.id === "cash-job")!;
    expect(cashJob.basis).toContain("the job that replaced it");
    expect(cashJob.basis).toContain("Work-study ended May 13, 2026 and");
    expect(cashJob.label).toBe("Cash job");
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
  });

  /* ⛔ ONE decision, not two that agree. The label and the sentence are chosen
     together, so a future edit cannot move one and leave the other.

     🔴 And the sentence is PROSE: both branches printed the raw constant,
     "Work-study ended 2026-05-13 and these deposits…", on /summary/2026 and
     /summary/2022 — a machine date inside a sentence, where `formatDayFull`
     is the app's rule. */
  test("the label and the basis are chosen from the same fact", () => {
    for (const year of [2021, 2025, 2026, 2027]) {
      const naming = cashJobNaming(year);
      const early = year < 2026;
      expect(naming.label === "Cash job", `label for ${year}`).toBe(!early);
      expect(naming.basis.includes("the job that replaced it"), `basis for ${year}`).toBe(!early);
      expect(naming.basis, `basis for ${year}`).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
      expect(naming.basis, `basis for ${year}`).toContain("May 13, 2026");
    }
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
