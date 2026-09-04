import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sparklineGeometry } from "@/lib/sparkline";
import {
  AccountsTable,
  buildAccountsTable,
  directionOf,
  sparkValueY,
  type AccountsTableAccount,
} from "./AccountsTable";

/**
 * The accounts table's arithmetic. The rule these encode: the footer is the sum
 * of a column the table actually PRINTS — never a second computation of net
 * worth — and every figure stays in the ledger's net-worth frame, so a card
 * paid down reads as a gain.
 */

function account(over: Partial<AccountsTableAccount> & { id: string }): AccountsTableAccount {
  return {
    name: over.id,
    institution: "Bank",
    meta: null,
    isLiability: false,
    balanceCents: null,
    asOf: null,
    spark: [],
    unreviewedCount: 0,
    ...over,
  };
}

/** a covered window: oldest → newest, net-worth convention */
function spark(...pairs: [string, number][]): { day: string; cents: number }[] {
  return pairs.map(([day, cents]) => ({ day, cents }));
}

describe("buildAccountsTable", () => {
  it("returns empty totals for no accounts", () => {
    expect(buildAccountsTable([])).toEqual({
      held: [],
      owed: [],
      heldShareBaseCents: 0,
      owedShareBaseCents: 0,
      heldTotalCents: 0,
      owedTotalCents: 0,
      netCents: 0,
      netDeltaCents: null,
      asOf: null,
    });
  });

  it("splits held from owed and preserves the caller's order inside each side", () => {
    const model = buildAccountsTable([
      account({ id: "checking", balanceCents: 1_000 }),
      account({ id: "card", isLiability: true, balanceCents: -400 }),
      account({ id: "savings", balanceCents: 2_000 }),
    ]);
    expect(model.held.map((r) => r.id)).toEqual(["checking", "savings"]);
    expect(model.owed.map((r) => r.id)).toEqual(["card"]);
  });

  it("totals each side from the printed balances and nets them", () => {
    const model = buildAccountsTable([
      account({ id: "checking", balanceCents: 11_203_251 }),
      account({ id: "card", isLiability: true, balanceCents: -141_469 }),
    ]);
    expect(model.heldTotalCents).toBe(11_203_251);
    expect(model.owedTotalCents).toBe(-141_469);
    expect(model.netCents).toBe(11_203_251 - 141_469);
  });

  it("counts an account with no derived balance as nothing, not as a hole", () => {
    const model = buildAccountsTable([
      account({ id: "checking", balanceCents: 5_000 }),
      account({ id: "fresh", balanceCents: null }),
    ]);
    expect(model.heldTotalCents).toBe(5_000);
    expect(model.held[1]!.balanceCents).toBeNull();
    // …and it takes no share either: a refused balance cannot yield a measured
    // 0.0%, which is what the Share cell used to print beside "no balance"
    expect(model.held[1]!.sharePct).toBeNull();
  });

  it("measures the change as last minus first across the covered window", () => {
    const model = buildAccountsTable([
      account({
        id: "checking",
        balanceCents: 1_500,
        spark: spark(["2026-06-27", 1_000], ["2026-07-01", 1_200], ["2026-07-27", 1_500]),
      }),
    ]);
    const row = model.held[0]!;
    expect(row.deltaCents).toBe(500);
    expect(row.startCents).toBe(1_000);
    expect(row.windowFrom).toBe("2026-06-27");
    expect(row.windowTo).toBe("2026-07-27");
    expect(row.windowDays).toBe(3);
    expect(row.highCents).toBe(1_500);
    expect(row.lowCents).toBe(1_000);
    expect(row.deltaPct).toBe(50);
  });

  it("reports no change when the window has fewer than two covered days", () => {
    const model = buildAccountsTable([
      account({ id: "one", balanceCents: 900, spark: spark(["2026-07-27", 900]) }),
      account({ id: "none", balanceCents: 900 }),
    ]);
    expect(model.held[0]!.deltaCents).toBeNull();
    expect(model.held[0]!.deltaPct).toBeNull();
    expect(model.held[1]!.deltaCents).toBeNull();
    expect(model.netDeltaCents).toBeNull();
  });

  it("signs a paid-down card as a GAIN — the whole table is in the net-worth frame", () => {
    const model = buildAccountsTable([
      account({
        id: "card",
        isLiability: true,
        balanceCents: -50_000,
        spark: spark(["2026-06-27", -120_000], ["2026-07-27", -50_000]),
      }),
    ]);
    const row = model.owed[0]!;
    expect(row.deltaCents).toBe(70_000);
    expect(directionOf(row.deltaCents)).toBe("up");
    // percentage is measured against the SIZE of the starting balance
    expect(row.deltaPct).toBe(58.3);
  });

  it("leaves the percentage unstated rather than dividing by a zero start", () => {
    const model = buildAccountsTable([
      account({ id: "opened", balanceCents: 2_500, spark: spark(["2026-07-01", 0], ["2026-07-27", 2_500]) }),
    ]);
    expect(model.held[0]!.deltaCents).toBe(2_500);
    expect(model.held[0]!.deltaPct).toBeNull();
  });

  it("never reports a signed zero percentage", () => {
    const model = buildAccountsTable([
      account({
        id: "drift",
        balanceCents: 999_999,
        spark: spark(["2026-07-01", 1_000_000], ["2026-07-27", 999_999]),
      }),
    ]);
    expect(Object.is(model.held[0]!.deltaPct, -0)).toBe(false);
    expect(model.held[0]!.deltaPct).toBe(0);
  });

  it("shares each side by size, so a side's column sums to 100%", () => {
    const model = buildAccountsTable([
      account({ id: "a", balanceCents: 7_500 }),
      account({ id: "b", balanceCents: 2_500 }),
      account({ id: "card", isLiability: true, balanceCents: -400 }),
    ]);
    expect(model.held.map((r) => r.sharePct)).toEqual([75, 25]);
    expect(model.owed[0]!.sharePct).toBe(100);
  });

  /*
   * 🔴 This asserted `[90, 10]` — the absolute-value rule, which gave an
   * OVERDRAWN account a tenth of "held". It holds nothing; it is a debt sitting
   * on the asset side, the mirror of the card in credit that took 8.2% "of
   * owed" on the owner's real ledger. `lib/side-magnitude` refuses both, and
   * the 0–100 guarantee this test was written for still holds: the denominator
   * is now the side's own money, which no row can exceed.
   */
  it("an overdrawn asset account takes no share of what is held", () => {
    const model = buildAccountsTable([
      account({ id: "savings", balanceCents: 9_000 }),
      account({ id: "overdrawn", balanceCents: -1_000 }),
    ]);
    // the side's NET is still 8,000 — the total is what the column adds up to
    expect(model.heldTotalCents).toBe(8_000);
    expect(model.held.map((r) => r.sharePct)).toEqual([100, 0]);
  });

  /*
   * ⛔ THE MEASURED CASE. Chase Sapphire closed 2026-09-02 at $82.72 in credit;
   * the table read "55.3% of owed" for Discover and "8.2% of owed" for the card
   * in credit, while /accounts/<Discover> read 60.2% of the same debt on the
   * same day. Both numbers were on the owner's screen.
   */
  it("an account with no balance takes no share and is not mistaken for a credit", () => {
    const model = buildAccountsTable([
      account({ id: "funded", balanceCents: 5_000 }),
      account({ id: "empty", balanceCents: null }),
    ]);
    expect(model.held.map((r) => r.sharePct)).toEqual([100, null]);
    expect(model.held[1]!.balanceCents).toBeNull();
  });

  it("a card in credit takes no slice of the debt, and the others share what is owed", () => {
    const model = buildAccountsTable([
      account({ id: "discover", isLiability: true, balanceCents: -55_762 }),
      account({ id: "venture", isLiability: true, balanceCents: -36_799 }),
      account({ id: "sapphire", isLiability: true, balanceCents: 8_272 }),
    ]);
    expect(model.owed.map((r) => r.sharePct)).toEqual([60.2, 39.8, 0]);
    // and the total stays the NET the footer prints — the slices are of the
    // gross, the total is of the type, and they are different questions
    expect(model.owedTotalCents).toBe(-84_289);
  });

  it("totals the change column exactly as printed, skipping rows that have none", () => {
    const model = buildAccountsTable([
      account({ id: "a", balanceCents: 1_500, spark: spark(["2026-06-27", 1_000], ["2026-07-27", 1_500]) }),
      account({
        id: "card",
        isLiability: true,
        balanceCents: -200,
        spark: spark(["2026-06-27", -300], ["2026-07-27", -200]),
      }),
      account({ id: "quiet", balanceCents: 10 }),
    ]);
    expect(model.netDeltaCents).toBe(500 + 100);
  });

  it("reports the latest day any listed account is covered to", () => {
    const model = buildAccountsTable([
      account({ id: "a", asOf: "2026-07-20" }),
      account({ id: "b", asOf: "2026-07-27" }),
      account({ id: "c", asOf: null }),
    ]);
    expect(model.asOf).toBe("2026-07-27");
  });
});

