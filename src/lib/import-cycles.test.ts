import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSpecifier, valueImportsOf, type SourceTree } from "./client-bundle-graph";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const TREE: SourceTree = {
  read(relative) {
    const absolute = path.join(REPO, relative);
    try {
      return statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : undefined;
    } catch {
      return undefined;
    }
  },
};

/** Every source module under src, and the source modules it imports a VALUE from — the edges a bundler walks. */
function valueImportGraph(): Map<string, string[]> {
  const files = readdirSync(path.join(REPO, "src"), { recursive: true, encoding: "utf8" })
    .map((relative) => path.posix.join("src", relative.split(path.sep).join("/")))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
  return new Map(
    files.map((file) => [
      file,
      valueImportsOf(file, TREE.read(file)!).flatMap((specifier) => {
        const resolved = resolveSpecifier(TREE, file, specifier);
        return resolved.kind === "module" ? [resolved.path] : [];
      }),
    ]),
  );
}

/** The groups of modules that import one another round a loop: strongly connected components of two or more. */
function cyclicGroups(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const group: string[] = [];
    for (let w = stack.pop()!; ; w = stack.pop()!) {
      onStack.delete(w);
      group.push(w);
      if (w === v) break;
    }
    if (group.length > 1) groups.push(group.sort());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return groups.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

/*
 * 🔴 Review of 43a66c99 (2026-10-30): the lines left out and their one writer imported each other — harmless while
 * neither touched the other at module scope, an uninitialised binding the day one did — and batch 9 F broke that one
 * cycle with a gate for its one edge, which a relative path walked round (the review of batch 9 F, 2026-10-30). Its
 * fixer found two more: a 12-module group and a 6-module one. Two edges were constants and pure helpers imported
 * through a module that imports the derivation — the baseline's window from `committed`, the account sides from
 * `accounts`, `valueCentsOf` through `holdings` — and each lives in a leaf now. What is left is recurring's own: it
 * reads the billing carriers, the earnings, the settlement and the posted average, and each reads its schedule back
 * (`effectiveSeries`, `projectOccurrences`…). Breaking it is moving recurring's schedule into a module of its own —
 * not a small change, and named here so the group can only shrink: a new loop anywhere in src fails this test.
 */
describe("the import cycles left in src", () => {
  it("are recurring's own five — and no other module joins a loop", () => {
    expect(cyclicGroups(valueImportGraph())).toEqual([
      [
        "src/services/billing-carriers.ts",
        "src/services/cash-earnings.ts",
        "src/services/payday-settlement.ts",
        "src/services/posted-average.ts",
        "src/services/recurring.ts",
      ],
    ]);
  });

  it("a loop two modules make is found, by any path either one writes", () => {
    const graph = new Map([
      ["src/a.ts", ["src/b.ts"]],
      ["src/b.ts", ["src/a.ts", "src/c.ts"]],
      ["src/c.ts", []],
    ]);
    expect(cyclicGroups(graph)).toEqual([["src/a.ts", "src/b.ts"]]);
  });
});
