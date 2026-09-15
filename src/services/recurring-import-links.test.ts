import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type Cadence, type SeriesKind, type SeriesStatus } from "@/db/schema/recurring";
import { transactions, type SeriesLinkSource } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { overdueForSeries } from "./arrears";
import { projectOccurrences, toProjectable } from "./recurring";
import { linkRowsMadeActive } from "./recurring-import-links";

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
      normalizedDescription: normalizeDescription(opts.raw),
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
    expect(overdueForSeries(bundle.db, new Set([breezeline]), "2026-09-01", TODAY).totalCents).toBe(5000);

    expect(linkRowsMadeActive(bundle.db, [imported], TODAY)).toEqual({ absorbed: 1, firstPostings: 0 });

    expect(seriesOf(imported).recurringSeriesId).toBe(breezeline);
    expect(seriesOf(imported).seriesLinkSource).toBe("detected");
    expect(seriesRow(breezeline).lastMatchedOn).toBe("2026-09-10");
    expect(overdueForSeries(bundle.db, new Set([breezeline]), "2026-09-01", TODAY).totalCents).toBe(0);
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

    expect(linkRowsMadeActive(bundle.db, [], TODAY)).toEqual({ absorbed: 0, firstPostings: 0 });
    expect(ledgerState()).toEqual(before);

    // the control: the same row in scope IS linked, so the empty set did it
    linkRowsMadeActive(bundle.db, [absorbable], TODAY);
    expect(seriesOf(absorbable).recurringSeriesId).toBe(breezeline);
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
    expect(overdueForSeries(bundle.db, new Set([balance]), "2026-11-01", TODAY_NOV).totalCents).toBe(7274);

    expect(linkRowsMadeActive(bundle.db, [row], TODAY_NOV)).toEqual({ absorbed: 0, firstPostings: 1 });

    expect(seriesOf(row).recurringSeriesId).toBe(balance);
    expect(seriesRow(insurance).lastMatchedOn).toBe("2026-08-12");
    expect(overdueForSeries(bundle.db, new Set([balance]), "2026-11-01", TODAY_NOV).totalCents).toBe(0);
  });

  test("the control: a Progressive charge at Car insurance's own amount is still absorbed by it", () => {
    const TODAY_DEC = "2026-12-20";
    const insurance = carInsurance();
    novemberBalance();
    const row = post({ postedOn: "2026-12-11", amountCents: -35758, raw: PROGRESSIVE_WF_CARD, accountId: checking });

    expect(linkRowsMadeActive(bundle.db, [row], TODAY_DEC)).toEqual({ absorbed: 1, firstPostings: 0 });
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

    expect(linkRowsMadeActive(bundle.db, [later, control], TODAY_DEC)).toEqual({ absorbed: 1, firstPostings: 0 });

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

    expect(linkRowsMadeActive(bundle.db, [december], TODAY_DEC)).toEqual({ absorbed: 1, firstPostings: 0 });

    expect(seriesOf(december).recurringSeriesId).toBe(insurance);
    expect(overdueForSeries(bundle.db, new Set([insurance]), "2026-12-01", TODAY_DEC).totalCents).toBe(0);
  });

  test("while both are live, the same descriptor still has two owners and links nothing", () => {
    const TODAY_NOV = "2026-11-12";
    const insurance = carInsurance();
    const balance = novemberBalance();
    post({ postedOn: "2026-11-10", amountCents: -7274, raw: PROGRESSIVE_WF_CARD, accountId: checking, seriesId: balance });
    const inside = post({ postedOn: "2026-11-12", amountCents: -1500, raw: PROGRESSIVE_WF_CARD, accountId: checking });

    expect(linkRowsMadeActive(bundle.db, [inside], TODAY_NOV)).toEqual({ absorbed: 0, firstPostings: 0 });
    expect(seriesOf(inside).recurringSeriesId).toBeNull();
    expect(seriesRow(insurance).lastMatchedOn).toBe("2026-08-12");
  });
});
