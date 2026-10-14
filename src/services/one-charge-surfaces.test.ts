import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { staleComponentEntries } from "@/components/recurring/labels";
import { committedBillsNamed, shrinkCaption } from "@/lib/committed";
import { noScheduleReason, projectedEvidence, seriesIsProjected } from "@/lib/series-evidence";
import { budgetTail } from "./budgets";
import { seriesInCategory } from "./category-detail";
import { committedBook } from "./committed";
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
   * 🔴 Caught widening the rule, on a copy of the e2e db: its "Storage unit" — monthly, last matched Jun 1, next Jul 1,
   * ends Jul 10, NO row linked (`seedBudgets`; Jun 6 and Jul 6 when it was caught, until e2a5c55) — read "once". Its
   * earlier charge lives only in the series' own `lastMatchedOn`, and a monthly bill in its last month must never read
   * once.
   */
  test("a charge the series' own last-matched day records counts, with no row linked", () => {
    const storageId = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Storage unit",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        nextExpectedOn: "2026-07-01",
        nextExpectedAmountCents: -4500,
        userEndsOn: "2026-07-10",
        lastMatchedOn: "2026-06-01",
        status: "confirmed",
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    const rows = () => bundle.db.select().from(recurringSeries).all();
    expect(oneChargeDays(bundle.db, rows()).has(storageId)).toBe(false);
    // …and with its next day on its end, as the first reading would have taken it
    bundle.db.update(recurringSeries).set({ userEndsOn: "2026-07-01" }).where(eq(recurringSeries.id, storageId)).run();
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
    // "once" in the cadence slot; no statement reaches Nov 11 on this fixture, so the runway's unread words follow
    expect(line.detail).toBe("1 × -$72.74 (once), came due Nov 11 and no statement has covered it yet");
  });
});

/*
 * ⚖️ §6A 56 — and the runway figure unchanged. 🔴 The committed book levelled the balance as a monthly bill cut short,
 * so his runway card read "…, and one other does too — … The rate above is $364.66 a month lower for the two of them."
 * (a copy of his ledger, 2026-10-13): $66.68 of it the balance's "missing" months. One charge is its own payment.
 */
describe("the runway's rate sentence reads it as its own single payment (committedBook)", () => {
  test("Car insurance alone stops the rate short, by its own $297.98 — the balance's $72.74 still in the rate", () => {
    const book = committedBook(bundle.db, "2026-10-13");
    expect(shrinkCaption(book)).toBe(
      "Car insurance stops inside that window — evidenced through Jan 11, 2027, with no renewal in the ledger — " +
        "so it is billed 2 times rather than throughout, and counts $59.60 a month here against the $357.58 it " +
        "charges. The rate above is $297.98 a month lower for it.",
    );
    expect(book.lines.find((l) => l.seriesId === balanceId)).toMatchObject({
      oneCharge: true,
      occurrences: 1,
      totalCents: 7274,
      shortfallPerMonthCents: 0,
    });
    expect(book.lines.find((l) => l.seriesId === insuranceId)!.oneCharge).toBe(false);
    expect(book.totalCents).toBe(2 * 35758 + 7274);
  });

  test("…and from Nov 12, owed and nothing of it to come, the line that carries its arrears is one charge too", () => {
    expect(committedBook(bundle.db, "2026-11-12").lines.find((l) => l.seriesId === balanceId)).toMatchObject({
      oneCharge: true,
      occurrences: 0,
      overdueCents: 7274,
    });
  });
});

/*
 * 🔴 From Nov 12 the balance's one day has passed: its schedule holds nothing still to come, and two surfaces made a
 * rate of that nothing. Measured on a copy of his ledger (2026-10-12) asked about 2026-11-12: "~$0.00/yr" on its own
 * page and the All tab, and a committed line of $0.00 a month on the runway — one of "…, and 10 more" bills that
 * "come to $3,446.19 a month", none of it its. What it still owes is the arrears it came due as — the runway's arrears
 * sentence and the forecast's "came due Nov 11" say so — and the subscriptions card already counts it ended.
 */
describe("from Nov 12, its one day passed — no $0.00 rate and no $0.00 line", () => {
  const NOV12 = "2026-11-12";

  test("its own page and the All tab print no year ahead of it — Car insurance, still billing, keeps its own", () => {
    expect(seriesDetail(bundle.db, balanceId, NOV12).annualizedCents).toBeNull();
    const listed = new Map(listSeries(bundle.db, NOV12).map((s) => [s.id, s]));
    expect(listed.get(balanceId)!.annualizedCents).toBeNull();
    // two premiums left inside the year, Dec 11 and Jan 11
    expect(listed.get(insuranceId)!.annualizedCents).toBe(2 * 35758);
    expect(seriesDetail(bundle.db, insuranceId, NOV12).annualizedCents).toBe(2 * 35758);
  });

  test("…while on its day the year ahead of it is its one charge", () => {
    expect(seriesDetail(bundle.db, balanceId, "2026-11-11").annualizedCents).toBe(7274);
    expect(listSeries(bundle.db, "2026-11-11").find((s) => s.id === balanceId)!.annualizedCents).toBe(7274);
  });

  test("the subscriptions card files it ended — no One-off line, no monthly line", () => {
    const card = subscriptionsCard(bundle.db, NOV12)!;
    expect(card.oneOffs).toEqual([]);
    expect(card.live.some((l) => l.seriesId === balanceId)).toBe(false);
    expect(card.endedCount).toBe(1);
  });

  test("the runway names only the bills inside its rate — the balance's arrears are said beside it, not as a line of it", () => {
    const book = committedBook(bundle.db, NOV12);
    // owed, and nothing of it inside the horizon: the line that carries the arrears
    expect(book.lines.find((l) => l.seriesId === balanceId)).toMatchObject({ occurrences: 0, totalCents: 0, overdueCents: 7274 });
    expect(committedBillsNamed(book.lines)).toBe("Car insurance");
    // on its day it is inside the rate, and named
    expect(committedBillsNamed(committedBook(bundle.db, "2026-11-11").lines)).toBe(
      "Car insurance, Car insurance — Nov 11 balance after the $1,000 early payment",
    );
  });
});

