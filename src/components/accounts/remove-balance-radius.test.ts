import { describe, expect, test } from "vitest";
import { blastRadiusSentence, type BlastRadius } from "@/components/ui/blast-radius";
import type { AnchorSource } from "@/db/schema/balances";
import { removalEffect, type ReplayAnchor } from "@/services/derivation";
import { removeBalanceRadius } from "./remove-balance-radius";

/**
 * ⛔ Not reachable from the e2e suite: the dialog lives inside a closed
 * `<dialog>`, and no spec opens it. Every sentence is pinned here instead, over
 * effects `removalEffect` DERIVES from a fixture — never a hand-built effect, so
 * a copy branch cannot be tested against a shape the derivation never produces.
 */

const anchor = (id: string, anchoredOn: string, balanceCents: number, source: AnchorSource): ReplayAnchor => ({
  id,
  anchoredOn,
  balanceCents,
  source,
});

interface DialogOptions {
  isInvestment?: boolean;
  /** stored-cache staleness, measured by services/anchors — see its tests */
  catchUpDays?: number;
}

function dialog(
  accountName: string,
  anchors: readonly ReplayAnchor[],
  removedId: string,
  txns: readonly [string, number][],
  today: string,
  { isInvestment = false, catchUpDays = 0 }: DialogOptions = {},
): BlastRadius {
  const effect = removalEffect(anchors, removedId, new Map(txns), { isInvestment, today });
  return removeBalanceRadius({
    accountName,
    effect: { pricedFromHoldings: false, isInvestment, catchUpDays, ...effect },
    recorded: { label: "Balance", value: "$1.00" },
    balancesLeft: anchors.length - 1,
  });
}

const valueOf = (radius: BlastRadius, label: string) => radius.lines?.find((l) => l.label === label)?.value;
const DAYS_LOST = "Days that stop being verified";
const DAYS_COUNTED = "Days that lose the balance you counted";
const VALUE_LOST = "Days that lose their balance";
const CATCH_UP = "Days rebuilt up to today, with or without this balance";

