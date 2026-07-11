import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { detectRecurringSeries, setSeriesStatus } from "./recurring";
import { classifyPostedAmount, recurringCalendar } from "./recurring-calendar";

const TODAY = "2026-07-08";
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] as const;

let dir: string;
let bundle: DbBundle;
let cardId: string;
let netflixId: string;
let seq = 0;

function insertTxn(opts: {
  postedOn: string;
  amountCents: number;
  rawDescription: string;
  merchantId?: string | null;
}): string {
  seq += 1;
  return bundle.db
    .insert(transactions)
    .values({
      accountId: cardId,
      postedOn: opts.postedOn,
      amountCents: opts.amountCents,
      rawDescription: opts.rawDescription,
      normalizedDescription: normalizeDescription(opts.rawDescription),
      merchantId: opts.merchantId ?? null,
      dedupeHash: dedupeHash({
        accountId: cardId,
        postedOn: opts.postedOn,
        amountCents: opts.amountCents,
        rawDescription: `${opts.rawDescription}#${seq}`,
        occurrenceIndex: seq,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

/** A monthly Netflix series charging on the 15th; the June charge can drift. */
function buildMonthlyNetflix(juneAmountCents = -1549): void {
  for (const m of MONTHS) {
    const amount = m === "2026-06" ? juneAmountCents : -1549;
    insertTxn({ postedOn: `${m}-15`, amountCents: amount, rawDescription: "NETFLIX.COM", merchantId: netflixId });
  }
}

function netflix() {
  return bundle.db.select().from(recurringSeries).where(eq(recurringSeries.merchantId, netflixId)).get()!;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-reccal-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  cardId = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
  netflixId = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Netflix")).get()!.id;
  seq = 0;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("classifyPostedAmount", () => {
  test("within the $1 floor is paid", () => {
    // 50c drift, tolerance floor is 100c → paid
    expect(classifyPostedAmount(-1549, -1499, null)).toBe("paid");
  });

  test("a cent of drift is paid (floor)", () => {
    expect(classifyPostedAmount(-1549, -1548, null)).toBe("paid");
    expect(classifyPostedAmount(-1549, -1549, 0)).toBe("paid");
  });

  test("a real price change beyond every band is paid_different", () => {
    // $2.50 hike on a $15.49 charge: > $1 floor, > 2% (31c), > 2σ (0)
    expect(classifyPostedAmount(-1799, -1549, 0)).toBe("paid_different");
  });

  test("2σ widens the band for a naturally noisy series", () => {
    // 250c drift but σ=200 → 2σ=400 tolerance → paid
    expect(classifyPostedAmount(-1799, -1549, 200)).toBe("paid");
  });

  test("2% of a large charge widens the band", () => {
    // $30 drift on a $1800 rent: 2% = $36 → within band → paid
    expect(classifyPostedAmount(-183000, -180000, 0)).toBe("paid");
    expect(classifyPostedAmount(-184000, -180000, 0)).toBe("paid_different");
  });
});

describe("recurringCalendar", () => {
  test("a past month shows its posted charge as paid", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    const march = recurringCalendar(bundle.db, "2026-03", TODAY);
    const day = march.entriesByDay["2026-03-15"];
    expect(day).toHaveLength(1);
    expect(day![0]).toMatchObject({ state: "paid", amountCents: -1549, transactionId: expect.any(String) });
    expect(march.postedNetCents).toBe(-1549);
    expect(march.upcomingNetCents).toBe(0);
    expect(march.missedCount).toBe(0);
    expect(march.entryCount).toBe(1);
  });

  test("an amount that drifted past the band shows paid_different", () => {
    buildMonthlyNetflix(-1799); // June is a price hike
    detectRecurringSeries(bundle.db, TODAY);
    const june = recurringCalendar(bundle.db, "2026-06", TODAY);
    const day = june.entriesByDay["2026-06-15"];
    expect(day![0]!.state).toBe("paid_different");
    expect(day![0]!.amountCents).toBe(-1799);
  });

  test("a future expected occurrence in the current month is upcoming", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    // median gap 31 → next expected 2026-06-15 + 31 = 2026-07-16 (≥ today)
    const july = recurringCalendar(bundle.db, "2026-07", TODAY);
    const day = july.entriesByDay["2026-07-16"];
    expect(day).toHaveLength(1);
    expect(day![0]).toMatchObject({ state: "upcoming", transactionId: null, amountCents: -1549 });
    expect(july.upcomingNetCents).toBe(-1549);
    expect(july.missedCount).toBe(0);
  });

  test("an overdue expected occurrence before today is missed", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    // view the same July but with a later 'today' so 07-16 is in the past
    const july = recurringCalendar(bundle.db, "2026-07", "2026-07-20");
    const day = july.entriesByDay["2026-07-16"];
    expect(day![0]!.state).toBe("missed");
    expect(july.missedCount).toBe(1);
    expect(july.upcomingNetCents).toBe(0);
  });

  test("a long-inactive series stops projecting upcoming/missed but keeps its postings", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    // view July from a 'today' far past the last charge (2026-06-15): the series
    // is inactive, so no upcoming/missed clutter — but March still shows posted
    const farFuture = "2027-01-10";
    const july = recurringCalendar(bundle.db, "2026-07", farFuture);
    expect(july.entryCount).toBe(0);
    expect(july.missedCount).toBe(0);
    const march = recurringCalendar(bundle.db, "2026-03", farFuture);
    expect(march.entriesByDay["2026-03-15"]?.[0]?.state).toBe("paid");
  });

  test("dismissed series drop off the calendar entirely", () => {
    buildMonthlyNetflix();
    detectRecurringSeries(bundle.db, TODAY);
    setSeriesStatus(bundle.db, netflix().id, "dismissed");
    const march = recurringCalendar(bundle.db, "2026-03", TODAY);
    expect(march.entryCount).toBe(0);
    expect(Object.keys(march.entriesByDay)).toHaveLength(0);
  });

  test("no series → an empty month, not a throw", () => {
    const month = recurringCalendar(bundle.db, "2026-07", TODAY);
    expect(month).toMatchObject({ entryCount: 0, postedNetCents: 0, upcomingNetCents: 0, missedCount: 0 });
    expect(Object.keys(month.entriesByDay)).toHaveLength(0);
  });

  test("defaults the month and today to the wall clock without throwing", () => {
    expect(() => recurringCalendar(bundle.db)).not.toThrow();
  });
});
