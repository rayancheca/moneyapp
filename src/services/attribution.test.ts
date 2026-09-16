import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { priceCache } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import type { TransactionStatus } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "./accounts";
import { addManualAnchor } from "./anchors";
import { rebuildAccount, netWorthSeries } from "./derivation";
import { netWorthAttribution, nonReplayingAccountIds } from "./attribution";
import { upsertHolding } from "./holdings";
import { investmentAccounts } from "./portfolio";

let dir: string;
let bundle: DbBundle;
let chk: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-attrib-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const inst = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  chk = createAccount(bundle.db, { institutionId: inst.id, name: "Chk", type: "checking" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function catId(pathStr: string): string {
  const [parentName, subName] = pathStr.split(" > ");
  const parent = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get()!;
  if (!subName) return parent.id;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get()!.id;
}

let seq = 0;
function post(
  accountId: string,
  postedOn: string,
  amountCents: number,
  categoryPath: string | null,
  status: TransactionStatus = "active",
): void {
  seq += 1;
  const raw = `ROW ${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription: raw,
      normalizedDescription: raw,
      categoryId: categoryPath === null ? null : catId(categoryPath),
      status,
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: 0 }),
    })
    .run();
}

/** Net worth from the app's own chain, so the test never invents its own. */
function nwOn(day: string): number {
  const series = netWorthSeries(bundle.db);
  let cents = 0;
  for (const p of series) {
    if (p.day > day) break;
    cents = p.totalCents;
  }
  return cents;
}

function bridgeOver(from: string, to: string) {
  for (const a of bundle.db.select({ id: accounts.id }).from(accounts).all()) {
    rebuildAccount(bundle.db, a.id);
  }
  return netWorthAttribution(bundle.db, from, to, nwOn(from), nwOn(to));
}

describe("netWorthAttribution — the identity, on a ledger that can be checked by hand", () => {
  test("a window of pure spending closes to the cent", () => {
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    post(chk, "2026-06-10", -30_000, "Food");
    post(chk, "2026-06-20", -20_000, "Food");

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.deltaCents).toBe(-50_000);
    expect(got.bands.find((b) => b.key === "spent")!.cents).toBe(-50_000);
    expect(got.unexplainedCents).toBe(0);
    expect(got.closes).toBe(true);
  });

  test("the window is HALF-OPEN — a row on the opening day is already inside the opening balance", () => {
    /*
     * The convention mismatch this pins is real and expensive: balance replay
     * and ledger-check treat `from` as a baseline, while periodTotals and
     * activeTxnsInRange count it. Measured on the live ledger, the 2026-07-01
     * boundary day alone carries $1,454.90 — a bridge mixing the two misstates
     * the month by that much while reporting that it closed.
     */
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    post(chk, "2026-06-01", -11_111, "Food");
    post(chk, "2026-06-15", -20_000, "Food");

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.bands.find((b) => b.key === "spent")!.cents).toBe(-20_000);
    expect(got.closes).toBe(true);
  });

  test("an EXCLUDED row is counted, because the money still moved", () => {
    // Pass 59 found a fabricated plug hiding behind exactly this: `excluded`
    // removes a row from analytics and not from the balance chain. A bridge that
    // read status='active' would open a hole the size of every excluded row.
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    post(chk, "2026-06-10", -25_000, "Food", "excluded");

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.deltaCents).toBe(-25_000);
    expect(got.bands.find((b) => b.key === "spent")!.cents).toBe(-25_000);
    expect(got.closes).toBe(true);
  });

  test("a quarantined row is counted by neither side, so the window still closes", () => {
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    post(chk, "2026-06-10", -25_000, "Food", "quarantined");

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.deltaCents).toBe(0);
    expect(got.bands.every((b) => b.isZero)).toBe(true);
    expect(got.closes).toBe(true);
  });

  test("`moved` is a catch-all, never a `continue` — a transfer is shown, not dropped", () => {
    /*
     * periodTotals drops every kind it does not recognise, which is correct for
     * a spending tab and fatal here: measured over July–August it discards
     * $18,870.53 of transfer- and investment-kind rows, seven times that
     * window's entire net movement. A dropped row becomes phantom `unexplained`.
     */
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    post(chk, "2026-06-10", 40_000, "Transfers > Internal Transfer");
    post(chk, "2026-06-12", -5_000, "Investments");

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.bands.find((b) => b.key === "moved")!.cents).toBe(35_000);
    expect(got.closes).toBe(true);
  });

  test("an uncategorized row lands in `moved` rather than vanishing", () => {
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    post(chk, "2026-06-10", -7_777, null);

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.bands.find((b) => b.key === "moved")!.cents).toBe(-7_777);
    expect(got.closes).toBe(true);
  });

  test("income and its clawback are not netted into one band", () => {
    // A credit that returns money previously recorded as income is not negative
    // earnings — docs/income-ground-truth.md. `earned` counts money IN only.
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    post(chk, "2026-06-05", 200_000, "Income > Salary");
    post(chk, "2026-06-06", -50_000, "Income > Salary");

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.bands.find((b) => b.key === "earned")!.cents).toBe(200_000);
    expect(got.bands.find((b) => b.key === "moved")!.cents).toBe(-50_000);
    expect(got.closes).toBe(true);
  });

  test("a refund is money back, never money earned", () => {
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    post(chk, "2026-06-05", -30_000, "Food");
    post(chk, "2026-06-06", 4_000, "Food");

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.bands.find((b) => b.key === "spent")!.cents).toBe(-30_000);
    expect(got.bands.find((b) => b.key === "refunds")!.cents).toBe(4_000);
    expect(got.bands.find((b) => b.key === "earned")!.cents).toBe(0);
    expect(got.closes).toBe(true);
  });

  test("an anchor that restates a balance is NAMED, not left as a bare residual", () => {
    /*
     * The live case this models: a $5,000.00 manual anchor opening `Cash on
     * Hand`, the owner's untracked cash float. It is deliberate, it must not be
     * reconciled away, and a bridge that showed it as an unlabelled hole would
     * invite exactly that.
     */
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-15", enteredCents: 300_000 });

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.deltaCents).toBe(200_000);
    expect(got.unexplainedCents).toBe(200_000);
    expect(got.closes).toBe(false);
    // …but every cent of it has a name, which is a different statement
    expect(got.attributedCents).toBe(200_000);
    expect(got.unattributedCents).toBe(0);
    expect(got.restatements).toEqual([{ accountName: "Chk", cents: 200_000, reason: "anchor" }]);
  });

  test("the CLOSING edge is inclusive — a row on `to` is inside the window", () => {
    /*
     * The opening edge had a test and the closing edge did not: `lte(postedOn,
     * to)` could be weakened to `lt` and all thirteen tests stayed green. Both
     * bounds now have to be right, because both are read by two queries that
     * must agree — the transaction sum and `balanceAsOf`.
     */
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    post(chk, "2026-06-30", -12_345, "Food");

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.deltaCents).toBe(-12_345);
    expect(got.bands.find((b) => b.key === "spent")!.cents).toBe(-12_345);
    expect(got.closes).toBe(true);

    // and a day short of it excludes the row from BOTH sides, so it still closes
    const shorter = bridgeOver("2026-06-01", "2026-06-29");
    expect(shorter.deltaCents).toBe(0);
    expect(shorter.bands.find((b) => b.key === "spent")!.cents).toBe(0);
    expect(shorter.closes).toBe(true);
  });

  test("an ARCHIVED account is read by neither side, exactly as net worth reads it", () => {
    /*
     * Found in review. Every net-worth surface in the app is active-only —
     * `netWorthSeries` selects on `isActive`, `latestBridgedNetWorthCents` states
     * the rule outright — while this service read the whole accounts table. An
     * archived account's rows would then sit on one side of the identity and not
     * the other, and the bridge would report a hole it had invented itself.
     *
     * Every account on the real ledger is active, which is precisely why this
     * would have shipped green and failed the first time one was archived.
     */
    const inst = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const old = createAccount(bundle.db, { institutionId: inst.id, name: "Old", type: "checking" });
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    addManualAnchor(bundle.db, { accountId: old, anchoredOn: "2026-06-01", enteredCents: 900_000 });
    post(old, "2026-06-10", -80_000, "Food");
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, old)).run();

    const got = bridgeOver("2026-06-01", "2026-06-30");
    expect(got.deltaCents).toBe(0);
    expect(got.bands.find((b) => b.key === "spent")!.cents).toBe(0);
    expect(got.unexplainedCents).toBe(0);
    expect(got.closes).toBe(true);
  });

  test("an account entering coverage inside the window IS an anchor restatement", () => {
    /*
     * There is no second branch here, and that is measured rather than assumed:
     * a replaying account's balance is derived from its anchors plus its rows, so
     * a residual always coincides with an anchor inside the window — the first
     * anchor of a brand-new account included. A ternary falling back to
     * "opening" survived every mutation, because nothing can reach it.
     */
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    const inst = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const later = createAccount(bundle.db, { institutionId: inst.id, name: "Later", type: "checking" });
    addManualAnchor(bundle.db, { accountId: later, anchoredOn: "2026-06-20", enteredCents: 7_500 });

    const spanning = bridgeOver("2026-06-01", "2026-06-30");
    expect(spanning.restatements).toEqual([
      { accountName: "Later", cents: 7_500, reason: "anchor" },
    ]);
    expect(spanning.unexplainedCents).toBe(7_500);
    expect(spanning.unattributedCents).toBe(0);

    // a window opening after it sees a settled balance and no restatement at all
    expect(bridgeOver("2026-06-21", "2026-06-30").restatements).toEqual([]);
  });

  test("a window that runs backwards is refused rather than silently inverted", () => {
    expect(() => netWorthAttribution(bundle.db, "2026-06-30", "2026-06-01", 0, 0)).toThrow(
      /runs backwards/,
    );
  });

  test("a zero-length window is allowed and is flat", () => {
    addManualAnchor(bundle.db, { accountId: chk, anchoredOn: "2026-06-01", enteredCents: 100_000 });
    post(chk, "2026-06-10", -1_000, "Food");
    const got = bridgeOver("2026-06-15", "2026-06-15");
    expect(got.deltaCents).toBe(0);
    expect(got.closes).toBe(true);
  });
});

describe("nonReplayingAccountIds — the divider that stops a double-count", () => {
  test("EVERY investment account is non-replaying, with or without holding events", () => {
    /*
     * I first wrote this as "investment AND has holding events" and it was
     * wrong. Both paths an investment account can take end in a balance no
     * transaction moved: `rebuildInvestmentHistory` for one with events, and
     * value-anchor step-hold for one without — whose own comment reads "replay
     * never applies". On today's ledger the two dividers name the same two
     * accounts, so the mistake would have shipped green.
     *
     * ⛔ And it is the account TYPE, never `investmentSideAccountIds()`, which
     * includes the settlement-cash sibling — typed `checking`, replayed, and
     * carrying 1,989 rows worth −$55,659.37 on the real ledger.
     */
    const inst = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const bare = createAccount(bundle.db, {
      institutionId: inst.id,
      name: "Brokerage",
      type: "investment",
    });
    const ids = nonReplayingAccountIds(bundle.db);
    expect(ids.has(bare)).toBe(true);
    expect(ids.has(chk)).toBe(false);
  });

  test("a transaction on one moves no balance, so the bridge does not count it", () => {
    // The double-count this prevents: the money is already inside the market and
    // flow terms, which read the account's NAV curve directly.
    const inst = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const bare = createAccount(bundle.db, {
      institutionId: inst.id,
      name: "Brokerage",
      type: "investment",
    });
    addManualAnchor(bundle.db, { accountId: bare, anchoredOn: "2026-06-01", enteredCents: 50_000 });
    post(bare, "2026-06-10", 15_000, "Transfers > Investment Contribution");

    const got = bridgeOver("2026-06-01", "2026-06-30");
    // the anchor holds the balance flat — the row genuinely moved nothing
    expect(got.deltaCents).toBe(0);
    expect(got.bands.find((b) => b.key === "moved")!.cents).toBe(0);
    expect(got.closes).toBe(true);
  });
});

/**
 * ⚖️ Owner decisions: Robinhood Agentic is kept OUT of his own brokerage returns (2026-09-14), and what the agent buys
 * sits in a brokerage book paired with it (2026-09-15). His RETURNS leave the book out; his NET WORTH does not.
 *
 * 🔴 The bridge's holdings side read his portfolio alone while net worth valued the book too, so the book's whole move
 * landed in "Unexplained" — measured on the agent's constructed August, +$1.51 on a quiet window and +$27.73 (the
 * book's entire value) on a window spanning its buy.
 */
describe("netWorthAttribution — the agent's brokerage book is in net worth, so its move is in a band", () => {
  let fakeToday: string | undefined;
  beforeEach(() => {
    fakeToday = process.env.MONEYAPP_FAKE_TODAY;
    process.env.MONEYAPP_FAKE_TODAY = "2026-10-05";
  });
  afterEach(() => {
    if (fakeToday === undefined) delete process.env.MONEYAPP_FAKE_TODAY;
    else process.env.MONEYAPP_FAKE_TODAY = fakeToday;
  });

  /** His brokerage holding 1 WMT since July, and the agent buying 0.25 WMT for $25.00 on Aug 20 — the rehearsal's month. */
  function agentBuysWmt(): { book: string } {
    const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    for (const [day, close] of [
      ["2026-07-01", 111.2],
      ["2026-08-20", 103.84],
      ["2026-08-31", 104.87],
      ["2026-09-30", 110.9],
    ] as const) {
      bundle.db.insert(priceCache).values({ symbol: "WMT", assetType: "stock", quotedOn: day, close, source: "yahoo", fetchedAt: `${day}T21:00:00.000Z` }).run();
    }
    const brokerage = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Brokerage", type: "investment", subtype: "brokerage" });
    upsertHolding(bundle.db, { accountId: brokerage, symbol: "WMT", assetType: "stock", quantityE8: 100_000_000, avgCostCents: 10_600, occurredOn: "2026-07-01" });

    const agentic = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
    const book = createAccount(bundle.db, { institutionId: robinhood.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
    addManualAnchor(bundle.db, { accountId: agentic, anchoredOn: "2026-06-30", enteredCents: 2_664 });
    post(agentic, "2026-08-20", -2_500, "Investments > Buys");
    upsertHolding(bundle.db, { accountId: book, symbol: "WMT", assetType: "stock", quantityE8: 25_000_000, avgCostCents: 10_000, occurredOn: "2026-08-20" });

    // the premise: the book is outside HIS portfolio, and net worth still values it
    expect(investmentAccounts(bundle.db).map((a) => a.id)).toEqual([brokerage]);
    return { book };
  }

  test("a window with no trade: the book's $26.22 → $27.73 is market, never unexplained", () => {
    agentBuysWmt();

    const got = bridgeOver("2026-08-31", "2026-10-05");

    // his 1 WMT $104.87 → $110.90 = +$6.03, the book's 0.25 +$1.51 (0.25 × $110.90 = $27.725 → $27.73)
    expect(got.deltaCents).toBe(603 + 151);
    expect(got.bands.find((b) => b.key === "market")!.cents).toBe(603 + 151);
    expect(got.bands.find((b) => b.key === "portfolioFlow")!.cents).toBe(0);
    expect([got.unexplainedCents, got.unattributedCents, got.closes]).toEqual([0, 0, true]);
  });

  test("a window spanning the agent's buy: the $25.00 leaving Agentic is moved, the shares it bought are flow — nothing unaccounted", () => {
    const { book } = agentBuysWmt();

    const got = bridgeOver("2026-07-31", "2026-10-05");

    // the book entered at 0.25 × $103.84 = $25.96 on the 20th, valued at that day's close
    expect(got.bands.find((b) => b.key === "moved")!.cents).toBe(-2_500);
    expect(got.bands.find((b) => b.key === "portfolioFlow")!.cents).toBe(2_596);
    expect(got.deltaCents).toBe(nwOn("2026-10-05") - nwOn("2026-07-31"));
    expect([got.unexplainedCents, got.unattributedCents, got.closes]).toEqual([0, 0, true]);
    expect(got.restatements).toEqual([]);
    // the book really is in the delta: without it the window moves by the cash and his shares alone
    expect(bundle.db.select().from(accounts).where(eq(accounts.id, book)).get()!.isActive).toBe(true);
  });
});
