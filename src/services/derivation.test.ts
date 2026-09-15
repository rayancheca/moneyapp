import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors, dailyBalances, type AnchorSource, type BalanceBasis } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import {
  DateOutOfRangeError,
  MAX_FINANCIAL_DATE,
  MIN_FINANCIAL_DATE,
} from "@/lib/date-window";
import { compareDates } from "@/lib/dates";
import { dedupeHash } from "@/lib/hash";
import {
  REPLAY_STATUSES,
  accountSeries,
  changesReplayMembership,
  deriveDailyRows,
  heldBalanceAnchor,
  isReplayStatus,
  latestBalances,
  netWorthSeries,
  pickWinners,
  rebuildAccount,
  removalEffect,
} from "./derivation";
import { addManualAnchor } from "./anchors";
import { createAccount } from "./accounts";
import { basisIsChecked } from "./coverage";

const TODAY = "2026-07-08";

describe("pickWinners", () => {
  test("statement beats manual beats live on the same date", () => {
    const winners = pickWinners([
      { anchoredOn: "2026-06-30", balanceCents: 100, source: "live" },
      { anchoredOn: "2026-06-30", balanceCents: 200, source: "manual" },
      { anchoredOn: "2026-06-30", balanceCents: 300, source: "statement" },
    ]);
    expect(winners).toEqual([{ anchoredOn: "2026-06-30", balanceCents: 300, source: "statement" }]);
  });

  test("sorts winners by date", () => {
    const winners = pickWinners([
      { anchoredOn: "2026-07-01", balanceCents: 2, source: "manual" },
      { anchoredOn: "2026-06-01", balanceCents: 1, source: "manual" },
    ]);
    expect(winners.map((w) => w.anchoredOn)).toEqual(["2026-06-01", "2026-07-01"]);
  });
});

describe("REPLAY_STATUSES — the one definition of what replays", () => {
  test("excluded replays (the money still moved); quarantined and superseded never did", () => {
    expect([...REPLAY_STATUSES]).toEqual(["active", "excluded"]);
    expect(isReplayStatus("active")).toBe(true);
    expect(isReplayStatus("excluded")).toBe(true);
    expect(isReplayStatus("quarantined")).toBe(false);
    expect(isReplayStatus("superseded")).toBe(false);
  });

  test("only crossing the set stales the derived cache", () => {
    // ordinary Exclude/Restore stays inside the set — no rebuild owed
    expect(changesReplayMembership("active", "excluded")).toBe(false);
    expect(changesReplayMembership("excluded", "active")).toBe(false);
    expect(changesReplayMembership("active", "active")).toBe(false);
    // leaving quarantine joins replay, and undoing that leaves it again
    expect(changesReplayMembership("quarantined", "active")).toBe(true);
    expect(changesReplayMembership("quarantined", "excluded")).toBe(true);
    expect(changesReplayMembership("active", "quarantined")).toBe(true);
  });
});

