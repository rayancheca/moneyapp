/**
 * Benchmark selection (Robinhood-parity item 4). Pure: validation, the preset
 * registry, and the URL > persisted > default resolution — mirroring the
 * view-state precedence, but as its own validated value because a CUSTOM
 * ticker cannot be an enumerated ViewSpec option.
 *
 * Custom symbols route to the equity/ETF provider (Yahoo prices most tickers);
 * only the BTC preset routes to the crypto provider — picking an arbitrary
 * coin needs the preset treatment, not a guess about which provider owns it.
 */

export interface BenchmarkPreset {
  symbol: string;
  label: string;
  assetType: "etf" | "crypto";
}

export const BENCHMARK_PRESETS: readonly BenchmarkPreset[] = [
  { symbol: "SPY", label: "S&P 500", assetType: "etf" },
  { symbol: "QQQ", label: "Nasdaq 100", assetType: "etf" },
  { symbol: "VTI", label: "Total US Market", assetType: "etf" },
  { symbol: "BTC", label: "Bitcoin", assetType: "crypto" },
];

export const DEFAULT_BENCHMARK = "SPY";

/**
 * "Show my performance alone" — a first-class choice, not the absence of one.
 *
 * Comparison used to be mandatory: the resolver fell through to SPY, so there
 * was no way to ask the chart what YOUR return did without a market line drawn
 * over it. Owner, 2026-07-31: *"i am forced to compare my performance to
 * something. what if i want to see just my performance."*
 *
 * The sentinel deliberately contains underscores, which `SYMBOL_RE` rejects, so
 * it can never collide with a ticker a user might type — including one literally
 * spelled "NONE". Every layer that turns a symbol into data must check this
 * first: it has no price history and must never be sent to a provider.
 */
export const NO_BENCHMARK = "__none";

/** Is the user asking for no comparison line at all? */
export function isBenchmarkOff(symbol: string): boolean {
  return symbol === NO_BENCHMARK;
}

/** Same shape the holdings form allows: letters, digits, dots, dashes. */
const SYMBOL_RE = /^[A-Z0-9.\-]{1,12}$/;

/** Trimmed + uppercased ticker, or null when the input isn't symbol-shaped. */
export function normalizeBenchmarkSymbol(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const symbol = input.trim().toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

/**
 * A symbol OR the off sentinel, for the layers that accept both (the resolver,
 * the persist action). Kept separate from `normalizeBenchmarkSymbol` so the
 * places that genuinely need a priceable ticker — the provider calls — cannot
 * accidentally be handed the sentinel.
 */
export function normalizeBenchmarkChoice(input: unknown): string | null {
  if (input === NO_BENCHMARK) return NO_BENCHMARK;
  return normalizeBenchmarkSymbol(input);
}

/** URL param > persisted preference > SPY — invalid layers fall through. */
export function resolveBenchmarkSymbol(
  urlValue: string | undefined,
  persisted: string | undefined,
): string {
  return (
    normalizeBenchmarkChoice(urlValue) ?? normalizeBenchmarkChoice(persisted) ?? DEFAULT_BENCHMARK
  );
}

/** The preset's friendly label, or the raw symbol for a custom pick. */
export function benchmarkLabel(symbol: string): string {
  if (isBenchmarkOff(symbol)) return "None";
  return BENCHMARK_PRESETS.find((p) => p.symbol === symbol)?.label ?? symbol;
}

/** Which provider prices this benchmark (custom symbols → equity/ETF). */
export function benchmarkAssetType(symbol: string): "etf" | "crypto" {
  return BENCHMARK_PRESETS.find((p) => p.symbol === symbol)?.assetType ?? "etf";
}
