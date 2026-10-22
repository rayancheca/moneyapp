import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { addDays } from "@/lib/dates";
import { formatDayLong } from "@/lib/format-date";
import { cashEarningsSectionNotes } from "@/lib/section-notes";
import { passedPaydaysWords } from "@/lib/unbanked-income";
import { cashEarningsReadings } from "./cash-earnings";
import { forecastCurrentMonth } from "./forecast";
import { incomeCard } from "./income-card";
import { paydaySettlement } from "./payday-settlement";

/**
 * "Never reached a bank" is said of a payday only once the ledger has checked it through its DAYS TO LAND — its
 * series' own tolerance after it, the reach the settlement's anchor clause gives a deposit — on every surface that
 * says it: the forecast's note and the pay series' own page (`pastGraceOccurrenceCount`), the dashboard's Earned vs
 * banked and /spending's shortfall note.
 *
 * 🔴 Review of 878c3d5 (the grace rule reached 2 of its 4 readers): weekly $1,000.00 paid through Thu Aug 27, Chase
 * read through Sat Sep 5, today Sep 15 — the forecast called Thu Sep 3 "Pay not banked yet", while the dashboard said
 * "$1,000.00 of it never reached a bank" and /spending September "…came to $1,000.00, and none of it reached a bank"
 * of the same payday, whose deposit could still land on Sun Sep 6.
 *
 * ⛔ A payday a deposit SETTLED is not one of them, inside its days to land or not: on his ledger copy 2026-10-21 Wells
 * Fargo is checked through Thu Sep 24, whose payday the Sep 24 deposit paid, and Earned vs banked's "$11,117.00 of it
 * never reached a bank" (decision 55's figure) must not move.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-15";
const CHASE = "acct-chase";
const SERIES = "series-pay";
const now = (): string => new Date().toISOString();
const CHECKED_DAY = "the last day every account that pay lands in has been checked through";

function salaryId(): string {
  const named = (name: string, parentId: string | null) => {
    const parent = parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId);
    return bundle.db.select().from(categories).where(and(eq(categories.name, name), parent)).get()!;
  };
  return named("Salary", named("Income", null).id).id;
}

let seq = 0;
function deposit(postedOn: string, cents = 100_000): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: CHASE,
      postedOn,
      amountCents: cents,
      rawDescription: "PAYROLL",
      normalizedDescription: "PAYROLL",
      categoryId: salaryId(),
      recurringSeriesId: SERIES,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/** A deposit on every Thursday from Jun 4 through `last` — each paying its own payday. */
function paidThrough(last: string): void {
  for (let day = "2026-06-04"; day <= last; day = addDays(day, 7)) deposit(day);
}

