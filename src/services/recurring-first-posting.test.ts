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
import { detectRecurringSeries, projectOccurrences, toProjectable } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";
import { planFirstPostings } from "./recurring-first-posting";
import { linkRowsMadeActive } from "./recurring-import-links";

/**
 * After the September postings of the owner's registered commitments would
 * have been imported — Rent utilities & fees on the 1st, Car lease on the
 * 15th, Gym on the 22nd. Amounts and days are the ones he registered
 * (measured on the real ledger, 2026-09-14).
 */
const TODAY = "2026-09-25";

let dir: string;
let bundle: DbBundle;
let card: string;
let checking: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-firstposting-"));
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
  raw?: string;
  accountId?: string;
  seriesId?: string | null;
  linkSource?: SeriesLinkSource | null;
  transferGroupId?: string | null;
}): string {
  seq += 1;
  const accountId = opts.accountId ?? checking;
  const raw = opts.raw ?? `ACH DEBIT ${seq}`;
  return bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription: raw,
      normalizedDescription: normalizeDescription(raw),
      recurringSeriesId: opts.seriesId ?? null,
      seriesLinkSource: opts.linkSource ?? (opts.seriesId ? "detected" : null),
      transferGroupId: opts.transferGroupId ?? null,
      dedupeHash: dedupeHash({ accountId, postedOn: opts.postedOn, amountCents: opts.amountCents, rawDescription: raw, occurrenceIndex: seq }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

/** A commitment registered by hand, the way the owner's four were. */
function register(opts: {
  name: string;
  amountCents: number;
  nextOn: string;
  userDated?: boolean;
  cadence?: Cadence;
  kind?: SeriesKind;
  status?: SeriesStatus;
  accountId?: string | null;
}): string {
  return bundle.db
    .insert(recurringSeries)
    .values({
      name: opts.name,
      kind: opts.kind ?? "bill",
      cadence: opts.cadence ?? "monthly",
      status: opts.status ?? "confirmed",
      accountId: opts.accountId ?? null,
      intervalDaysAvg: 30,
      toleranceDays: 3,
      amountCentsAvg: opts.amountCents,
      nextExpectedOn: opts.nextOn,
      nextExpectedAmountCents: opts.amountCents,
      userAmountCents: opts.amountCents,
      userNextExpectedOn: opts.userDated ? opts.nextOn : null,
      anchorDay: Number(opts.nextOn.slice(8, 10)),
    })
    .returning({ id: recurringSeries.id })
    .get().id;
}

const carLease = (over: { accountId?: string | null; name?: string; kind?: SeriesKind; status?: SeriesStatus } = {}) =>
  register({ name: over.name ?? "Car lease", amountCents: -69504, nextOn: "2026-09-15", userDated: true, ...over });

const linkOf = (txnId: string) => bundle.db.select().from(transactions).where(eq(transactions.id, txnId)).get()!;
const seriesRow = (id: string) => bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get()!;

/**
 * The control every negative sits beside: Gym, $100.00 on the 22nd, posting
 * on the 22nd. It MUST link in the same run, so a negative can never pass
 * merely because nothing links at all.
 */
function gymControl(): { seriesId: string; rowId: string } {
  const seriesId = register({ name: "Gym", amountCents: -10000, nextOn: "2026-09-22" });
  return { seriesId, rowId: post({ postedOn: "2026-09-22", amountCents: -10000, raw: "GYM MEMBERSHIP" }) };
}

function run(ids: readonly string[]): void {
  linkRowsMadeActive(bundle.db, ids, TODAY);
}

describe("the first posting of a commitment that has never posted", () => {
  test("each registered commitment links its first charge, on schedule to the cent", () => {
    const lease = carLease();
    const utilities = register({ name: "Rent utilities & fees", amountCents: -18221, nextOn: "2026-09-01" });
    const gym = register({ name: "Gym", amountCents: -10000, nextOn: "2026-09-22" });
    const leaseRow = post({ postedOn: "2026-09-15", amountCents: -69504, raw: "TOYOTA LEASE PMT" });
    const utilitiesRow = post({ postedOn: "2026-09-01", amountCents: -18221, raw: "FLAMINGO UTIL FEES" });
    const gymRow = post({ postedOn: "2026-09-23", amountCents: -10000, raw: "GYM MEMBERSHIP", accountId: card }); // a day late
    // the fixture expresses the defect: posted, and still owed
    expect(overdueForSeries(bundle.db, new Set([utilities]), "2026-09-01", TODAY).totalCents).toBe(18221);

    expect(linkRowsMadeActive(bundle.db, [leaseRow, utilitiesRow, gymRow], TODAY)).toEqual({ absorbed: 0, firstPostings: 3 });

    for (const [row, series, day] of [
      [leaseRow, lease, "2026-09-15"],
      [utilitiesRow, utilities, "2026-09-01"],
      [gymRow, gym, "2026-09-23"],
    ] as const) {
      expect(linkOf(row).recurringSeriesId).toBe(series);
      expect(linkOf(row).seriesLinkSource).toBe("detected");
      expect(seriesRow(series).lastMatchedOn).toBe(day);
    }
    expect(overdueForSeries(bundle.db, new Set([utilities]), "2026-09-01", TODAY).totalCents).toBe(0);
  });

  test("a second run changes nothing — the series now posts, and posting series are absorption's", () => {
    carLease();
    const row = post({ postedOn: "2026-09-15", amountCents: -69504 });
    run([row]);
    const state = () => bundle.db.select().from(transactions).orderBy(asc(transactions.id)).all();
    const after = state();
    run([row]);
    expect(state()).toEqual(after);
  });

  test("planning writes nothing", () => {
    const lease = carLease();
    const row = post({ postedOn: "2026-09-15", amountCents: -69504 });
    const plan = bundle.db.transaction((tx) => planFirstPostings(tx, TODAY));
    expect(plan).toEqual([{ seriesId: lease, transactionId: row }]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
  });
});

describe("anything short of certain links nothing", () => {
  test("off by one cent", () => {
    carLease();
    const row = post({ postedOn: "2026-09-15", amountCents: -69503 });
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test.each([["2026-09-19"], ["2026-09-11"]])("outside the series' 3-day tolerance (%s)", (postedOn) => {
    carLease();
    const row = post({ postedOn, amountCents: -69504 });
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("on the same day of the month, a month BEFORE the schedule starts", () => {
    const lease = carLease();
    const row = post({ postedOn: "2026-08-15", amountCents: -69504 });
    // what the rule relies on: the walk steps forward from Sep 15 only, so no
    // occurrence exists on Aug 15 for a charge that day to match
    expect(projectOccurrences(toProjectable(seriesRow(lease)), "2026-08-12", "2026-08-18")).toEqual([]);
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("on another account than the series names", () => {
    carLease({ accountId: checking });
    const row = post({ postedOn: "2026-09-15", amountCents: -69504, accountId: card });
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("two candidate rows for one series", () => {
    carLease();
    const one = post({ postedOn: "2026-09-15", amountCents: -69504 });
    const two = post({ postedOn: "2026-09-16", amountCents: -69504, accountId: card });
    const control = gymControl();
    run([one, two, control.rowId]);
    expect(linkOf(one).recurringSeriesId).toBeNull();
    expect(linkOf(two).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("a second candidate sitting in history, outside the scope, still makes it ambiguous", () => {
    carLease();
    const history = post({ postedOn: "2026-09-14", amountCents: -69504, accountId: card });
    const imported = post({ postedOn: "2026-09-15", amountCents: -69504 });
    const control = gymControl();
    run([imported, control.rowId]);
    expect(linkOf(imported).recurringSeriesId).toBeNull();
    expect(linkOf(history).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("two commitments claiming one row", () => {
    carLease();
    carLease({ name: "Car lease (second)" });
    const row = post({ postedOn: "2026-09-15", amountCents: -69504 });
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("a row the user owns", () => {
    carLease();
    const row = post({ postedOn: "2026-09-15", amountCents: -69504, linkSource: "user" });
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(row).seriesLinkSource).toBe("user");
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test.each([
    ["income", 104700],
    ["transfer", -69504],
  ] as const)("a %s series", (kind, amountCents) => {
    register({ name: `A ${kind}`, amountCents, nextOn: "2026-09-15", userDated: true, kind });
    const row = post({ postedOn: "2026-09-15", amountCents });
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("a detected series — only a commitment the owner confirmed", () => {
    carLease({ status: "detected" });
    const row = post({ postedOn: "2026-09-15", amountCents: -69504 });
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("a series that already posts — its next charge is absorption's to link, by description", () => {
    // Car insurance: $361.49, one linked posting on 2026-08-12, next the 11th
    const insurance = register({ name: "Car insurance", amountCents: -36149, nextOn: "2026-09-11" });
    post({ postedOn: "2026-08-12", amountCents: -36149, raw: "INSURANCE PREMIUM AUG", seriesId: insurance });
    const row = post({ postedOn: "2026-09-11", amountCents: -36149, raw: "INSURANCE PREMIUM SEP" });
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("another live series that already posts expects the same charge that day", () => {
    const insurance = register({ name: "Car insurance", amountCents: -36149, nextOn: "2026-09-11" });
    // its August posting is at ANOTHER amount, so the ledger has never carried
    // $361.49 and the identity fence cannot be what holds this negative
    post({ postedOn: "2026-08-12", amountCents: -35758, raw: "INSURANCE PREMIUM AUG", seriesId: insurance });
    register({ name: "A second policy", amountCents: -36149, nextOn: "2026-09-12" });
    const row = post({ postedOn: "2026-09-11", amountCents: -36149, raw: "INSURANCE PMT" });
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("a row in a transfer group", () => {
    carLease();
    const row = post({ postedOn: "2026-09-15", amountCents: -69504, transferGroupId: "tg-1" });
    const control = gymControl();
    run([row, control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });

  test("a row outside the operation's scope", () => {
    carLease();
    const row = post({ postedOn: "2026-09-15", amountCents: -69504 });
    const control = gymControl();
    run([control.rowId]);
    expect(linkOf(row).recurringSeriesId).toBeNull();
    expect(linkOf(control.rowId).recurringSeriesId).toBe(control.seriesId);
  });
});

describe("an amount is an identity only where the ledger has never carried it elsewhere", () => {
  /*
   * 🔴 Uniqueness was counted among the rows imported so far, so the order
   * statements arrived in decided the link. On a copy of the real ledger the
   * 22nd back-tested over 42 months claimed a non-gym $100.00 row in 6 — and
   * $100.00 is on 185 active rows. The descriptors below are the real ledger's.
   */
  test("a $100.00 commitment claims nothing while $100.00 sits elsewhere — whichever statement lands first", () => {
    const gym = register({ name: "Gym", amountCents: -10000, nextOn: "2026-09-22", userDated: true });
    const lease = carLease();
    post({ postedOn: "2026-07-06", amountCents: -10000, raw: "OVERDRAFT TO CHECKING - 9067", accountId: card });
    // upload 1: a brokerage buy, a day before the gym's day, lands first
    const etf = post({ postedOn: "2026-09-21", amountCents: -10000, raw: "SPDR S&P 500 ETF TRUST CUSIP: 78462F103 RECURRING (SPY)" });
    const leaseRow = post({ postedOn: "2026-09-15", amountCents: -69504, raw: "TOYOTA LEASE PMT" });
    run([etf, leaseRow]);
    // upload 2: the gym's own charge, on the card
    const charge = post({ postedOn: "2026-09-22", amountCents: -10000, raw: "GYM MEMBERSHIP", accountId: card });
    run([charge]);

    expect(linkOf(etf).recurringSeriesId).toBeNull();
    expect(linkOf(charge).recurringSeriesId).toBeNull();
    expect(seriesRow(gym).lastMatchedOn).toBeNull();
    // the control, in upload 1: an amount the ledger has never carried links
    expect(linkOf(leaseRow).recurringSeriesId).toBe(lease);
  });

  test("a commitment that names its account needs the amount unique on that account only", () => {
    // a control for the owner's lever, not a new refusal: $100.00 elsewhere in
    // the ledger does not stop a Gym that says which card it bills
    const gym = register({ name: "Gym", amountCents: -10000, nextOn: "2026-09-22", accountId: card });
    post({ postedOn: "2026-07-06", amountCents: -10000, raw: "OVERDRAFT TO CHECKING - 9067" });
    const charge = post({ postedOn: "2026-09-22", amountCents: -10000, raw: "GYM MEMBERSHIP", accountId: card });
    run([charge]);
    expect(linkOf(charge).recurringSeriesId).toBe(gym);
  });
});

describe("what a first-posting link leaves the rest of the app believing", () => {
  test("after its first charge links, the next missed lease payment has too few charges to grade — G2 (a)", () => {
    // ⛔ OWNER DECISION G2 (a), 2026-09-14: KEEP the posting-count check. One
    // linked posting puts the lease in `scheduleIsProven`'s 1–2 band, and a
    // series there is not graded "missed" — even over a date he typed. He was
    // shown (b), "trust a typed date at any posting count", with the consequence
    // that it turns a typed-date bill red, and chose (a). uc/linking's 08a239b
    // implemented (b) and asserted "missed" here; that was not carried.
    //
    // ⚠️ Open, not blessed: arrears (`overdueForSeries`) has no posting-count
    // gate, so it still counts the same October payment owed. Pinned so a
    // change to either side has to be made on purpose.
    const lease = carLease({ accountId: card });
    const first = post({ postedOn: "2026-09-15", amountCents: -69504, raw: "TOYOTA LEASE PMT", accountId: card });
    // the card has been shown through Oct 20, and no October lease payment is in it
    post({ postedOn: "2026-10-20", amountCents: -2200, raw: "GROCERY", accountId: card });

    linkRowsMadeActive(bundle.db, [first], "2026-10-25");
    expect(linkOf(first).recurringSeriesId).toBe(lease);

    const october = recurringCalendar(bundle.db, "2026-10", "2026-10-25");
    const due = october.entriesByDay["2026-10-15"]?.find((e) => e.name === "Car lease" && e.transactionId === null);
    expect(due).toMatchObject({ state: "unsettled", unsettledReason: "schedule_unproven" });
    // the open disagreement named above
    expect(overdueForSeries(bundle.db, new Set([lease]), "2026-10-01", "2026-10-25").totalCents).toBe(69504);
  });

  test("Detect now leaves three import-linked lease payments on Car lease — no duplicate series", () => {
    // 🔴 A hand-registered commitment matches neither of detection's group keys
    // (no merchant id; his name, not the bank's), so three rows linked by import
    // looked like a brand-new pattern: Detect now created a detected series and
    // re-pointed all three at it, and Car lease read owed again beside them.
    const lease = carLease();
    const rows: string[] = [];
    for (const [postedOn, today] of [
      ["2026-09-15", "2026-09-25"],
      ["2026-10-15", "2026-10-25"],
      ["2026-11-16", "2026-11-26"],
    ] as const) {
      const id = post({ postedOn, amountCents: -69504, raw: "TOYOTA FINANCIAL SERVICES LEASE PMT" });
      linkRowsMadeActive(bundle.db, [id], today);
      rows.push(id);
    }
    expect(rows.map((id) => linkOf(id).recurringSeriesId)).toEqual([lease, lease, lease]);
    const seriesBefore = bundle.db.select().from(recurringSeries).all().length;

    const summary = detectRecurringSeries(bundle.db, "2026-12-05");

    expect(summary.created).toBe(0);
    expect(bundle.db.select().from(recurringSeries).all()).toHaveLength(seriesBefore);
    expect(rows.map((id) => linkOf(id).recurringSeriesId)).toEqual([lease, lease, lease]);
    expect(overdueForSeries(bundle.db, new Set([lease]), "2026-11-01", "2026-12-05").totalCents).toBe(0);
  });
});
