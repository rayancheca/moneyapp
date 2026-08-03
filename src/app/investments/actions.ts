"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ASSET_TYPES } from "@/db/schema/holdings";
import { isValidIsoDate } from "@/lib/dates";
import { QuantityParseError, parseQuantityToE8, upsertHolding } from "@/services/holdings";
import {
  pnlCalendarMonth,
  pnlDayDetail,
  type PnlCalendarMonth,
  type PnlDayDetail,
} from "@/services/portfolio";
import { refreshIntraday } from "@/services/intraday";
import { backfillSymbolHistory, refreshPrices } from "@/services/prices";
import { hasBenchmark } from "@/services/portfolio";
import { readSettings, writeSetting } from "@/services/settings";
import { benchmarkAssetType, isBenchmarkOff, normalizeBenchmarkChoice } from "@/lib/benchmark-symbol";
import {
  actionErrorMessage,
  firstIssueMessage,
  parseAmountField,
  type ActionResult,
} from "@/app/transactions/action-types";

// the single-argument form reports the SAME message when the field is missing
// entirely, instead of zod's "expected string, received undefined"
const addHoldingFormSchema = z.object({
  accountId: z.string("Pick an account").min(1, "Pick an account"),
  symbol: z.string("Enter a symbol").trim().min(1, "Enter a symbol"),
  assetType: z.enum(ASSET_TYPES),
  quantity: z.string("Enter a quantity").trim().min(1, "Enter a quantity"),
  avgCost: z.string().trim().optional(),
  occurredOn: z.string().refine(isValidIsoDate, "Invalid date").optional(),
});

const HOLDING_LABELS = {
  accountId: "Account",
  symbol: "Symbol",
  assetType: "Asset type",
  quantity: "Quantity",
  avgCost: "Average cost",
  occurredOn: "Date",
  monthKey: "Month",
  day: "Day",
} as const;

/**
 * Validating core of the add-holding form: quantity, average cost and the
 * upsert all report as an {@link ActionResult}. Every one of them used to throw
 * straight out of a `<form action>`, which Next turns into an error digest that
 * replaces the page and loses the other fields.
 */
export async function addHoldingResultAction(
  formData: FormData,
): Promise<ActionResult<{ symbol: string; quantityE8: number }>> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = addHoldingFormSchema.safeParse({
    accountId: raw.accountId,
    symbol: raw.symbol,
    assetType: raw.assetType,
    quantity: raw.quantity,
    avgCost: typeof raw.avgCost === "string" && raw.avgCost !== "" ? raw.avgCost : undefined,
    occurredOn:
      typeof raw.occurredOn === "string" && raw.occurredOn !== "" ? raw.occurredOn : undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, HOLDING_LABELS) };
  }

  // quantity is parsed with string math — floats never touch it
  let quantityE8: number;
  try {
    quantityE8 = parseQuantityToE8(parsed.data.quantity);
  } catch (error: unknown) {
    if (error instanceof QuantityParseError) {
      return { ok: false, error: `${HOLDING_LABELS.quantity}: enter a number like 10 or 0.25` };
    }
    return { ok: false, error: `${HOLDING_LABELS.quantity}: could not read that quantity` };
  }

  let avgCostCents: number | null = null;
  if (parsed.data.avgCost !== undefined) {
    const amount = parseAmountField(HOLDING_LABELS.avgCost, parsed.data.avgCost);
    if (!amount.ok) return amount;
    if (amount.data < 0) return { ok: false, error: "Average cost must be positive" };
    avgCostCents = amount.data;
  }

  try {
    upsertHolding(getDb(), {
      accountId: parsed.data.accountId,
      symbol: parsed.data.symbol,
      assetType: parsed.data.assetType,
      quantityE8,
      avgCostCents,
      occurredOn: parsed.data.occurredOn,
    });
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, HOLDING_LABELS, "Could not add the holding") };
  }

  revalidatePath("/");
  revalidatePath("/investments");
  return { ok: true, data: { symbol: parsed.data.symbol, quantityE8 } };
}

export async function addHoldingAction(formData: FormData): Promise<void> {
  const result = await addHoldingResultAction(formData);
  if (result.ok) return;
  // redirect() throws NEXT_REDIRECT by design — it must stay outside any catch
  redirect(`/investments?error=${encodeURIComponent(result.error)}`);
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
    return { ok: false, error: actionErrorMessage(error, HOLDING_LABELS, "Refresh failed") };
  }
}

/**
 * Load today's intraday session for the 1D view.
 *
 * Deliberately NOT folded into `refreshPricesAction`. That flow backfills two
 * years of daily closes, quotes every symbol and re-anchors net worth — the
 * dashboard number depends on it. Intraday feeds one chart window on one
 * surface and nothing depends on it, so joining them would make every net-worth
 * refresh pay for a chart nobody may open and would put a five-minute tick on
 * the same failure path as the headline. `prices.test.ts` asserts that
 * separation directly ("refresh must not fetch intraday"); this keeps it true.
 *
 * `refreshIntraday` collects per-symbol failures rather than throwing, so a
 * delisted ticker or a provider outage degrades to whatever ticked.
 */
export async function refreshIntradayAction(): Promise<
  ActionResult<{ symbols: number; ticks: number; errors: string[] }>
> {
  try {
    const result = await refreshIntraday(getDb());
    revalidatePath("/investments");
    revalidatePath("/investments/[assetType]/[symbol]", "page");
    return {
      ok: true,
      data: { symbols: result.symbols, ticks: result.ticks, errors: result.errors },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: actionErrorMessage(error, HOLDING_LABELS, "Couldn't load today's session"),
    };
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
  const symbol = normalizeBenchmarkChoice(symbolInput);
  if (symbol === null) {
    return { ok: false, error: "Symbols are 1–12 letters, digits, dots, or dashes" };
  }
  const db = getDb();
  // "No comparison" persists like any other choice but has no price history and
  // must never reach a provider — return before the backfill/hasBenchmark path,
  // which would try to fetch a ticker named "__none" and fail.
  if (isBenchmarkOff(symbol)) {
    try {
      if (readSettings(db).benchmarkSymbol !== symbol) writeSetting(db, "benchmarkSymbol", symbol);
      revalidatePath("/investments");
      return { ok: true, data: { symbol } };
    } catch (error: unknown) {
      return { ok: false, error: actionErrorMessage(error, HOLDING_LABELS, "Couldn't set the benchmark") };
    }
  }
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
    return { ok: false, error: actionErrorMessage(error, HOLDING_LABELS, "Couldn't set the benchmark") };
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
    // a ZodError's own message is a JSON dump of the issue array — unwrap it
    return { ok: false, error: actionErrorMessage(error, HOLDING_LABELS, "Failed to load month") };
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
    return { ok: false, error: actionErrorMessage(error, HOLDING_LABELS, "Failed to load day") };
  }
}