describe("directionOf", () => {
  it("separates a gain, a loss, no movement, and no reading at all", () => {
    expect(directionOf(1)).toBe("up");
    expect(directionOf(-1)).toBe("down");
    expect(directionOf(0)).toBe("flat");
    expect(directionOf(null)).toBe("unknown");
  });
});

describe("sparkValueY", () => {
  /**
   * The drift pin: lib/sparkline only exposes the LAST point's y, and the row's
   * dashed "where it stood then" rule needs the FIRST point's. Feeding a series
   * whose first and last values are equal makes the lib state the answer, so any
   * divergence between the two mappings fails here instead of misdrawing.
   */
  it("agrees with sparklineGeometry's own y mapping", () => {
    const values = [1_000, 4_200, 900, 1_000];
    const geo = sparklineGeometry(values, 100, 28, 3)!;
    expect(sparkValueY(values, values[0]!, 28, 3)).toBe(geo.lastY);
  });

  it("agrees with the lib at another viewBox and padding", () => {
    const values = [-500, 250, -500];
    const geo = sparklineGeometry(values, 240, 30, 2)!;
    expect(sparkValueY(values, values[0]!, 30, 2)).toBe(geo.lastY);
  });

  it("puts a flat series on the midline instead of dividing by a zero span", () => {
    expect(sparkValueY([7, 7, 7], 7, 28, 3)).toBe(14);
  });

  it("pins the maximum to the top padding and the minimum to the bottom", () => {
    expect(sparkValueY([0, 100], 100, 28, 3)).toBe(3);
    expect(sparkValueY([0, 100], 0, 28, 3)).toBe(25);
  });

  it("falls back to the midline when there is nothing to map", () => {
    expect(sparkValueY([], 0, 28, 3)).toBe(14);
  });
});

