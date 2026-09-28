import { describe, expect, test } from "vitest";
import { settlePaydaysBackwards, type AttributedDeposit, type PaydayOccurrence } from "./payday-settlement";

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