describe("deriveDailyRows — cash accounts", () => {
  const opts = { isInvestment: false, today: TODAY };

  test("no anchors -> no rows (levels are never invented)", () => {
    expect(deriveDailyRows([], new Map([["2026-07-01", -100]]), opts)).toEqual([]);
  });

  test("single manual anchor carries forward to today", () => {
    const rows = deriveDailyRows(
      [{ anchoredOn: "2026-07-05", balanceCents: 50_000, source: "manual" }],
      new Map(),
      opts,
    );
    expect(rows).toEqual([
      { day: "2026-07-05", balanceCents: 50_000, basis: "anchored" },
      { day: "2026-07-06", balanceCents: 50_000, basis: "carried" },
      { day: "2026-07-07", balanceCents: 50_000, basis: "carried" },
      { day: "2026-07-08", balanceCents: 50_000, basis: "carried" },
    ]);
  });

  test("equal anchors with no transactions step-hold as carried", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "manual" },
        { anchoredOn: "2026-07-04", balanceCents: 10_000, source: "manual" },
      ],
      new Map(),
      { isInvestment: false, today: "2026-07-04" },
    );
    expect(rows.map((r) => [r.day, r.basis])).toEqual([
      ["2026-07-01", "anchored"],
      ["2026-07-02", "carried"],
      ["2026-07-03", "carried"],
      ["2026-07-04", "anchored"],
    ]);
  });

  test("unequal anchors with no transactions render an honest gap", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "manual" },
        { anchoredOn: "2026-07-04", balanceCents: 12_000, source: "manual" },
      ],
      new Map(),
      { isInvestment: false, today: "2026-07-04" },
    );
    expect(rows.find((r) => r.day === "2026-07-02")?.basis).toBe("gap");
    expect(rows.find((r) => r.day === "2026-07-04")?.basis).toBe("anchored");
  });

  test("chain closure: replay between anchors verifies to the cent", () => {
    // 100.00 + (-25.50) + 10.00 = 84.50
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "statement" },
        { anchoredOn: "2026-07-04", balanceCents: 8_450, source: "statement" },
      ],
      new Map([
        ["2026-07-02", -2_550],
        ["2026-07-04", 1_000],
      ]),
      { isInvestment: false, today: "2026-07-04" },
    );
    expect(rows).toEqual([
      { day: "2026-07-01", balanceCents: 10_000, basis: "anchored" },
      { day: "2026-07-02", balanceCents: 7_450, basis: "derived" },
      { day: "2026-07-03", balanceCents: 7_450, basis: "derived" },
      { day: "2026-07-04", balanceCents: 8_450, basis: "anchored" },
    ]);
  });

  test("broken chain marks the span gap but keeps replayed values for inspection", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "statement" },
        { anchoredOn: "2026-07-04", balanceCents: 9_999, source: "statement" }, // off by 1c
      ],
      new Map([["2026-07-02", -2_550]]),
      { isInvestment: false, today: "2026-07-04" },
    );
    expect(rows.find((r) => r.day === "2026-07-02")).toEqual({
      day: "2026-07-02",
      balanceCents: 7_450,
      basis: "gap",
    });
  });

  test("backward derivation before the earliest anchor is derived_unverified", () => {
    const rows = deriveDailyRows(
      [{ anchoredOn: "2026-07-05", balanceCents: 10_000, source: "statement" }],
      new Map([
        ["2026-07-03", -500],
        ["2026-07-05", 2_000],
      ]),
      { isInvestment: false, today: "2026-07-05" },
    );
    // balance[07-04] = 10000 - txns[07-05] = 8000; balance[07-03] = 8000; balance[07-02] = 8000+500=8500
    expect(rows).toEqual([
      { day: "2026-07-02", balanceCents: 8_500, basis: "derived_unverified" },
      { day: "2026-07-03", balanceCents: 8_000, basis: "derived_unverified" },
      { day: "2026-07-04", balanceCents: 8_000, basis: "derived_unverified" },
      { day: "2026-07-05", balanceCents: 10_000, basis: "anchored" },
    ]);
  });

  test("forward derivation after the last anchor: carried until a txn appears, then derived_unverified", () => {
    const rows = deriveDailyRows(
      [{ anchoredOn: "2026-07-05", balanceCents: 10_000, source: "statement" }],
      new Map([["2026-07-07", -1_000]]),
      opts,
    );
    expect(rows).toEqual([
      { day: "2026-07-05", balanceCents: 10_000, basis: "anchored" },
      { day: "2026-07-06", balanceCents: 10_000, basis: "carried" },
      { day: "2026-07-07", balanceCents: 9_000, basis: "derived_unverified" },
      { day: "2026-07-08", balanceCents: 9_000, basis: "derived_unverified" },
    ]);
  });

  test("moment anchors are never chain endpoints when chain-grade anchors exist", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "statement" },
        { anchoredOn: "2026-07-02", balanceCents: 55, source: "ofx_ledger" }, // mid-morning moment
        { anchoredOn: "2026-07-03", balanceCents: 10_000, source: "statement" },
      ],
      new Map(),
      { isInvestment: false, today: "2026-07-03" },
    );
    // the ofx_ledger observation must not fracture the carried span
    expect(rows.find((r) => r.day === "2026-07-02")).toEqual({
      day: "2026-07-02",
      balanceCents: 10_000,
      basis: "carried",
    });
  });

  test("a live anchor for today overrides the derived value for display", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-07-06", balanceCents: 10_000, source: "statement" },
        { anchoredOn: TODAY, balanceCents: 10_500, source: "live" },
      ],
      new Map(),
      opts,
    );
    expect(rows.at(-1)).toEqual({ day: TODAY, balanceCents: 10_500, basis: "anchored" });
  });

  /*
   * ⛔ PASS 73 — the claim `schema/balances.ts` used to make in prose.
   *
   * That comment said "'live' is only ever written for today", and the ledger
   * disagrees: one of 29 live anchors is stamped the day before it was written,
   * by a fetch that ran past midnight. It was left as `live` rather than
   * relabelled `manual`, because `manual` means a person typed the number and
   * nobody typed this one — so what has to be true is that a past-dated live
   * anchor changes NOTHING. Asserted here rather than promised there.
   */
  test("a live anchor for a PAST day is inert — it neither overrides nor chains", () => {
    const withoutIt = deriveDailyRows(
      [{ anchoredOn: "2026-07-06", balanceCents: 10_000, source: "statement" }],
      new Map([["2026-07-07", -2_500]]),
      opts,
    );
    const withIt = deriveDailyRows(
      [
        { anchoredOn: "2026-07-06", balanceCents: 10_000, source: "statement" },
        // a real reading of a real day, recorded a day late
        { anchoredOn: "2026-07-07", balanceCents: 999_999, source: "live" },
      ],
      new Map([["2026-07-07", -2_500]]),
      opts,
    );
    expect(withIt).toEqual(withoutIt);
    expect(withIt.find((r) => r.day === "2026-07-07")?.balanceCents).toBe(7_500);
  });
});

describe("deriveDailyRows — investment accounts", () => {
  test("step-holds between statement anchors; buys/sells never replay", () => {
    const rows = deriveDailyRows(
      [
        { anchoredOn: "2026-06-30", balanceCents: 8_900_000, source: "statement" },
        { anchoredOn: "2026-07-03", balanceCents: 9_100_000, source: "statement" },
      ],
      new Map([["2026-07-01", 50_000]]), // contribution — must NOT be replayed
      { isInvestment: true, today: "2026-07-05" },
    );
    expect(rows.map((r) => [r.day, r.balanceCents, r.basis])).toEqual([
      ["2026-06-30", 8_900_000, "anchored"],
      ["2026-07-01", 8_900_000, "carried"],
      ["2026-07-02", 8_900_000, "carried"],
      ["2026-07-03", 9_100_000, "anchored"],
      ["2026-07-04", 9_100_000, "carried"],
      ["2026-07-05", 9_100_000, "carried"],
    ]);
  });
});

/**
 * 🔴 An investment account with no holdings read "…is the balance recorded on
 * Sep 5, 2026, held forward" of a day holding the Sep 1 balance: the headline
 * took the newest recorded balance of ANY source, and a bank export or a live
 * reading is a moment the step-hold never carries while a statement or a typed
 * balance exists. Every answer here is held to the row `deriveDailyRows` writes
 * for that day, so it cannot drift from the rule.
 */
