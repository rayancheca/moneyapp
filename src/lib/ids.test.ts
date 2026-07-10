import { describe, expect, test, vi } from "vitest";
import { uuidv7 } from "./ids";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  test("matches the v7 format with RFC variant", () => {
    for (let i = 0; i < 100; i++) {
      expect(uuidv7()).toMatch(UUID_RE);
    }
  });

  test("encodes the timestamp in the first 48 bits", () => {
    const at = Date.UTC(2026, 6, 8, 12, 0, 0);
    const id = uuidv7(at);
    const tsHex = id.slice(0, 8) + id.slice(9, 13);
    expect(Number.parseInt(tsHex, 16)).toBe(at);
  });

  test("later timestamps sort lexicographically after earlier ones", () => {
    const earlier = uuidv7(1_000_000_000_000);
    const later = uuidv7(2_000_000_000_000);
    expect(later > earlier).toBe(true);
  });

  test("no collisions across 10k ids at one timestamp", () => {
    const at = Date.now();
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(uuidv7(at));
    expect(seen.size).toBe(10_000);
  });

  // uuidv7 keeps a module-level monotonic clock (lastMs/counter). These two
  // tests assert same-ms ordering, which is only well-defined from a pristine
  // clock — otherwise an earlier call with a higher timestamp (e.g. the
  // overflow test, or a non-isolated coverage run) leaves lastMs above `at`,
  // pushing uuidv7 onto the past-timestamp branch (counter 0, random tail) and
  // making the ascent nondeterministic. Reset the module so each starts fresh.
  test("same-millisecond ids ascend strictly (monotonic counter)", async () => {
    vi.resetModules();
    const { uuidv7: fresh } = await import("./ids");
    const at = 3_000_000_000_000;
    const ids = Array.from({ length: 100 }, () => fresh(at));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!, `id ${i} ascends`).toBe(true);
    }
  });

  test("counter overflow borrows the next millisecond instead of colliding", async () => {
    vi.resetModules();
    const { uuidv7: fresh } = await import("./ids");
    const at = 3_100_000_000_000;
    let last = fresh(at);
    for (let i = 0; i < 0x1000; i++) {
      const next = fresh(at);
      expect(next > last).toBe(true);
      last = next;
    }
    const tsHex = last.slice(0, 8) + last.slice(9, 13);
    expect(Number.parseInt(tsHex, 16)).toBe(at + 1);
  });

  test("an explicit past timestamp is encoded faithfully", () => {
    const past = Date.UTC(2025, 0, 1);
    const id = uuidv7(past);
    const tsHex = id.slice(0, 8) + id.slice(9, 13);
    expect(Number.parseInt(tsHex, 16)).toBe(past);
  });
});
