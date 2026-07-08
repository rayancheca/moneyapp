import { describe, expect, test } from "vitest";
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
});
