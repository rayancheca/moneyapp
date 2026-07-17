"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ASSET_TYPES } from "@/db/schema/holdings";
import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { parseQuantityToE8, upsertHolding } from "@/services/holdings";
import {
  pnlCalendarMonth,
  pnlDayDetail,
  type PnlCalendarMonth,
  type PnlDayDetail,
} from "@/services/portfolio";
import { backfillSymbolHistory, refreshPrices } from "@/services/prices";
import { hasBenchmark } from "@/services/portfolio";
import { readSettings, writeSetting } from "@/services/settings";
import { benchmarkAssetType, normalizeBenchmarkSymbol } from "@/lib/benchmark-symbol";
import type { ActionResult } from "@/app/transactions/action-types";

const addHoldingFormSchema = z.object({
  accountId: z.string().min(1, "Pick an account"),
  symbol: z.string().trim().min(1, "Enter a symbol"),
  assetType: z.enum(ASSET_TYPES),
  quantity: z.string().trim().min(1, "Enter a quantity"),
  avgCost: z.string().trim().optional(),
  occurredOn: z.string().refine(isValidIsoDate, "Invalid date").optional(),
});

export async function addHoldingAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = addHoldingFormSchema.parse({
    accountId: raw.accountId,
    symbol: raw.symbol,
    assetType: raw.assetType,
    quantity: raw.quantity,
    avgCost: typeof raw.avgCost === "string" && raw.avgCost !== "" ? raw.avgCost : undefined,
    occurredOn:
      typeof raw.occurredOn === "string" && raw.occurredOn !== "" ? raw.occurredOn : undefined,
  });

  // quantity is parsed with string math — floats never touch it
  const quantityE8 = parseQuantityToE8(parsed.quantity);
  const avgCostCents = parsed.avgCost !== undefined ? parseAmountToCents(parsed.avgCost) : null;
  if (avgCostCents !== null && avgCostCents < 0) {
    throw new Error("Average cost must be positive");
  }

  upsertHolding(getDb(), {
    accountId: parsed.accountId,
    symbol: parsed.symbol,
    assetType: parsed.assetType,
    quantityE8,
    avgCostCents,
    occurredOn: parsed.occurredOn,
  });

  revalidatePath("/");
  revalidatePath("/investments");
}

export interface RefreshPricesSummary {
  /** symbols that got a live quote at press time */
  quotedSymbols: number;
  /** new daily-close rows fetched to fill the gap since the last cached day */
  backfilledRows: number;
  /** ISO timestamp of the fetch — the "prices as of …" stamp */
  asOf: string;
  /** provider failures that degraded to cached prices (never fatal) */
  errors: string[];
}

/**
 * The manual "Refresh prices" press: `force` bypasses the staleness window so it
 * pulls a LIVE quote at the exact press time, then revalidates the dashboard +
 * investments. Provider outages degrade to cached prices (reported in `errors`),
 * so a refresh never takes the page down (Phase 7 acceptance); only an
 * unexpected failure returns `{ ok: false }`.
 */
export async function refreshPricesAction(): Promise<ActionResult<RefreshPricesSummary>> {
  try {
    const result = await refreshPrices(getDb(), { force: true });
    revalidatePath("/");
    revalidatePath("/investments");
    return {
      ok: true,
      data: {
        quotedSymbols: result.quotedSymbols,
        backfilledRows: result.backfilledRows,
        asOf: result.asOf,
        errors: result.errors,
      },
    };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Refresh failed" };
  }
}

/**
 * Pick the Return views' comparison benchmark (Robinhood-parity item 4).
 * Validates the ticker shape, backfills 2y of daily closes for a symbol the
 * user doesn't hold (fake provider under MONEYAPP_FAKE_PRICES), and persists
 * ONLY when price history actually exists — a typo'd or unpriceable symbol is
 * rejected with the reason, never silently saved as a blank overlay.
 */
export async function setBenchmarkAction(symbolInput: string): Promise<ActionResult<{ symbol: string }>> {
  const symbol = normalizeBenchmarkSymbol(symbolInput);
  if (symbol === null) {
    return { ok: false, error: "Symbols are 1–12 letters, digits, dots, or dashes" };
  }
  const db = getDb();
  try {
    if (!hasBenchmark(db, symbol)) {
      try {
        await backfillSymbolHistory(db, symbol, benchmarkAssetType(symbol));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `Couldn't fetch price history for ${symbol}: ${detail}` };
      }
    }
    if (!hasBenchmark(db, symbol)) {
      return { ok: false, error: `No price history found for ${symbol}` };
    }
    // the persist path (readSettings/writeSetting) can throw too — keep it inside
    // the guard so a write failure returns {ok:false} the picker can surface,
    // never a rejected transition that silently does nothing.
    if (readSettings(db).benchmarkSymbol !== symbol) {
      writeSetting(db, "benchmarkSymbol", symbol);
    }
    revalidatePath("/investments");
    return { ok: true, data: { symbol } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Couldn't set the benchmark" };
  }
}

// ─── P/L calendar (read-only slice loaders, §6.3) ──────────────────────────

const monthSchema = z.object({ monthKey: z.string().regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM") });

export async function loadPnlMonthAction(
  input: z.input<typeof monthSchema>,
): Promise<ActionResult<PnlCalendarMonth>> {
  try {
    const { monthKey } = monthSchema.parse(input);
    return { ok: true, data: pnlCalendarMonth(getDb(), monthKey) };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to load month" };
  }
}

const daySchema = z.object({ day: z.string().refine(isValidIsoDate, "Expected a valid date") });

export async function loadPnlDayAction(
  input: z.input<typeof daySchema>,
): Promise<ActionResult<PnlDayDetail>> {
  try {
    const { day } = daySchema.parse(input);
    return { ok: true, data: pnlDayDetail(getDb(), day) };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to load day" };
  }
}
