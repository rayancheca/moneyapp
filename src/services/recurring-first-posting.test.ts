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
    post({ postedOn: "2026-08-12", amountCents: -36149, raw: "INSURANCE PREMIUM AUG", seriesId: insurance });
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
