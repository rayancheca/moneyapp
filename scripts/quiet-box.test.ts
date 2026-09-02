import { describe, expect, test } from "vitest";
import {
  assertQuietBox,
  LOAD_PER_CORE_REFUSE,
  LOAD_PER_CORE_WARN,
  quietBoxMessage,
  readBoxLoad,
} from "./quiet-box";

describe("readBoxLoad", () => {
  test("the box that cost 2.9 hours is refused", () => {
    // measured 2026-09-01: uptime 44.65 on a 15-core Mac
    expect(readBoxLoad(44.65, 15).verdict).toBe("overloaded");
  });

  test("an idle box is quiet, and a working one is merely busy", () => {
    expect(readBoxLoad(4.2, 15).verdict).toBe("quiet");
    expect(readBoxLoad(15, 15).verdict).toBe("busy");
  });

  /** Both thresholds, from each side, so neither can drift unnoticed. */
  test("the thresholds are exactly where they say they are", () => {
    const cores = 10;
    expect(readBoxLoad(LOAD_PER_CORE_WARN * cores, cores).verdict).toBe("busy");
    expect(readBoxLoad(LOAD_PER_CORE_WARN * cores - 0.01, cores).verdict).toBe("quiet");
    expect(readBoxLoad(LOAD_PER_CORE_REFUSE * cores, cores).verdict).toBe("overloaded");
    expect(readBoxLoad(LOAD_PER_CORE_REFUSE * cores - 0.01, cores).verdict).toBe("busy");
  });

  /**
   * ⛔ A ZERO CORE COUNT MUST NOT REFUSE EVERY RUN. `os.cpus()` can return an
   * empty array in a container, and dividing by it would make an idle machine
   * look infinitely loaded — a guard that blocks every run is worse than none.
   */
  test("a machine that reports no cores is treated as one, not as zero", () => {
    expect(readBoxLoad(0.5, 0)).toMatchObject({ cores: 1, perCore: 0.5, verdict: "quiet" });
  });
});

describe("assertQuietBox", () => {
  const busy = { suite: "vitest", escapeHatch: "TEST_ALLOW_LOAD", load1: 44.65, cores: 15 };

  test("throws on an overloaded box, and names the escape hatch", () => {
    expect(() => assertQuietBox({ ...busy, env: {} })).toThrow(/TEST_ALLOW_LOAD=1/);
    expect(() => assertQuietBox({ ...busy, env: {} })).toThrow(/44\.[67] across 15 cores/u);
  });

  test("the escape hatch is honoured, and only for its own name", () => {
    expect(assertQuietBox({ ...busy, env: { TEST_ALLOW_LOAD: "1" } }).verdict).toBe("overloaded");
    expect(() => assertQuietBox({ ...busy, env: { TEST_ALLOW_LOAD: "yes" } })).toThrow();
    expect(() => assertQuietBox({ ...busy, env: { OTHER: "1" } })).toThrow();
  });

  test("a busy-but-workable box returns its reading instead of throwing", () => {
    const load = assertQuietBox({ ...busy, load1: 12, env: {} });
    expect(load.verdict).toBe("busy");
  });
});

describe("quietBoxMessage", () => {
  test("says what is wrong, what it cost last time, and how to override", () => {
    const msg = quietBoxMessage(readBoxLoad(44.65, 15), "e2e", "E2E_ALLOW_LOAD");
    expect(msg).toContain("THE BOX IS ALREADY BUSY");
    expect(msg).toContain("2.9 HOURS");
    expect(msg).toContain("E2E_ALLOW_LOAD=1");
  });
});