describe("heldBalanceAnchor — the recorded balance a step-held day holds", () => {
  const investmentWinners = pickWinners([
    { anchoredOn: "2026-09-01", balanceCents: 70_000, source: "manual" },
    { anchoredOn: "2026-09-05", balanceCents: 90_000, source: "ofx_ledger" },
    { anchoredOn: "2026-09-07", balanceCents: 95_000, source: "live" },
    { anchoredOn: "2026-09-08", balanceCents: 80_000, source: "statement" },
    { anchoredOn: "2026-09-10", balanceCents: 60_000, source: "live" },
  ]);

  const heldOn = (winners: typeof investmentWinners, today: string) =>
    deriveDailyRows(winners, new Map(), { isInvestment: true, today }).map((r) => {
      const held = heldBalanceAnchor(winners, r);
      // the figure it names is the figure the day carries, recorded on or before it
      expect(held?.balanceCents, r.day).toBe(r.balanceCents);
      expect(compareDates(held!.anchoredOn, r.day), r.day).toBeLessThanOrEqual(0);
      return [r.day, r.basis, held!.anchoredOn];
    });

  test("a bank export and a past live reading are never what a day holds", () => {
    expect(heldOn(investmentWinners, "2026-09-10")).toEqual([
      ["2026-09-01", "anchored", "2026-09-01"],
      ["2026-09-02", "carried", "2026-09-01"],
      ["2026-09-03", "carried", "2026-09-01"],
      ["2026-09-04", "carried", "2026-09-01"],
      ["2026-09-05", "carried", "2026-09-01"],
      ["2026-09-06", "carried", "2026-09-01"],
      ["2026-09-07", "carried", "2026-09-01"],
      ["2026-09-08", "anchored", "2026-09-08"],
      ["2026-09-09", "carried", "2026-09-08"],
      // the rebuild's today: its live reading stands for that day
      ["2026-09-10", "anchored", "2026-09-10"],
    ]);
  });

  test("a live reading stands only on the day the curve was rebuilt", () => {
    expect(heldOn(investmentWinners, "2026-09-12").slice(-3)).toEqual([
      ["2026-09-10", "carried", "2026-09-08"],
      ["2026-09-11", "carried", "2026-09-08"],
      ["2026-09-12", "carried", "2026-09-08"],
    ]);
  });

  test("with no statement and no typed balance, the moments ARE the curve", () => {
    const moments = pickWinners([
      { anchoredOn: "2026-09-01", balanceCents: 50_000, source: "live" },
      { anchoredOn: "2026-09-04", balanceCents: 65_000, source: "ofx_ledger" },
    ]);
    expect(heldOn(moments, "2026-09-05").slice(-3)).toEqual([
      ["2026-09-03", "carried", "2026-09-01"],
      ["2026-09-04", "anchored", "2026-09-04"],
      ["2026-09-05", "carried", "2026-09-04"],
    ]);
  });

  test("a day before the first recorded balance holds none", () => {
    expect(heldBalanceAnchor(investmentWinners, { day: "2026-08-31", basis: "carried" })).toBeNull();
  });
});

describe("deriveDailyRows — the date-window cap", () => {
  const opts = { isInvestment: false, today: TODAY };

  test("refuses an out-of-window anchor instead of walking a millennium of days", () => {
    expect(() =>
      deriveDailyRows(
        [
          { anchoredOn: "1026-07-01", balanceCents: 0, source: "manual" }, // typo for 2026
          { anchoredOn: "2026-07-01", balanceCents: 10_000, source: "manual" },
        ],
        new Map(),
        opts,
      ),
    ).toThrow(DateOutOfRangeError);

    expect(() =>
      deriveDailyRows(
        [{ anchoredOn: "9999-12-31", balanceCents: 10_000, source: "manual" }],
        new Map(),
        opts,
      ),
    ).toThrow(/anchor date must be between/);
  });

  test("refuses an out-of-window transaction day — it bounds the backward walk", () => {
    expect(() =>
      deriveDailyRows(
        [{ anchoredOn: "2026-07-01", balanceCents: 10_000, source: "manual" }],
        new Map([["1026-07-01", -500]]),
        opts,
      ),
    ).toThrow(/transaction date must be between/);
  });

  test("refuses an out-of-window today — it bounds the forward walk", () => {
    expect(() =>
      deriveDailyRows(
        [{ anchoredOn: "2026-07-01", balanceCents: 10_000, source: "manual" }],
        new Map(),
        { isInvestment: false, today: "9999-01-01" },
      ),
    ).toThrow(/today must be between/);
  });

  test("the window bounds themselves are legal", () => {
    expect(
      deriveDailyRows([{ anchoredOn: MIN_FINANCIAL_DATE, balanceCents: 1, source: "manual" }], new Map(), {
        isInvestment: false,
        today: MIN_FINANCIAL_DATE,
      }),
    ).toEqual([{ day: MIN_FINANCIAL_DATE, balanceCents: 1, basis: "anchored" }]);
    expect(
      deriveDailyRows([{ anchoredOn: MAX_FINANCIAL_DATE, balanceCents: 1, source: "manual" }], new Map(), {
        isInvestment: true,
        today: MAX_FINANCIAL_DATE,
      }),
    ).toEqual([{ day: MAX_FINANCIAL_DATE, balanceCents: 1, basis: "anchored" }]);
  });

  test("with no anchors there is no loop to bound, so a wild txn date is still just no rows", () => {
    expect(deriveDailyRows([], new Map([["9999-12-31", -100]]), opts)).toEqual([]);
  });
});

/**
 * The remove-balance dialog on /accounts/[id] quotes this before a destructive,
 * snapshot-only-undo action. Every fixture below ALSO asserts the condition its
 * name promises — a fixture that cannot express a condition cannot test it —
 * and, where the old page got it wrong, the number the old range rule printed.
 */
