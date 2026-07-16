import { describe, expect, test } from "vitest";
import {
  BENCHMARK_PRESETS,
  DEFAULT_BENCHMARK,
  benchmarkAssetType,
  benchmarkLabel,
  normalizeBenchmarkSymbol,
  resolveBenchmarkSymbol,
} from "./benchmark-symbol";

describe("normalizeBenchmarkSymbol", () => {
  test("trims, uppercases, and accepts ticker-shaped symbols", () => {
    expect(normalizeBenchmarkSymbol(" qqq ")).toBe("QQQ");
    expect(normalizeBenchmarkSymbol("brk.b")).toBe("BRK.B");
    expect(normalizeBenchmarkSymbol("BTC-USD")).toBe("BTC-USD");
  });

  test("rejects empty, overlong, and garbage input", () => {
    expect(normalizeBenchmarkSymbol("")).toBeNull();
    expect(normalizeBenchmarkSymbol("   ")).toBeNull();
    expect(normalizeBenchmarkSymbol("THIRTEENCHARS")).toBeNull();
    expect(normalizeBenchmarkSymbol("SPY; DROP")).toBeNull();
    expect(normalizeBenchmarkSymbol(undefined)).toBeNull();
    expect(normalizeBenchmarkSymbol(42)).toBeNull();
  });
});

describe("resolveBenchmarkSymbol", () => {
  test("URL beats persisted beats the SPY default", () => {
    expect(resolveBenchmarkSymbol("qqq", "VTI")).toBe("QQQ");
    expect(resolveBenchmarkSymbol(undefined, "VTI")).toBe("VTI");
    expect(resolveBenchmarkSymbol(undefined, undefined)).toBe(DEFAULT_BENCHMARK);
  });

  test("invalid layers fall through, never throw", () => {
    expect(resolveBenchmarkSymbol("not a symbol!", "VTI")).toBe("VTI");
    expect(resolveBenchmarkSymbol("not a symbol!", "also bad!")).toBe(DEFAULT_BENCHMARK);
  });
});

describe("benchmarkLabel / benchmarkAssetType", () => {
  test("presets carry friendly labels and their provider route", () => {
    expect(benchmarkLabel("SPY")).toBe("S&P 500");
    expect(benchmarkLabel("BTC")).toBe("Bitcoin");
    expect(benchmarkAssetType("BTC")).toBe("crypto");
    expect(benchmarkAssetType("QQQ")).toBe("etf");
  });

  test("a custom symbol is its own label and routes to the equity provider", () => {
    expect(benchmarkLabel("VXUS")).toBe("VXUS");
    expect(benchmarkAssetType("VXUS")).toBe("etf");
  });

  test("every preset symbol survives its own normalization", () => {
    for (const p of BENCHMARK_PRESETS) {
      expect(normalizeBenchmarkSymbol(p.symbol)).toBe(p.symbol);
    }
  });
});