/**
 * A real render, not a markup assertion for its own sake: `tsc` cannot see a
 * cell that reads a null balance, a link built from the wrong helper, or a
 * figure that renders "NaN" — only rendering can. Three rows cover the three
 * shapes a real ledger produces: an asset that moved, a card that was paid
 * down, and an account with no derived balance at all.
 */
describe("AccountsTable, rendered", () => {
  const html = renderToStaticMarkup(
    createElement(AccountsTable, {
      accounts: [
        account({
          id: "a1",
          name: "Chase Checking",
          institution: "Chase",
          meta: "Checking · ····1234",
          balanceCents: 150_000,
          asOf: "2026-07-27",
          spark: spark(["2026-06-27", 100_000], ["2026-07-10", 90_000], ["2026-07-27", 150_000]),
          unreviewedCount: 2,
        }),
        account({
          id: "c1",
          name: "Chase Sapphire",
          institution: "Chase",
          meta: "Credit card",
          isLiability: true,
          balanceCents: -40_000,
          asOf: "2026-07-27",
          spark: spark(["2026-06-27", -60_000], ["2026-07-27", -40_000]),
        }),
        account({ id: "n1", name: "New Account", institution: "Ally" }),
      ],
      cashWalletNote: "Cash wallets ($20.00) keep their own card below.",
    }),
  );

  it("never prints a broken figure", () => {
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  it("groups the sides and totals them to the net of the printed column", () => {
    expect(html).toContain(">Held<");
    expect(html).toContain(">Owed<");
    expect(html).toContain("$1,500.00"); // held
    expect(html).toContain("-$400.00"); // owed, in the net-worth frame
    expect(html).toContain("$1,100.00"); // net
    expect(html).toContain("+$700.00"); // the change column, added up
  });

  it("reads a paid-down card as a gain, with a glyph and a sign beside the colour", () => {
    expect(html).toContain("+$200.00");
    expect(html).toContain("▲");
  });

  it("sends the name to the ledger and the balance to the account's own history", () => {
    expect(html).toContain('href="/transactions?account=a1"');
    expect(html).toContain('href="/accounts/a1"');
  });

  it("hides the sparkline from readers and restates its figures in words", () => {
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("The balance series, printed");
    expect(html).toContain("covered days");
    expect(html).toContain("high");
    expect(html).toContain("low");
  });

  it("states an account with no derived balance instead of printing a zero", () => {
    expect(html).toContain("no balance");
    expect(html).toContain("no balance history yet");
  });

  it("keeps the accounts a real table with scoped headers", () => {
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="rowgroup"');
    expect(html).toContain('scope="row"');
    expect(html).toContain("<caption");
  });

  it("says where the accounts it does NOT count are", () => {
    expect(html).toContain("Cash wallets ($20.00) keep their own card below.");
    expect(html).toContain("Archived accounts are left out.");
  });

  it("renders an empty set as a sentence, not an empty grid", () => {
    const empty = renderToStaticMarkup(createElement(AccountsTable, { accounts: [] }));
    expect(empty).toContain("No accounts yet");
    expect(empty).not.toContain("<table");
  });
});

describe("what a share is OF, and when there is no share to state", () => {
  /*
   * 🔴 The Owed group printed "-$842.89" while every slice under it divided by
   * $925.61 — the gross debt, with Chase Sapphire's $82.72 of credit netted out
   * of the total but not out of the base. Measured 2026-09-04: "39.8% of owed"
   * and "60.2% of owed" over a heading reading -$842.89, and 39.8% of $842.89
   * is $335.47, not the $367.99 printed two columns along.
   *
   * The dashboard's cards card already carries the missing sentence — "$82.72
   * of credit on Chase Sapphire is netted off, so each slice is of the $925.61
   * actually owed" — and this table did not. Same shape as the concentration
   * card: the qualifier existed and only some of the sentences carried it.
   */
  it("the owed side reports the base its shares are struck against", () => {
    const model = buildAccountsTable([
      account({ id: "discover", isLiability: true, balanceCents: -55_762 }),
      account({ id: "venture", isLiability: true, balanceCents: -36_799 }),
      account({ id: "sapphire", isLiability: true, balanceCents: 8_272 }),
    ]);
    expect(model.owedTotalCents).toBe(-84_289);
    expect(model.owedShareBaseCents).toBe(92_561);
  });

  it("with no card in credit the base IS the total, and there is nothing extra to say", () => {
    const model = buildAccountsTable([
      account({ id: "discover", isLiability: true, balanceCents: -55_762 }),
      account({ id: "venture", isLiability: true, balanceCents: -36_799 }),
    ]);
    expect(model.owedShareBaseCents).toBe(-model.owedTotalCents);
  });

  /*
   * 🔴 Capital One 360 Checking holds no rows, no anchor and no derived day. Its
   * Balance cell refuses ("no balance") and its Change cell refuses ("not yet"),
   * and between them the Share cell stated a measurement: "0.0% of held".
   */
  it("an account with NO balance takes no share rather than a measured zero", () => {
    const model = buildAccountsTable([
      account({ id: "chase", balanceCents: 300_760 }),
      account({ id: "capone", balanceCents: null }),
    ]);
    expect(model.held.find((r) => r.id === "capone")!.sharePct).toBeNull();
    expect(model.held.find((r) => r.id === "chase")!.sharePct).toBe(100);
  });

  it("a balance of exactly zero is a measurement, and keeps its 0.0%", () => {
    const model = buildAccountsTable([
      account({ id: "chase", balanceCents: 300_760 }),
      account({ id: "sofi", balanceCents: 0 }),
    ]);
    expect(model.held.find((r) => r.id === "sofi")!.sharePct).toBe(0);
  });
});
