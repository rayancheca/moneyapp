import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache, ASSET_TYPES, type AssetType } from "@/db/schema/holdings";
import { isValidIsoDate, todayIso } from "@/lib/dates";

/**
 * Holdings CRUD + portfolio math (master-plan Phase 7). Quantities are
 * exact INTEGER 1e-8 units end to end — parsing is string math, never
 * floats. Market values are rounded to cents at the edge (schema.md).
 * Every quantity change appends a holding_events delta so the crypto
 * history timeline stays reconstructible.
 */

const E8 = 100_000_000n;
const QUANTITY_RE = /^(\d{1,3}(?:,\d{3})*|\d*)(?:\.(\d+))?$/;

export class QuantityParseError extends Error {
  constructor(input: string, reason: string) {
    super(`Cannot parse quantity "${input}": ${reason}`);
    this.name = "QuantityParseError";
  }
}

/**
 * "0.5" → 50_000_000; "12.34567891" throws (more than 8 decimals would
 * silently lose precision — quantities are exact by contract).
 */
export function parseQuantityToE8(input: string): number {
  const s = input.trim();
  if (s === "") throw new QuantityParseError(input, "empty");
  const m = QUANTITY_RE.exec(s);
  if (!m) throw new QuantityParseError(input, "not a decimal number");
  const intRaw = (m[1] as string).replaceAll(",", "");
  const frac = m[2] ?? "";
  if (intRaw === "" && frac === "") throw new QuantityParseError(input, "no digits");
  if (frac.length > 8) throw new QuantityParseError(input, "more than 8 decimal places");

  const e8 = BigInt(intRaw || "0") * E8 + BigInt(frac.padEnd(8, "0") || "0");
  if (e8 > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new QuantityParseError(input, "exceeds safe integer range");
  }
  return Number(e8);
}

/** 50_000_000 → "0.5"; 1_234_500_000_000 → "12,345". Display only. */
export function formatQuantityE8(quantityE8: number): string {
  if (!Number.isSafeInteger(quantityE8)) throw new RangeError(`Invalid quantity_e8: ${quantityE8}`);
  const sign = quantityE8 < 0 ? "-" : "";
  const abs = BigInt(Math.abs(quantityE8));
  const whole = (abs / E8).toLocaleString("en-US");
  const frac = (abs % E8).toString().padStart(8, "0").replace(/0+$/, "");
  return frac === "" ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

/** quantity_e8 × close (USD) → cents, rounded at the edge (schema.md). */
export function valueCentsOf(quantityE8: number, close: number): number {
  return Math.round(quantityE8 * close * 1e-6);
}

/* ── Upsert (by account + symbol) ───────────────────────────────────── */

export const holdingInputSchema = z.object({
  accountId: z.string().min(1),
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .transform((s) => s.toUpperCase())
    .refine((s) => /^[A-Z0-9.\-]+$/.test(s), "Symbols are letters, digits, dots, dashes"),
  assetType: z.enum(ASSET_TYPES),
  quantityE8: z.number().int().nonnegative(),
  avgCostCents: z.number().int().nonnegative().nullish(),
  /** when the quantity change happened — drives the crypto history timeline */
  occurredOn: z.string().refine(isValidIsoDate, "Invalid date").optional(),
  note: z.string().trim().max(200).nullish(),
});
export type HoldingInput = z.infer<typeof holdingInputSchema>;

/**
 * Insert-or-update by (account, symbol). Any quantity change appends a
 * signed holding_events delta; setting quantity to 0 deactivates the row.
 */
export function upsertHolding(db: AppDatabase, input: HoldingInput): string {
  const parsed = holdingInputSchema.parse(input);
  const account = db.select().from(accounts).where(eq(accounts.id, parsed.accountId)).get();
  if (!account) throw new Error(`Unknown account ${parsed.accountId}`);
  if (account.type !== "investment") {
    throw new Error("Holdings belong to investment accounts only");
  }
  const occurredOn = parsed.occurredOn ?? todayIso();

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(holdings)
      .where(and(eq(holdings.accountId, parsed.accountId), eq(holdings.symbol, parsed.symbol)))
      .get();

    const previousQty = existing?.quantityE8 ?? 0;
    const deltaE8 = parsed.quantityE8 - previousQty;

    let holdingId: string;
    if (existing) {
      tx.update(holdings)
        .set({
          assetType: parsed.assetType,
          quantityE8: parsed.quantityE8,
          avgCostCents: parsed.avgCostCents ?? existing.avgCostCents,
          isActive: parsed.quantityE8 > 0,
        })
        .where(eq(holdings.id, existing.id))
        .run();
      holdingId = existing.id;
    } else {
      holdingId = tx
        .insert(holdings)
        .values({
          accountId: parsed.accountId,
          symbol: parsed.symbol,
          assetType: parsed.assetType,
          quantityE8: parsed.quantityE8,
          avgCostCents: parsed.avgCostCents ?? null,
          isActive: parsed.quantityE8 > 0,
        })
        .returning({ id: holdings.id })
        .get().id;
    }

    if (deltaE8 !== 0) {
      // event cost: avg cost × |delta|, display-only (never net worth)
      const costCents =
        parsed.avgCostCents != null
          ? Math.round((parsed.avgCostCents * Math.abs(deltaE8)) / 1e8)
          : null;
      tx.insert(holdingEvents)
        .values({
          accountId: parsed.accountId,
          symbol: parsed.symbol,
          assetType: parsed.assetType,
          occurredOn,
          quantityDeltaE8: deltaE8,
          costCents,
          note: parsed.note ?? null,
        })
        .run();
    }

    return holdingId;
  });
}