/** Days the balance walk has read — the second arbiter `accountCoverage` grades. */
function readThrough(to: string, from = "2026-06-01"): void {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId: CHASE, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-days-to-land-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  bundle.db
    .insert(accounts)
    .values({
      id: CHASE,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: "Chase",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  bundle.db
    .insert(recurringSeries)
    .values({
      id: SERIES,
      name: "It America LLC (weekly pay)",
      kind: "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: 100_000,
      userAmountCents: 100_000,
      nextExpectedOn: "2026-06-04",
      nextExpectedAmountCents: 100_000,
      lastMatchedOn: "2026-06-04",
      status: "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** /spending's notes over a window, as its page reads them. */
function spending(from: string, to: string, today = TODAY): string[] {
  return cashEarningsSectionNotes({
    rows: cashEarningsReadings(bundle.db, { from, to, today, withChecked: true }),
    formatDay: formatDayLong,
  }).map((n) => n.body);
}

/** The windows a stale schedule's note prints in on these fixtures: August, September, Q3 and the year. */
const STALE_WINDOWS = [
  ["2026-08-01", "2026-08-31"],
  ["2026-09-01", "2026-09-30"],
  ["2026-07-01", "2026-09-30"],
  ["2026-01-01", "2026-12-31"],
] as const;

/** The schedule-wide sentence of a window's note for a stale schedule — from "Across the whole schedule" on. */
function staleSentence(from: string, to: string): string {
  const notes = spending(from, to).filter((body) => body.includes("Across the whole schedule"));
  expect(notes).toHaveLength(1);
  return notes[0]!.slice(notes[0]!.indexOf("Across the whole schedule"));
}

/** What each surface says of the same paydays. */
function surfaces() {
  const f = forecastCurrentMonth(bundle.db, TODAY).unbankedIncome;
  return {
    forecast: passedPaydaysWords(f, formatDayLong).notProjected,
    dashboard: incomeCard(bundle.db, TODAY)!.totals.gapLabel,
    september: spending("2026-09-01", "2026-09-30"),
    year: spending("2026-01-01", "2026-12-31"),
  };
}

describe("a payday checked on its day but not through its days to land never 'never reached a bank'", () => {
  test("the reviewer's state: Sep 3 checked through Sep 5 — every surface says not banked yet", () => {
    paidThrough("2026-08-27");
    readThrough("2026-09-05");
    const s = surfaces();

    // Sep 10 falls after the checked day: the subject names it as the dashboard does (default built, 2026-10-21)
    expect(s.forecast).toBe(
      "Pay not banked yet, and pay the ledger has not looked for, cannot be projected as arriving",
    );
    expect(s.dashboard).toBe(
      `$1,000.00 of it is for paydays whose days to land run past Sep 5, ${CHECKED_DAY} — so it is not banked ` +
        "yet; the other $1,000.00 is for paydays after that day — so the ledger has not looked for it.",
    );
    expect(s.september).toEqual([
      "It America LLC (weekly pay)'s payday on Sep 3, 2026 came to $1,000.00, and none of it is banked yet; " +
        `Sep 3's days to land run past Sat, Sep 5, 2026, ${CHECKED_DAY}; 1 more payday in the window falls after ` +
        "Sat, Sep 5, 2026 — so the ledger has not looked for its deposit.",
    ]);
    expect(s.year).toEqual([
      "It America LLC (weekly pay)'s paydays over Jun 4 – Sep 3, 2026 came to $14,000.00, of which $13,000.00 was " +
        "banked inside the window and $1,000.00 is not banked yet; Sep 3's days to land run past Sat, Sep 5, 2026, " +
        `${CHECKED_DAY}; 1 more payday in the window falls after Sat, Sep 5, 2026 — so the ledger has not looked ` +
        "for its deposit.",
    ]);
    for (const words of [s.dashboard, ...s.september, ...s.year]) expect(words).not.toMatch(/reached a bank/);
  });

  // ⛔ A date window has two ends: Sun Sep 6, three days on, is the last of Sep 3's days to land
  test("…and checked through Sep 6, its last day to land, every surface says it never reached a bank", () => {
    paidThrough("2026-08-27");
    readThrough("2026-09-06");
    const s = surfaces();

    expect(s.forecast).toBe(
      "Pay that never reaches a bank, and pay the ledger has not looked for, cannot be projected as arriving",
    );
    expect(s.dashboard).toBe(
      `$1,000.00 of it never reached a bank; the other $1,000.00 is for paydays after Sep 6, ${CHECKED_DAY} — so ` +
        "the ledger has not looked for it.",
    );
    expect(s.september).toEqual([
      "It America LLC (weekly pay)'s payday on Sep 3, 2026 came to $1,000.00, and none of it reached a bank; 1 " +
        `more payday in the window falls after Sun, Sep 6, 2026, ${CHECKED_DAY} — so the ledger has not looked for ` +
        "its deposit.",
    ]);
  });

  // ⚖️ …by its OWN series' tolerance: a schedule given 5 days waits 5
  test("a schedule given 5 days to land is not banked yet through Sep 7, and never reached a bank from Sep 8", () => {
    bundle.db.update(recurringSeries).set({ toleranceDays: 5 }).where(eq(recurringSeries.id, SERIES)).run();
    paidThrough("2026-08-27");
    readThrough("2026-09-07");
    expect(surfaces().dashboard).toMatch(/^\$1,000\.00 of it is for paydays whose days to land run past Sep 7/);
    readThrough("2026-09-08", "2026-09-08");
    expect(surfaces().dashboard).toMatch(/^\$1,000\.00 of it never reached a bank/);
  });

  test("past its days to land, inside them, and after the checked day: three paydays, three parts", () => {
    paidThrough("2026-08-20");
    readThrough("2026-09-05");
    expect(surfaces().dashboard).toBe(
      `$1,000.00 of it never reached a bank; $1,000.00 is for paydays whose days to land run past Sep 5, ` +
        `${CHECKED_DAY} — so it is not banked yet; the other $1,000.00 is for paydays after that day — so the ` +
        "ledger has not looked for it.",
    );
    expect(surfaces().year).toEqual([
      "It America LLC (weekly pay)'s paydays over Jun 4 – Sep 3, 2026 came to $14,000.00, of which $12,000.00 was " +
        "banked inside the window, $1,000.00 is not banked yet, and $1,000.00 never reached a bank; Sep 3's days " +
        `to land run past Sat, Sep 5, 2026, ${CHECKED_DAY}; 1 more payday in the window falls after Sat, Sep 5, ` +
        "2026 — so the ledger has not looked for its deposit.",
    ]);
  });

  /*
   * ⚖️ The stale verdict under the same card counts "did not reach a bank" of paydays checked through their days to
   * land only, and names the one still inside them "not banked yet" — the difference line's words, one line above it.
   * 🔴 Review of 4b98f77: weekly pay through Aug 6, Chase read through Sat Sep 5, today Sep 15 — the verdict said "4 of
   * them fall on days the records already cover, through Sep 5 — so the pay did not reach a bank" ($4,000.00), while
   * the difference above it said "$3,000.00 of it never reached a bank; $1,000.00 … — so it is not banked yet" of Sep 3.
   */
  test("the stale verdict says 'did not reach a bank' of the paydays past their days to land, as the gap does", () => {
    paidThrough("2026-08-06");
    readThrough("2026-09-05");
    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;

    expect(line.basis).toBe("series-stale");
    expect(line.gapLabel).toBe(
      `$3,000.00 of it never reached a bank; $1,000.00 is for paydays whose days to land run past Sep 5, ` +
        `${CHECKED_DAY} — so it is not banked yet; the other $1,000.00 is for paydays after that day — so the ` +
        "ledger has not looked for it.",
    );
    // (Sep 10, after the checked day, is "not looked for" — the describe on every payday of the silence pins that)
    expect(line.verdict).toContain(
      "3 of them, and their days to land, fall on days the records already cover, through Sep 5 — so the pay did " +
        `not reach a bank; Sep 3's days to land run past Sep 5, ${CHECKED_DAY} — so its pay is not banked yet;`,
    );
  });

  /*
   * ⚖️ …and /spending's note for a stale schedule, under the same rule: its list of what the quiet can mean names the
   * payday whose days to land run past the checked day — "not banked yet" — beside cash, ended and not looked for.
   * 🔴 Review of 4b98f77's follow-up: it read "that money was held as cash, spent as cash, the schedule has ended, or
   * the ledger has not looked for its deposit" of September, Sep 3 among it, while the dashboard said Sep 3's pay is
   * not banked yet. On his ledger copy 2026-10-21 with Wells Fargo checked through Fri Oct 16 and no October deposit,
   * October read "…that money was held as cash, spent as cash, or the schedule has ended" of Oct 15 the same way.
   */
  test("/spending's stale note names the payday inside its days to land among what the quiet can mean", () => {
    paidThrough("2026-08-06");
    readThrough("2026-09-05");

    expect(surfaces().september).toEqual([
      "It America LLC (weekly pay) implies $2,000.00 of earnings over Sep 3 – 10, 2026 and none of it reached an " +
        `account through Sat, Sep 5, 2026; the other payday falls after that, ${CHECKED_DAY}. Across the whole ` +
        "schedule, 5 expected paydays have passed since the last deposit on Thu, Aug 6, 2026, and 4 of them fall on " +
        "days the records cover, through Sat, Sep 5, 2026 — that money was held as cash, spent as cash, paid into an " +
        "account the ledger does not read, the schedule has ended, the ledger has not looked for its deposit, or Sep " +
        "3's days to land run past Sat, Sep 5, 2026, " +
        `${CHECKED_DAY} — so its pay is not banked yet. The income figures on this page count deposits, so they ` +
        "cannot tell you which.",
    ]);
  });

  /*
   * ⛔ …over the SILENCE, as the verdict counts it (`silentPaydaysNotBankedYet`), never over the window: the sentence
   * is schedule-wide ("Across the whole schedule … since the last deposit"), so every window that prints it prints it
   * the same. 🔴 Review of c02a4b0: it took its payday from the window's shortfall, and August — which holds no Sep 3 —
   * listed cash, ended and not looked for alone, while September, Q3 and the year named Sep 3. On his ledger copy
   * 2026-10-21 with Wells Fargo checked through Fri Oct 16 and no October deposit, June, July, August and Q3 left
   * Oct 15 out the same way.
   */
  test("/spending's stale sentence is the same in every window that prints it — August names Sep 3 too", () => {
    paidThrough("2026-08-06");
    readThrough("2026-09-05");

    const sentence =
      "Across the whole schedule, 5 expected paydays have passed since the last deposit on Thu, Aug 6, 2026, and 4 " +
      "of them fall on days the records cover, through Sat, Sep 5, 2026 — that money was held as cash, spent as " +
      "cash, paid into an account the ledger does not read, the schedule has ended, the ledger has not looked for its " +
      "deposit, or Sep 3's days to land run past " +
      `Sat, Sep 5, 2026, ${CHECKED_DAY} — so its pay is not banked yet. The income figures on this page count ` +
      "deposits, so they cannot tell you which.";
    expect(spending("2026-08-01", "2026-08-31")).toEqual([
      "It America LLC (weekly pay) implies $4,000.00 of earnings over Aug 6 – 27, 2026 and only $1,000.00 reached " +
        `an account. ${sentence}`,
    ]);
    for (const [from, to] of STALE_WINDOWS) expect(staleSentence(from, to)).toBe(sentence);
  });

  // ⛔ …and never a payday before the silence: Aug 13, unpaid before Fri Aug 14's $500.00, is the window's, not its.
  // ⚖️ Nor Sep 10, which that $500.00 paid early (the newest payday its 28 days reach — the calendar draws it paid):
  // three silent paydays, every one checked, so nothing is "not looked for" — and Sep 10 named as the one it does not
  // count, with four passed since Aug 14 (review of 337baa7, MEDIUM)
  test("/spending's stale sentence names the verdict's paydays — Aug 20, Aug 27 and Sep 3, never Aug 13", () => {
    deposit("2026-08-14", 50_000);
    const verdict = raisedFromAug13(28);

    expect(verdict).toContain("the days to land of Aug 20, Aug 27, and Sep 3 run past Sep 5,");
    const sentence =
      "Across the whole schedule, 3 expected paydays have passed since the last deposit on Fri, Aug 14, 2026 (not " +
      "counting Sep 10, which was paid early) — that money was held as cash, spent as cash, paid into an account the " +
      "ledger does not read, the schedule has ended, or the days to land of Aug 20, Aug 27, and " +
      `Sep 3 run past Sat, Sep 5, 2026, ${CHECKED_DAY} — so their pay is not banked yet. The income figures on this ` +
      "page count deposits, so they cannot tell you which.";
    for (const [from, to] of STALE_WINDOWS) expect(staleSentence(from, to)).toBe(sentence);
  });

  // ⛔ A date window has two ends: the silence opens the day AFTER the last deposit. $500.00 on Thu Aug 13 itself pays
  // Sep 10 early (the newest payday it reaches), so Aug 13 stays unpaid — and is still not one of the silence's; nor is
  // Sep 10, which a deposit paid
  test("a payday on the last deposit's own day is not the silence's, on the verdict or on /spending", () => {
    deposit("2026-08-13", 50_000);
    const verdict = raisedFromAug13(28);

    // ⛔ …and the count says which it leaves out, as /spending's sentence below does (review of 0c9bc8d)
    expect(verdict).toBe(
      "3 paydays have passed since Aug 13 with no deposit (not counting Sep 10, which was paid early). 3 of them fall " +
        `on days the records already cover, through Sep 5, but the days to land of Aug 20, Aug 27, and Sep 3 run ` +
        `past Sep 5, ${CHECKED_DAY} — so their pay is not banked yet. ${NOT_ANSWERED}`,
    );
    for (const [from, to] of STALE_WINDOWS) {
      expect(staleSentence(from, to)).toContain(
        "since the last deposit on Thu, Aug 13, 2026 (not counting Sep 10, which was paid early) — that money was " +
          "held as cash, spent as cash, paid into an account the ledger does not read, the schedule has ended, or the " +
          "days to land of Aug 20, Aug 27, and Sep 3 run past Sat, Sep 5, 2026,",
      );
    }
  });

  /*
   * ⛔ …and with nothing ever banked, the silence opens on the schedule's first payday (`silenceFrom`), as the
   * sentence counts it — "nothing attributed to it has ever banked". 🔴 Review of 147f167 (MEDIUM): the only payroll
   * a $1,000.00 on Thu Jun 4 returned the same day (decision 75: it banked nothing, and opens the schedule), the
   * silence's not-banked-yet paydays were none — "there is no 'since' to count from" — so every window's sentence
   * left Sep 3 out, while the window's shortfall and Earned vs banked's difference named Sep 3's pay not banked yet.
   */
  test("never banked: the stale sentence names Sep 3 not banked yet in every window, as the dashboard does", () => {
    deposit("2026-06-04");
    deposit("2026-06-04", -100_000);
    readThrough("2026-09-05");

    const sentence =
      "Across the whole schedule, 15 expected paydays have passed and nothing attributed to it has ever banked, and " +
      "14 of them fall on days the records cover, through Sat, Sep 5, 2026 — that money was held as cash, spent as " +
      "cash, paid into an account the ledger does not read, the schedule has ended, the ledger has not looked for its " +
      "deposit, or Sep 3's days to land run past " +
      `Sat, Sep 5, 2026, ${CHECKED_DAY} — so its pay is not banked yet. The income figures on this page count ` +
      "deposits, so they cannot tell you which.";
    for (const [from, to] of STALE_WINDOWS) expect(staleSentence(from, to)).toBe(sentence);
    expect(incomeCard(bundle.db, TODAY)!.totals.gapLabel).toContain(
      `; $1,000.00 is for paydays whose days to land run past Sep 5, ${CHECKED_DAY} — so it is not banked yet;`,
    );
  });

  // ⛔ …and checked through Sun Sep 6, Sep 3's last day to land, the verdict is the one it always was
  test("checked through Sep 6, the stale verdict counts all 4 checked paydays as not having reached a bank", () => {
    paidThrough("2026-08-06");
    readThrough("2026-09-06");
    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;

    expect(line.gapLabel).toMatch(/^\$4,000\.00 of it never reached a bank; the other \$1,000\.00 is for paydays/);
    expect(line.verdict).toContain(
      "4 of them fall on days the records already cover, through Sep 6 — so the pay did not reach a bank; the other " +
        "one falls after Sep 6,",
    );
  });

  /*
   * ⚖️ …by its own series' days to land, each payday by its own. A raise from Aug 13 that Aug 6's money cannot pay
   * (§6A 55a), so no deposit before the silence settles a payday inside it: every checked silent payday is unpaid, and
   * the only question left is whether its days to land are checked.
   */
  function raisedFromAug13(toleranceDays: number): string {
    bundle.db
      .update(recurringSeries)
      .set({
        toleranceDays,
        userAmountCents: 110_000,
        userAmountHistory: [{ throughOn: "2026-08-06", amountCents: 100_000 }],
      })
      .where(eq(recurringSeries.id, SERIES))
      .run();
    paidThrough("2026-08-06");
    readThrough("2026-09-05");
    return incomeCard(bundle.db, TODAY)!.pay[0]!.verdict;
  }
  // Sep 10, after the checked Sep 5, is the silence's fifth: not looked for, never "with no deposit"
  const STALE = "5 paydays have passed since the last deposit on Aug 6.";
  const NOT_ANSWERED = "Whether it was earned is a different question, and this card cannot answer it.";
  const SEP_10 = "the other one falls after Sep 5 — so the ledger has not looked for its deposit.";

  test("14 days to land: Aug 13 and Aug 20 did not reach a bank; the days to land of Aug 27 and Sep 3 run past", () => {
    expect(raisedFromAug13(14)).toBe(
      `${STALE} 2 of them, and their days to land, fall on days the records already cover, through Sep 5 — so the ` +
        `pay did not reach a bank; the days to land of Aug 27 and Sep 3 run past Sep 5, ${CHECKED_DAY} — so their ` +
        `pay is not banked yet; ${SEP_10} ${NOT_ANSWERED}`,
    );
  });

  // ⛔ "1 of them … falls", never "1 of them fall"
  test("21 days to land: Aug 13 alone did not reach a bank", () => {
    expect(raisedFromAug13(21)).toBe(
      `${STALE} 1 of them, and its days to land, falls on days the records already cover, through Sep 5 — so the pay ` +
        `did not reach a bank; the days to land of Aug 20, Aug 27, and Sep 3 run past Sep 5, ${CHECKED_DAY} — so ` +
        `their pay is not banked yet; ${SEP_10} ${NOT_ANSWERED}`,
    );
  });

  // ⛔ …and with none past its days to land, no "did not reach a bank" at all
  test("28 days to land: every checked silent payday is inside them, and none did not reach a bank", () => {
    expect(raisedFromAug13(28)).toBe(
      `${STALE} 4 of them fall on days the records already cover, through Sep 5, but the days to land of Aug 13, ` +
        `Aug 20, Aug 27, and Sep 3 run past Sep 5, ${CHECKED_DAY} — so their pay is not banked yet; ${SEP_10} ` +
        NOT_ANSWERED,
    );
    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.gapLabel).toContain(
      "; $4,400.00 is for paydays whose days to land run past Sep 5,",
    );
  });

  // ⛔ The silence counts from the last deposit: Aug 13, unpaid and inside its days to land before Fri Aug 14's $500.00
  // (which paid Sep 10 early — so Sep 10 is not one either), is the difference's — never one of the verdict's paydays
  test("a not-banked-yet payday before the last deposit is not one of the silence's", () => {
    deposit("2026-08-14", 50_000);
    expect(raisedFromAug13(28)).toBe(
      "3 paydays have passed since Aug 14 with no deposit (not counting Sep 10, which was paid early). 3 of them fall " +
        `on days the records already cover, through Sep 5, but the days to land of Aug 20, Aug 27, and Sep 3 run ` +
        `past Sep 5, ${CHECKED_DAY} — so their pay is not banked yet. ${NOT_ANSWERED}`,
    );
  });

  /*
   * ⛔ His ledger's shape on 2026-10-21: the payday ON the checked day was paid by its own deposit. The days to land
   * are a question about money still to come — settled money has come, so its payday stays in the checked part, and
   * the unpaid payday before it still never reached a bank. ⛔ Never the checked day moved back by the days to land:
   * measured on his ledger copy 2026-10-21, that reading turned Earned vs banked's "$11,117.00 of it never reached a
   * bank" into $9,975.08, Sep 24's paid $1,141.92 among the pay "the ledger has not looked for"
   * (`paydaysNotBankedYet`).
   */
  test("a payday settled inside its days to land moves nothing — the unpaid one before it never reached a bank", () => {
    paidThrough("2026-08-20");
    deposit("2026-09-03");
    readThrough("2026-09-05");
    const s = surfaces();

    expect(s.dashboard).toBe(
      `$1,000.00 of it never reached a bank; the other $1,000.00 is for paydays after Sep 5, ${CHECKED_DAY} — so ` +
        "the ledger has not looked for it.",
    );
    expect(s.year.join(" ")).toContain("and $1,000.00 never reached a bank;");
    expect(s.year.join(" ")).not.toMatch(/not banked yet|days to land/);
  });
});

/**
 * The SILENCE — the paydays every stale sentence counts, Earned vs banked's verdict and /spending's note for a stale
 * schedule — is the paydays since pay last banked that no deposit paid, as the calendar draws them; and what a stale
 * note's own figure leaves out is named, as the card names it.
 */
describe("the silence the verdict and /spending's stale note count, and the money out beside it", () => {
  /*
   * ⛔ With nothing ever banked, Thu Jun 4 is one of the silence's: no deposit banked it (`silenceFrom`). 🔴 Review of
   * c3b30fe (MEDIUM): counted strictly after Jun 4, one YTD note read "implies $15,000.00 … over Jun 4 – Sep 10" (14
   * read + the other payday) and then "14 expected paydays have passed … and 13 of them fall on days the records
   * cover", while the card counted "15 paydays, Jun 4 – Sep 10".
   */
  test("never banked: the silence counts Jun 4 too — the paydays the card and the note's own lead count", () => {
    deposit("2026-06-04");
    deposit("2026-06-04", -100_000);
    readThrough("2026-09-05");

    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.paydaysLabel).toBe("15 paydays, Jun 4 – Sep 10");
    // ⛔ a payroll attributed and returned the same day banked nothing (decision 75) — but it WAS attributed. 🔴 Both
    // surfaces said no deposit had ever been attributed (review of the pay-chain batch)
    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.verdict).toBe(
      "Nothing attributed to this schedule has banked on or before today, so there is nothing to date the silence from.",
    );
    const [ytd] = spending("2026-01-01", "2026-12-31");
    expect(ytd).toContain(
      "implies $15,000.00 of earnings over Jun 4 – Sep 10, 2026 and none of it reached an account through Sat, Sep 5, " +
        "2026; the other payday falls after that,",
    );
    expect(ytd).toContain(
      "Across the whole schedule, 15 expected paydays have passed and nothing attributed to it has ever banked, and " +
        "14 of them fall on days the records cover, through Sat, Sep 5, 2026 —",
    );
  });

  /*
   * ⚖️ A payday a deposit PAID — Wed Aug 26's $1,000.00 paid Thu Aug 27 early, as the calendar draws it — is not one
   * of the silence's. 🔴 Review of 27ca437 (MEDIUM, pre-existing): the verdict counted every payday after the last day
   * that banked, so it said "1 falls on a day already checked, with no deposit" of Aug 27, which the calendar draws
   * paid by the deposit of Aug 26 and /spending names "paid early, by the deposit of Wed, Aug 26, 2026".
   */
  test("a payday the last deposit paid early is not silent — the verdict never says 'with no deposit' of it", () => {
    paidThrough("2026-08-20");
    deposit("2026-08-26");
    readThrough("2026-08-28");

    expect(paydaySettlement(bundle.db, SERIES, TODAY).settledBy.get("2026-08-27")).toBe("2026-08-26");
    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;
    expect(line.silentPeriods).toBe(2);
    // ⛔ …nor does it say "2 paydays have passed since the last deposit" with Aug 27, Sep 3 and Sep 10 all passed
    // (review of 337baa7, MEDIUM): it names the one it does not count
    expect(line.verdict).toBe(
      "2 paydays have passed since the last deposit on Aug 26 (not counting Aug 27, which was paid early). Both fall " +
        `after Aug 28, ${CHECKED_DAY} — so the ledger has not looked for their deposits.`,
    );
    // …as /spending says it, of a window holding Aug 27 and not its deposit
    expect(spending("2026-08-27", "2026-09-02").join(" ")).toContain(
      "$1,000.00 (Aug 27) was paid early, by the deposit of Wed, Aug 26, 2026",
    );
  });

  // ⛔ …and a stale schedule's "did not reach a bank" never counts it either, on the verdict or on /spending
  test("stale: Wed Aug 5 paid Thu Aug 6 — 5 silent paydays, not 6, on the verdict and on /spending", () => {
    paidThrough("2026-07-30");
    deposit("2026-08-05");
    readThrough("2026-09-12");

    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.verdict).toBe(
      "5 paydays have passed since Aug 5 with no deposit (not counting Aug 6, which was paid early). 4 of them, and " +
        "their days to land, fall on days the records already cover, through Sep 12 — so the pay did not reach a " +
        `bank; Sep 10's days to land run past Sep 12, ${CHECKED_DAY} — so its pay is not banked yet. Whether it was ` +
        "earned is a different question, and this card cannot answer it.",
    );
    for (const [from, to] of STALE_WINDOWS) {
      expect(staleSentence(from, to)).toContain(
        "Across the whole schedule, 5 expected paydays have passed since the last deposit on Wed, Aug 5, 2026 (not " +
          "counting Aug 6, which was paid early) — ",
      );
    }
  });

  /*
   * ⛔ …and its note never says "none of it reached an account" of a read payday a deposit outside the window paid —
   * it names that money as the live schedule's shortfall note does. 🔴 Review of 337baa7 (MEDIUM, pre-existing): with
   * Wed Sep 30's payroll paying Thu Oct 1, Wells Fargo read through Oct 23 and today Oct 30, /spending October read
   * "none of it reached an account through Fri, Oct 23, 2026" of Oct 1, which the calendar drew paid by Sep 30.
   */
  test("stale: a window opening on Aug 6 names Wed Aug 5's deposit paying it early, as the calendar draws it", () => {
    paidThrough("2026-07-30");
    deposit("2026-08-05");
    readThrough("2026-09-12");

    expect(paydaySettlement(bundle.db, SERIES, TODAY).settledBy.get("2026-08-06")).toBe("2026-08-05");
    const [note] = spending("2026-08-06", "2026-08-31");
    expect(note).toBe(
      "It America LLC (weekly pay) implies $4,000.00 of earnings over Aug 6 – 27, 2026 and none of it reached an " +
        "account inside the window; $1,000.00 (Aug 6) was paid early, by the deposit of Wed, Aug 5, 2026. " +
        staleSentence("2026-08-06", "2026-08-31"),
    );
  });

  /*
   * ⚖️ DEFAULT (A), built 2026-10-21: money out on a day of its own is named "went back out on <day>" wherever a
   * banked figure leaves it out — /spending's note for a stale schedule too, as the card and the shortfall note do.
   * 🔴 Review of 27ca437 (MEDIUM): the stale note printed "only $X reached an account" — the one rule's figure — with
   * no day, and its `continue` skipped the shortfall note, the only /spending path that named it.
   */
  test("a stale schedule's note names the money that went back out, on its day, as the card does", () => {
    paidThrough("2026-08-06");
    deposit("2026-08-07", -100_000);
    readThrough("2026-09-05");

    const back = "$1,000.00 went back out on Fri, Aug 7, 2026";
    expect(incomeCard(bundle.db, TODAY)!.totals.gapLabel).toContain(back);
    expect(spending("2026-08-01", "2026-08-31")).toEqual([
      "It America LLC (weekly pay) implies $4,000.00 of earnings over Aug 6 – 27, 2026 and only $1,000.00 reached " +
        `an account; ${back}. ${staleSentence("2026-08-01", "2026-08-31")}`,
    ]);
    // …and beside the figure where the claim stops at the checked day: Q3 and the year hold Sep 10, past Sep 5
    for (const [from, to] of [
      ["2026-07-01", "2026-09-30"],
      ["2026-01-01", "2026-12-31"],
    ] as const) {
      // ⛔ after "the other payday falls after that, …", which names the checked day — never Aug 7 (review of 337baa7)
      expect(spending(from, to).join(" ")).toContain(
        `reached an account through Sat, Sep 5, 2026; the other payday falls after that, ${CHECKED_DAY}; ${back}.`,
      );
    }
    // a window without Aug 7 has no money out to name
    expect(spending("2026-09-01", "2026-09-30").join(" ")).not.toContain("went back out");
  });
});

/**
 * A stale schedule's verdict on Earned vs banked names EVERY payday of the silence it counts: "did not reach a bank" of
 * those checked through their days to land, "not banked yet" of those inside them, and "the ledger has not looked for
 * its deposit" of those past the checked day — the label one line above says the same three things of the same money.
 * ⛔ Never "with no deposit" of a silence that runs past the checked day: of a payday nobody has read that is the claim
 * 27ca437's V2 took out of the branch below the bar.
 *
 * 🔴 Review of 0c9bc8d (MEDIUM, there before 337baa7): on his ledger copy 2026-10-21 with a Salary-filed −$1,141.92 on
 * Fri Sep 25, Wells Fargo read through Fri Oct 16 and today Oct 23, the verdict read "4 paydays have passed since Sep 24
 * with no deposit. 2 of them, and their days to land, fall on days the records already cover, through Oct 16 — so the
 * pay did not reach a bank; Oct 15's days to land run past Oct 16, … — so its pay is not banked yet." — Oct 22, after
 * the checked day, never named, while the label beside it read "…the other $1,141.92 is for paydays after that day — so
 * the ledger has not looked for it". The e2e fixture (today Jul 8) read "4 paydays have passed since May 8 with no
 * deposit. 3 of them fall on days the records already cover, through Jun 30 — so the pay did not reach a bank".
 */
describe("a stale verdict names every payday of its silence — one past the checked day is not looked for", () => {
  const NOT_ANSWERED = "Whether it was earned is a different question, and this card cannot answer it.";

  test("the reviewer's shape: two did not reach a bank, one is not banked yet, one is not looked for", () => {
    paidThrough("2026-08-06");
    readThrough("2026-09-05");
    const line = incomeCard(bundle.db, TODAY)!.pay[0]!;

    expect(line).toMatchObject({ basis: "series-stale", silentPeriods: 5, checkedSilentPeriods: 4 });
    expect(line.verdict).toBe(
      "5 paydays have passed since the last deposit on Aug 6. 3 of them, and their days to land, fall on days the " +
        "records already cover, through Sep 5 — so the pay did not reach a bank; Sep 3's days to land run past Sep 5, " +
        `${CHECKED_DAY} — so its pay is not banked yet; the other one falls after Sep 5 — so the ledger has not ` +
        `looked for its deposit. ${NOT_ANSWERED}`,
    );
    // …as the label one line above it says of the same money
    expect(line.gapLabel).toContain("the other $1,000.00 is for paydays after that day — so the ledger has not looked");
    expect(line.verdict).not.toContain("with no deposit");
  });

  // the e2e fixture's shape: no payday inside its days to land, so the checked day is named in full by this clause
  test("none inside its days to land: the other one falls after the checked day, named in full", () => {
    paidThrough("2026-08-06");
    readThrough("2026-09-06");

    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.verdict).toBe(
      "5 paydays have passed since the last deposit on Aug 6. 4 of them fall on days the records already cover, " +
        `through Sep 6 — so the pay did not reach a bank; the other one falls after Sep 6, ${CHECKED_DAY} — so the ` +
        `ledger has not looked for its deposit. ${NOT_ANSWERED}`,
    );
  });

  test("two past the checked day: 'the other 2 fall', 'their deposits'", () => {
    paidThrough("2026-08-06");
    readThrough("2026-08-30");

    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.verdict).toBe(
      "5 paydays have passed since the last deposit on Aug 6. 3 of them fall on days the records already cover, " +
        `through Aug 30 — so the pay did not reach a bank; the other 2 fall after Aug 30, ${CHECKED_DAY} — so the ` +
        `ledger has not looked for their deposits. ${NOT_ANSWERED}`,
    );
  });

  // ⛔ …and "since the last deposit" names the payday its count leaves out, as the sentence below the bar does
  test("a payday the last deposit paid early is named where the count leaves it out", () => {
    paidThrough("2026-07-30");
    deposit("2026-08-05");
    readThrough("2026-09-05");

    expect(incomeCard(bundle.db, TODAY)!.pay[0]!.verdict).toBe(
      "5 paydays have passed since the last deposit on Aug 5 (not counting Aug 6, which was paid early). 3 of them, " +
        "and their days to land, fall on days the records already cover, through Sep 5 — so the pay did not reach a " +
        `bank; Sep 3's days to land run past Sep 5, ${CHECKED_DAY} — so its pay is not banked yet; the other one ` +
        `falls after Sep 5 — so the ledger has not looked for its deposit. ${NOT_ANSWERED}`,
    );
  });
});

