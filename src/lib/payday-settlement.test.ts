import { describe, expect, test } from "vitest";
import {
  portionsAcross,
  settlePaydaysBackwards,
  type AttributedDeposit,
  type PaydayOccurrence,
} from "./payday-settlement";

/**
 * The rule at its boundaries, where no fixture built out of the owner's own
 * schedule can reach it.
 *
 * ⛔ A FIXTURE THAT CANNOT EXPRESS A CONDITION CANNOT TEST IT. His pay is weekly
 * with three days of tolerance, and a window of ±3 days around one deposit can
 * never touch two paydays seven days apart — so the anchor clause ("only the
 * FIRST occurrence in reach is settled on the strength of the date alone") is
 * invisible on his ledger and stayed invisible through a mutation run against
 * the service tests. It is visible here, at `toleranceDays: 5`, which is why
 * the rule lives in `lib` and is tested through its own front door.
 */

const WEEK = 114_192;
const weekly = (...dates: string[]): PaydayOccurrence[] => dates.map((date) => ({ date, amountCents: WEEK }));
const paid = (postedOn: string, amountCents: number): AttributedDeposit => ({ postedOn, amountCents });
const settle = (
  occurrences: PaydayOccurrence[],
  deposits: AttributedDeposit[],
  toleranceDays = 3,
): { dates: string[]; unallocatedCents: number } => {
  const s = settlePaydaysBackwards({ occurrences, deposits, toleranceDays });
  return { dates: [...s.settledBy.keys()].sort(), unallocatedCents: s.unallocatedCents };
};