/* ── Portfolio view ─────────────────────────────────────────────────── */

export interface PortfolioRow {
  accountId: string;
  accountName: string;
  symbol: string;
  assetType: AssetType;
  quantityE8: number;
  latestClose: number | null;
  /** as-of day of latestClose */
  quotedOn: string | null;
  valueCents: number | null;
  avgCostCents: number | null;
  plCents: number | null;
  plPct: number | null;
  allocationPct: number | null;
}

export interface PortfolioTotals {
  valueCents: number;
  costCents: number | null;
  plCents: number | null;
  plPct: number | null;
}

export interface Portfolio {
  rows: PortfolioRow[];
  totals: PortfolioTotals;
  /** newest fetched_at across quoted rows — the "as of" staleness stamp */
  latestFetchedAt: string | null;
}

/**
 * Active holdings × latest cached close. P/L compares market value to
 * avg-cost basis (display only); allocation shares sum to 100 (±0.1)
 * across priced rows.
 */
export function listPortfolio(db: AppDatabase): Portfolio {
  const rows = db
    .select({
      accountId: holdings.accountId,
      accountName: accounts.name,
      symbol: holdings.symbol,
      assetType: holdings.assetType,
      quantityE8: holdings.quantityE8,
      avgCostCents: holdings.avgCostCents,
    })
    .from(holdings)
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(eq(holdings.isActive, true))
    .orderBy(asc(accounts.name), asc(holdings.symbol))
    .all();

  let latestFetchedAt: string | null = null;
  const priced = rows.map((r) => {
    const latest = db
      .select()
      .from(priceCache)
      .where(and(eq(priceCache.symbol, r.symbol), eq(priceCache.assetType, r.assetType)))
      .orderBy(desc(priceCache.quotedOn))
      .limit(1)
      .get();
    if (latest && (latestFetchedAt === null || latest.fetchedAt > latestFetchedAt)) {
      latestFetchedAt = latest.fetchedAt;
    }

    const valueCents = latest ? valueCentsOf(r.quantityE8, latest.close) : null;
    const costCents =
      r.avgCostCents != null ? Math.round((r.avgCostCents * r.quantityE8) / 1e8) : null;
    const plCents = valueCents !== null && costCents !== null ? valueCents - costCents : null;
    const plPct =
      plCents !== null && costCents !== null && costCents !== 0
        ? (plCents / costCents) * 100
        : null;

    return {
      ...r,
      latestClose: latest?.close ?? null,
      quotedOn: latest?.quotedOn ?? null,
      valueCents,
      costCents,
      plCents,
      plPct,
    };
  });

  const totalValue = priced.reduce((sum, r) => sum + (r.valueCents ?? 0), 0);
  const costKnown = priced.filter((r) => r.costCents !== null && r.valueCents !== null);
  const totalCost = costKnown.length > 0 ? costKnown.reduce((s, r) => s + r.costCents!, 0) : null;
  const totalPl = totalCost !== null ? costKnown.reduce((s, r) => s + r.plCents!, 0) : null;

  return {
    rows: priced.map((r) => ({
      accountId: r.accountId,
      accountName: r.accountName,
      symbol: r.symbol,
      assetType: r.assetType,
      quantityE8: r.quantityE8,
      latestClose: r.latestClose,
      quotedOn: r.quotedOn,
      valueCents: r.valueCents,
      avgCostCents: r.avgCostCents,
      plCents: r.plCents,
      plPct: r.plPct,
      allocationPct:
        r.valueCents !== null && totalValue > 0 ? (r.valueCents / totalValue) * 100 : null,
    })),
    totals: {
      valueCents: totalValue,
      costCents: totalCost,
      plCents: totalPl,
      plPct: totalPl !== null && totalCost !== null && totalCost !== 0 ? (totalPl / totalCost) * 100 : null,
    },
    latestFetchedAt,
  };
}
