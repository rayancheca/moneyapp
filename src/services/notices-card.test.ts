import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import {
  FIRST_CHARGE_FLOOR_CENTS,
  MAX_NOTICES,
  medianCents,
  monthsBetween,
  noticesCard,
} from "./notices-card";

/**
 * Neutral notices — things that happened, described and never judged.
 *
 * ⛔ The wording is enforced by `insight-grammar`'s neutrality sweep, so these
 * tests are about the MEASUREMENT: which charges qualify, which do not, and the
 * one that read exactly backwards on the real ledger.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-08-26";
const ACCT = "acct-1";

function topLevelId(name: string): string {
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), isNull(categories.parentId)))
    .get()!.id;
}

function addMerchant(id: string, name: string): void {
  bundle.db
    .insert(merchants)
    .values({ id, canonicalName: name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .run();
}

let seq = 0;
function addTxn(day: string, cents: number, categoryName: string, merchantId: string | null): string {
  seq += 1;
  const id = `t-${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      id,
      accountId: ACCT,
      importFileId: null,
      postedOn: day,
      amountCents: cents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId: topLevelId(categoryName),
      merchantId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-notices-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(accounts)
    .values({
      id: ACCT,
      institutionId,
      name: "Chase Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a merchant seen once", () => {
  test("is named, with what it took", () => {
    addMerchant("m-1", "Zzz Insurance");
    addTxn("2026-08-12", -35_758, "Transport", "m-1");
    const out = noticesCard(bundle.db, TODAY)!;
    expect(out.notices[0]!.text).toBe("Zzz Insurance appears once in your ledger, for $357.58.");
    expect(out.notices[0]!.claimId).toBe("only_charge");
  });

  test("a small first charge is not news — every merchant has a first one", () => {
    addMerchant("m-1", "Zzz Deli");
    addTxn("2026-08-12", -(FIRST_CHARGE_FLOOR_CENTS - 1), "Food", "m-1");
    expect(noticesCard(bundle.db, TODAY)).toBeNull();
  });

  test("a merchant seen twice is not seen once", () => {
    addMerchant("m-1", "Zzz Shop");
    addTxn("2026-07-01", -30_000, "Shopping", "m-1");
    addTxn("2026-08-12", -30_000, "Shopping", "m-1");
    expect(noticesCard(bundle.db, TODAY)).toBeNull();
  });

  test("an old first charge has stopped being news", () => {
    addMerchant("m-1", "Zzz Shop");
    addTxn("2025-01-04", -90_000, "Shopping", "m-1");
    expect(noticesCard(bundle.db, TODAY)).toBeNull();
  });

  test("a refund is not a charge", () => {
    // an inflow at a merchant is money coming back, and a merchant whose only
    // row is a credit has not charged anything
    addMerchant("m-1", "Zzz Shop");
    addTxn("2026-08-12", 90_000, "Shopping", "m-1");
    expect(noticesCard(bundle.db, TODAY)).toBeNull();
  });
});

describe("a charge far above what he usually pays there", () => {
  const usual = (merchantId: string, cents: number, count: number): void => {
    for (let i = 0; i < count; i += 1) addTxn(`2026-0${(i % 5) + 1}-0${(i % 8) + 1}`, -cents, "Shopping", merchantId);
  };

  test("is stated as a multiple of the usual, never as a verdict", () => {
    addMerchant("m-1", "Zzz Target");
    usual("m-1", 1_675, 8);
    addTxn("2026-08-12", -36_535, "Shopping", "m-1");
    const out = noticesCard(bundle.db, TODAY)!;
    expect(out.notices[0]!.text).toMatch(/^The Zzz Target charge on Aug 12 came to \d+\.\d× what you usually pay there\.$/);
  });

  test("⚠️ a merchant with too little history has no 'usual' to compare to", () => {
    // five sightings is an anecdote; the same constant the rest of the app uses
    // to separate a habit from a coincidence
    addMerchant("m-1", "Zzz Target");
    usual("m-1", 1_675, 4);
    addTxn("2026-08-12", -36_535, "Shopping", "m-1");
    expect(noticesCard(bundle.db, TODAY)).toBeNull();
  });

  test("⛔ a big multiple of a tiny usual is not news on its own", () => {
    /*
     * 8× a $2 coffee is $16, and a notice about it is noise wearing a
     * threshold. Measured on the real ledger the 4× rule alone produced 19
     * charges in 2026, nearly all of them a device instead of an app.
     */
    addMerchant("m-1", "Zzz Coffee");
    usual("m-1", 200, 8);
    addTxn("2026-08-12", -5_000, "Food", "m-1");
    expect(noticesCard(bundle.db, TODAY)).toBeNull();
  });

  test("a charge merely above the usual is not far above it", () => {
    addMerchant("m-1", "Zzz Target");
    usual("m-1", 10_000, 8);
    addTxn("2026-08-12", -30_000, "Shopping", "m-1"); // 3×
    expect(noticesCard(bundle.db, TODAY)).toBeNull();
  });
});

