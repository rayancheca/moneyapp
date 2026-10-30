import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type Cadence, type SeriesKind, type SeriesStatus } from "@/db/schema/recurring";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { transactions, type CategorizationSource, type SeriesLinkSource } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { overdueForSeries } from "./arrears";
import { loadRecomputeCtx, projectOccurrences, recomputeSeriesStats, toProjectable } from "./recurring";
import { importFilingLine, linkRowsMadeActive } from "./recurring-import-links";

/** The day the Breezeline row of 2026-09-10 was imported into the real ledger. */
const TODAY = "2026-09-14";

let dir: string;
let bundle: DbBundle;
let card: string;
let checking: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-importlinks-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  card = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  checking = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function post(opts: {
  postedOn: string;
  amountCents: number;
  raw: string;
  accountId?: string;
  seriesId?: string | null;
  linkSource?: SeriesLinkSource | null;
  transferGroupId?: string | null;
  /** the stored form, when an older normalizer wrote it — otherwise today's `normalizeDescription(raw)` */
  normalized?: string;
}): string {
  seq += 1;
  const accountId = opts.accountId ?? card;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription: opts.raw,
      normalizedDescription: opts.normalized ?? normalizeDescription(opts.raw),
      recurringSeriesId: opts.seriesId ?? null,
      seriesLinkSource: opts.linkSource ?? (opts.seriesId ? "detected" : null),
      transferGroupId: opts.transferGroupId ?? null,
      dedupeHash: dedupeHash({
        accountId,
        postedOn: opts.postedOn,
        amountCents: opts.amountCents,
        rawDescription: `${opts.raw}#${seq}`,
        occurrenceIndex: seq,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

/** A series registered by hand: its schedule is what the owner typed. */
function register(opts: {
  name: string;
  amountCents: number;
  nextOn: string;
  cadence?: Cadence;
  kind?: SeriesKind;
  status?: SeriesStatus;
  accountId?: string | null;
  anchorDay?: number | null;
  toleranceDays?: number;
}): string {
  const cadence = opts.cadence ?? "monthly";
  return bundle.db
    .insert(recurringSeries)
    .values({
      name: opts.name,
      kind: opts.kind ?? "bill",
      cadence,
      status: opts.status ?? "confirmed",
      accountId: opts.accountId ?? null,
      intervalDaysAvg: cadence === "quarterly" ? 91 : 30,
      toleranceDays: opts.toleranceDays ?? 3,
      amountCentsAvg: opts.amountCents,
      nextExpectedOn: opts.nextOn,
      nextExpectedAmountCents: opts.amountCents,
      userAmountCents: opts.amountCents,
      anchorDay: opts.anchorDay ?? Number(opts.nextOn.slice(8, 10)),
    })
    .returning({ id: recurringSeries.id })
    .get().id;
}

const seriesOf = (txnId: string) =>
  bundle.db.select().from(transactions).where(eq(transactions.id, txnId)).get()!;
const seriesRow = (id: string) =>
  bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get()!;

/** Every link and every stat a linking pass could write. */
function ledgerState() {
  return {
    txns: bundle.db
      .select({ id: transactions.id, s: transactions.recurringSeriesId, src: transactions.seriesLinkSource })
      .from(transactions)
      .orderBy(asc(transactions.id))
      .all(),
    series: bundle.db.select().from(recurringSeries).orderBy(asc(recurringSeries.id)).all(),
  };
}

describe("linking at import — the rows an operation made active, and only those", () => {
  /*
   * 🔴 The real shape, 2026-09-14. Breezeline (internet) is a confirmed bill the
   * owner registered at $50.00 on the 8th, carrying three linked postings:
   * 2026-06-20 -$40.32 under a different descriptor, then 2026-07-10 and
   * 2026-08-10 under "BREEZELINE 866-290-5400 MA". The 2026-09-10 charge was
   * imported that afternoon with that exact descriptor and nothing linked it,
   * so /recurring said "1 × -$50.00 (monthly), came due Sep 8 and has not
   * posted" beside the posting itself.
   *
   * ⛔ It needs three prior rows with an uneven first gap: the 4th is what
   * crosses MIN_OCCURRENCES and recomputes the interval to 27.33, and three
   * identical 30-day gaps could not express the drift 74dfdfe closed.
   */
  test("the Breezeline charge of 2026-09-10 links on import — and the Sep 8 bill is no longer owed", () => {
    const breezeline = register({ name: "Breezeline (internet)", amountCents: -5000, nextOn: "2026-09-08", anchorDay: 8 });
    bundle.db
      .update(recurringSeries)
      .set({ userNextExpectedOn: "2026-09-08", lastMatchedOn: "2026-08-10" })
      .where(eq(recurringSeries.id, breezeline))
      .run();
    post({ postedOn: "2026-06-20", amountCents: -4032, raw: "MOBILE* BREEZELINE REACHPLATFORM", seriesId: breezeline, linkSource: "user" });
    post({ postedOn: "2026-07-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA", seriesId: breezeline });
    post({ postedOn: "2026-08-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA", seriesId: breezeline });
    const imported = post({ postedOn: "2026-09-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA" });

    // the fixture expresses the defect: unlinked, the bill reads as owed
    expect(overdueForSeries(bundle.db, new Set([breezeline]), "2026-09-01", TODAY, TODAY).totalCents).toBe(5000);

    expect(linkRowsMadeActive(bundle.db, [imported], TODAY)).toEqual({ absorbed: 1, firstPostings: 0, filed: [] });

    expect(seriesOf(imported).recurringSeriesId).toBe(breezeline);
    expect(seriesOf(imported).seriesLinkSource).toBe("detected");
    expect(seriesRow(breezeline).lastMatchedOn).toBe("2026-09-10");
    expect(overdueForSeries(bundle.db, new Set([breezeline]), "2026-09-01", TODAY, TODAY).totalCents).toBe(0);
    // …and the recompute the 4th posting triggers does not re-step the owner's
    // schedule: still the 8th, twelve charges a year
    const walk = projectOccurrences(toProjectable(seriesRow(breezeline)), "2026-09-15", "2027-09-14").map((o) => o.date);
    expect(walk).toHaveLength(12);
    expect(walk.every((d) => d.endsWith("-08"))).toBe(true);
  });

  test("a row outside the operation's scope is not claimed, though its description is owned", () => {
    const breezeline = register({ name: "Breezeline (internet)", amountCents: -5000, nextOn: "2026-09-08" });
    post({ postedOn: "2026-07-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA", seriesId: breezeline });
    const history = post({ postedOn: "2026-08-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA" });
    const imported = post({ postedOn: "2026-09-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA" });

    linkRowsMadeActive(bundle.db, [imported], TODAY);

    expect(seriesOf(imported).recurringSeriesId).toBe(breezeline);
    expect(seriesOf(history).recurringSeriesId).toBeNull();
  });

  test("an empty scope writes nothing at all", () => {
    const breezeline = register({ name: "Breezeline (internet)", amountCents: -5000, nextOn: "2026-09-08" });
    post({ postedOn: "2026-08-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA", seriesId: breezeline });
    const absorbable = post({ postedOn: "2026-09-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA" });
    const before = ledgerState();

    expect(linkRowsMadeActive(bundle.db, [], TODAY)).toEqual({ absorbed: 0, firstPostings: 0, filed: [] });
    expect(ledgerState()).toEqual(before);

    // the control: the same row in scope IS linked, so the empty set did it
    linkRowsMadeActive(bundle.db, [absorbable], TODAY);
    expect(seriesOf(absorbable).recurringSeriesId).toBe(breezeline);
  });
});

describe("his weekly pay links at import though the rows it owns were stored by normalizer v2", () => {
  /*
   * 🔴 Measured on his ledger copy 2026-10-29: the Wells Fargo statement of Sep 25 → Oct 26 brought four +$1,141.92
   * deposits, "It America LLC Payroll <day> <13 digits>Qj Karim Checa,Rayan", and linking at import linked none —
   * each normalized to a string no other row can equal, by the ACH ID inside it. Only the off-cycle +$200.00 linked:
   * its ID field holds his name, so its string equals Sep 23's. ⛔ The rows the series owns keep the strings v2
   * stored (nothing rewrites a row of his), so the NEXT statement links only if absorption reads them in v3's form.
   */
  const TODAY_OCT = "2026-10-29";
  const ID_OF_SEP_24 = "It America LLC Payroll 260924 9357426222928Qj Karim Checa,Rayan";

  function weeklyPay(): string {
    const pay = register({
      name: "It America LLC (weekly pay)",
      amountCents: 114192,
      nextOn: "2026-10-01",
      cadence: "weekly",
      kind: "income",
      accountId: checking,
    });
    post({ postedOn: "2026-09-23", amountCents: 456768, raw: "It America LLC Payroll 260923 Rayancheca Rayan Checa", accountId: checking, seriesId: pay, linkSource: "user" });
    post({
      postedOn: "2026-09-24",
      amountCents: 114192,
      raw: ID_OF_SEP_24,
      normalized: "IT AMERICA LLC PAYROLL 9357426222928QJ KARIM CHECA,RAYAN",
      accountId: checking,
      seriesId: pay,
      linkSource: "user",
    });
    return pay;
  }

  test("all four weekly deposits and the off-cycle $200 link to the pay — the reimbursement does not", () => {
    const pay = weeklyPay();
    const weeks = [
      ["2026-10-01", "It America LLC Payroll 261001 9303446743548Qj Karim Checa,Rayan"],
      ["2026-10-08", "It America LLC Payroll 261008 7820845303038Qj Karim Checa,Rayan"],
      ["2026-10-15", "It America LLC Payroll 261015 5970777473238Qj Karim Checa,Rayan"],
      ["2026-10-22", "It America LLC Payroll 261022 9288454030138Qj Karim Checa,Rayan"],
    ].map(([postedOn, raw]) => post({ postedOn: postedOn!, amountCents: 114192, raw: raw!, accountId: checking }));
    const offCycle = post({ postedOn: "2026-10-15", amountCents: 20000, raw: "It America LLC Payroll 261015 Rayancheca Rayan Checa", accountId: checking });
    // his employer paying back a subscription — another payee's words, never his pay
    const reimbursement = post({
      postedOn: "2026-10-20",
      amountCents: 46820,
      raw: "Instant Pmt From It America LLC on 10/20 Ref#20261020021000021P1Brjpc08540023001",
      accountId: checking,
    });

    // the pay's rows are filed nowhere here, so its links name no category to file under
    expect(linkRowsMadeActive(bundle.db, [...weeks, offCycle, reimbursement], TODAY_OCT)).toEqual({
      absorbed: 5,
      firstPostings: 0,
      filed: [],
    });

    expect(weeks.map((id) => seriesOf(id).recurringSeriesId)).toEqual([pay, pay, pay, pay]);
    expect(seriesOf(offCycle).recurringSeriesId).toBe(pay);
    expect(seriesOf(reimbursement).recurringSeriesId).toBeNull();
    expect(seriesRow(pay).lastMatchedOn).toBe("2026-10-22");
  });
});

/*
 * The owner's car insurance, as `data/owner-decisions-2026-09-14.ts` wrote it:
 * `Car insurance` at $357.58, next Dec 11, last Jan 11, owning Progressive's
 * descriptor through the Venture X row of 2026-08-12 he confirmed; and the
 * one-off "Nov 11 balance after the $1,000 early payment", $72.74 on Nov 11
 * only, never posted. A Wells Fargo card purchase at Progressive normalizes to
 * exactly the descriptor `Car insurance` owns (measured, audit 2026-09-15).
 */
const PROGRESSIVE_VENTURE_X = "PROGRESSIVE INS 800-776-4737 OH";
const PROGRESSIVE_WF_CARD = "Purchase authorized on 11/10 Progressive Ins 800-776-4737 OH S466223760601111 Card 7158";

function carInsurance(): string {
  const id = register({ name: "Car insurance", amountCents: -35758, nextOn: "2026-12-11" });
  bundle.db
    .update(recurringSeries)
    .set({ userNextExpectedOn: "2026-12-11", userEndsOn: "2027-01-11", lastMatchedOn: "2026-08-12" })
    .where(eq(recurringSeries.id, id))
    .run();
  post({ postedOn: "2026-08-12", amountCents: -35758, raw: PROGRESSIVE_VENTURE_X, seriesId: id, linkSource: "user" });
  return id;
}

function novemberBalance(): string {
  const id = register({
    name: "Car insurance — Nov 11 balance after the $1,000 early payment",
    amountCents: -7274,
    nextOn: "2026-11-11",
  });
  bundle.db
    .update(recurringSeries)
    .set({ userNextExpectedOn: "2026-11-11", userEndsOn: "2026-11-11" })
    .where(eq(recurringSeries.id, id))
    .run();
  return id;
}

describe("a charge a never-posted commitment expects to the cent is its first posting, whoever owns the descriptor", () => {
  /*
   * 🔴 Absorption ran first and matches on description alone, so the $72.74
   * went to `Car insurance` — n 1 → 2, last_matched_on Aug 12 → Nov 11 — and
   * the one-off built for exactly this charge still read $72.74 owed beside its
   * own posting. Measured on a copy of the real ledger with main's import path
   * (audit, 2026-09-15). First-posting's own fences decide it: exact amount,
   * the schedule's forward walk, uniqueness both ways, and no live series —
   * `Car insurance` included — expecting that amount that day.
   */
  test("Progressive's Nov 11 $72.74 links to the one-off, not to the series owning Progressive's descriptor", () => {
    const TODAY_NOV = "2026-11-20";
    const insurance = carInsurance();
    const balance = novemberBalance();
    const row = post({ postedOn: "2026-11-11", amountCents: -7274, raw: PROGRESSIVE_WF_CARD, accountId: checking });
    // the fixture expresses the conflict: one descriptor, owned elsewhere
    expect(normalizeDescription(PROGRESSIVE_WF_CARD)).toBe(normalizeDescription(PROGRESSIVE_VENTURE_X));
    expect(overdueForSeries(bundle.db, new Set([balance]), "2026-11-01", TODAY_NOV, TODAY_NOV).totalCents).toBe(7274);

    expect(linkRowsMadeActive(bundle.db, [row], TODAY_NOV)).toEqual({ absorbed: 0, firstPostings: 1, filed: [] });

    expect(seriesOf(row).recurringSeriesId).toBe(balance);
    expect(seriesRow(insurance).lastMatchedOn).toBe("2026-08-12");
    expect(overdueForSeries(bundle.db, new Set([balance]), "2026-11-01", TODAY_NOV, TODAY_NOV).totalCents).toBe(0);
  });

  test("the control: a Progressive charge at Car insurance's own amount is still absorbed by it", () => {
    const TODAY_DEC = "2026-12-20";
    const insurance = carInsurance();
    novemberBalance();
    const row = post({ postedOn: "2026-12-11", amountCents: -35758, raw: PROGRESSIVE_WF_CARD, accountId: checking });

    expect(linkRowsMadeActive(bundle.db, [row], TODAY_DEC)).toEqual({ absorbed: 1, firstPostings: 0, filed: [] });
    expect(seriesOf(row).recurringSeriesId).toBe(insurance);
  });
});

describe("a series past its last date owns no later charge by description", () => {
  /*
   * 🔴 `absorbIntoLiveSeries` filtered on status alone. A one-off that ended
   * Nov 11, holding a Nov 10 "VAPE N SMOKE SHOP MIAMI BEACH" row a first-posting
   * guess gave it, took a Dec 3 −$19.77 Vape N Smoke charge weeks after it
   * ended (n 1 → 2, last_matched_on Nov 10 → Dec 3). Measured on a copy of the
   * real ledger, audit 2026-09-15; that descriptor is on 28 unlinked rows there.
   */
  test("an ended one-off takes no charge dated after its last day and its tolerance", () => {
    const TODAY_DEC = "2026-12-10";
    const balance = novemberBalance();
    post({ postedOn: "2026-11-10", amountCents: -7274, raw: "VAPE N SMOKE SHOP MIAMI BEACH", accountId: checking, seriesId: balance });
    bundle.db.update(recurringSeries).set({ lastMatchedOn: "2026-11-10" }).where(eq(recurringSeries.id, balance)).run();
    const later = post({ postedOn: "2026-12-03", amountCents: -1977, raw: "VAPE N SMOKE SHOP MIAMI BEACH", accountId: checking });
    // the control: a live series in the same run DOES absorb its own charge
    const breezeline = register({ name: "Breezeline (internet)", amountCents: -5000, nextOn: "2026-12-08" });
    post({ postedOn: "2026-11-10", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA", seriesId: breezeline });
    const control = post({ postedOn: "2026-12-08", amountCents: -5000, raw: "BREEZELINE 866-290-5400 MA" });

    expect(linkRowsMadeActive(bundle.db, [later, control], TODAY_DEC)).toEqual({
      absorbed: 1,
      firstPostings: 0,
      filed: [],
    });

    expect(seriesOf(later).recurringSeriesId).toBeNull();
    expect(seriesRow(balance).lastMatchedOn).toBe("2026-11-10");
    expect(seriesOf(control).recurringSeriesId).toBe(breezeline);
  });

  test("once the one-off holds Progressive's descriptor too, Car insurance still takes its Dec 11 premium", () => {
    // after the Nov 11 link above, two live series carry the descriptor — and
    // "two owners" made absorption refuse the next premium, which then read owed
    const TODAY_DEC = "2026-12-20";
    const insurance = carInsurance();
    const balance = novemberBalance();
    post({ postedOn: "2026-11-11", amountCents: -7274, raw: PROGRESSIVE_WF_CARD, accountId: checking, seriesId: balance });
    const december = post({ postedOn: "2026-12-11", amountCents: -35758, raw: PROGRESSIVE_WF_CARD, accountId: checking });

    expect(linkRowsMadeActive(bundle.db, [december], TODAY_DEC)).toEqual({ absorbed: 1, firstPostings: 0, filed: [] });

    expect(seriesOf(december).recurringSeriesId).toBe(insurance);
    expect(overdueForSeries(bundle.db, new Set([insurance]), "2026-12-01", TODAY_DEC, TODAY_DEC).totalCents).toBe(0);
  });

  test("while both are live, the same descriptor still has two owners and links nothing", () => {
    const TODAY_NOV = "2026-11-12";
    const insurance = carInsurance();
    const balance = novemberBalance();
    post({ postedOn: "2026-11-10", amountCents: -7274, raw: PROGRESSIVE_WF_CARD, accountId: checking, seriesId: balance });
    const inside = post({ postedOn: "2026-11-12", amountCents: -1500, raw: PROGRESSIVE_WF_CARD, accountId: checking });

    expect(linkRowsMadeActive(bundle.db, [inside], TODAY_NOV)).toEqual({ absorbed: 0, firstPostings: 0, filed: [] });
    expect(seriesOf(inside).recurringSeriesId).toBeNull();
    expect(seriesRow(insurance).lastMatchedOn).toBe("2026-08-12");
  });
});

describe("⚖️ default built, not asked (2026-10-29): what the import links to a series he confirmed, it files", () => {
  /*
   * 🔴 Measured on his ledger copy 2026-10-30, a trial of the Wells Fargo statement Sep 25 → Oct 26 on the copy from
   * before that import: linking at import attached the four +$1,141.92 payroll deposits and the off-cycle +$200.00
   * to "It America LLC (weekly pay)" — confirmed, every deposit he attached filed Income > Salary — and filed none
   * of them, so every pay surface counted none of it: Earned vs banked read $7,156.60 of $23,983.20 (30%) and "5
   * paydays have passed since the last deposit on Sep 24". His own attach files an unfiled row (§6A 47); the
   * import's link to a series he confirmed now files it by the same rule, stamped as the import's so his own
   * filings stay his.
   */
  const TODAY_OCT = "2026-10-29";
  const PAY = "It America LLC (weekly pay)";
  const WEEKS = [
    ["2026-10-01", "It America LLC Payroll 261001 9303446743548Qj Karim Checa,Rayan"],
    ["2026-10-08", "It America LLC Payroll 261008 7820845303038Qj Karim Checa,Rayan"],
    ["2026-10-15", "It America LLC Payroll 261015 5970777473238Qj Karim Checa,Rayan"],
    ["2026-10-22", "It America LLC Payroll 261022 9288454030138Qj Karim Checa,Rayan"],
  ] as const;
  const OFF_CYCLE = "It America LLC Payroll 261015 Rayancheca Rayan Checa";

  function categoryId(parent: string, child?: string): string {
    const top = bundle.db.select().from(categories).all().find((c) => c.parentId === null && c.name === parent)!;
    if (child === undefined) return top.id;
    return bundle.db.select().from(categories).all().find((c) => c.parentId === top.id && c.name === child)!.id;
  }

  function file(
    txnId: string,
    to: string | null,
    source: CategorizationSource | null,
    confidence: number | null = 1,
  ): void {
    bundle.db
      .update(transactions)
      .set({ categoryId: to, categorizationSource: source, categorizationConfidence: confidence })
      .where(eq(transactions.id, txnId))
      .run();
  }

  /** the columns a filing writes */
  function filingOf(txnId: string) {
    const r = seriesOf(txnId);
    return {
      categoryId: r.categoryId,
      categorizationSource: r.categorizationSource,
      categorizationConfidence: r.categorizationConfidence,
      needsReview: r.needsReview,
    };
  }

  /** what the import's filing writes: the category, as the import's — never his 'user' */
  const filedByImport = (to: string) => ({
    categoryId: to,
    categorizationSource: "confirmed_series",
    categorizationConfidence: 1,
    needsReview: false,
  });
  const unfiled = { categoryId: null, categorizationSource: null, categorizationConfidence: null, needsReview: false };

  /** His pay as his ledger holds it: the deposits he attached, filed Income > Salary by his hand. */
  function confirmedPay(status: SeriesStatus = "confirmed"): string {
    const pay = register({
      name: PAY,
      amountCents: 114192,
      nextOn: "2026-10-01",
      cadence: "weekly",
      kind: "income",
      accountId: checking,
      status,
    });
    const salary = categoryId("Income", "Salary");
    const held = [
      post({
        postedOn: "2026-09-23",
        amountCents: 456768,
        raw: "It America LLC Payroll 260923 Rayancheca Rayan Checa",
        accountId: checking,
        seriesId: pay,
        linkSource: "user",
      }),
      post({
        postedOn: "2026-09-24",
        amountCents: 114192,
        raw: "It America LLC Payroll 260924 9357426222928Qj Karim Checa,Rayan",
        accountId: checking,
        seriesId: pay,
        linkSource: "user",
      }),
    ];
    for (const id of held) file(id, salary, "user");
    return pay;
  }

  /** a deposit the statement brought in, flagged for review as the import flags a large credit */
  function deposit(postedOn: string, raw: string, amountCents = 114192): string {
    const id = post({ postedOn, amountCents, raw, accountId: checking });
    bundle.db.update(transactions).set({ needsReview: true }).where(eq(transactions.id, id)).run();
    return id;
  }

  test("his four weekly deposits and the off-cycle $200 are filed Income > Salary — stamped as the import's", () => {
    const pay = confirmedPay();
    const salary = categoryId("Income", "Salary");
    const weeks = WEEKS.map(([postedOn, raw]) => deposit(postedOn, raw));
    const offCycle = deposit("2026-10-15", OFF_CYCLE, 20000);
    // his employer paying back a subscription — another payee's words, never his pay
    const reimbursement = deposit(
      "2026-10-20",
      "Instant Pmt From It America LLC on 10/20 Ref#20261020021000021P1Brjpc08540023001",
      46820,
    );

    const { filed, ...linked } = linkRowsMadeActive(bundle.db, [...weeks, offCycle, reimbursement], TODAY_OCT);

    expect(linked).toEqual({ absorbed: 5, firstPostings: 0 });
    for (const id of [...weeks, offCycle]) expect(filingOf(id)).toEqual(filedByImport(salary));
    expect(seriesOf(reimbursement).recurringSeriesId).toBeNull();
    expect(filingOf(reimbursement)).toEqual({ ...unfiled, needsReview: true });
    // one line for the one series: what it filed, under which category, and the very rows
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      seriesId: pay,
      seriesName: PAY,
      categoryId: salary,
      categoryPath: "Income > Salary",
      count: 5,
    });
    expect([...filed[0]!.transactionIds].sort()).toEqual([...weeks, offCycle].sort());
    expect(importFilingLine(filed[0]!)).toBe("It America LLC (weekly pay): 5 rows filed under Income > Salary");
  });

  test("the report's line counts one row as one row", () => {
    confirmedPay();
    const [first] = WEEKS;
    const { filed } = linkRowsMadeActive(bundle.db, [deposit(first[0], first[1])], TODAY_OCT);
    expect(filed.map(importFilingLine)).toEqual(["It America LLC (weekly pay): 1 row filed under Income > Salary"]);
  });

  test("a series the detector found and he never confirmed files nothing — its charge is linked and left unfiled", () => {
    const streaming = categoryId("Subscriptions", "Streaming");
    const detected = register({
      name: "NFLX",
      amountCents: -1549,
      nextOn: "2026-10-03",
      kind: "subscription",
      status: "detected",
    });
    for (const day of ["2026-07-03", "2026-08-03", "2026-09-03"]) {
      const held = post({ postedOn: day, amountCents: -1549, raw: "NFLX DIGITAL NTFLX US", seriesId: detected });
      file(held, streaming, "merchant_map");
    }
    const october = post({ postedOn: "2026-10-03", amountCents: -1549, raw: "NFLX DIGITAL NTFLX US" });
    // the control: his confirmed pay, in the same run, IS filed
    const pay = confirmedPay();
    const week = deposit(WEEKS[0][0], WEEKS[0][1]);

    const { filed } = linkRowsMadeActive(bundle.db, [october, week], TODAY_OCT);

    expect(seriesOf(october).recurringSeriesId).toBe(detected);
    expect(filingOf(october)).toEqual(unfiled);
    expect(filingOf(week)).toEqual(filedByImport(categoryId("Income", "Salary")));
    expect(filed.map((f) => f.seriesId)).toEqual([pay]);
  });

  test("the first charge of a commitment he registered is filed under the category he named it by", () => {
    const fitness = categoryId("Health", "Fitness");
    const gym = register({ name: "Gym", amountCents: -10037, nextOn: "2026-10-22", accountId: checking });
    bundle.db.update(recurringSeries).set({ userCategoryId: fitness }).where(eq(recurringSeries.id, gym)).run();
    const charge = post({
      postedOn: "2026-10-22",
      amountCents: -10037,
      raw: "MOVE FITNESS MIAMI BEACH FL",
      accountId: checking,
    });

    const { filed, ...linked } = linkRowsMadeActive(bundle.db, [charge], TODAY_OCT);

    expect(linked).toEqual({ absorbed: 0, firstPostings: 1 });
    expect(seriesOf(charge).recurringSeriesId).toBe(gym);
    expect(filingOf(charge)).toEqual(filedByImport(fitness));
    expect(filed.map(importFilingLine)).toEqual(["Gym: 1 row filed under Health > Fitness"]);
  });

  describe("what the import's filing never touches — each beside a deposit of his pay the same run files", () => {
    function payAndControl(): { pay: string; control: string } {
      const pay = confirmedPay();
      return { pay, control: deposit(WEEKS[0][0], WEEKS[0][1]) };
    }

    test("a transfer leg: a row in a transfer group stays unfiled though it carries his pay's words", () => {
      const { pay, control } = payAndControl();
      const leg = post({
        postedOn: "2026-10-08",
        amountCents: 114192,
        raw: WEEKS[1][1],
        accountId: checking,
        transferGroupId: "group-1",
      });

      linkRowsMadeActive(bundle.db, [leg, control], TODAY_OCT);

      expect(seriesOf(leg).recurringSeriesId).toBe(pay);
      expect(filingOf(leg)).toEqual(unfiled);
      expect(filingOf(control).categorizationSource).toBe("confirmed_series");
    });

    test("a transfer series: a confirmed series of transfer kind files nothing", () => {
      const { control } = payAndControl();
      const internal = categoryId("Transfers", "Internal Transfer");
      const SWEEP = "ONLINE TRANSFER TO SAV ...8721";
      const sweep = register({
        name: "Savings sweep",
        amountCents: -30000,
        nextOn: "2026-10-02",
        kind: "transfer",
        accountId: checking,
      });
      const held = post({
        postedOn: "2026-09-02",
        amountCents: -30000,
        raw: SWEEP,
        accountId: checking,
        seriesId: sweep,
        linkSource: "user",
      });
      file(held, internal, "user");
      const october = post({ postedOn: "2026-10-02", amountCents: -30000, raw: SWEEP, accountId: checking });

      linkRowsMadeActive(bundle.db, [october, control], TODAY_OCT);

      expect(seriesOf(october).recurringSeriesId).toBe(sweep);
      expect(filingOf(october)).toEqual(unfiled);
      expect(filingOf(control).categorizationSource).toBe("confirmed_series");
    });

    test("a split row: its parts decide its category, and it stays as they leave it", () => {
      const { pay, control } = payAndControl();
      const split = post({ postedOn: "2026-10-08", amountCents: 114192, raw: WEEKS[1][1], accountId: checking });
      bundle.db
        .insert(transactionSplits)
        .values([
          { transactionId: split, categoryId: categoryId("Income", "Salary"), amountCents: 100000, sortOrder: 0 },
          { transactionId: split, categoryId: categoryId("Income", "Other Income"), amountCents: 14192, sortOrder: 1 },
        ])
        .run();

      linkRowsMadeActive(bundle.db, [split, control], TODAY_OCT);

      expect(seriesOf(split).recurringSeriesId).toBe(pay);
      expect(filingOf(split)).toEqual(unfiled);
      expect(filingOf(control).categorizationSource).toBe("confirmed_series");
    });

    test("money against the series' sign: his pay going back out stays unfiled", () => {
      const { pay, control } = payAndControl();
      const back = post({ postedOn: "2026-10-09", amountCents: -114192, raw: WEEKS[1][1], accountId: checking });

      linkRowsMadeActive(bundle.db, [back, control], TODAY_OCT);

      expect(seriesOf(back).recurringSeriesId).toBe(pay);
      expect(filingOf(back)).toEqual(unfiled);
      expect(filingOf(control).categorizationSource).toBe("confirmed_series");
    });

    test("a row already filed keeps its own category, source and confidence", () => {
      const { pay, control } = payAndControl();
      const other = categoryId("Income", "Other Income");
      const filedAlready = post({ postedOn: "2026-10-08", amountCents: 114192, raw: WEEKS[1][1], accountId: checking });
      file(filedAlready, other, "rule", 0.5);

      linkRowsMadeActive(bundle.db, [filedAlready, control], TODAY_OCT);

      expect(seriesOf(filedAlready).recurringSeriesId).toBe(pay);
      expect(filingOf(filedAlready)).toEqual({
        categoryId: other,
        categorizationSource: "rule",
        categorizationConfidence: 0.5,
        needsReview: false,
      });
      expect(filingOf(control).categorizationSource).toBe("confirmed_series");
    });

    test("his own 'Uncategorized' is his filing: a row he cleared stays cleared", () => {
      const { pay, control } = payAndControl();
      const cleared = post({ postedOn: "2026-10-08", amountCents: 114192, raw: WEEKS[1][1], accountId: checking });
      file(cleared, null, "user");

      linkRowsMadeActive(bundle.db, [cleared, control], TODAY_OCT);

      expect(seriesOf(cleared).recurringSeriesId).toBe(pay);
      expect(filingOf(cleared)).toEqual({ ...unfiled, categorizationSource: "user", categorizationConfidence: 1 });
      expect(filingOf(control).categorizationSource).toBe("confirmed_series");
    });

    test("a row outside the operation's scope stays unfiled, though it sits unfiled on his confirmed pay", () => {
      const { pay, control } = payAndControl();
      const history = post({
        postedOn: "2026-09-17",
        amountCents: 114192,
        raw: WEEKS[1][1],
        accountId: checking,
        seriesId: pay,
      });

      linkRowsMadeActive(bundle.db, [control], TODAY_OCT);

      expect(filingOf(history)).toEqual(unfiled);
      expect(filingOf(control).categorizationSource).toBe("confirmed_series");
    });
  });

  test("the series' category is read before the import links — rows it links filed elsewhere do not rename it", () => {
    const rent = categoryId("Housing", "Rent");
    const supplies = categoryId("Housing", "Home Supplies");
    const RENT = "043257 Flamingo Rent 261001 xxxxx5441 Rayan Karim Checa";
    const flamingo = register({
      name: "Flamingo South Beach (rent)",
      amountCents: -230521,
      nextOn: "2026-10-01",
      accountId: checking,
    });
    const held = post({
      postedOn: "2026-09-01",
      amountCents: -230521,
      raw: RENT,
      accountId: checking,
      seriesId: flamingo,
      linkSource: "user",
    });
    file(held, rent, "user");
    // two rows the merchant map filed elsewhere would outvote his one were the category read after the link
    const elsewhere = ["2026-10-01", "2026-10-02"].map((day) => {
      const id = post({ postedOn: day, amountCents: -230521, raw: RENT, accountId: checking });
      file(id, supplies, "merchant_map");
      return id;
    });
    const loose = post({ postedOn: "2026-10-03", amountCents: -230521, raw: RENT, accountId: checking });

    const { filed } = linkRowsMadeActive(bundle.db, [...elsewhere, loose], TODAY_OCT);

    expect([...elsewhere, loose].map((id) => seriesOf(id).recurringSeriesId)).toEqual([flamingo, flamingo, flamingo]);
    expect(filingOf(loose)).toEqual(filedByImport(rent));
    for (const id of elsewhere) expect(filingOf(id).categoryId).toBe(supplies);
    expect(filed.map(importFilingLine)).toEqual(["Flamingo South Beach (rent): 1 row filed under Housing > Rent"]);
  });

  test("a row in scope that arrives linked to his confirmed pay — a re-read's carry — is filed too", () => {
    const pay = confirmedPay();
    const carried = post({
      postedOn: WEEKS[0][0],
      amountCents: 114192,
      raw: WEEKS[0][1],
      accountId: checking,
      seriesId: pay,
    });

    const { filed, ...linked } = linkRowsMadeActive(bundle.db, [carried], TODAY_OCT);

    expect(linked).toEqual({ absorbed: 0, firstPostings: 0 });
    expect(filingOf(carried)).toEqual(filedByImport(categoryId("Income", "Salary")));
    expect(filed.map(importFilingLine)).toEqual(["It America LLC (weekly pay): 1 row filed under Income > Salary"]);
  });

  test("what the filing feeds is settled in the same step: a recompute afterwards changes nothing", () => {
    // ⛔ The kind a series' stats derive reads its rows' categories (`classifyKind`): three deposits he filed as
    // Internal Transfer outvote four unfiled ones, and four filed Income > Salary outvote the three — so a filing that
    // left the stats as linking settled them would leave a stale kind for the next Detect now to rewrite.
    const internal = categoryId("Transfers", "Internal Transfer");
    const pay = register({
      name: PAY,
      amountCents: 114192,
      nextOn: "2026-10-01",
      cadence: "weekly",
      kind: "income",
      accountId: checking,
    });
    bundle.db
      .update(recurringSeries)
      .set({ userCategoryId: categoryId("Income", "Salary") })
      .where(eq(recurringSeries.id, pay))
      .run();
    for (const day of ["2026-09-10", "2026-09-17", "2026-09-24"]) {
      const held = post({
        postedOn: day,
        amountCents: 114192,
        raw: WEEKS[0][1],
        accountId: checking,
        seriesId: pay,
        linkSource: "user",
      });
      file(held, internal, "user");
    }
    const weeks = WEEKS.map(([postedOn, raw]) => deposit(postedOn, raw));
    const statsOf = (id: string) => ({ ...seriesRow(id), updatedAt: undefined });

    linkRowsMadeActive(bundle.db, weeks, TODAY_OCT);
    const settled = statsOf(pay);
    bundle.db.transaction((tx) => recomputeSeriesStats(tx, pay, TODAY_OCT, loadRecomputeCtx(bundle.db)));

    expect(weeks.map((id) => filingOf(id).categorizationSource)).toEqual(Array(4).fill("confirmed_series"));
    expect(statsOf(pay)).toEqual(settled);
    expect(settled.kind).toBe("income");
  });
});
