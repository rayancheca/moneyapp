import { addDays, compareDates, isoWeekday, monthKey, periodBounds } from "../../src/lib/dates";
import { fakeDailyClose } from "../../src/lib/fake-prices";
import { hashString, makeRng } from "../../src/lib/prng";

/**
 * Deterministic 24-month financial-life simulator. Every statement period is
 * exact by construction (begin + Σtxns = end), transfers always have paired
 * legs, and brokerage values derive from the shared fake price walk — so the
 * fixtures exercise the real reconciliation, dedupe, transfer-pairing, and
 * backfill machinery with bank-realistic content.
 */

export const SIM_START = "2024-07-01";
export const SIM_END = "2026-07-05"; // generation-time "today" ≈ 2026-07-08

export type AccountKey =
  | "chase-checking"
  | "chase-savings"
  | "chase-card"
  | "discover-card"
  | "capone-checking"
  | "capone-venturex"
  | "sofi-checking"
  | "sofi-savings"
  | "robinhood-brokerage";

export interface SimAccount {
  key: AccountKey;
  institution: "Chase" | "Discover" | "Capital One" | "SoFi" | "Robinhood";
  name: string;
  type: "checking" | "savings" | "credit" | "investment";
  subtype?: "brokerage";
  last4: string;
}

export const SIM_ACCOUNTS: SimAccount[] = [
  { key: "chase-checking", institution: "Chase", name: "Chase Total Checking", type: "checking", last4: "4321" },
  { key: "chase-savings", institution: "Chase", name: "Chase Savings", type: "savings", last4: "8721" },
  { key: "chase-card", institution: "Chase", name: "Chase Freedom Unlimited", type: "credit", last4: "1111" },
  { key: "discover-card", institution: "Discover", name: "Discover it Card", type: "credit", last4: "2222" },
  { key: "capone-checking", institution: "Capital One", name: "Capital One 360 Checking", type: "checking", last4: "3333" },
  { key: "capone-venturex", institution: "Capital One", name: "Venture X", type: "credit", last4: "4444" },
  { key: "sofi-checking", institution: "SoFi", name: "SoFi Checking", type: "checking", last4: "5555" },
  { key: "sofi-savings", institution: "SoFi", name: "SoFi Savings", type: "savings", last4: "6666" },
  { key: "robinhood-brokerage", institution: "Robinhood", name: "Robinhood Brokerage", type: "investment", subtype: "brokerage", last4: "7777" },
];

export interface SimTxn {
  accountKey: AccountKey;
  postedOn: string;
  /** net-worth-signed canonical amount */
  amountCents: number;
  rawDescription: string;
  /** Robinhood activity metadata */
  rh?: { transCode: string; instrument: string; quantityE8: number | null; price: number | null };
  /** direct category path hint applied by parser profiles (investment rows) */
  categoryPath?: string;
}

export interface SimHoldingRow {
  symbol: string;
  quantityE8: number;
  price: number;
  valueCents: number;
}

export interface SimPeriod {
  accountKey: AccountKey;
  periodStart: string;
  periodEnd: string;
  beginCents: number;
  endCents: number;
  txns: SimTxn[];
  /** investment statements */
  holdings?: SimHoldingRow[];
  cashCents?: number;
}

export interface Simulation {
  accounts: SimAccount[];
  txns: Map<AccountKey, SimTxn[]>;
  periods: SimPeriod[];
  startBalances: Record<AccountKey, number>;
  endBalances: Map<AccountKey, number>;
  minCheckingBalance: number;
}

/** Card statement period end day-of-month (period runs end+1 → next end). */
const CARD_CYCLE_END: Partial<Record<AccountKey, number>> = {
  "chase-card": 4,
  "discover-card": 14,
  "capone-venturex": 19,
};

const START_BALANCES: Record<AccountKey, number> = {
  "chase-checking": 1_012_000,
  "chase-savings": 1_250_000,
  "chase-card": -78_045,
  "discover-card": -21_530,
  "capone-checking": 310_000,
  "capone-venturex": -114_220,
  "sofi-checking": 230_000,
  "sofi-savings": 1_500_000,
  "robinhood-brokerage": 0, // tracked as cash+shares below
};