describe("removalEffect — what removing a recorded balance un-verifies", () => {
  const anchor = (id: string, anchoredOn: string, balanceCents: number, source: AnchorSource) => ({
    id,
    anchoredOn,
    balanceCents,
    source,
  });
  const cash = (today: string) => ({ isInvestment: false, today });
  const basisOn = (rows: readonly { day: string; basis: BalanceBasis }[], day: string) =>
    rows.find((r) => r.day === day)?.basis;

  /**
   * The rule the page used to apply — checked days of the derived series from
   * the balance's own date up to the next recorded one — kept here ONLY to prove
   * each fixture reproduces what the dialog printed.
   */
  const oldRangeCount = (
    rows: readonly { day: string; basis: BalanceBasis }[],
    from: string,
    nextExclusive?: string,
  ) =>
    rows.filter(
      (r) =>
        basisIsChecked(r.basis) &&
        compareDates(r.day, from) >= 0 &&
        (nextExclusive === undefined || compareDates(r.day, nextExclusive) < 0),
    ).length;

  const NO_LOST_DAYS = { lostDays: 0, lostRuns: [], lostTo: { unverified: 0, gap: 0, gone: 0 } };
  /** no day differs, so the account keeps every row it has */
  const nothing = (daysLeft: number) => ({
    ...NO_LOST_DAYS,
    rebasedDays: 0,
    daysLeft,
    changedDays: 0,
    curveUnchanged: true,
  });

  test("A1 a past-dated live reading between two statements that close un-verifies nothing (Robinhood Cash)", () => {
    const today = "2026-08-02";
    const anchors = [
      anchor("s-jun", "2026-06-30", 19_229, "statement"),
      anchor("live", "2026-07-10", 723_565, "live"),
      anchor("s-jul", "2026-07-31", 168_038, "statement"),
    ];
    // 19,229 + 700,000 − 551,191 = 168,038: Jun 30 → Jul 31 closes without the live reading
    const txns = new Map([
      ["2026-07-05", 700_000],
      ["2026-07-20", -551_191],
    ]);

    const rows = deriveDailyRows(pickWinners(anchors), txns, cash(today));
    expect(basisOn(rows, "2026-07-15")).toBe("derived");
    expect(compareDates("2026-07-10", today)).toBeLessThan(0);
    // the defect: the range rule credited Jul 10 – 30 to a reading that is not an endpoint
    expect(oldRangeCount(rows, "2026-07-10", "2026-07-31")).toBe(21);

    expect(removalEffect(anchors, "live", txns, cash(today))).toEqual(nothing(rows.length));
  });

  test("A2 a manual balance one day after an EQUAL statement, nothing posted that day (Chase Sapphire)", () => {
    const today = "2025-03-05";
    const anchors = [
      anchor("s-feb", "2025-02-02", 0, "statement"),
      anchor("manual", "2025-02-03", 0, "manual"),
      anchor("s-mar", "2025-03-02", 0, "statement"),
    ];
    const txns = new Map([
      ["2025-02-04", -5_000],
      ["2025-02-20", 5_000],
    ]);
    expect(txns.has("2025-02-03")).toBe(false);

    const rows = deriveDailyRows(pickWinners(anchors), txns, cash(today));
    expect(oldRangeCount(rows, "2025-02-03", "2025-03-02")).toBe(27);
    // the only change removal makes is anchored → derived at the same balance, and that is not a loss
    const without = deriveDailyRows(
      pickWinners(anchors.filter((a) => a.id !== "manual")),
      txns,
      cash(today),
    );
    expect(rows.find((r) => r.day === "2025-02-03")).toEqual({ day: "2025-02-03", balanceCents: 0, basis: "anchored" });
    expect(without.find((r) => r.day === "2025-02-03")).toEqual({ day: "2025-02-03", balanceCents: 0, basis: "derived" });

    expect(removalEffect(anchors, "manual", txns, cash(today))).toEqual(nothing(rows.length));
  });

  test("A3 the sole manual balance: its day, the carried days, never the unverified one (Cash on Hand)", () => {
    const today = "2026-08-14";
    const anchors = [anchor("manual", "2026-08-03", 500_000, "manual")];
    const txns = new Map([["2026-08-11", -500_000]]);

    const rows = deriveDailyRows(pickWinners(anchors), txns, cash(today));
    expect(rows.filter((r) => r.basis === "carried")).toHaveLength(7);
    expect(basisOn(rows, "2026-08-11")).toBe("derived_unverified");

    expect(removalEffect(anchors, "manual", txns, cash(today))).toEqual({
      lostDays: 8,
      lostRuns: [{ from: "2026-08-03", to: "2026-08-10" }],
      // every row goes: nothing is left to derive the account from, so the lost
      // days lose their balance outright — and the unverified Aug 11 – 14 go too
      lostTo: { unverified: 0, gap: 0, gone: 8 },
      rebasedDays: 0,
      daysLeft: 0,
      changedDays: 12,
      curveUnchanged: false,
    });
  });

  test("A4 a same-day manual + statement pair: precedence decides, never row order (Discover)", () => {
    const today = "2024-09-20";
    const statement = anchor("s-aug", "2024-08-18", -18_000, "statement");
    // a DIFFERENT figure, so a manual that won the day would move the curve
    const manual = anchor("manual", "2024-08-18", -17_500, "manual");
    const next = anchor("s-sep", "2024-09-17", -20_000, "statement");
    const txns = new Map([["2024-08-25", -2_000]]);

    const rows = deriveDailyRows(pickWinners([statement, manual, next]), txns, cash(today));
    // the order-sensitive half of the old rule: with Sep 17 as "next" it read 30 days
    expect(oldRangeCount(rows, "2024-08-18", "2024-09-17")).toBe(30);

    for (const order of [
      [statement, manual, next],
      [manual, statement, next],
    ]) {
      expect(pickWinners(order).find((w) => w.anchoredOn === "2024-08-18")?.source).toBe("statement");
      expect(removalEffect(order, "manual", txns, cash(today))).toEqual(nothing(rows.length));
    }
  });

  test("A5 days BEFORE the balance's own date count when removal re-grades the span behind it", () => {
    const today = "2026-07-12";
    const anchors = [
      anchor("s-jul", "2026-07-01", 10_000, "statement"),
      anchor("manual", "2026-07-10", 8_000, "manual"),
    ];
    const txns = new Map([["2026-07-05", -2_000]]);

    const rows = deriveDailyRows(pickWinners(anchors), txns, cash(today));
    expect(basisOn(rows, "2026-07-05")).toBe("derived");
    expect(oldRangeCount(rows, "2026-07-10")).toBe(3);

    expect(removalEffect(anchors, "manual", txns, cash(today))).toEqual({
      // Jul 5 – 9 derived, Jul 10 anchored, Jul 11 – 12 carried: all become a walk forward from Jul 1
      lostDays: 8,
      lostRuns: [{ from: "2026-07-05", to: "2026-07-12" }],
      lostTo: { unverified: 8, gap: 0, gone: 0 },
      rebasedDays: 0,
      daysLeft: 12,
      changedDays: 8,
      curveUnchanged: false,
    });
  });

  test("A6 a wrong manual balance that breaks the chain: nothing lost, but the curve moves", () => {
    const today = "2026-07-22";
    const anchors = [
      anchor("s-jul1", "2026-07-01", 10_000, "statement"),
      anchor("manual", "2026-07-10", 5_000, "manual"),
      anchor("s-jul20", "2026-07-20", 8_000, "statement"),
    ];
    const txns = new Map([["2026-07-05", -2_000]]);

    const rows = deriveDailyRows(pickWinners(anchors), txns, cash(today));
    expect(basisOn(rows, "2026-07-05")).toBe("gap");
    expect(basisOn(rows, "2026-07-15")).toBe("gap");

    expect(removalEffect(anchors, "manual", txns, cash(today))).toEqual({
      ...NO_LOST_DAYS,
      // Jul 10 is verified either way: anchored at $50.00, then derived at $80.00
      rebasedDays: 1,
      daysLeft: 22,
      // Jul 2 – 19: seventeen gap days become derived, and Jul 10 moves from $50.00 to $80.00
      changedDays: 18,
      curveUnchanged: false,
    });
  });

  test("A7a a live reading dated TODAY after a posted transaction verifies exactly today", () => {
    const today = "2026-07-06";
    const anchors = [
      anchor("s-jul", "2026-07-01", 10_000, "statement"),
      anchor("live", today, 9_000, "live"),
    ];
    const txns = new Map([["2026-07-03", -1_000]]);

    const rows = deriveDailyRows(pickWinners(anchors), txns, cash(today));
    expect(basisOn(rows, "2026-07-05")).toBe("derived_unverified");
    expect(basisOn(rows, today)).toBe("anchored");

    expect(removalEffect(anchors, "live", txns, cash(today))).toEqual({
      lostDays: 1,
      lostRuns: [{ from: today, to: today }],
      // the forward walk from Jul 1 still reaches today, unchecked
      lostTo: { unverified: 1, gap: 0, gone: 0 },
      rebasedDays: 0,
      daysLeft: 6,
      changedDays: 1,
      curveUnchanged: false,
    });
  });

  test("A7b a live reading dated TODAY with nothing posted: today stays carried, at a different figure", () => {
    const today = "2026-07-06";
    const anchors = [
      anchor("s-jul", "2026-07-01", 10_000, "statement"),
      anchor("live", today, 9_500, "live"),
    ];
    const txns = new Map<string, number>();

    const rows = deriveDailyRows(pickWinners(anchors), txns, cash(today));
    expect(rows.find((r) => r.day === today)).toEqual({ day: today, balanceCents: 9_500, basis: "anchored" });

    expect(removalEffect(anchors, "live", txns, cash(today))).toEqual({
      ...NO_LOST_DAYS,
      // today is carried either way, at $100.00 instead of $95.00
      rebasedDays: 1,
      daysLeft: 6,
      changedDays: 1,
      curveUnchanged: false,
    });
  });

  test("A8 an investment account on the anchor path: step-holds never un-verify, but the level moves", () => {
    const options = { isInvestment: true, today: "2026-07-08" };
    const anchors = [
      anchor("s-jun", "2026-06-30", 8_900_000, "statement"),
      anchor("manual", "2026-07-03", 9_000_000, "manual"),
      anchor("s-jul", "2026-07-06", 9_100_000, "statement"),
    ];
    const txns = new Map([["2026-07-01", 50_000]]); // a contribution — never replayed

    const rows = deriveDailyRows(pickWinners(anchors), txns, options);
    expect(basisOn(rows, "2026-07-04")).toBe("carried");
    expect(rows.every((r) => basisIsChecked(r.basis))).toBe(true);

    expect(removalEffect(anchors, "manual", txns, options)).toEqual({
      ...NO_LOST_DAYS,
      // Jul 3 – 5 carry $89,000.00 instead of $90,000.00 — verified either way
      rebasedDays: 3,
      daysLeft: 9,
      changedDays: 3,
      curveUnchanged: false,
    });
  });

  test("A9 removing the FIRST balance moves the backward walk; days already unverified are not counted", () => {
    const today = "2026-07-10";
    const anchors = [
      anchor("manual", "2026-07-01", 10_000, "manual"),
      anchor("s-jul", "2026-07-10", 8_000, "statement"),
    ];
    const txns = new Map([
      ["2026-06-28", 500],
      ["2026-07-05", -2_000],
    ]);

    const rows = deriveDailyRows(pickWinners(anchors), txns, cash(today));
    expect(basisOn(rows, "2026-06-30")).toBe("derived_unverified");
    expect(basisOn(rows, "2026-07-02")).toBe("derived");

    expect(removalEffect(anchors, "manual", txns, cash(today))).toEqual({
      lostDays: 9,
      lostRuns: [{ from: "2026-07-01", to: "2026-07-09" }],
      // the backward walk from Jul 10 still reaches every one of them
      lostTo: { unverified: 9, gap: 0, gone: 0 },
      rebasedDays: 0,
      daysLeft: 14,
      changedDays: 9,
      curveUnchanged: false,
    });
  });

  /**
   * 🔴 The dialog said "Removing it leaves those days to be derived from
   * transactions alone" of every lost day. B1–B3 are the three things that can
   * really become of one, each checked against the rows without the balance.
   */
  test("B1 the FIRST balance, before the first transaction: some lost days lose their balance, the rest stay derived", () => {
    const today = "2026-07-12";
    const anchors = [
      anchor("manual", "2026-07-01", 10_000, "manual"),
      anchor("s-jul", "2026-07-10", 8_000, "statement"),
    ];
    const txns = new Map([["2026-07-05", -2_000]]);

    const without = deriveDailyRows(pickWinners([anchors[1]!]), txns, cash(today));
    expect(basisOn(without, "2026-07-03")).toBeUndefined();
    expect(basisOn(without, "2026-07-04")).toBe("derived_unverified");

    expect(removalEffect(anchors, "manual", txns, cash(today))).toEqual({
      lostDays: 9,
      lostRuns: [{ from: "2026-07-01", to: "2026-07-09" }],
      // Jul 4 – 9 are walked back from Jul 10; Jul 1 – 3 are before the walk ends
      lostTo: { unverified: 6, gap: 0, gone: 3 },
      rebasedDays: 0,
      daysLeft: 9,
      changedDays: 9,
      curveUnchanged: false,
    });
  });

  test("B2 a middle balance that closes both spans: without it the lost days are a gap", () => {
    const today = "2026-07-22";
    const anchors = [
      anchor("s1", "2026-07-01", 10_000, "statement"),
      anchor("manual", "2026-07-10", 9_000, "manual"),
      anchor("s2", "2026-07-20", 5_000, "statement"),
    ];
    const txns = new Map([
      ["2026-07-05", -1_000],
      ["2026-07-15", -1_000],
    ]);

    const rows = deriveDailyRows(pickWinners(anchors), txns, cash(today));
    expect(basisOn(rows, "2026-07-05")).toBe("derived");
    expect(basisOn(rows, "2026-07-15")).toBe("gap"); // $90.00 − $10.00 is not $50.00

    expect(removalEffect(anchors, "manual", txns, cash(today))).toEqual({
      lostDays: 9,
      lostRuns: [{ from: "2026-07-02", to: "2026-07-10" }],
      lostTo: { unverified: 0, gap: 9, gone: 0 },
      rebasedDays: 0,
      daysLeft: 22,
      changedDays: 9,
      curveUnchanged: false,
    });
  });

  test("B3 an investment account never replays transactions, so its lost days lose their balance outright", () => {
    const options = { isInvestment: true, today: "2026-07-08" };
    const anchors = [
      anchor("manual", "2026-07-01", 10_000, "manual"),
      anchor("s-jul", "2026-07-05", 12_000, "statement"),
    ];

    expect(removalEffect(anchors, "manual", new Map(), options)).toEqual({
      lostDays: 4,
      lostRuns: [{ from: "2026-07-01", to: "2026-07-04" }],
      lostTo: { unverified: 0, gap: 0, gone: 4 },
      rebasedDays: 0,
      daysLeft: 4,
      changedDays: 4,
      curveUnchanged: false,
    });
  });

  /**
   * 🔴 `lostWindow` was the first and last lost day, named as one range: "Jun 7 –
   * 26, 2026" beside a count of 19, with Jun 8 still verified inside it.
   */
  test("B4 removing the only chain-grade balance hands the curve to bank exports: the lost days are two runs", () => {
    const today = "2026-07-02";
    const anchors = [
      anchor("manual", "2026-06-07", 0, "manual"),
      anchor("ofx-8", "2026-06-08", 0, "ofx_ledger"),
      anchor("ofx-27", "2026-06-27", 2_000, "ofx_ledger"),
    ];

    const without = deriveDailyRows(pickWinners(anchors.slice(1)), new Map(), cash(today));
    expect(basisOn(without, "2026-06-08")).toBe("anchored");

    expect(removalEffect(anchors, "manual", new Map(), cash(today))).toEqual({
      lostDays: 19,
      lostRuns: [
        { from: "2026-06-07", to: "2026-06-07" },
        { from: "2026-06-09", to: "2026-06-26" },
      ],
      lostTo: { unverified: 0, gap: 18, gone: 1 },
      // Jun 27 – Jul 2: carried at $0.00, then at the export's $20.00
      rebasedDays: 6,
      daysLeft: 25,
      changedDays: 25,
      curveUnchanged: false,
    });
  });

  test("B5 the same with live readings and a transaction: two runs, two fates", () => {
    const today = "2026-07-14";
    const anchors = [
      anchor("manual", "2026-07-05", 10_000, "manual"),
      anchor("live-8", "2026-07-08", 12_000, "live"),
      anchor("live-12", "2026-07-12", 13_000, "live"),
    ];
    const txns = new Map([["2026-07-01", 10_000]]);

    expect(removalEffect(anchors, "manual", txns, cash(today))).toEqual({
      lostDays: 6,
      lostRuns: [
        { from: "2026-07-05", to: "2026-07-07" },
        { from: "2026-07-09", to: "2026-07-11" },
      ],
      lostTo: { unverified: 3, gap: 3, gone: 0 },
      // Jul 8 and Jul 12 – 14 stay verified, at the readings' figures
      rebasedDays: 4,
      daysLeft: 15,
      changedDays: 15,
      curveUnchanged: false,
    });
  });

  /**
   * 🔴 "This balance pins no day … that another balance does not already pin" of
   * a balance that alone set four verified days at $120.00.
   */
  test("B6 a balance above a quiet statement un-verifies nothing, but re-bases the verified days it set", () => {
    const today = "2026-07-08";
    const anchors = [
      anchor("s-jul", "2026-07-01", 10_000, "statement"),
      anchor("manual", "2026-07-05", 12_000, "manual"),
    ];

    const rows = deriveDailyRows(pickWinners(anchors), new Map(), cash(today));
    expect(rows.find((r) => r.day === "2026-07-06")).toEqual({ day: "2026-07-06", balanceCents: 12_000, basis: "carried" });

    expect(removalEffect(anchors, "manual", new Map(), cash(today))).toEqual({
      ...NO_LOST_DAYS,
      rebasedDays: 4,
      daysLeft: 8,
      // Jul 2 – 4 gap → carried, Jul 5 – 8 $120.00 → $100.00
      changedDays: 7,
      curveUnchanged: false,
    });
  });

  /**
   * ⛔ Days that exist ONLY without the balance count as changed. Dropping that
   * half of the count left every service test green.
   */
  test("B7 bank exports before the only manual balance take the curve back further: the new rows are changes", () => {
    const today = "2026-06-12";
    const anchors = [
      anchor("ofx-1", "2026-06-01", 5_000, "ofx_ledger"),
      anchor("ofx-3", "2026-06-03", 5_000, "ofx_ledger"),
      anchor("manual", "2026-06-10", 5_000, "manual"),
    ];

    const rows = deriveDailyRows(pickWinners(anchors), new Map(), cash(today));
    expect(rows[0]?.day).toBe("2026-06-10");

    expect(removalEffect(anchors, "manual", new Map(), cash(today))).toEqual({
      ...NO_LOST_DAYS,
      rebasedDays: 0,
      daysLeft: 12,
      // Jun 1 – 9, and nothing that was already there
      changedDays: 9,
      curveUnchanged: false,
    });
  });

  test("an id that is not among the anchors is refused, never reported as harmless", () => {
    expect(() =>
      removalEffect([anchor("a", "2026-07-01", 1, "manual")], "missing", new Map(), cash("2026-07-02")),
    ).toThrow(/missing/);
  });
});