/**
 * ⛔ A stale schedule's note on /spending counts as what "reached an account" of its window's earnings only the
 * window's OWN money: money inside it that paid another window's read payday (`paidAcross`) is that window's — its
 * note names it paying that payday — so here it is named after the claim, in the live shortfall note's words.
 *
 * 🔴 Review of 0c9bc8d (MEDIUM): on his ledger copy 2026-10-21 with Wed Sep 30's payroll paying Thu Oct 1, Wells Fargo
 * read through Fri Oct 23 and today Oct 30, Q3 read "implies $14,085.60 of earnings over Jul 2 – Sep 24, 2026 and only
 * $6,851.52 reached an account" — Sep 30's $1,141.92 among it — while Q4 on the same page read "$1,141.92 (Oct 1) was
 * paid early, by the deposit of Wed, Sep 30, 2026": one deposit on both sides, and $7,234.08 to infer short where the
 * card and the live Q3 note say $8,376.00 never reached a bank.
 */
describe("a stale note's money that paid another window's payday is named, never counted as the window's own", () => {
  test("his shape: Wed Sep 30 paid Thu Oct 1 — Q3 names it paid early, as Q4 names it paying Oct 1", () => {
    const OCT_30 = "2026-10-30";
    paidThrough("2026-06-25");
    deposit("2026-09-24");
    deposit("2026-09-30");
    readThrough("2026-10-23");

    expect(paydaySettlement(bundle.db, SERIES, OCT_30).settledBy.get("2026-10-01")).toBe("2026-09-30");
    const [q3] = spending("2026-07-01", "2026-09-30", OCT_30);
    expect(q3).toContain(
      "It America LLC (weekly pay) implies $13,000.00 of earnings over Jul 2 – Sep 24, 2026 and only $1,000.00 " +
        "reached an account inside the window; another $1,000.00 banked inside the window, from the deposit of Wed, " +
        "Sep 30, 2026, paid Oct 1's payday early. Across the whole schedule,",
    );
    expect(spending("2026-10-01", "2026-12-31", OCT_30).join(" ")).toContain(
      "$1,000.00 (Oct 1) was paid early, by the deposit of Wed, Sep 30, 2026",
    );
  });

  // Sat Aug 1 reaches back to Thu Jul 30 and not ahead to Thu Aug 6 — 3 days to land
  test("paid late: Sat Aug 1 paid Thu Jul 30 — August names it paying July's payday", () => {
    paidThrough("2026-07-23");
    deposit("2026-08-01");
    readThrough("2026-09-12");

    expect(paydaySettlement(bundle.db, SERIES, TODAY).settledBy.get("2026-07-30")).toBe("2026-08-01");
    expect(spending("2026-08-01", "2026-08-31")).toEqual([
      "It America LLC (weekly pay) implies $4,000.00 of earnings over Aug 6 – 27, 2026 and none of it reached an " +
        "account inside the window; another $1,000.00 banked inside the window, from the deposit of Sat, Aug 1, " +
        `2026, paid Jul 30's payday. ${staleSentence("2026-08-01", "2026-08-31")}`,
    ]);
    expect(spending("2026-07-01", "2026-07-31").join(" ")).toContain(
      "$1,000.00 (Jul 30) was paid by the deposit of Sat, Aug 1, 2026",
    );
  });
});
