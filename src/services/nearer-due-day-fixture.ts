import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { arrearsThisMonth } from "./arrears";
import { checkedThrough } from "./checked-days-fixture";
import { forecastForMonth } from "./forecast";
import { upcomingOccurrences } from "./recurring";
import { recurringCalendar } from "./recurring-calendar";

/**
 * TEST FIXTURE. The ledger every pin of his decision 76 grades on — nearer-due-day.test.ts, which states it, and the
 * files split out of it by subject (review of 68c837ce, L14: one file of 2,332 lines, past the 800-line cap): a seeded
 * temp database with one checking account, "acct" (named Wells Fargo Checking), its bills filed under the first
 * top-level expense category, opened before each test and closed after it (`openLedger`, `closeLedger`); the series
 * and rows a test lays down (`bill`, `seriesWith`, `pay`, `rentWith`) and the readers it asks — the calendar's marks,
 * the arrears, Upcoming and a month's forecast (`marks`, `unpaid`, `owed`, `coming`, `labelsIn`).
 */

let dir: string;
let bundle: DbBundle;
let categoryId: string;
export const LEASE = "lease";
export const FPL = "fpl";
export const RENT = "rent";
export const UTIL = "util";
export const MEAL = "meal";
const now = (): string => new Date().toISOString();

/** a row on the account — attached to `seriesId`, or to nothing when it is null */
export function pay(id: string, seriesId: string | null, postedOn: string, cents: number): void {
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: "acct",
      postedOn,
      amountCents: cents,
      rawDescription: id,
      normalizedDescription: id.toUpperCase(),
      categoryId,
      recurringSeriesId: seriesId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${id}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

export const bill = (id: string, name: string, cents: number, nextOn: string) => ({
  id,
  name,
  kind: "bill" as const,
  cadence: "monthly" as const,
  intervalDaysAvg: 30,
  amountCentsAvg: cents,
  toleranceDays: 3,
  nextExpectedOn: nextOn,
  nextExpectedAmountCents: cents,
  userAmountCents: cents,
  anchorDay: Number(nextOn.slice(8)),
  accountId: "acct",
  status: "confirmed" as const,
  userCategoryId: categoryId,
  createdAt: now(),
  updatedAt: now(),
});

/** A fresh ledger for one test: its database, and the category its bills are filed under. */
export function openLedger(): { bundle: DbBundle; categoryId: string } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-nearer-due-day-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: "acct",
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Wells Fargo Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  categoryId = bundle.db.select().from(categories).all().find((c) => c.kind === "expense" && c.parentId === null)!.id;
  return { bundle, categoryId };
}

/** …and gone after it. */
export function closeLedger(): void {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** one series and its own rows, as given — `[postedOn, cents]` */
export function seriesWith(id: string, name: string, cents: number, anchor: string, ...rows: [string, number][]): void {
  bundle.db
    .insert(recurringSeries)
    .values({ ...bill(id, name, cents, anchor), lastMatchedOn: rows.at(-1)?.[0] ?? null })
    .run();
  for (const [postedOn, rowCents] of rows) pay(`t-${id}-${postedOn}`, id, postedOn, rowCents);
}

/** each series' marks on a day — `[series, state, paidWith]` */
export const marks = (key: string, day: string, today: string) =>
  (recurringCalendar(bundle.db, key, today).entriesByDay[day] ?? []).map((e) => [e.seriesId, e.state, e.paidWith]);
/**
 * the series drawn UNPAID on a day — missed, or "?" where one or two postings prove no schedule yet
 * (`scheduleIsProven`): which state is the read's, not the payment's
 */
export const unpaid = (key: string, day: string, today: string) =>
  (recurringCalendar(bundle.db, key, today).entriesByDay[day] ?? [])
    .filter((e) => e.paidWith === null && e.transactionId === null && (e.state === "missed" || e.state === "unsettled"))
    .map((e) => e.seriesId);
export const owed = (today: string) =>
  arrearsThisMonth(bundle.db, new Set([LEASE, FPL, RENT, UTIL, MEAL]), today).series.map((s) => [
    s.id,
    s.nextDate,
    s.amountCents,
  ]);
export const coming = (today: string, id: string) =>
  upcomingOccurrences(bundle.db, today, 60)
    .filter((o) => o.seriesId === id)
    .map((o) => o.date);

/** a carried series' dates, as `rentWith` lays them down */
export type Dates = { rentOn: string; typed: boolean; utilOn: string; utilTyped?: boolean; noneOfTwo?: boolean };
/**
 * a what-if rent at what a month posts, its date `rentOn` (his when `typed`), the utilities carried on `utilOn`; its
 * last row two months at once, unless `noneOfTwo`
 */
export const rentWith = (dates: Dates, ...rows: string[]) => {
  const { rentOn, typed, utilOn, utilTyped = false, noneOfTwo = false } = dates;
  bundle.db
    .insert(recurringSeries)
    .values([
      {
        ...bill(RENT, "What-if (rent)", -229121, rentOn),
        userNextExpectedOn: typed ? rentOn : null,
        lastMatchedOn: rows.at(-1)!,
      },
      {
        ...bill(UTIL, "Rent utilities & fees", -18221, utilOn),
        userNextExpectedOn: utilTyped ? utilOn : null,
        userBilledWithSeriesId: RENT,
      },
    ])
    .run();
  // Jul 1 and Aug 2 at the rate, then the last row two months at once
  const twoAt = noneOfTwo ? -1 : rows.length - 1;
  for (const [i, on] of rows.entries()) pay(`t-rent-${on}`, RENT, on, i === twoAt ? -458242 : -229121);
  checkedThrough(bundle.db, "acct", "2026-10-22");
};
/** the labels of a month's forecast lines (`forecastForMonth`) */
export const labelsIn = (month: string, today: string) =>
  forecastForMonth(bundle.db, month, today)!.components.map((c) => c.label);
