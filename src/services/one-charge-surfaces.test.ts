import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { budgetTail } from "./budgets";
import { seriesInCategory } from "./category-detail";
import { forecastCurrentMonth, forecastForMonth } from "./forecast";
import { merchantIntelligence } from "./merchants";
import { type OneChargeLedger, seedHisCarSeries } from "./one-charge-fixture";
import {
  effectiveSeries,
  listSeries,
  oneChargeDays,
  projectOccurrences,
  rollForwardNextExpected,
  toProjectable,
} from "./recurring";
import { seriesDetail, setSeriesOverrides } from "./recurring-detail";
import { attachTransactions } from "./recurring-links";
import { subscriptionsCard } from "./subscriptions-card";

/**
 * ⚖️ Owner decision 2026-10-08 (§6A 56): the one-time Nov 11 car-insurance balance reads as ONE CHARGE wherever a
 * cadence is printed. Each surface below carried "monthly" for it on a copy of his ledger that morning — the category
 * page ("monthly · next Nov 11 · never billed"), its own page ("Cadence Monthly"), the All tab, the budget tail, the
 * forecast's math table — and each must now say "once", from the ONE reading (`oneChargeDays`). Car insurance itself
 * (two charges left, ends 2027-01-11) is a monthly bill in its last months, and must not.
 *
 * The two series are his, as stored on 2026-10-08 (`seedHisCarSeries`). What each printer then SAYS is pinned beside
 * the printer, from the same fixture.
 */
const TODAY = "2026-10-08";

let dir: string;
let bundle: DbBundle;
let carId: string;
let balanceId: string;
let insuranceId: string;
let ledger: OneChargeLedger;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-onecharge-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  ledger = seedHisCarSeries(bundle.db);
  ({ carId, balanceId, insuranceId } = ledger);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("oneChargeDays — the one reading every surface asks", () => {
  test("names the balance, to its day, and not Car insurance", () => {
    const rows = bundle.db.select().from(recurringSeries).all();
    expect([...oneChargeDays(bundle.db, rows)]).toEqual([[balanceId, "2026-11-11"]]);
  });

  test("Car insurance re-anchored onto its last day is still not one charge — it has charged since August", () => {
    bundle.db
      .update(recurringSeries)
      .set({ userNextExpectedOn: "2027-01-11" })
      .where(eq(recurringSeries.id, insuranceId))
      .run();
    const rows = bundle.db.select().from(recurringSeries).all();
    expect(oneChargeDays(bundle.db, rows).has(insuranceId)).toBe(false);
  });

  /*
   * 🔴 Review of 8a4ac47, on a copy of his ledger: Car insurance set to end and be next on 2026-09-11 (a two-payment
   * policy, Aug + Sep) read "Car insurance once · Sep 11" on the card and "Once" on its page — its Aug 12 charge,
   * posted a day after Aug 11, was taken for the September charge.
   */
  test("Car insurance as a two-payment policy, its August charge posted a day late, is not one charge", () => {
    bundle.db
      .update(recurringSeries)
      .set({ userNextExpectedOn: "2026-09-11", userEndsOn: "2026-09-11" })
      .where(eq(recurringSeries.id, insuranceId))
      .run();
    const rows = bundle.db.select().from(recurringSeries).all();
    expect(oneChargeDays(bundle.db, rows).has(insuranceId)).toBe(false);
  });

  /*
   * 🔴 Caught widening the rule, on a copy of the e2e db: its "Storage unit" — monthly, last matched Jun 6, next Jul 6,
   * ends Jul 10, NO row linked — read "once · Jul 6". Its earlier charge lives only in the series' own `lastMatchedOn`,
   * and a monthly bill in its last month must never read once.
   */
  test("a charge the series' own last-matched day records counts, with no row linked", () => {
    const storageId = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Storage unit",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        nextExpectedOn: "2026-07-06",
        nextExpectedAmountCents: -4500,
        userEndsOn: "2026-07-10",
        lastMatchedOn: "2026-06-06",
        status: "confirmed",
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    const rows = () => bundle.db.select().from(recurringSeries).all();
    expect(oneChargeDays(bundle.db, rows()).has(storageId)).toBe(false);
    // …and with its next day on its end, as the first reading would have taken it
    bundle.db.update(recurringSeries).set({ userEndsOn: "2026-07-06" }).where(eq(recurringSeries.id, storageId)).run();
    expect(oneChargeDays(bundle.db, rows()).has(storageId)).toBe(false);
  });

  /*
   * 🔴 Review of 3044ea6, on a copy of his ledger: a -$72.74 row posted 2026-10-20 and attached to the balance read as
   * October's charge (nearer Oct 11 than Nov 11), so the balance went back to "$72.74 a month" in the card's headline
   * ($3,738.18 → $3,810.92), its one-offs emptied, and every printer said monthly again. He paid this insurer early
   * once already — the $1,000 on Sep 3 made this balance.
   */
  test("the balance paid three weeks early, attached by hand, stays one charge — and out of the monthly figure", () => {
    const paid = ledger.charge("2026-10-20", -7274, null);
    attachTransactions(bundle.db, balanceId, [paid], "2026-10-21");
    const rows = bundle.db.select().from(recurringSeries).all();
    expect([...oneChargeDays(bundle.db, rows)]).toEqual([[balanceId, "2026-11-11"]]);
    const card = subscriptionsCard(bundle.db, "2026-10-21")!;
    expect(card.live.some((l) => l.seriesId === balanceId)).toBe(false);
    expect(card.oneOffs.map((o) => [o.seriesId, o.cadenceLabel])).toEqual([[balanceId, "once · Nov 11"]]);
  });

  test("a write that moves only the due day earlier, inside the end, keeps one charge — on that day", () => {
    bundle.db
      .update(recurringSeries)
      .set({ userNextExpectedOn: "2026-11-08" })
      .where(eq(recurringSeries.id, balanceId))
      .run();
    const rows = bundle.db.select().from(recurringSeries).all();
    expect([...oneChargeDays(bundle.db, rows)]).toEqual([[balanceId, "2026-11-08"]]);
  });
});

