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

/** Same shape the holdings form allows: letters, digits, dots, dashes. */
const SYMBOL_RE = /^[A-Z0-9.\-]{1,12}$/;

/** Trimmed + uppercased ticker, or null when the input isn't symbol-shaped. */
export function normalizeBenchmarkSymbol(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const symbol = input.trim().toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

/** URL param > persisted preference > SPY — invalid layers fall through. */
export function resolveBenchmarkSymbol(
  urlValue: string | undefined,
  persisted: string | undefined,
): string {
  return (
    normalizeBenchmarkSymbol(urlValue) ?? normalizeBenchmarkSymbol(persisted) ?? DEFAULT_BENCHMARK
  );
}

/** The preset's friendly label, or the raw symbol for a custom pick. */
export function benchmarkLabel(symbol: string): string {
  return BENCHMARK_PRESETS.find((p) => p.symbol === symbol)?.label ?? symbol;
}

/** Which provider prices this benchmark (custom symbols → equity/ETF). */
export function benchmarkAssetType(symbol: string): "etf" | "crypto" {
  return BENCHMARK_PRESETS.find((p) => p.symbol === symbol)?.assetType ?? "etf";
}
