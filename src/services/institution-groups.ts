import { asc, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts, isLiability, type AccountSubtype, type AccountType } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { holdings } from "@/db/schema/holdings";
import { institutions } from "@/db/schema/institutions";
import { compareDates, todayIso } from "@/lib/dates";
import { dayChangeTerm } from "@/lib/day-change-label";
import { formatDayShort } from "@/lib/format-date";
import { formatQuantityE8 } from "./holdings";
import { unreviewedByAccount } from "./review-count";

/**
 * Institution-grouped account cards (dashboard + accounts pages): one
 * card per institution with a combined balance, a day change, and a
 * sparkline — expandable into per-account sub-cards. All money in the
 * net-worth sign convention (liabilities negative), exactly like the
 * daily_balances rows it reads.
 */

/** days of history shown in card sparklines */
export const SPARK_WINDOW_DAYS = 30;

export interface SparkPoint {
  day: string;
  cents: number;
}

export interface AccountCard {
  id: string;
  institutionId: string;
  name: string;
  /** name minus a leading institution prefix — sub-cards say "Brokerage", not "Robinhood Brokerage" */
  shortName: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  last4: string | null;
  /** S6: the credit card's funding account, when linked */
  paymentSourceAccountId: string | null;
  isLiability: boolean;
  balanceCents: number | null;
  asOf: string | null;
  /** latest covered day minus the covered day before it; null when unknowable */
  dayChangeCents: number | null;
  /** the newer of the two days `dayChangeCents` was measured between */
  dayChangeAsOf: string | null;
  /** the older of them */
  dayChangeVsDay: string | null;
  /** what to CALL that figure — "today", or the two dates it really spans */
  dayChangeTerm: string;
  spark: SparkPoint[];
  /** e.g. "8 positions · MSFT SPY AMZN…" or "14.619066 ETH"; null for non-investment */
  holdingsSummary: string | null;
  /** active transactions awaiting review in this account — drives the §7.2 dot */
  unreviewedCount: number;
}

export interface InstitutionGroup {
  institutionName: string;
  totalCents: number;
  dayChangeCents: number | null;
  /**
   * ⚠️ NOT `asOf`. `asOf` is the NEWEST day any child covers; the change is
   * measured on the combined series, which ends at the newest day EVERY child
   * covers — the oldest of them. On the real ledger the Chase group is as of
   * 2026-08-14 and its change spans 2026-08-04 → 2026-08-05.
   */
  dayChangeAsOf: string | null;
  dayChangeVsDay: string | null;
  dayChangeTerm: string;
  asOf: string | null;
  spark: SparkPoint[];
  accounts: AccountCard[];
}

interface DayRow {
  accountId: string;
  day: string;
  balanceCents: number;
}

function shortNameOf(accountName: string, institutionName: string): string {
  const prefix = `${institutionName} `;
  if (accountName.startsWith(prefix) && accountName.length > prefix.length) {
    return accountName.slice(prefix.length);
  }
  return accountName;
}

interface DayChange {
  cents: number | null;
  asOf: string | null;
  vsDay: string | null;
}

/**
 * The move between the last two covered days — AND the two days it was measured
 * between, from one read of the same array.
 *
 * ⛔ The figure and the word for it are returned together on purpose. A caller
 * that took the cents here and read the date off `AccountCard.asOf` (or, worse,
 * `InstitutionGroup.asOf`) would be two places agreeing about a date, which is
 * the defect pass 54 was written to stop — and for a GROUP the two are not even
 * the same day.
 */
function dayChangeOf(series: readonly SparkPoint[]): DayChange {
  // Fewer than two covered days is no measured change at all, so there is no
  // pair of days to name either — null, not the single day, which would invite
  // a caller to print "as of X" over a figure that does not exist.
  if (series.length < 2) return { cents: null, asOf: null, vsDay: null };
  const last = series[series.length - 1]!;
  const prev = series[series.length - 2]!;
  return { cents: last.cents - prev.cents, asOf: last.day, vsDay: prev.day };
}

/** top holdings by |quantity×cost| are noise — summarize by count + tickers */
function summarizeHoldings(rows: readonly { symbol: string; quantityE8: number }[]): string | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const only = rows[0]!;
    return `${formatQuantityE8(only.quantityE8)} ${only.symbol}`;
  }
  const tickers = rows.slice(0, 3).map((r) => r.symbol).join(" ");
  const suffix = rows.length > 3 ? "…" : "";
  return `${rows.length} positions · ${tickers}${suffix}`;
}