describe("removeBalanceRadius — the lost days, by what becomes of them", () => {
  /**
   * 🔴 THE KNOWN UNTRUE SENTENCE. Measured 2026-09-14 on the owner's ledger, Cash on
   * Hand's one balance (manual $5,000.00 on Aug 3, the $5,000.00 car down payment
   * posted Aug 11): 43 rows before, 0 after, yet the dialog read "Removing it
   * leaves those days to be derived from transactions alone" and "the balance
   * curve is derived, so it rebuilds from what is left".
   */
  test("the account's ONLY balance: no day is left, so nothing is said to be derived or rebuilt (Cash on Hand)", () => {
    const radius = dialog(
      "Cash on Hand",
      [anchor("opening", "2026-08-03", 500_000, "manual")],
      "opening",
      [["2026-08-11", -500_000]],
      "2026-09-14",
      { catchUpDays: 34 },
    );

    /*
     * 🔴 …and "verifies" was false of it too. That balance is one he typed, and
     * nothing is replayed onto it: the balance popover on the same page calls Aug
     * 3 and Aug 5 "you entered it" with no checked-through date (measured
     * 2026-09-16 on a copy of the real ledger, where this dialog still read
     * "This balance is what verifies Cash on Hand on Aug 3 – 10, 2026").
     */
    expect(radius.headline).toBe(
      "Cash on Hand rests on this balance on Aug 3 – 10, 2026. It is the only balance Cash on Hand has, so removing it leaves nothing to derive a curve from, and every day comes off it.",
    );
    expect(valueOf(radius, DAYS_COUNTED)).toBe("8 days");
    expect(valueOf(radius, DAYS_LOST)).toBeUndefined();
    expect(blastRadiusSentence(radius)).not.toMatch(/verif/);
    // a curve that goes away is not "brought up to today"
    expect(valueOf(radius, CATCH_UP)).toBeUndefined();
    expect(valueOf(radius, "Recorded balances left on this account")).toBe("no balances");
    expect(radius.reassurance).toBe(
      "No transaction is touched. Record a balance again and the curve is derived from it and the transactions.",
    );
    expect(blastRadiusSentence(radius)).not.toMatch(/derived from transactions alone|rebuilds from what is left/);
  });

  test("days a later balance still reaches keep the owner's wording, over the window they fill", () => {
    const radius = dialog(
      "Checking",
      [anchor("s-jul", "2026-07-01", 10_000, "statement"), anchor("manual", "2026-07-10", 8_000, "manual")],
      "manual",
      [["2026-07-05", -2_000]],
      "2026-07-12",
    );

    expect(radius.headline).toBe(
      "This balance is what verifies Checking on Jul 5 – 12, 2026. Removing it leaves those days to be derived from transactions alone.",
    );
    expect(radius.reassurance).toMatch(/Record the balance again to re-verify these days\.$/);
  });

  test("ONE lost day is that day, on its date", () => {
    const today = "2026-07-06";
    const radius = dialog(
      "Checking",
      [anchor("s-jul", "2026-07-01", 10_000, "statement"), anchor("live", today, 9_000, "live")],
      "live",
      [["2026-07-03", -1_000]],
      today,
    );

    expect(radius.headline).toBe(
      "This balance is what verifies Checking on Jul 6, 2026. Removing it leaves that day to be derived from transactions alone.",
    );
    expect(valueOf(radius, DAYS_LOST)).toBe("1 day");
  });

  /** removing the FIRST balance when the first transaction posts after it */
  test("days that lose their balance outright are told apart from days left to transactions", () => {
    const radius = dialog(
      "Checking",
      [anchor("manual", "2026-07-01", 10_000, "manual"), anchor("s-jul", "2026-07-10", 8_000, "statement")],
      "manual",
      [["2026-07-05", -2_000]],
      "2026-07-12",
    );

    /*
     * ⛔ Jul 1 is his count and nothing reaches it, so removing it un-verifies
     * only the eight days the statement's replay closed; the ninth loses his
     * count. Each line says what it counts.
     */
    expect(radius.headline).toBe(
      "Checking rests on this balance on Jul 1 – 9, 2026, and it verifies 8 days of them. Removing it leaves 6 days to be derived from transactions alone and 3 days with no balance at all.",
    );
    expect(valueOf(radius, DAYS_LOST)).toBe("8 days");
    expect(valueOf(radius, DAYS_COUNTED)).toBe("1 day");
    expect(radius.reassurance).toMatch(/Record the balance again to re-verify these days\.$/);
  });

  test("a second count he typed, joined to the first by his own row: every lost day was his count's", () => {
    const radius = dialog(
      "Cash on Hand",
      [anchor("opening", "2026-08-03", 500_000, "manual"), anchor("recount", "2026-08-12", 0, "manual")],
      "recount",
      [["2026-08-11", -500_000]],
      "2026-09-16",
    );

    expect(radius.headline).toBe(
      "Cash on Hand rests on this balance on Aug 11 – Sep 16, 2026. Removing it leaves those days to be derived from transactions alone.",
    );
    expect(valueOf(radius, DAYS_COUNTED)).toBe("37 days");
    expect(valueOf(radius, DAYS_LOST)).toBeUndefined();
    expect(radius.reassurance).toBe(
      "No transaction is touched — the balance curve is derived, so it rebuilds from what is left. Record the balance again to restore these days.",
    );
  });

  test("a count a statement's replay lands on keeps the verified words", () => {
    const radius = dialog(
      "Checking",
      [anchor("s-jul", "2026-07-31", 10_000, "statement"), anchor("manual", "2026-08-03", 8_000, "manual")],
      "manual",
      [["2026-08-01", -2_000]],
      "2026-08-05",
    );

    expect(radius.headline).toMatch(/^This balance is what verifies Checking on /);
    expect(valueOf(radius, DAYS_COUNTED)).toBeUndefined();
  });

  /**
   * investment derivation never replays transactions, so nothing is derived from them
   *
   * 🔴 …and nothing on it is verified either. `accountCoverage` grades every
   * investment account `market_value`, the balance chart on the same page draws a
   * carried price dashed (`balanceDayIsExact`), and the provenance headline says
   * "no transaction arithmetic checks it" — while this dialog read "This balance
   * is what verifies Bare holding on Jul 1 – 4, 2026" and "Days that stop being
   * verified: 4 days".
   */
  test("an investment account's first balance: those days lose their balance, and none was ever verified", () => {
    const radius = dialog(
      "Bare holding",
      [anchor("manual", "2026-07-01", 10_000, "manual"), anchor("s-jul", "2026-07-05", 12_000, "statement")],
      "manual",
      [],
      "2026-07-08",
      { isInvestment: true },
    );

    expect(radius.headline).toBe(
      "This balance alone sets Bare holding's value on Jul 1 – 4, 2026. Removing it leaves those days with no balance at all.",
    );
    expect(valueOf(radius, VALUE_LOST)).toBe("4 days");
    expect(valueOf(radius, DAYS_LOST)).toBeUndefined();
    expect(radius.reassurance).toBe(
      "No transaction is touched — the balance curve is derived, so it rebuilds from what is left. Record the balance again to restore these days.",
    );
    expect(blastRadiusSentence(radius)).not.toMatch(/verif|derived from transactions/i);
  });

  test("a middle balance that closes two spans: without it the days are a gap, not derived", () => {
    const radius = dialog(
      "Checking",
      [
        anchor("s1", "2026-07-01", 10_000, "statement"),
        anchor("manual", "2026-07-10", 9_000, "manual"),
        anchor("s2", "2026-07-20", 5_000, "statement"),
      ],
      "manual",
      [
        ["2026-07-05", -1_000],
        ["2026-07-15", -1_000],
      ],
      "2026-07-22",
    );

    expect(radius.headline).toBe(
      "This balance is what verifies Checking on Jul 2 – 10, 2026. Removing it leaves those days as a gap: the balances either side no longer agree with the transactions between them.",
    );
  });

  /**
   * 🔴 The window was first-to-last lost day: "Jun 7 – 26, 2026" is 20 days, the
   * count line read 19, and Jun 8 stays verified by the bank export that takes
   * over the curve.
   */
  test("lost days with a verified day between them: a count within the window, equal to the count line", () => {
    const radius = dialog(
      "Checking",
      [
        anchor("manual", "2026-06-07", 0, "manual"),
        anchor("ofx-8", "2026-06-08", 0, "ofx_ledger"),
        anchor("ofx-27", "2026-06-27", 2_000, "ofx_ledger"),
      ],
      "manual",
      [],
      "2026-07-02",
    );

    /*
     * ⛔ While his $0.00 exists it is the only replay endpoint — the exports are
     * moments — so the 19 days, and the 6 it re-bases, stand on his count: the
     * balance popover calls them "you entered it", and the dialog agrees.
     */
    expect(radius.headline).toBe(
      "Checking rests on this balance on 19 days within Jun 7 – 26, 2026. Removing it leaves 18 days as a gap and 1 day with no balance at all. It also sets the balance on 6 other days.",
    );
    expect(valueOf(radius, DAYS_COUNTED)).toBe("19 days");
    expect(valueOf(radius, DAYS_LOST)).toBeUndefined();
  });

  test("live readings that take over: two runs, two fates, and the days they re-base off his count", () => {
    const radius = dialog(
      "Checking",
      [
        anchor("manual", "2026-07-05", 10_000, "manual"),
        anchor("live-8", "2026-07-08", 12_000, "live"),
        anchor("live-12", "2026-07-12", 13_000, "live"),
      ],
      "manual",
      [["2026-07-01", 10_000]],
      "2026-07-14",
    );

    expect(radius.headline).toBe(
      "Checking rests on this balance on 6 days within Jul 5 – 11, 2026. Removing it leaves 3 days to be derived from transactions alone and 3 days as a gap. It also sets the balance on 4 other days.",
    );
    expect(valueOf(radius, DAYS_COUNTED)).toBe("6 days");
  });
});