interface BrokerageState {
  cashCents: number;
  shares: Map<string, number>; // symbol → quantityE8
}

function brokerageValueCents(b: BrokerageState, day: string): number {
  let total = b.cashCents;
  for (const [symbol, qtyE8] of b.shares) {
    total += Math.round((qtyE8 / 1e8) * fakeDailyClose(symbol, day) * 100);
  }
  return total;
}

function dayOfMonth(day: string): number {
  return Number(day.slice(8, 10));
}

export function runSimulation(): Simulation {
  const txns = new Map<AccountKey, SimTxn[]>(SIM_ACCOUNTS.map((a) => [a.key, []]));
  const balances = { ...START_BALANCES };
  const brokerage: BrokerageState = { cashCents: 12_000, shares: new Map([["VOO", 8_25000000]]) };
  const scheduledPayments = new Map<string, { card: AccountKey; amountCents: number }[]>();
  const periods: SimPeriod[] = [];
  let minCheckingBalance = Number.MAX_SAFE_INTEGER;

  const add = (t: SimTxn) => {
    txns.get(t.accountKey)!.push(t);
    if (t.accountKey === "robinhood-brokerage") return; // value tracked via state
    balances[t.accountKey] += t.amountCents;
    if (t.accountKey === "chase-checking") {
      minCheckingBalance = Math.min(minCheckingBalance, balances["chase-checking"]);
    }
  };

  // period bookkeeping: snapshot begin balances lazily per period key
  const periodBegin = new Map<string, number>();
  const periodTxns = new Map<string, SimTxn[]>();
  const periodKeyFor = (account: AccountKey, day: string): { key: string; start: string; end: string } => {
    const cycleEnd = CARD_CYCLE_END[account];
    if (cycleEnd === undefined) {
      const b = periodBounds(day, "monthly");
      return { key: `${account}|${b.start}`, start: b.start, end: b.end };
    }
    const dom = dayOfMonth(day);
    const m = monthKey(day);
    const [y, mo] = m.split("-").map(Number);
    const endThisMonth = `${m}-${String(cycleEnd).padStart(2, "0")}`;
    if (dom <= cycleEnd) {
      const prevMonth = mo === 1 ? `${y! - 1}-12` : `${y}-${String(mo! - 1).padStart(2, "0")}`;
      return { key: `${account}|${prevMonth}-${String(cycleEnd).padStart(2, "0")}`, start: addDays(`${prevMonth}-${String(cycleEnd).padStart(2, "0")}`, 1), end: endThisMonth };
    }
    const nextMonth = mo === 12 ? `${y! + 1}-01` : `${y}-${String(mo! + 1).padStart(2, "0")}`;
    return { key: `${account}|${endThisMonth}`, start: addDays(endThisMonth, 1), end: `${nextMonth}-${String(cycleEnd).padStart(2, "0")}` };
  };

  const track = (t: SimTxn) => {
    const p = periodKeyFor(t.accountKey, t.postedOn);
    if (!periodBegin.has(p.key)) {
      periodBegin.set(
        p.key,
        t.accountKey === "robinhood-brokerage"
          ? brokerageValueCents(brokerage, addDays(p.start, -1))
          : balances[t.accountKey],
      );
    }
    (periodTxns.get(p.key) ?? periodTxns.set(p.key, []).get(p.key)!).push(t);
    add(t);
  };

  const emit = (accountKey: AccountKey, postedOn: string, amountCents: number, rawDescription: string, extra?: Partial<SimTxn>) => {
    track({ accountKey, postedOn, amountCents, rawDescription, ...extra });
  };

  const payrollAnchor = "2024-07-05"; // a Friday
  const cardStatementBalance = new Map<AccountKey, number>();

  for (let day = SIM_START; compareDates(day, SIM_END) <= 0; day = addDays(day, 1)) {
    const rng = makeRng(hashString(`day:${day}`));
    const dom = dayOfMonth(day);
    const weekday = isoWeekday(day); // 0=Mon … 6=Sun
    const m = monthKey(day);
    const monthIndex = (Number(m.slice(0, 4)) - 2024) * 12 + Number(m.slice(5)) - 7;

    // ── income ──────────────────────────────────────────────────────────
    const daysSincePayroll = (Date.parse(day) - Date.parse(payrollAnchor)) / 86_400_000;
    if (compareDates(day, "2026-05-08") <= 0 && daysSincePayroll >= 0 && daysSincePayroll % 14 === 0) {
      emit("chase-checking", day, 294_319, "ACME CORP PAYROLL DIR DEP");
    }
    if (compareDates(day, "2026-05-14") >= 0 && weekday === 3) {
      emit("chase-checking", day, 115_000 + rng.int(0, 260) * 100, `ATM CASH DEPOSIT ${day.slice(5, 7)}/${day.slice(8, 10)} 100 BROADWAY NEW YORK NY`);
    }

    // ── fixed bills ─────────────────────────────────────────────────────
    if (dom === 1) emit("chase-checking", day, -215_000, "ACH PYMT WESTVIEW APARTMENTS RENT");
    if (dom === 8) emit("chase-checking", day, -(8_000 + rng.int(0, 60) * 100), "CONED ELEC BILL PAYMENT");
    if (dom === 12) emit("chase-checking", day, -6_500, "VERIZON WIRELESS PAYMENTS");
    if (dom === 15) emit("capone-checking", day, -7_999, "XFINITY COMCAST INTERNET");
    if (dom === 17) emit("capone-venturex", day, -2_999, "CRUNCH FITNESS CLUB FEE NEW YORK NY");
    if (dom === 3) emit("chase-card", day, -1_549, "NETFLIX.COM NETFLIX.COM CA");
    if (dom === 7) emit("discover-card", day, -1_199, "SPOTIFY USA NEW YORK NY");
    if (dom === 9) emit("chase-card", day, -299, "APPLE.COM/BILL CUPERTINO CA");

    // ── transfers (both legs always emitted) ────────────────────────────
    if (dom === 2) {
      emit("chase-checking", day, -30_000, "ONLINE TRANSFER TO SAV ...8721");
      emit("chase-savings", day, 30_000, "ONLINE TRANSFER FROM CHK ...4321");
    }
    if (dom === 6) {
      emit("chase-checking", day, -40_000, "CAPITAL ONE 360 TRANSFER");
      emit("capone-checking", day, 40_000, "TRANSFER FROM CHASE BANK TRANSFER");
    }
    if (weekday === 0 && rng.chance(0.5)) {
      emit("chase-checking", day, -20_000, "SOFI BANK TRANSFER OUT");
      emit("sofi-checking", day, 20_000, "SOFI BANK TRANSFER FROM CHASE");
    }
    if (dom === 4) {
      emit("sofi-checking", day, -15_000, "TRANSFER TO SOFI SAVINGS");
      emit("sofi-savings", day, 15_000, "TRANSFER FROM SOFI CHECKING");
    }
    if (dom === 15) {
      emit("chase-checking", day, -50_000, "ROBINHOOD ACH TRANSFER");
      emit("robinhood-brokerage", day, 50_000, "ACH Deposit", {
        rh: { transCode: "ACH", instrument: "", quantityE8: null, price: null },
      });
      brokerage.cashCents += 50_000;
    }

    // ── interest ────────────────────────────────────────────────────────
    const monthEnd = periodBounds(day, "monthly").end;
    if (day === monthEnd) {
      emit("chase-savings", day, Math.max(10, Math.round((balances["chase-savings"] * 0.0001) / 12)), "INTEREST PAYMENT");
      emit("sofi-savings", day, Math.round((balances["sofi-savings"] * 0.038) / 12), "INTEREST EARNED");
    }

    // ── card spending ───────────────────────────────────────────────────
    if (weekday === 5 || (weekday === 2 && rng.chance(0.6))) {
      const grocer = rng.pick([
        { d: `TRADER JOE S #${rng.int(520, 559)} NEW YORK NY`, min: 3_500, max: 9_500 },
        { d: `WHOLEFDS MKT #${rng.int(10_100, 10_199)} NEW YORK NY`, min: 4_500, max: 12_000 },
      ]);
      emit("chase-card", day, -rng.int(grocer.min, grocer.max), grocer.d);
    }
    if ((weekday === 0 || weekday === 3) && rng.chance(0.8)) {
      emit("chase-card", day, -rng.int(550, 825), `STARBUCKS STORE ${rng.int(10_000, 99_999)} NEW YORK NY`);
    }
    if (rng.chance(0.25)) {
      const dining = rng.pick([
        { key: "chase-card" as const, d: "TST* JOES PIZZA - BROADWAY NEW YORK NY", min: 1_800, max: 3_400 },
        { key: "chase-card" as const, d: `CHIPOTLE ${rng.int(1_000, 3_999)} NEW YORK NY`, min: 1_245, max: 1_720 },
        { key: "chase-card" as const, d: "SWEETGREEN NOMAD NEW YORK NY", min: 1_400, max: 1_780 },
        { key: "discover-card" as const, d: `MCDONALD'S F${rng.int(10_000, 32_000)} NEW YORK NY`, min: 850, max: 1_640 },
      ]);
      emit(dining.key, day, -rng.int(dining.min, dining.max), dining.d);
    }
    if (weekday === 6 && rng.chance(0.55)) {
      emit("capone-venturex", day, -rng.int(3_800, 6_900), rng.pick(["SHELL OIL 5744291 QUEENS NY", "CHEVRON 0209318 BROOKLYN NY"]));
    }
    if (rng.chance(0.1)) {
      emit("capone-venturex", day, -rng.int(2_800, 5_600), "DD *DOORDASH CHIPOTLE NEW YORK NY");
    }
    if (rng.chance(0.12)) {
      emit("chase-card", day, -rng.int(1_500, 14_000), `AMAZON MKTPL*${rng.int(100_000, 999_999).toString(36).toUpperCase()} AMZN.COM/BILL WA`);
    }
    if (rng.chance(0.05)) {
      emit("discover-card", day, -rng.int(999, 5_999), "STEAMGAMES.COM 4259522985 WA");
    }
    if (rng.chance(0.06)) {
      emit("discover-card", day, -rng.int(1_400, 3_800), `UBER TRIP HELP.UBER.COM CA`);
    }
    if (rng.chance(0.05)) {
      emit("chase-card", day, -rng.int(1_200, 6_400), `CVS/PHARM ${rng.int(1_000, 9_999)} NEW YORK NY`);
    }

    // ── travel (Venture X) ──────────────────────────────────────────────
    if (["2024-09-03", "2025-02-11", "2025-06-24", "2025-11-04", "2026-03-17"].includes(day)) {
      emit("capone-venturex", day, -rng.int(18_000, 52_000), rng.pick(["UNITED AIRLINES 0162341598726 TX", "DELTA AIR LINES ATLANTA GA"]));
      if (dom !== 19) emit("capone-venturex", addDays(day, 2), 30_000, "CREDIT FOR VENTURE X TRAVEL");
    }
    if (["2024-09-05", "2025-06-26"].includes(day)) {
      emit("capone-venturex", day, -rng.int(22_000, 64_000), rng.pick(["MARRIOTT COURTYARD AUSTIN TX", "AIRBNB * HMQZXKY3PA CA"]));
    }
    if (day.endsWith("11-20")) emit("capone-venturex", day, -39_500, "ANNUAL MEMBERSHIP FEE");

    // ── Discover cashback redemption (quarterly) ───────────────────────
    if (dom === 25 && monthIndex % 3 === 2) {
      emit("discover-card", day, 2_000 + rng.int(0, 15) * 100, "CASHBACK BONUS REDEMPTION");
    }

    // ── Robinhood brokerage activity ────────────────────────────────────
    if (dom === 1) {
      emit("robinhood-brokerage", day, -500, "Gold Monthly Fee", {
        rh: { transCode: "GOLD", instrument: "", quantityE8: null, price: null },
        categoryPath: "Fees > Bank Fees",
      });
      brokerage.cashCents -= 500;
    }
    if (dom === 16) {
      const symbol = ["VOO", "VOO", "AAPL", "MSFT"][monthIndex % 4]!;
      const price = fakeDailyClose(symbol, day);
      const investCents = brokerage.cashCents - 2_000;
      if (investCents > 5_000) {
        const qtyE8 = Math.floor((investCents / (price * 100)) * 1e8);
        const costCents = Math.round((qtyE8 / 1e8) * price * 100);
        brokerage.cashCents -= costCents;
        brokerage.shares.set(symbol, (brokerage.shares.get(symbol) ?? 0) + qtyE8);
        emit("robinhood-brokerage", day, -costCents, `Buy ${symbol}`, {
          rh: { transCode: "Buy", instrument: symbol, quantityE8: qtyE8, price },
          categoryPath: "Investments > Buys",
        });
      }
    }
    if (dom === 22 && [2, 5, 8, 11].includes(Number(m.slice(5)) - 1)) {
      const qty = brokerage.shares.get("VOO") ?? 0;
      const div = Math.round((qty / 1e8) * 170);
      if (div > 0) {
        brokerage.cashCents += div;
        emit("robinhood-brokerage", day, div, "Cash Div: VOO", {
          rh: { transCode: "CDIV", instrument: "VOO", quantityE8: null, price: null },
          categoryPath: "Income > Dividends",
        });
      }
    }

    // ── card autopay scheduling and execution ───────────────────────────
    for (const [card, endDom] of Object.entries(CARD_CYCLE_END) as [AccountKey, number][]) {
      if (dom === endDom) {
        const owed = -balances[card];
        if (owed > 0) {
          const payDay = addDays(day, 20);
          const list = scheduledPayments.get(payDay) ?? [];
          scheduledPayments.set(payDay, [...list, { card, amountCents: owed }]);
          cardStatementBalance.set(card, owed);
        }
      }
    }
    for (const p of scheduledPayments.get(day) ?? []) {
      const desc: Record<string, [string, string]> = {
        "chase-card": ["CHASE CREDIT CRD AUTOPAY", "Payment Thank You-Mobile"],
        "discover-card": ["DISCOVER E-PAYMENT", "DIRECTPAY FULL BALANCE - THANK YOU"],
        "capone-venturex": ["CAPITAL ONE MOBILE PYMT", "CAPITAL ONE AUTOPAY PYMT - THANK YOU"],
      };
      const [chk, card] = desc[p.card]!;
      emit("chase-checking", day, -p.amountCents, chk);
      emit(p.card, day, p.amountCents, card);
    }

    // ── close monthly/statement periods when their end day passes ──────
    for (const account of SIM_ACCOUNTS) {
      const p = periodKeyFor(account.key, day);
      if (day !== p.end) continue;
      const beginKnown = periodBegin.get(p.key);
      const list = periodTxns.get(p.key) ?? [];
      const isBrokerage = account.key === "robinhood-brokerage";
      const begin =
        beginKnown ??
        (isBrokerage ? brokerageValueCents(brokerage, addDays(p.start, -1)) : balances[account.key]);
      const end = isBrokerage ? brokerageValueCents(brokerage, p.end) : balances[account.key];
      const holdings = isBrokerage
        ? [...brokerage.shares.entries()]
            .filter(([, q]) => q > 0)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([symbol, quantityE8]) => {
              const price = fakeDailyClose(symbol, p.end);
              return { symbol, quantityE8, price, valueCents: Math.round((quantityE8 / 1e8) * price * 100) };
            })
        : undefined;
      periods.push({
        accountKey: account.key,
        periodStart: p.start,
        periodEnd: p.end,
        beginCents: begin,
        endCents: end,
        txns: list,
        ...(holdings ? { holdings, cashCents: brokerage.cashCents } : {}),
      });
      periodBegin.delete(p.key);
      periodTxns.delete(p.key);
    }
  }

  const endBalances = new Map<AccountKey, number>(
    SIM_ACCOUNTS.map((a) => [
      a.key,
      a.key === "robinhood-brokerage" ? brokerageValueCents(brokerage, SIM_END) : balances[a.key],
    ]),
  );

  return {
    accounts: SIM_ACCOUNTS,
    txns,
    periods,
    startBalances: { ...START_BALANCES },
    endBalances,
    minCheckingBalance,
  };
}