describe("settlePaydaysBackwards", () => {
  /* ⚖️ His decision, worked on his own numbers: 2026-09-23 +$4,567.68 and
     2026-09-24 +$1,141.92 retire Aug 27, Sep 3, Sep 10, Sep 17 and Sep 24. */
  test("his five", () => {
    const occ = weekly("2026-08-06", "2026-08-13", "2026-08-20", "2026-08-27", "2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24");
    expect(settle(occ, [paid("2026-09-23", WEEK * 4), paid("2026-09-24", WEEK)]).dates).toEqual([
      "2026-08-27",
      "2026-09-03",
      "2026-09-10",
      "2026-09-17",
      "2026-09-24",
    ]);
  });

  test("the answer does not depend on the order the deposits are handed over", () => {
    const occ = weekly("2026-08-27", "2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24");
    const forwards = settle(occ, [paid("2026-09-23", WEEK * 4), paid("2026-09-24", WEEK)]);
    const backwards = settle(occ, [paid("2026-09-24", WEEK), paid("2026-09-23", WEEK * 4)]);
    expect(backwards).toEqual(forwards);
  });

  /*
   * ⛔ THE ANCHOR CLAUSE IS THE FIRST OCCURRENCE ONLY. One deposit settles one
   * payday outright; every further payday behind it has to be paid for. Let the
   * clause run for each occurrence in reach and the deposit's tolerance window
   * buys a second week it never carried — the double-settle rule (A) exists to
   * prevent. Invisible at weekly/3 (a ±3 window cannot touch two Thursdays);
   * visible here.
   */
  test("a tolerance window touching two paydays still settles only one on the date alone", () => {
    const occ = weekly("2026-06-01", "2026-06-08");
    // 06-04 is within 5 days of BOTH, and carries one week plus $454.00
    const got = settle(occ, [paid("2026-06-04", WEEK + 45_400)], 5);
    expect(got.dates).toEqual(["2026-06-08"]);
    expect(got.unallocatedCents).toBe(45_400);
  });

  /* PARTIAL: the deposit landed on the payday, so the payday was answered. How
     much it paid is `classifyPostedAmount`'s question — his June week really was
     $1,047.00 against $1,141.92. */
  test("a short deposit still settles the payday it landed on", () => {
    expect(settle(weekly("2026-06-04", "2026-06-11"), [paid("2026-06-04", 104_700)]).dates).toEqual(["2026-06-04"]);
  });

  test("a short deposit never reaches the payday behind the one it answered", () => {
    const occ = weekly("2026-05-28", "2026-06-04");
    expect(settle(occ, [paid("2026-06-04", 104_700)]).dates).toEqual(["2026-06-04"]);
  });

  /* Past the tolerance the money decides, and only the whole amount will do. */
  test("a late deposit retires the payday behind it when it covers the whole of it", () => {
    expect(settle(weekly("2026-06-04"), [paid("2026-06-30", WEEK)]).dates).toEqual(["2026-06-04"]);
  });

  test("a late deposit short of the whole amount retires nothing", () => {
    const got = settle(weekly("2026-06-04"), [paid("2026-06-30", WEEK - 1)]);
    expect(got.dates).toEqual([]);
    expect(got.unallocatedCents).toBe(WEEK - 1);
  });

  /* LEFTOVER stays unallocated: it never pre-pays a payday out of reach. */
  test("money left over does not pre-pay the paydays ahead", () => {
    const got = settle(weekly("2026-09-17", "2026-09-24", "2026-10-01", "2026-10-08"), [paid("2026-09-24", WEEK * 4)]);
    expect(got.dates).toEqual(["2026-09-17", "2026-09-24"]);
    expect(got.unallocatedCents).toBe(WEEK * 2);
  });

  /* …but it does reach the payday just ahead that the tolerance covers — the
     lump that posts the day BEFORE the payday it pays for. */
  test("a deposit reaches a payday inside its tolerance ahead of it", () => {
    expect(settle(weekly("2026-09-17", "2026-09-24"), [paid("2026-09-23", WEEK * 2)]).dates).toEqual([
      "2026-09-17",
      "2026-09-24",
    ]);
  });

  /* A RATE CHANGE MID-RUN: his weeks have been $1,047.00 and $1,141.92, so a
     deposit matching no whole number of paydays is the ordinary case. */
  test("an amount matching no whole number of paydays stops where the money stops", () => {
    const occ = weekly("2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24");
    const got = settle(occ, [paid("2026-09-24", 400_000)]);
    expect(got.dates).toEqual(["2026-09-10", "2026-09-17", "2026-09-24"]);
    expect(got.unallocatedCents).toBe(400_000 - WEEK * 3);
  });

  test("weeks of different sizes are each retired at their own amount", () => {
    const occ = [
      { date: "2026-06-04", amountCents: 104_700 },
      { date: "2026-06-11", amountCents: WEEK },
    ];
    expect(settle(occ, [paid("2026-06-11", 104_700 + WEEK)]).dates).toEqual(["2026-06-04", "2026-06-11"]);
  });

  test("no deposits settles nothing, and no occurrences allocates nothing", () => {
    expect(settle(weekly("2026-06-04"), [])).toEqual({ dates: [], unallocatedCents: 0 });
    expect(settle([], [paid("2026-06-04", WEEK)])).toEqual({ dates: [], unallocatedCents: 0 });
  });

  /* Two deposits in one window, neither a lump. */
  test("two ordinary weekly deposits settle their own two weeks", () => {
    const occ = weekly("2026-09-10", "2026-09-17", "2026-09-24");
    expect(settle(occ, [paid("2026-09-17", WEEK), paid("2026-09-24", WEEK)]).dates).toEqual([
      "2026-09-17",
      "2026-09-24",
    ]);
  });
});

/**
 * 🔴 THE SAME MONEY, SPLIT IN TWO, RETIRED FEWER PAYDAYS.
 *
 * His decision is stated in aggregate — "a deposit attributed to a pay series
 * pays down the OLDEST unmet paydays up to its amount" — but each deposit's
 * remainder was dropped on the floor rather than carried into the next, so the
 * answer depended on how the payer happened to split the transfer. One lump of
 * $4,567.68 retired four paydays; the same $4,567.68 sent as two transfers
 * retired three, Sep 3 stayed red "unsettled (unbanked)" on /recurring, and
 * /budgets printed "1 payday worth $1,141.92 already passed this month with no
 * deposit against them" for a month carrying $4,567.68 attributed to that very
 * series.
 */
