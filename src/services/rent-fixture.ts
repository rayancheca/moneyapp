import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";

/**
 * TEST FIXTURE. His rent and what is billed inside it, as his ledger stores them on 2026-10-12, on a seeded database
 * (`seedDatabase`):
 *
 *  - "Flamingo South Beach (rent)": confirmed, monthly on the 1st with 3 days' grace, -$2,109.00 set by him, paid
 *    Jun 16 in ONE payment the card posted as two rows (-$1,100.00 and -$1,334.80), then Jul 8 -$2,285.70, Aug 4
 *    -$2,237.11 and Sep 2 -$2,291.21.
 *  - "Rent utilities & fees": confirmed, -$182.21 on the 1st, never posted — ⚖️ billed with the rent (§6A 59,
 *    2026-10-08): every rent payment above carries it.
 *
 * One fixture for the services AND the components that print them — the lesson of `one-charge-fixture`.
 */
export interface RentLedger {
  rentId: string;
  utilitiesId: string;
  /** a posted row on the rent's account, linked to `seriesId` — its id */
  charge: (postedOn: string, amountCents: number, seriesId: string) => string;
}

/** His five rent rows: Jun 16's two are one payment. */
export const HIS_RENT_ROWS = [
  ["2026-06-16", -110_000],
  ["2026-06-16", -133_480],
  ["2026-07-08", -228_570],
  ["2026-08-04", -223_711],
  ["2026-09-02", -229_121],
] as const;

export function seedHisRent(db: AppDatabase): RentLedger {
  const chase = db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  const accountId = createAccount(db, { institutionId: chase.id, name: "Rent account", type: "checking" });
  const categoryId = db.select().from(categories).all()[0]!.id;
  const monthly = {
    kind: "bill" as const,
    cadence: "monthly" as const,
    intervalDaysAvg: 30,
    toleranceDays: 3,
    anchorDay: 1,
    status: "confirmed" as const,
    userCategoryId: categoryId,
  };
  const rentId = db
    .insert(recurringSeries)
    .values({
      ...monthly,
      name: "Flamingo South Beach (rent)",
      nextExpectedOn: "2026-09-01",
      userNextExpectedOn: "2026-09-01",
      nextExpectedAmountCents: -228_570,
      userAmountCents: -210_900,
      lastMatchedOn: "2026-09-02",
    })
    .returning({ id: recurringSeries.id })
    .get().id;
  const utilitiesId = db
    .insert(recurringSeries)
    .values({
      ...monthly,
      name: "Rent utilities & fees",
      nextExpectedOn: "2026-09-01",
      nextExpectedAmountCents: -18_221,
      userAmountCents: -18_221,
      lastMatchedOn: null,
      userBilledWithSeriesId: rentId,
    })
    .returning({ id: recurringSeries.id })
    .get().id;

  let seq = 0;
  const charge = (postedOn: string, amountCents: number, seriesId: string): string => {
    seq += 1;
    const raw = `ETT*043257FlamingoSouthBe ${seq}`;
    return db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription: raw,
        normalizedDescription: raw,
        categoryId,
        recurringSeriesId: seriesId,
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: seq }),
      })
      .returning({ id: transactions.id })
      .get().id;
  };
  for (const [postedOn, cents] of HIS_RENT_ROWS) charge(postedOn, cents, rentId);

  return { rentId, utilitiesId, charge };
}