/*
 * 🔴 Review of 8a4ac47: the one charge's date token ("charges once on [Nov 11]") wrote the next day and left the end
 * where it was. On a copy of his ledger, moved to 2026-11-14 the next day passed the end, the schedule held nothing,
 * the $72.74 left the forecast and the card said "1 has already ended" about a balance still owed. A one charge's day
 * IS its schedule, so moving it moves the end with it — in the service, so every writer gets it.
 */
describe("setSeriesOverrides — moving a one charge's day moves its end with it", () => {
  const row = () => bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, balanceId)).get()!;

  test("moved later than its end, it stays one charge on the new day, still owed", () => {
    setSeriesOverrides(bundle.db, balanceId, { userNextExpectedOn: "2026-11-14" });
    expect(row().userEndsOn).toBe("2026-11-14");
    expect([...oneChargeDays(bundle.db, [row()])]).toEqual([[balanceId, "2026-11-14"]]);
    expect(projectOccurrences(toProjectable(row()), TODAY, "2027-03-31").map((o) => o.date)).toEqual(["2026-11-14"]);
    expect(rollForwardNextExpected(effectiveSeries(row()), TODAY)).toBe("2026-11-14");
    const card = subscriptionsCard(bundle.db, TODAY)!;
    expect(card.oneOffs.map((o) => [o.seriesId, o.cadenceLabel])).toEqual([[balanceId, "once · Nov 14"]]);
    expect(card.endedCount).toBe(0);
  });

  test("moved earlier, the end comes back to it too", () => {
    setSeriesOverrides(bundle.db, balanceId, { userNextExpectedOn: "2026-11-08" });
    expect(row().userEndsOn).toBe("2026-11-08");
    expect([...oneChargeDays(bundle.db, [row()])]).toEqual([[balanceId, "2026-11-08"]]);
  });

  test("'Use detected' puts the end on the detected day the charge goes back to", () => {
    setSeriesOverrides(bundle.db, balanceId, { userNextExpectedOn: "2026-11-14" });
    setSeriesOverrides(bundle.db, balanceId, { userNextExpectedOn: null });
    expect(row().userNextExpectedOn).toBeNull();
    expect(row().userEndsOn).toBe("2026-11-11");
    expect([...oneChargeDays(bundle.db, [row()])]).toEqual([[balanceId, "2026-11-11"]]);
  });

  test("a monthly bill's next day moves alone — its end is its own", () => {
    setSeriesOverrides(bundle.db, insuranceId, { userNextExpectedOn: "2026-12-14" });
    const insurance = bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, insuranceId)).get()!;
    expect(insurance.userNextExpectedOn).toBe("2026-12-14");
    expect(insurance.userEndsOn).toBe("2027-01-11");
  });

  test("an amount change leaves both days alone", () => {
    setSeriesOverrides(bundle.db, balanceId, { userAmountCents: -7000 });
    expect(row().userNextExpectedOn).toBe("2026-11-11");
    expect(row().userEndsOn).toBe("2026-11-11");
  });
});