/*
 * 🔴 Review of 0af5689: from Nov 12 the balance was ENDED to its annualized figure and to the subscriptions card ("1 has
 * already ended") — and live and forecast to its own page and the All tab. Measured on a copy of his ledger
 * (2026-10-12) at 2026-12-12: its page read "Confirmed · Bill · Never billed · Ends Nov 11, 2026 … charges once on
 * Nov 11, about $72.74. Annualized —", a present-tense schedule a month past with no "Nothing expected" card, and the
 * All tab filed it under "Never billed — registered by hand and forecast — the bank has not charged them yet". From
 * Dec 1 nothing forecasts it. A schedule with no date still to come inside its end is ENDED, in one word, everywhere.
 */
describe("from Nov 12, its one day passed — its schedule has ended, on every surface that files it", () => {
  test.each(["2026-11-12", "2026-12-12"])("%s: its page and the All tab call it ended and project nothing", (today) => {
    const d = seriesDetail(bundle.db, balanceId, today);
    expect(d.evidence).toBe("schedule-ended");
    expect(seriesIsProjected(d.status, d.evidence)).toBe(false);
    expect(noScheduleReason(d.status, d.evidence, d.kind, d.linkedTxns.length > 0)).toContain("Its schedule has ended");
    expect(d.nextExpected).toEqual([]);
    expect(listSeries(bundle.db, today).find((s) => s.id === balanceId)!.evidence).toBe("schedule-ended");
    // the subscriptions card's own word for the same series, on the same day
    expect(subscriptionsCard(bundle.db, today)!.endedCount).toBe(1);
  });

  test("…while the charge it came due as is still owed in its month: the already-due card stays to Nov 30", () => {
    expect(seriesDetail(bundle.db, balanceId, "2026-11-12").overdue).toMatchObject({ date: "2026-11-11", occurrenceCount: 1 });
    expect(seriesDetail(bundle.db, balanceId, "2026-11-30").overdue).not.toBeNull();
    expect(seriesDetail(bundle.db, balanceId, "2026-12-12").overdue).toBeNull();
  });

  test("on its day it is still projected — and Car insurance, two premiums left, is not ended until Jan 12", () => {
    const nov11 = seriesDetail(bundle.db, balanceId, "2026-11-11");
    expect(nov11.evidence).toBe("never-billed");
    expect(seriesIsProjected(nov11.status, nov11.evidence)).toBe(true);
    for (const today of ["2026-11-12", "2026-12-12", "2027-01-11"]) {
      expect(seriesDetail(bundle.db, insuranceId, today).evidence, today).not.toBe("schedule-ended");
    }
    expect(seriesDetail(bundle.db, insuranceId, "2027-01-12").evidence).toBe("schedule-ended");
  });
});

/*
 * 🔴 Review of 49cc98f: Nov 12–30 one /recurring page filed the balance under two words — "never billed … still
 * projected" in the forecast (its math-table chip, "$172.74 of it never billed" in the money-out band, "2 series have
 * never been billed" in the footer) and "Ended — nothing more forecast" on the All tab below it (a copy of his ledger,
 * 2026-10-12, asked about 2026-11-12). The forecast still counts what came due Nov 11 — the arrears leg, on purpose —
 * so the series is a line of both, and each must say of it the word the other does: ONE predicate.
 */
describe("Nov 12–30: the forecast above the All tab says of the balance the All tab's word", () => {
  const BALANCE = "Car insurance — Nov 11 balance after the $1,000 early payment";

  test.each(["2026-11-11", "2026-11-12", "2026-11-30"])("%s: every fixed line's word is its series' All-tab word", (today) => {
    const word = new Map(listSeries(bundle.db, today).map((s) => [s.name, s.evidence]));
    const fixed = forecastCurrentMonth(bundle.db, today).components.filter((c) => c.kind === "fixed");
    // a line of the month to Nov 30 — forward on its day, came due after it
    expect(fixed.some((c) => c.label === BALANCE), today).toBe(true);
    for (const c of fixed) expect(projectedEvidence(c.staleness!), `${today} · ${c.label}`).toBe(word.get(c.label));
  });

  test("…so from Nov 12 no footer names it never billed, while the $72.74 it came due as is still counted", () => {
    const nov12 = forecastCurrentMonth(bundle.db, "2026-11-12").components;
    expect(nov12.find((c) => c.label === BALANCE)!.cents).toBe(-7274);
    expect(staleComponentEntries(nov12).map((e) => e.name)).not.toContain(BALANCE);
    // on its day it is still the footer's never billed
    const nov11 = forecastCurrentMonth(bundle.db, "2026-11-11").components;
    expect(staleComponentEntries(nov11).map((e) => e.name)).toContain(BALANCE);
  });
});
