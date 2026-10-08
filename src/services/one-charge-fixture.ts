import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";

/**
 * TEST FIXTURE. His two car-insurance series as his ledger stores them on 2026-10-08, filed under Transport (the seed's
 * stand-in for his Car category), on a seeded database (`seedDatabase`):
 *
 *  - "Car insurance — Nov 11 balance after the $1,000 early payment": stored monthly, next and last day both
 *    2026-11-11, -$72.74, never billed. ⚖️ §6A 56 (2026-10-08): ONE charge — "once · Nov 11" wherever a cadence prints.
 *  - "Car insurance": monthly, next 2026-12-11 (re-anchored past the months the $1,000 paid), ends 2027-01-11, charged
 *    Aug 12 and the $1,000 on Sep 3. A monthly bill in its last months — never "once".
 *
 * 🔴 One fixture for the services AND the components that print them: review of 3044ea6 reverted six printers to the
 * stored cadence and every component test stayed green, because only the services' fields were asked.
 */
export interface OneChargeLedger {
  checkingId: string;
  carId: string;
  balanceId: string;
  insuranceId: string;
  /** a posted charge on Checking, filed under Transport and linked to `seriesId` (null: to none) — its id */
  charge: (postedOn: string, amountCents: number, seriesId: string | null) => string;
}

export function seedHisCarSeries(db: AppDatabase): OneChargeLedger {
  const chase = db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  const checkingId = createAccount(db, { institutionId: chase.id, name: "Checking", type: "checking" });
  const carId = db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Transport"), isNull(categories.parentId)))
    .get()!.id;
  const balanceId = db
    .insert(recurringSeries)
    .values({
      name: "Car insurance — Nov 11 balance after the $1,000 early payment",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-11-11",
      userNextExpectedOn: "2026-11-11",
      userEndsOn: "2026-11-11",
      nextExpectedAmountCents: -7274,
      userAmountCents: -7274,
      status: "confirmed",
      lastMatchedOn: null,
      userCategoryId: carId,
    })
    .returning({ id: recurringSeries.id })
    .get().id;
  const insuranceId = db
    .insert(recurringSeries)
    .values({
      name: "Car insurance",
      kind: "bill",
      cadence: "monthly",
      intervalDaysAvg: 30,
      nextExpectedOn: "2026-09-11",
      userNextExpectedOn: "2026-12-11",
      userEndsOn: "2027-01-11",
      nextExpectedAmountCents: -36149,
      userAmountCents: -35758,
      status: "confirmed",
      lastMatchedOn: "2026-09-03",
      userCategoryId: carId,
    })
    .returning({ id: recurringSeries.id })
    .get().id;

  let seq = 0;
  const charge = (postedOn: string, amountCents: number, seriesId: string | null): string => {
    seq += 1;
    const raw = `PROGRESSIVE ${seq}`;
    return db
      .insert(transactions)
      .values({
        accountId: checkingId,
        postedOn,
        amountCents,
        rawDescription: raw,
        normalizedDescription: raw,
        categoryId: carId,
        recurringSeriesId: seriesId,
        dedupeHash: dedupeHash({ accountId: checkingId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: seq }),
      })
      .returning({ id: transactions.id })
      .get().id;
  };
  charge("2026-08-12", -35758, insuranceId);
  charge("2026-09-03", -100000, insuranceId);

  return { checkingId, carId, balanceId, insuranceId, charge };
}