/**
 * ⛔ On an investment account with no holdings the curve is its recorded
 * balances held flat: a VALUE, never a verification. Every branch the dialog can
 * take there says what the balance sets, and not one says "verified".
 */
describe("removeBalanceRadius — an investment account's balances are values, never verification", () => {
  const investment = { isInvestment: true };

  test("a middle balance: no day loses its balance, and the days it sets are not called verified", () => {
    const radius = dialog(
      "Bare holding",
      [
        anchor("s-jun", "2026-06-30", 8_900_000, "statement"),
        anchor("manual", "2026-07-03", 9_000_000, "manual"),
        anchor("s-jul", "2026-07-06", 9_100_000, "statement"),
      ],
      "manual",
      [],
      "2026-07-08",
      investment,
    );

    expect(radius.headline).toBe(
      "No day of Bare holding loses its balance without this one, but it sets the balance on 3 days, so removing it re-derives 3 days from the balances around it.",
    );
    expect(valueOf(radius, VALUE_LOST)).toBe("no days");
    expect(radius.reassurance).toBe(
      "No transaction is touched — the balance curve is derived, so it rebuilds from what is left.",
    );
    expect(blastRadiusSentence(radius)).not.toMatch(/verif/i);
  });

  test("the only chain-grade balance hands the curve to a live reading: the days it re-bases are not called verified", () => {
    const radius = dialog(
      "Bare holding",
      [anchor("manual", "2026-07-01", 10_000, "manual"), anchor("live", "2026-07-03", 12_000, "live")],
      "manual",
      [],
      "2026-07-06",
      investment,
    );

    expect(radius.headline).toBe(
      "This balance alone sets Bare holding's value on Jul 1 – 2, 2026. Removing it leaves those days with no balance at all. It also sets the balance on 4 other days.",
    );
    expect(blastRadiusSentence(radius)).not.toMatch(/verif/i);
  });

  test("a balance a same-day statement outranks: every day keeps its balance, and nothing is said of verification", () => {
    const radius = dialog(
      "Bare holding",
      [anchor("s-jul", "2026-07-01", 10_000, "statement"), anchor("manual", "2026-07-01", 12_000, "manual")],
      "manual",
      [],
      "2026-07-08",
      investment,
    );

    expect(radius.headline).toBe(
      "This balance pins no day of Bare holding that another balance does not already pin. Without it, every day keeps the same balance.",
    );
    expect(blastRadiusSentence(radius)).not.toMatch(/verif/i);
  });

  test("the account's only balance: every day comes off, and no curve is promised from transactions", () => {
    const radius = dialog(
      "Bare holding",
      [anchor("opening", "2026-07-01", 10_000, "manual")],
      "opening",
      [],
      "2026-07-04",
      investment,
    );

    expect(radius.headline).toBe(
      "This balance alone sets Bare holding's value on Jul 1 – 4, 2026. It is the only balance Bare holding has, so removing it leaves nothing to derive a curve from, and every day comes off it.",
    );
    expect(valueOf(radius, VALUE_LOST)).toBe("4 days");
    expect(radius.reassurance).toBe("No transaction is touched. Record a balance again and the curve is derived from it.");
    expect(blastRadiusSentence(radius)).not.toMatch(/verif|and the transactions/i);
  });
});

