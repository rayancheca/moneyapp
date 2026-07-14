import { describe, expect, it } from "vitest";
import { moveItem, normalizeOrder } from "./reorder";

describe("moveItem", () => {
  it("moves forward and backward, returning a new array", () => {
    const list = ["a", "b", "c", "d"];
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(list).toEqual(["a", "b", "c", "d"]); // untouched
  });

  it("clamps out-of-range indices and no-ops on same position", () => {
    expect(moveItem(["a", "b"], -5, 1)).toEqual(["b", "a"]);
    expect(moveItem(["a", "b"], 1, 99)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveItem([], 0, 1)).toEqual([]);
  });
});

describe("normalizeOrder", () => {
  it("keeps the saved order for known ids", () => {
    expect(normalizeOrder(["c", "a", "b"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  });

  it("drops unknown ids and appends missing ones in canonical order", () => {
    expect(normalizeOrder(["ghost", "c", "a"], ["a", "b", "c", "d"])).toEqual(["c", "a", "b", "d"]);
    expect(normalizeOrder([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("dedupes a corrupted saved order — the result holds exactly the canonical ids", () => {
    expect(normalizeOrder(["a", "a", "b", "a"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});
