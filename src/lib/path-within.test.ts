import { describe, expect, test } from "vitest";
import { isWithin } from "./path-within";

describe("isWithin — a path is its parent or below it, by path component", () => {
  test("the folder itself and anything under it", () => {
    expect(isWithin("/repo/data/statements", "/repo/data/statements")).toBe(true);
    expect(isWithin("/repo/data/statements/chase-1111/a.pdf", "/repo/data/statements")).toBe(true);
    // a name that merely begins with two dots is a file, not a climb
    expect(isWithin("/repo/data/statements/..hidden", "/repo/data/statements")).toBe(true);
  });

  test("a sibling sharing the name as a prefix, the parent, and another tree are not", () => {
    expect(isWithin("/repo/data/statements-staged/a.pdf", "/repo/data/statements")).toBe(false);
    expect(isWithin("/repo/data", "/repo/data/statements")).toBe(false);
    expect(isWithin("/repo/.trial/originals/a.pdf", "/repo/data/statements")).toBe(false);
  });

  test("written with `..`, a path is where it leads", () => {
    expect(isWithin("/repo/data/statements/../backups", "/repo/data/statements")).toBe(false);
    expect(isWithin("/repo/data/backups/../statements/a.pdf", "/repo/data/statements")).toBe(true);
  });

  test("relative paths are both read from the working directory", () => {
    expect(isWithin("data/statements/chase-1111", "data/statements")).toBe(true);
    expect(isWithin("data/backups", "data/statements")).toBe(false);
  });
});