describe("removeBalanceRadius — a balance that un-verifies nothing", () => {
  const robinhoodCash = (catchUpDays: number) =>
    dialog(
      "Robinhood Cash",
      [
        anchor("s-jun", "2026-06-30", 19_229, "statement"),
        anchor("live", "2026-07-10", 723_565, "live"),
        anchor("s-jul", "2026-07-31", 168_038, "statement"),
      ],
      "live",
      [
        ["2026-07-05", 700_000],
        ["2026-07-20", -551_191],
      ],
      "2026-08-02",
      { catchUpDays },
    );

  /**
   * 🔴 "Removing it leaves the curve exactly as it is" — while the stored curve
   * ended 2026-08-28 and confirming rebuilt it through 2026-09-14: 17 days the
   * owner saw appear. The headline claims only what the balance does, and the
   * catch-up is a line of its own.
   */
  test("promises nothing about the drawn curve, and names the rebuild's catch-up (Robinhood Cash)", () => {
    const radius = robinhoodCash(17);

    expect(radius.headline).toBe(
      "This balance pins no day of Robinhood Cash that another balance does not already pin. Without it, every day keeps the same balance and the same verification.",
    );
    expect(valueOf(radius, CATCH_UP)).toBe("17 days");
    expect(blastRadiusSentence(radius)).not.toMatch(/exactly as it is/);
  });

  test("a current cache has no catch-up line", () => {
    expect(valueOf(robinhoodCash(0), CATCH_UP)).toBeUndefined();
  });

  /** 🔴 "Record the balance again to re-verify these days" under "no days" */
  test("the reassurance promises no re-verification when no day stops being verified", () => {
    const radius = robinhoodCash(0);

    expect(valueOf(radius, DAYS_LOST)).toBe("no days");
    expect(radius.reassurance).toBe(
      "No transaction is touched — the balance curve is derived, so it rebuilds from what is left.",
    );
  });

  /**
   * 🔴 "This balance pins no day … that another balance does not already pin"
   * over a manual $120.00 recorded above a quiet $100.00 statement: it alone set
   * Jul 5 – 8 at $120.00, and those four verified days drop to $100.00 without it.
   */
  test("verified days that re-base without it are not called pinned by another balance", () => {
    const radius = dialog(
      "Checking",
      [anchor("s-jul", "2026-07-01", 10_000, "statement"), anchor("manual", "2026-07-05", 12_000, "manual")],
      "manual",
      [],
      "2026-07-08",
    );

    expect(radius.headline).toBe(
      "No day of Checking stops being verified without this balance, but it sets the balance on 4 verified days, so removing it re-derives 7 days from the balances around it.",
    );
    expect(radius.headline).not.toMatch(/does not already pin/);
  });

  /** the owner's wording: nothing un-verified, but the curve changes → it re-derives N days */
  test("days the other balances derive differently keep the owner's 're-derives N days'", () => {
    const radius = dialog(
      "Checking",
      [
        anchor("ofx-1", "2026-06-01", 5_000, "ofx_ledger"),
        anchor("ofx-3", "2026-06-03", 5_000, "ofx_ledger"),
        anchor("manual", "2026-06-10", 5_000, "manual"),
      ],
      "manual",
      [],
      "2026-06-12",
    );

    expect(radius.headline).toBe(
      "This balance pins no day of Checking that another balance does not already pin, but removing it re-derives 9 days from the balances around it.",
    );
  });

  test("an account priced from holdings: no claim about its curve, and no catch-up it cannot measure", () => {
    const radius = removeBalanceRadius({
      accountName: "Robinhood Brokerage",
      effect: { pricedFromHoldings: true },
      recorded: { label: "Balance", value: "$1.00" },
      balancesLeft: 3,
    });

    expect(radius.headline).toBe(
      "Robinhood Brokerage is priced from its holdings, so this recorded balance verifies nothing and plays no part in its curve.",
    );
    expect(valueOf(radius, DAYS_LOST)).toBe("none — the curve comes from holdings");
    expect(valueOf(radius, CATCH_UP)).toBeUndefined();
    expect(blastRadiusSentence(radius)).not.toMatch(/exactly as it is/);
  });

  test("the recorded balance is the one irreversible line, first", () => {
    const radius = robinhoodCash(17);

    expect(radius.lines?.map((l) => [l.label, l.irreversible === true])).toEqual([
      ["Balance, as recorded", true],
      [DAYS_LOST, false],
      [CATCH_UP, false],
      ["Recorded balances left on this account", false],
    ]);
  });
});
