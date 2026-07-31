import { describe, expect, test } from "vitest";
import {
  BENCHMARK_PRESETS,
  NO_BENCHMARK,
  isBenchmarkOff,
  normalizeBenchmarkChoice,
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

/**
 * "Just my return" — comparison as an opt-in rather than something the resolver
 * forces on you. The sentinel's whole job is to be a choice the user can make
 * that no ticker can impersonate, so these tests are mostly about the boundary
 * between "a symbol" and "the absence of one".
 */
describe("no benchmark", () => {
  test("the sentinel is not a legal ticker, so nothing a user types can collide", () => {
    expect(normalizeBenchmarkSymbol(NO_BENCHMARK)).toBeNull();
    // including the word someone would most plausibly try
    expect(normalizeBenchmarkSymbol("NONE")).toBe("NONE");
    expect(isBenchmarkOff("NONE")).toBe(false);
  });

  test("normalizeBenchmarkChoice accepts the sentinel where a plain symbol would not", () => {
    expect(normalizeBenchmarkChoice(NO_BENCHMARK)).toBe(NO_BENCHMARK);
    expect(normalizeBenchmarkChoice("spy")).toBe("SPY");
    expect(normalizeBenchmarkChoice("not a ticker!")).toBeNull();
    expect(normalizeBenchmarkChoice(undefined)).toBeNull();
  });

  test("it survives the URL > persisted > default resolution from either layer", () => {
    expect(resolveBenchmarkSymbol(NO_BENCHMARK, "SPY")).toBe(NO_BENCHMARK);
    expect(resolveBenchmarkSymbol(undefined, NO_BENCHMARK)).toBe(NO_BENCHMARK);
    // and an explicit URL choice still beats a persisted "off"
    expect(resolveBenchmarkSymbol("QQQ", NO_BENCHMARK)).toBe("QQQ");
  });

  test("it labels as None rather than leaking the sentinel into the UI", () => {
    expect(benchmarkLabel(NO_BENCHMARK)).toBe("None");
  });

  test("isBenchmarkOff is true only for the sentinel", () => {
    expect(isBenchmarkOff(NO_BENCHMARK)).toBe(true);
    for (const p of BENCHMARK_PRESETS) expect(isBenchmarkOff(p.symbol)).toBe(false);
  });
});