export function institutionGroups(
  db: AppDatabase,
  today: string = todayIso(),
): InstitutionGroup[] {
  const accountRows = db
    .select({
      id: accounts.id,
      institutionId: accounts.institutionId,
      institutionName: institutions.name,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      last4: accounts.last4,
      paymentSourceAccountId: accounts.paymentSourceAccountId,
      displayOrder: accounts.displayOrder,
    })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.isActive, true))
    .orderBy(asc(institutions.name), asc(accounts.displayOrder), asc(accounts.name))
    .all();
  if (accountRows.length === 0) return [];

  const balanceRows: DayRow[] = db
    .select({
      accountId: dailyBalances.accountId,
      day: dailyBalances.day,
      balanceCents: dailyBalances.balanceCents,
      basis: dailyBalances.basis,
    })
    .from(dailyBalances)
    .where(
      inArray(
        dailyBalances.accountId,
        accountRows.map((a) => a.id),
      ),
    )
    .orderBy(asc(dailyBalances.day))
    .all()
    .filter((r) => r.basis !== "gap");

  const seriesByAccount = new Map<string, SparkPoint[]>();
  for (const r of balanceRows) {
    const list = seriesByAccount.get(r.accountId) ?? [];
    list.push({ day: r.day, cents: r.balanceCents });
    seriesByAccount.set(r.accountId, list);
  }

  const investmentIds = accountRows.filter((a) => a.type === "investment").map((a) => a.id);
  const holdingRows =
    investmentIds.length === 0
      ? []
      : db
          .select({
            accountId: holdings.accountId,
            symbol: holdings.symbol,
            quantityE8: holdings.quantityE8,
          })
          .from(holdings)
          .where(inArray(holdings.accountId, investmentIds))
          .orderBy(asc(holdings.symbol))
          .all()
          .filter((h) => h.quantityE8 > 0);

  const unreviewed = unreviewedByAccount(db);

  const groups = new Map<string, InstitutionGroup>();
  for (const a of accountRows) {
    const series = seriesByAccount.get(a.id) ?? [];
    const latest = series.at(-1) ?? null;
    const change = dayChangeOf(series);
    const card: AccountCard = {
      id: a.id,
      institutionId: a.institutionId,
      name: a.name,
      shortName: shortNameOf(a.name, a.institutionName),
      type: a.type,
      subtype: a.subtype,
      last4: a.last4,
      paymentSourceAccountId: a.paymentSourceAccountId,
      isLiability: isLiability(a.type),
      balanceCents: latest?.cents ?? null,
      asOf: latest?.day ?? null,
      dayChangeCents: change.cents,
      dayChangeAsOf: change.asOf,
      dayChangeVsDay: change.vsDay,
      dayChangeTerm: dayChangeTerm(change.asOf, change.vsDay, today, formatDayShort),
      spark: series.slice(-SPARK_WINDOW_DAYS),
      holdingsSummary:
        a.type === "investment"
          ? summarizeHoldings(holdingRows.filter((h) => h.accountId === a.id))
          : null,
      unreviewedCount: unreviewed.get(a.id) ?? 0,
    };

    const group = groups.get(a.institutionName) ?? {
      institutionName: a.institutionName,
      totalCents: 0,
      dayChangeCents: null,
      dayChangeAsOf: null,
      dayChangeVsDay: null,
      dayChangeTerm: "",
      asOf: null,
      spark: [],
      accounts: [],
    };
    groups.set(a.institutionName, { ...group, accounts: [...group.accounts, card] });
  }

  return [...groups.values()].map((group) => {
    // combined series: only days where EVERY account in the group is
    // covered — a missing account would masquerade as a balance drop
    const ids = group.accounts.map((c) => c.id);
    const byDay = new Map<string, { total: number; covered: number }>();
    for (const id of ids) {
      for (const p of seriesByAccount.get(id) ?? []) {
        const entry = byDay.get(p.day) ?? { total: 0, covered: 0 };
        byDay.set(p.day, { total: entry.total + p.cents, covered: entry.covered + 1 });
      }
    }
    const combined: SparkPoint[] = [...byDay.entries()]
      .filter(([, v]) => v.covered === ids.length)
      .sort(([a], [b]) => compareDates(a, b))
      .map(([day, v]) => ({ day, cents: v.total }));

    const totalCents = group.accounts.reduce((sum, c) => sum + (c.balanceCents ?? 0), 0);
    const asOf = group.accounts.reduce<string | null>(
      (acc, c) => (c.asOf && (!acc || compareDates(c.asOf, acc) > 0) ? c.asOf : acc),
      null,
    );

    const change = dayChangeOf(combined);
    return {
      ...group,
      totalCents,
      dayChangeCents: change.cents,
      dayChangeAsOf: change.asOf,
      dayChangeVsDay: change.vsDay,
      dayChangeTerm: dayChangeTerm(change.asOf, change.vsDay, today, formatDayShort),
      asOf,
      spark: combined.slice(-SPARK_WINDOW_DAYS),
    };
  });
}