describe("every cadence printer reads it", () => {
  test("/recurring's All tab and the attach list (listSeries)", () => {
    const listed = listSeries(bundle.db, TODAY);
    expect(listed.find((s) => s.id === balanceId)!.oneChargeOn).toBe("2026-11-11");
    expect(listed.find((s) => s.id === insuranceId)!.oneChargeOn).toBeNull();
  });

  test("the series' own page (seriesDetail)", () => {
    expect(seriesDetail(bundle.db, balanceId, TODAY)!.oneChargeOn).toBe("2026-11-11");
    expect(seriesDetail(bundle.db, insuranceId, TODAY)!.oneChargeOn).toBeNull();
  });

  test("/categories/<Car> (seriesInCategory)", () => {
    const rows = seriesInCategory(bundle.db, carId, TODAY);
    expect(rows.find((r) => r.id === balanceId)!.oneChargeOn).toBe("2026-11-11");
    expect(rows.find((r) => r.id === insuranceId)!.oneChargeOn).toBeNull();
  });

  test("the budget tail's expected list (budgetTail)", () => {
    const tail = budgetTail(bundle.db, carId, "2026-11-30", "2026-11-01");
    expect(tail.series.find((s) => s.id === balanceId)!.oneCharge).toBe(true);
  });

  test("the forecast's math table, forward — and its single occurrence still counted", () => {
    const november = forecastForMonth(bundle.db, "2026-11", TODAY)!;
    const line = november.components.find((c) => c.label.startsWith("Car insurance — Nov 11"))!;
    expect(line.cents).toBe(-7274);
    expect(line.detail).toBe("1 × -$72.74 (once), next Nov 11");
  });

  test("the merchant page's 'Billed … as' (merchantIntelligence)", () => {
    const merchantId = bundle.db.select().from(merchants).all()[0]!.id;
    bundle.db.update(recurringSeries).set({ merchantId }).where(eq(recurringSeries.id, balanceId)).run();
    expect(merchantIntelligence(bundle.db, merchantId, TODAY).cadence).toMatchObject({
      seriesId: balanceId,
      oneChargeLabel: "Nov 11",
    });
    bundle.db.update(recurringSeries).set({ merchantId: null }).where(eq(recurringSeries.id, balanceId)).run();
    bundle.db.update(recurringSeries).set({ merchantId }).where(eq(recurringSeries.id, insuranceId)).run();
    expect(merchantIntelligence(bundle.db, merchantId, TODAY).cadence).toMatchObject({
      seriesId: insuranceId,
      cadence: "monthly",
      oneChargeLabel: null,
    });
  });

  test("the forecast's math table, came due and not posted", () => {
    const late = forecastCurrentMonth(bundle.db, "2026-11-20");
    const line = late.components.find((c) => c.label.startsWith("Car insurance — Nov 11"))!;
    // "once" in the cadence slot; no import reaches Nov 11 on this fixture, so the runway's unread words follow
    expect(line.detail).toBe("1 × -$72.74 (once), came due Nov 11 and no import has covered it yet");
  });
});