describe("settlePaydaysBackwards — the money pools, however it was split", () => {
  const his = (): PaydayOccurrence[] => weekly("2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24");
  const HIS_FOUR = ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"];

  test("one lump retires four paydays", () => {
    expect(settle(his(), [paid("2026-09-23", WEEK * 4)]).dates).toEqual(HIS_FOUR);
  });

  test("two transfers on the same day retire the same four", () => {
    expect(settle(his(), [paid("2026-09-23", 170_000), paid("2026-09-23", 286_768)]).dates).toEqual(HIS_FOUR);
  });

  test("two transfers on different days retire the same four", () => {
    expect(settle(his(), [paid("2026-09-22", 200_000), paid("2026-09-24", 256_768)]).dates).toEqual(HIS_FOUR);
  });

  /* ⛔ Pooling never invents money. Three weeks' worth split in two still buys
     three weeks, and the change left over is still change. */
  test("a pool short of a whole payday still buys nothing", () => {
    const got = settle(his(), [paid("2026-09-23", 200_000), paid("2026-09-23", 142_576)]);
    expect(got.dates).toEqual(["2026-09-10", "2026-09-17", "2026-09-24"]);
    expect(got.unallocatedCents).toBe(0);
  });
});

/**
 * 🔴 SETTLEMENT NAMED THE DEPOSIT, NEVER THE MONEY.
 *
 * `settledBy` says which deposit's walk retired a payday. A reader that
 * publishes a figure over a WINDOW needs more: how much of which deposit's money
 * went to which payday. /budgets' fourth figure added each payday's SCHEDULED
 * amount wherever the settling deposit's date fell outside the month, so it
 * misstated another month's money twice over:
 *
 *   SHORT   Wed 2026-09-30 +$1,100.00 settles Thu Oct 1 under the anchor clause;
 *           read Oct 2, October said "$1,141.92 … paid early, by the deposit of
 *           Wed, Sep 30" — a row that holds $1,100.00.
 *   POOLED  change carried over from an earlier deposit pays part of a payday
 *           another deposit's walk retires, so the whole payday landed on one
 *           side of the month line when its money sat on both.
 *
 * `portions` is the walk's own record of the money: every sum it spent, as
 * (payday, deposit, cents).
 */