describe("a recurring bill that posted at a different amount", () => {
  function addSeries(name: string, expectedCents: number): string {
    const id = `s-${name}`;
    bundle.db
      .insert(recurringSeries)
      .values({
        id,
        name,
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        amountCentsAvg: expectedCents,
        /*
         * ⚠️ Without a measured spread the calendar refuses to call ANYTHING a
         * change — `classifyPostedAmount` returns "paid" on a null stddev,
         * deliberately, because a series nobody has measured has no normal to
         * depart from. A fixture that omits it is testing silence.
         */
        amountCentsStddev: 500,
        userAmountCents: expectedCents,
        nextExpectedOn: "2026-09-16",
        status: "confirmed",
        lastMatchedOn: "2026-08-16",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    return id;
  }

  test("⛔ a bill that posted LESS is never described as a rise", () => {
    /*
     * The bug this test exists for. A bill is stored NEGATIVE, so rent posting
     * $1,100.00 against an expected $2,285.70 gives a signed difference of
     * +$1,185.70 — and the first build printed "rose by +$1,185.70" over a
     * month he paid less. No gate caught it: the vocabulary guarantees the
     * sentence matches the FACT, and can say nothing about whether the fact
     * matches the world.
     */
    const seriesId = addSeries("Zzz Rent", -228_570);
    const txnId = addTxn("2026-08-16", -110_000, "Housing", null);
    bundle.db.update(transactions).set({ recurringSeriesId: seriesId }).where(eq(transactions.id, txnId)).run();

    const out = noticesCard(bundle.db, TODAY);
    const drift = out?.notices.find((n) => n.text.includes("Zzz Rent"));
    expect(drift?.claimId).toBe("fell_between");
    expect(drift?.text).toContain("fell by -$1,185.70");
  });

  test("a bill that posted MORE is a rise", () => {
    // the band is the widest of $1, 2% and 2σ — here $10, so $10 is INSIDE it
    const seriesId = addSeries("Zzz Internet", -5_000);
    const txnId = addTxn("2026-08-16", -7_000, "Utilities", null);
    bundle.db.update(transactions).set({ recurringSeriesId: seriesId }).where(eq(transactions.id, txnId)).run();

    const drift = noticesCard(bundle.db, TODAY)?.notices.find((n) => n.text.includes("Zzz Internet"));
    expect(drift?.claimId).toBe("rose_between");
    expect(drift?.text).toContain("rose by +$20.00");
  });
});

describe("the card as a whole", () => {
  test("an empty ledger is silence, not a card saying nothing happened", () => {
    expect(noticesCard(bundle.db, TODAY)).toBeNull();
  });

  test("newest first, and capped", () => {
    for (let i = 0; i < MAX_NOTICES + 4; i += 1) {
      addMerchant(`m-${i}`, `Zzz Shop ${i}`);
      addTxn(`2026-08-${String(i + 1).padStart(2, "0")}`, -30_000, "Shopping", `m-${i}`);
    }
    const out = noticesCard(bundle.db, TODAY)!;
    expect(out.notices).toHaveLength(MAX_NOTICES);
    const days = out.notices.map((n) => n.day);
    expect([...days].sort().reverse()).toEqual(days);
  });

  test("every notice carries a proof and a way to see it", () => {
    addMerchant("m-1", "Zzz Insurance");
    addTxn("2026-08-12", -35_758, "Transport", "m-1");
    for (const n of noticesCard(bundle.db, TODAY)!.notices) {
      expect(n.provenance.verdict).toBeTruthy();
      expect(n.href).toContain("/transactions");
    }
  });

  test("the card says what it looked at, so an empty one is a measurement", () => {
    addMerchant("m-1", "Zzz Insurance");
    addTxn("2026-08-12", -35_758, "Transport", "m-1");
    const out = noticesCard(bundle.db, TODAY)!;
    expect(out.summary).toContain("a first sighting at a merchant");
    expect(out.summary).toContain("not a verdict");
  });
});

describe("medianCents", () => {
  test("⚠️ rounds, because a half-cent is not money", () => {
    // `formatCents` REFUSES a fractional cent; a probe threw
    // "Invalid cents value: 2012.5" on an even-length list
    expect(medianCents([2_000, 2_025])).toBe(2_013);
    expect(medianCents([1, 2, 3])).toBe(2);
    expect(medianCents([3, 1, 2])).toBe(2);
    expect(medianCents([])).toBe(0);
    expect(Number.isInteger(medianCents([1, 2]))).toBe(true);
  });
});

describe("monthsBetween", () => {
  test("covers the window, including the year boundary", () => {
    expect(monthsBetween("2026-06-15", "2026-08-26")).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(monthsBetween("2025-11-30", "2026-01-02")).toEqual(["2025-11", "2025-12", "2026-01"]);
    expect(monthsBetween("2026-08-01", "2026-08-26")).toEqual(["2026-08"]);
  });

  test("a reversed window does not run away", () => {
    // the guard, not the arithmetic: a `to` before `from` must terminate
    expect(monthsBetween("2026-08-01", "2026-01-01").length).toBeLessThanOrEqual(24);
  });
});
