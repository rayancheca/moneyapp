import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { holdingEvents } from "@/db/schema/holding-events";
import { holdings, priceCache, ASSET_TYPES, type AssetType } from "@/db/schema/holdings";
import { financialWindowMessage, isWithinFinancialWindow } from "@/lib/date-window";
import { isValidIsoDate, todayIso } from "@/lib/dates";
import { valueCentsOf } from "@/lib/holding-returns";
// NOTE: derivation → crypto-history → holdings closes an import cycle here.
// It is safe (every cross-module reference is inside a function body, never at
// module scope) but do not add a module-scope use of a derivation export. The
// cycle disappears the day crypto-history imports valueCentsOf from
// @/lib/holding-returns — its real home — instead of re-importing it from here.
import { rebuildAccount } from "./derivation";

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

/** quantity_e8 × close (USD) → cents, rounded at the edge (schema.md).
 *  Canonical definition lives in the pure lib so holding-returns can value
 *  NAVs/flows with the EXACT same rounding; re-exported here for callers. */
export { valueCentsOf };

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
  /** when the quantity change happened — drives the crypto history timeline,
   *  which walks one row per day from the first event, so the year is bounded */
  occurredOn: z
    .string()
    .refine(isValidIsoDate, "Invalid date")
    .refine(isWithinFinancialWindow, financialWindowMessage("occurredOn"))
    .optional(),
  note: z.string().trim().max(200).nullish(),
});
export type HoldingInput = z.infer<typeof holdingInputSchema>;

/**
 * Insert-or-update by (account, symbol). Any quantity change appends a
 * signed holding_events delta; setting quantity to 0 deactivates the row.
 *
 * A quantity change is an INPUT to this account's daily_balances (crypto-history
 * derives the curve from holding_events × closes), and a derived cache cannot
 * notice its own inputs changing — so the cache is rebuilt here, once the write
 * has committed. See shouldRebuildAfterQuantityChange for the one case where
 * rebuilding would destroy more than it fixes.
 */
export function upsertHolding(db: AppDatabase, input: HoldingInput): string {
  const parsed = holdingInputSchema.parse(input);
  const account = db.select().from(accounts).where(eq(accounts.id, parsed.accountId)).get();
  if (!account) throw new Error(`Unknown account ${parsed.accountId}`);
  if (account.type !== "investment") {
    throw new Error("Holdings belong to investment accounts only");
  }
  const occurredOn = parsed.occurredOn ?? todayIso();

  const { holdingId, quantityChanged } = db.transaction((tx) => {
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

    return { holdingId, quantityChanged: deltaE8 !== 0 };
  });

  // outside the write transaction — rebuildAccount opens its own, and a nested
  // BEGIN on a synchronous driver throws
  if (quantityChanged && shouldRebuildAfterQuantityChange(db, parsed.accountId)) {
    rebuildAccount(db, parsed.accountId);
  }
  return holdingId;
}

/**
 * An events timeline with no cached close anywhere produces NO days at all
 * (crypto-history never invents a level), so rebuilding one would delete the
 * value-anchor rows currently carrying the account and leave it absent from net
 * worth until the next price fetch. refreshPrices skips those accounts for the
 * same reason (`priced === 0 → continue`). Wait for a price; the refresh
 * rebuilds then.
 */
function shouldRebuildAfterQuantityChange(db: AppDatabase, accountId: string): boolean {
  const held = db
    .selectDistinct({ symbol: holdingEvents.symbol, assetType: holdingEvents.assetType })
    .from(holdingEvents)
    .where(eq(holdingEvents.accountId, accountId))
    .all();
  if (held.length === 0) return false;
  // each symbol resolves under its OWN asset_type, exactly as crypto-history
  // prices it — a ticker must never be answered by a same-named coin's close
  const assetOf = new Map(held.map((h) => [h.symbol, h.assetType]));
  return db
    .selectDistinct({ symbol: priceCache.symbol, assetType: priceCache.assetType })
    .from(priceCache)
    .where(inArray(priceCache.symbol, [...assetOf.keys()]))
    .all()
    .some((c) => assetOf.get(c.symbol) === c.assetType);
}

/* ── Per-account holdings view (account detail page) ────────────────── */

export interface AccountHoldingRow {
  symbol: string;
  assetType: AssetType;
  quantityE8: number;
  avgCostCents: number | null;
  latestClose: number | null;
  quotedOn: string | null;
  valueCents: number | null;
  /** value move vs the previous cached close × quantity */
  dayChangeCents: number | null;
  dayChangePct: number | null;
  plCents: number | null;
  plPct: number | null;
  /** share of THIS account's priced value (not the whole portfolio) */
  allocationPct: number | null;
}

/** Active holdings of one account with day change and within-account allocation. */
export function listAccountHoldings(db: AppDatabase, accountId: string): AccountHoldingRow[] {
  const rows = db
    .select()
    .from(holdings)
    .where(and(eq(holdings.accountId, accountId), eq(holdings.isActive, true)))
    .orderBy(asc(holdings.symbol))
    .all();

  const priced = rows.map((r) => {
    const closes = db
      .select()
      .from(priceCache)
      .where(and(eq(priceCache.symbol, r.symbol), eq(priceCache.assetType, r.assetType)))
      .orderBy(desc(priceCache.quotedOn))
      .limit(2)
      .all();
    const latest = closes[0] ?? null;
    const previous = closes[1] ?? null;

    const valueCents = latest ? valueCentsOf(r.quantityE8, latest.close) : null;
    const prevValueCents = previous ? valueCentsOf(r.quantityE8, previous.close) : null;
    const dayChangeCents =
      valueCents !== null && prevValueCents !== null ? valueCents - prevValueCents : null;
    const dayChangePct =
      dayChangeCents !== null && prevValueCents !== null && prevValueCents !== 0
        ? (dayChangeCents / prevValueCents) * 100
        : null;
    const costCents =
      r.avgCostCents != null ? Math.round((r.avgCostCents * r.quantityE8) / 1e8) : null;
    const plCents = valueCents !== null && costCents !== null ? valueCents - costCents : null;
    const plPct =
      plCents !== null && costCents !== null && costCents !== 0 ? (plCents / costCents) * 100 : null;

    return {
      symbol: r.symbol,
      assetType: r.assetType,
      quantityE8: r.quantityE8,
      avgCostCents: r.avgCostCents,
      latestClose: latest?.close ?? null,
      quotedOn: latest?.quotedOn ?? null,
      valueCents,
      dayChangeCents,
      dayChangePct,
      plCents,
      plPct,
    };
  });

  const totalValue = priced.reduce((sum, r) => sum + (r.valueCents ?? 0), 0);
  return priced.map((r) => ({
    ...r,
    allocationPct: r.valueCents !== null && totalValue > 0 ? (r.valueCents / totalValue) * 100 : null,
  }));
}