describe("integration: rebuild + net worth against a real database", () => {
  let dir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-deriv-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function institutionId(name: string): string {
    const row = bundle.db.select().from(institutions).where(eq(institutions.name, name)).get();
    if (!row) throw new Error(`missing institution ${name}`);
    return row.id;
  }

  test("accountSeries returns one account's covered days oldest-first", () => {
    const checking = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "Chase Checking",
      type: "checking",
    });
    const other = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "Chase Savings",
      type: "savings",
    });
    addManualAnchor(bundle.db, { accountId: checking, anchoredOn: "2026-07-07", enteredCents: 100_00 });
    addManualAnchor(bundle.db, { accountId: checking, anchoredOn: TODAY, enteredCents: 150_00 });
    addManualAnchor(bundle.db, { accountId: other, anchoredOn: TODAY, enteredCents: 999_00 });

    const series = accountSeries(bundle.db, checking);

    // anchored days first, then carried forward to the wall-clock today
    expect(series[0]).toEqual({ day: "2026-07-07", balanceCents: 100_00, basis: "anchored" });
    expect(series[1]).toEqual({ day: TODAY, balanceCents: 150_00, basis: "anchored" });
    for (const p of series.slice(2)) {
      expect(p.basis).toBe("carried");
      expect(p.balanceCents).toBe(150_00);
    }
    // the sibling account's balance never leaks in
    expect(series.some((p) => p.balanceCents === 999_00)).toBe(false);
  });

  test("net worth = assets − liabilities with credit stored negative", () => {
    const checking = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "Chase Checking",
      type: "checking",
    });
    const card = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "Chase Card",
      type: "credit",
    });

    addManualAnchor(bundle.db, { accountId: checking, anchoredOn: TODAY, enteredCents: 500_000 });
    // credit entered as positive amount owed → stored negative
    addManualAnchor(bundle.db, { accountId: card, anchoredOn: TODAY, enteredCents: 120_000 });

    const series = netWorthSeries(bundle.db);
    const today = series.find((p) => p.day === TODAY);
    expect(today?.totalCents).toBe(380_000);
    expect(today?.complete).toBe(true);

    const balances = latestBalances(bundle.db);
    expect(balances.get(card)?.balanceCents).toBe(-120_000);
  });

  test("partial days are annotated when one account lacks coverage", () => {
    const a = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "A",
      type: "checking",
    });
    const b = createAccount(bundle.db, {
      institutionId: institutionId("SoFi"),
      name: "B",
      type: "savings",
    });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: "2026-07-01", enteredCents: 100_000 });
    addManualAnchor(bundle.db, { accountId: b, anchoredOn: "2026-07-05", enteredCents: 50_000 });

    const series = netWorthSeries(bundle.db);
    const early = series.find((p) => p.day === "2026-07-02");
    const late = series.find((p) => p.day === "2026-07-06");
    expect(early?.complete).toBe(false);
    expect(early?.coveredAccounts).toBe(1);
    expect(early?.totalCents).toBe(100_000);
    // a partial day names EXACTLY which account is missing, not just the count
    expect(early?.missingAccounts).toEqual(["B"]);
    // ...and which it DOES cover, so the readout can say "only A"
    expect(early?.coveredAccountNames).toEqual(["A"]);
    expect(late?.complete).toBe(true);
    expect(late?.totalCents).toBe(150_000);
    expect(late?.missingAccounts).toEqual([]);
    expect(late?.coveredAccountNames).toEqual(["A", "B"]);
  });

  /**
   * 🔴 The regression that shipped. An account holding zero rows and zero
   * balances has no first-known day, so it could never be "covered" — and the
   * live dashboard therefore reported "no statement for Capital One 360
   * Checking on this date" in the WARNING tone on all 1,464 days of the series,
   * while ZERO of them could be `complete`.
   *
   * Nothing is missing from an account that has never held anything.
   */
  test("an account holding nothing does not make every day incomplete", () => {
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "Empty", type: "checking" });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: "2026-07-01", enteredCents: 100_000 });

    const day = netWorthSeries(bundle.db).find((p) => p.day === "2026-07-01")!;
    expect(day.complete).toBe(true);
    expect(day.gapAccounts).toEqual([]);
    expect(day.missingAccounts).toEqual([]);
    // named, so a surface CAN mention it — but never as a hole
    expect(day.emptyAccounts).toEqual(["Empty"]);
    // and it contributes nothing to the total
    expect(day.totalCents).toBe(100_000);
  });

  /**
   * ⛔ The other side of the line, which must not move: an account with ROWS but
   * no placeable balance is money the total cannot see, and stays a hole.
   */
  test("an account with rows but no balances is still a hole", () => {
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    const stranded = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "Stranded", type: "checking" });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: "2026-07-01", enteredCents: 100_000 });
    bundle.db
      .insert(transactions)
      .values({
        id: "stranded-1",
        accountId: stranded,
        importFileId: null,
        postedOn: "2026-07-01",
        amountCents: -2_500,
        rawDescription: "ROW",
        normalizedDescription: "ROW",
        status: "active",
        needsReview: false,
        occurrenceIndex: 0,
        dedupeHash: "stranded-hash",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    const day = netWorthSeries(bundle.db).find((p) => p.day === "2026-07-01")!;
    expect(day.gapAccounts).toEqual(["Stranded"]);
    expect(day.emptyAccounts).toEqual([]);
    expect(day.complete).toBe(false);
  });

  test("a fresher account's trailing days carry the others forward (net worth stays assets − liabilities)", () => {
    // regression for the "only Venture X" bug: one account's statement runs past the
    // others', so the tail must still sum ALL accounts (carried forward), not collapse
    // to the single fresh account.
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
    const put = (accountId: string, day: string, cents: number) =>
      bundle.db.insert(dailyBalances).values({ accountId, day, balanceCents: cents, basis: "carried" }).run();
    // A's data ends 2026-07-10; B's fresher statement runs to 2026-07-14
    for (const d of ["2026-07-08", "2026-07-09", "2026-07-10"]) put(a, d, 30_000);
    for (const d of ["2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13", "2026-07-14"])
      put(b, d, 80_000);

    const series = netWorthSeries(bundle.db);
    const tail = series.find((p) => p.day === "2026-07-14");
    expect(tail?.totalCents).toBe(110_000); // A (30k carried) + B (80k), NOT just 80k
    expect(tail?.complete).toBe(true);
    expect(tail?.coveredAccounts).toBe(2);
    expect(tail?.missingAccounts).toEqual([]);
    // and the whole tail is stable at the full sum
    for (const day of ["2026-07-11", "2026-07-12", "2026-07-13", "2026-07-14"]) {
      expect(series.find((p) => p.day === day)?.totalCents).toBe(110_000);
    }
  });

  test("rebuild replays active transactions and ignores quarantined ones", () => {
    const a = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "A",
      type: "checking",
    });
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: a, anchoredOn: "2026-07-01", balanceCents: 100_000, source: "statement" })
      .run();
    const mkTxn = (postedOn: string, amountCents: number, status: "active" | "quarantined") => ({
      accountId: a,
      postedOn,
      amountCents,
      rawDescription: `T-${postedOn}-${status}`,
      normalizedDescription: `T-${postedOn}-${status}`,
      status,
      dedupeHash: dedupeHash({
        accountId: a,
        postedOn,
        amountCents,
        rawDescription: `T-${postedOn}-${status}`,
        occurrenceIndex: 0,
      }),
    });
    bundle.db.insert(transactions).values(mkTxn("2026-07-03", -10_000, "active")).run();
    bundle.db.insert(transactions).values(mkTxn("2026-07-03", -99_999, "quarantined")).run();

    rebuildAccount(bundle.db, a, TODAY);
    const rows = bundle.db
      .select()
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, a))
      .all();
    const jul3 = rows.find((r) => r.day === "2026-07-03");
    expect(jul3?.balanceCents).toBe(90_000); // only the active txn replayed
  });

  test("an excluded transaction still replays — it is hidden from analytics, not from the balance", () => {
    const a = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "A",
      type: "checking",
    });
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: a, anchoredOn: "2026-07-01", balanceCents: 100_000, source: "statement" })
      .run();
    bundle.db
      .insert(transactions)
      .values({
        accountId: a,
        postedOn: "2026-07-03",
        amountCents: -10_000,
        rawDescription: "EXCLUDED BUT REAL",
        normalizedDescription: "EXCLUDED BUT REAL",
        status: "excluded",
        dedupeHash: dedupeHash({
          accountId: a,
          postedOn: "2026-07-03",
          amountCents: -10_000,
          rawDescription: "EXCLUDED BUT REAL",
          occurrenceIndex: 0,
        }),
      })
      .run();

    rebuildAccount(bundle.db, a, TODAY);

    const jul3 = bundle.db
      .select()
      .from(dailyBalances)
      .where(and(eq(dailyBalances.accountId, a), eq(dailyBalances.day, "2026-07-03")))
      .get();
    expect(jul3?.balanceCents).toBe(90_000);
  });

  test("anchor precedence end-to-end: statement supersedes manual on the same date", () => {
    const a = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "A",
      type: "checking",
    });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: "2026-07-01", enteredCents: 99_000 });
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: a, anchoredOn: "2026-07-01", balanceCents: 100_000, source: "statement" })
      .run();
    rebuildAccount(bundle.db, a, TODAY);

    const row = bundle.db
      .select()
      .from(dailyBalances)
      .where(eq(dailyBalances.accountId, a))
      .all()
      .find((r) => r.day === "2026-07-01");
    expect(row?.balanceCents).toBe(100_000);
  });

  test("a rogue out-of-window anchor fails the rebuild loudly, leaving the cache untouched", () => {
    const a = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "A",
      type: "checking",
    });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: "2026-07-01", enteredCents: 100_000 });
    const before = bundle.db.select().from(dailyBalances).where(eq(dailyBalances.accountId, a)).all();
    expect(before.length).toBeGreaterThan(0);

    // written straight to the table, the way an importer or a script could —
    // the schema guard never sees it, so the pure cap has to
    bundle.db
      .insert(balanceAnchors)
      .values({ accountId: a, anchoredOn: "1026-07-01", balanceCents: 0, source: "statement" })
      .run();

    expect(() => rebuildAccount(bundle.db, a, TODAY)).toThrow(DateOutOfRangeError);
    // the cap fires before rebuildAccount opens its delete/insert transaction
    expect(bundle.db.select().from(dailyBalances).where(eq(dailyBalances.accountId, a)).all()).toEqual(
      before,
    );
  });

  test("accounts.isActive=false leaves the net-worth series", () => {
    const a = createAccount(bundle.db, {
      institutionId: institutionId("Chase"),
      name: "A",
      type: "checking",
    });
    addManualAnchor(bundle.db, { accountId: a, anchoredOn: TODAY, enteredCents: 100_000 });
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, a)).run();
    expect(netWorthSeries(bundle.db)).toEqual([]);
  });
});