describe("settlePaydaysBackwards — where the money went", () => {
  const walk = (occurrences: PaydayOccurrence[], deposits: AttributedDeposit[], toleranceDays = 3) =>
    settlePaydaysBackwards({ occurrences, deposits, toleranceDays });
  /** payday ← deposit: cents, oldest payday first — the order a reader checks them in */
  const flows = (s: ReturnType<typeof walk>): string[] =>
    s.portions
      .map((p) => `${p.paydayOn} ← ${p.depositOn}: ${p.cents}`)
      .sort();

  /* ⚖️ His two deposits: the lump takes the four weeks it reaches, newest first
     from Sep 24; the weekly deposit, finding Sep 24 already paid, takes Aug 27. */
  test("his five: whose money paid which week", () => {
    const occ = weekly("2026-08-20", "2026-08-27", "2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24");
    expect(flows(walk(occ, [paid("2026-09-23", WEEK * 4), paid("2026-09-24", WEEK)]))).toEqual([
      `2026-08-27 ← 2026-09-24: ${WEEK}`,
      `2026-09-03 ← 2026-09-23: ${WEEK}`,
      `2026-09-10 ← 2026-09-23: ${WEEK}`,
      `2026-09-17 ← 2026-09-23: ${WEEK}`,
      `2026-09-24 ← 2026-09-23: ${WEEK}`,
    ]);
  });

  /* The anchor clause settles the payday whatever the deposit carried, and the
     money it paid is the money it had — not the payday's worth. */
  test("a short deposit pays the payday it landed on with the money it had", () => {
    expect(flows(walk(weekly("2026-09-24", "2026-10-01"), [paid("2026-09-30", 110_000)]))).toEqual([
      "2026-10-01 ← 2026-09-30: 110000",
    ]);
  });

  /* $5,000.00 on Sep 23 retires four weeks and carries $432.32 of change; the
     $709.60 of Oct 1 tops it up to a whole Oct 1. Both deposits' money is in
     that payday, and each sum is named by the deposit it came from. */
  test("change carried over is named by the deposit it came from", () => {
    const occ = weekly("2026-08-27", "2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01");
    const got = walk(occ, [paid("2026-09-23", 500_000), paid("2026-10-01", 70_960)]);
    expect(got.portions.filter((p) => p.paydayOn === "2026-10-01").map((p) => [p.depositOn, p.cents])).toEqual([
      ["2026-10-01", 70_960],
      ["2026-09-23", 43_232],
    ]);
    expect(got.settledBy.get("2026-10-01")).toBe("2026-10-01");
  });

  /*
   * ⚖️ A DEPOSIT'S OWN MONEY IS SPENT FIRST. The anchor is that deposit's own
   * statement about the payday it landed on, so its money answers that payday;
   * change carried over from an earlier deposit only tops up what its own
   * cannot reach. Spend the oldest money first instead and Oct 1's own deposit
   * would be recorded as the change, and September's leftover as Oct 1's pay.
   */
  test("the deposit that landed on a payday pays it; older change waits for older weeks", () => {
    const occ = weekly("2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01");
    const got = walk(occ, [paid("2026-09-23", WEEK * 5), paid("2026-10-01", WEEK)]);
    expect(got.portions.filter((p) => p.paydayOn === "2026-10-01")).toEqual([
      { paydayOn: "2026-10-01", depositOn: "2026-10-01", cents: WEEK },
    ]);
    expect(got.unallocatedCents).toBe(WEEK);
  });

  /* ⛔ Nothing invented, nothing lost: every cent of every deposit is spent on
     exactly one payday or left unallocated, no payday takes more than it is
     worth, and exactly the settled paydays hold money. */
  test("every cent is spent once or left over", () => {
    const occ = weekly("2026-08-20", "2026-08-27", "2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01");
    const cases: AttributedDeposit[][] = [
      [paid("2026-09-23", WEEK * 4), paid("2026-09-24", WEEK)],
      [paid("2026-09-23", 500_000), paid("2026-10-01", 70_960)],
      [paid("2026-09-22", 200_000), paid("2026-09-24", 256_768)],
      [paid("2026-09-30", 110_000), paid("2026-10-01", WEEK * 2)],
      [paid("2026-09-03", WEEK), paid("2026-09-30", WEEK * 4), paid("2026-10-01", WEEK)],
    ];
    for (const deposits of cases) {
      const got = walk(occ, deposits);
      const spent = got.portions.reduce((sum, p) => sum + p.cents, 0);
      expect(spent + got.unallocatedCents).toBe(deposits.reduce((sum, d) => sum + d.amountCents, 0));
      for (const o of occ) {
        const into = got.portions.filter((p) => p.paydayOn === o.date).reduce((sum, p) => sum + p.cents, 0);
        expect(into).toBeLessThanOrEqual(o.amountCents);
        expect(into > 0).toBe(got.settledBy.has(o.date));
      }
      expect(got.portions.every((p) => p.cents > 0)).toBe(true);
    }
  });
});

/*
 * One sort of the money across a month line, for the two pages that print
 * figures about it side by side — /budgets' fourth figure and its mirror, and
 * the recurring calendar's Settled figure.
 */
describe("portionsAcross — the money that crossed a window, both ways", () => {
  const october = (day: string): boolean => day >= "2026-10-01" && day <= "2026-10-31";
  const window = { paydayInside: october, depositInside: october };

  test("the shifted case: September's lump paid Oct 1, and Oct 1's deposit paid Aug 27", () => {
    const got = settlePaydaysBackwards({
      occurrences: weekly("2026-08-27", "2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01"),
      deposits: [paid("2026-09-03", WEEK), paid("2026-09-30", WEEK * 4), paid("2026-10-01", WEEK)],
      toleranceDays: 3,
    });
    const across = portionsAcross(got.portions, window);
    expect(across.paidByAnotherWindow).toEqual([{ paydayOn: "2026-10-01", depositOn: "2026-09-30", cents: WEEK }]);
    expect(across.paidForAnotherWindow).toEqual([{ paydayOn: "2026-08-27", depositOn: "2026-10-01", cents: WEEK }]);
  });

  test("money whose payday and deposit sit on the same side crossed nothing", () => {
    const portions = [
      { paydayOn: "2026-10-08", depositOn: "2026-10-08", cents: WEEK },
      { paydayOn: "2026-09-17", depositOn: "2026-09-23", cents: WEEK },
    ];
    expect(portionsAcross(portions, window)).toEqual({ paidByAnotherWindow: [], paidForAnotherWindow: [] });
  });
});
