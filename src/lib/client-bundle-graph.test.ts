import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findClientBundleLeaks,
  formatLeak,
  isClientModule,
  resolveSpecifier,
  valueImportsOf,
  type ForbiddenTargets,
  type SourceTree,
} from "./client-bundle-graph";

/* ── The real tree ──────────────────────────────────────────────────── */

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

/** Reads the working tree; a directory or a missing path is "no file". */
const REAL_TREE: SourceTree = {
  read(relative) {
    const absolute = path.join(REPO, relative);
    try {
      return statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : undefined;
    } catch {
      return undefined;
    }
  },
};

/** A tree with some files added over the real one — how a leak is staged without touching the repo. */
function overlay(base: SourceTree, extra: Record<string, string>): SourceTree {
  return { read: (relative) => extra[relative] ?? base.read(relative) };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(REPO, dir), { recursive: true, encoding: "utf8" })
    .map((relative) => path.posix.join(dir, relative.split(path.sep).join("/")))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .sort();
}

/**
 * What a browser bundle cannot hold — MEASURED, not assumed. Each specifier was
 * imported on its own into SpendHeatmap.tsx on a scratch copy of 25b9435 and
 * built with `next build` (Next 16.2.10, Turbopack), 2026-09-15:
 *
 *   fails the build                     builds (Turbopack polyfills it)
 *   ─────────────────────────────────   ─────────────────────────────────
 *   fs, node:fs, node:fs/promises       path, node:path
 *   better-sqlite3                      node:crypto
 *   drizzle-orm/better-sqlite3
 *   @/db/client, @/db/backup
 *
 * `path` and `node:crypto` are NOT here because they do not break anything:
 * 13 client roots reach node:crypto today (EditAccountSheet → db/schema/accounts
 * → db/schema/common → lib/ids) and main builds. The two db files are listed
 * even though what breaks is the fs/better-sqlite3 they import, so a leak is
 * reported at the module a reader recognises rather than inside it.
 */
const BROWSER_FORBIDDEN: ForbiddenTargets = {
  files: ["src/db/backup.ts", "src/db/client.ts"],
  packages: ["better-sqlite3", "drizzle-orm/better-sqlite3", "fs", "node:fs"],
};

function clientRoots(tree: SourceTree): string[] {
  return sourceFiles("src").filter((file) => isClientModule(file, tree.read(file)!));
}

describe("no client bundle reaches the database or the filesystem", () => {
  it("finds the client components — a walk from no roots is clean by construction", () => {
    const roots = clientRoots(REAL_TREE);
    expect(roots.length).toBeGreaterThan(100);
    expect(roots).toContain("src/components/spending/SpendHeatmap.tsx");
  });

  it("on this tree, no \"use client\" file reaches a forbidden module through value imports", () => {
    const leaks = findClientBundleLeaks(REAL_TREE, clientRoots(REAL_TREE), BROWSER_FORBIDDEN);
    expect(leaks.map(formatLeak)).toEqual([]);
  });

  it("names the whole chain when a client component reaches db/backup through a service", () => {
    // Staged over the REAL service graph: manual-transactions imports the pre-mutation snapshot.
    const staged = "src/components/zz-staged-leak.tsx";
    const tree = overlay(REAL_TREE, {
      [staged]: `"use client";\nimport { isCashWallet } from "@/services/manual-transactions";\nexport const x = isCashWallet;\n`,
    });
    const leaks = findClientBundleLeaks(tree, [staged], BROWSER_FORBIDDEN);
    expect(leaks.map(formatLeak)).toContain(
      `${staged} → src/services/manual-transactions.ts → src/db/backup.ts`,
    );
  });
});

/* ── The walker, on trees small enough to read ──────────────────────── */

function treeOf(files: Record<string, string>): SourceTree {
  return { read: (relative) => files[relative] };
}

const NONE: ForbiddenTargets = { files: [], packages: [] };

describe("isClientModule", () => {
  it("is true for the directive, after a leading comment, and beside another directive", () => {
    expect(isClientModule("a.tsx", `"use client";\nexport const a = 1;`)).toBe(true);
    expect(isClientModule("a.ts", `/** docs */\n// more\n'use client'\nexport const a = 1;`)).toBe(true);
    expect(isClientModule("a.ts", `"use strict";\n"use client";\n`)).toBe(true);
  });

  it("is false when the words appear anywhere but the prologue", () => {
    expect(isClientModule("a.ts", `// "use client"\nexport const a = 1;`)).toBe(false);
    expect(isClientModule("a.ts", `import x from "x";\n"use client";\n`)).toBe(false);
    expect(isClientModule("a.ts", `export const note = "use client";`)).toBe(false);
    expect(isClientModule("a.ts", `"use server";\n`)).toBe(false);
  });
});

describe("valueImportsOf", () => {
  it("follows every form that puts a module in the bundle", () => {
    const text = [
      `import a from "default";`,
      `import * as b from "namespace";`,
      `import { c } from "named";`,
      `import { type T, d } from "mixed";`,
      `import e, { type U } from "default-and-type";`,
      `import "side-effect";`,
      `export * from "star";`,
      `export * as f from "star-as";`,
      `export { g } from "re-export";`,
      `export { type V, h } from "re-export-mixed";`,
      `async function later() { return import("dynamic"); }`,
    ].join("\n");
    expect(valueImportsOf("a.ts", text)).toEqual([
      "default",
      "namespace",
      "named",
      "mixed",
      "default-and-type",
      "side-effect",
      "star",
      "star-as",
      "re-export",
      "re-export-mixed",
      "dynamic",
    ]);
  });

  it("skips everything the compiler erases", () => {
    const text = [
      `import type A from "type-default";`,
      `import type { B } from "type-named";`,
      `import { type C, type D } from "all-specifiers-typed";`,
      `export type { E } from "type-re-export";`,
      `export { type F } from "all-re-exports-typed";`,
      `type G = typeof import("type-query");`,
      `export { local };`,
      `const local = 1;`,
      `const notImport = require;`,
      `function call(f: (x: string) => void) { f("not-a-specifier"); }`,
      `async function noLiteral(m: string) { return import(m); }`,
      `async function noArgument() { return (import as never)(); }`,
    ].join("\n");
    expect(valueImportsOf("a.ts", text)).toEqual([]);
  });

  it("lists a specifier once however many times it is imported", () => {
    expect(valueImportsOf("a.tsx", `import { a } from "m";\nimport { b } from "m";\nconst C = () => <div />;`)).toEqual(["m"]);
  });
});

describe("resolveSpecifier", () => {
  const tree = treeOf({
    "src/lib/a.ts": "",
    "src/lib/b.tsx": "",
    "src/lib/dir/index.ts": "",
    "src/lib/dirx/index.tsx": "",
    "src/lib/icons.generated.ts": "",
    "src/app/sheet.module.css": "",
  });

  it("maps @/ to src/ and tries .ts, .tsx, then an index", () => {
    expect(resolveSpecifier(tree, "src/app/page.tsx", "@/lib/a")).toEqual({ kind: "module", path: "src/lib/a.ts" });
    expect(resolveSpecifier(tree, "src/app/page.tsx", "@/lib/b")).toEqual({ kind: "module", path: "src/lib/b.tsx" });
    expect(resolveSpecifier(tree, "src/app/page.tsx", "@/lib/dir")).toEqual({ kind: "module", path: "src/lib/dir/index.ts" });
    expect(resolveSpecifier(tree, "src/app/page.tsx", "@/lib/dirx")).toEqual({ kind: "module", path: "src/lib/dirx/index.tsx" });
  });

  it("resolves relative paths against the importing file, dots and all", () => {
    expect(resolveSpecifier(tree, "src/lib/dir/index.ts", "../a")).toEqual({ kind: "module", path: "src/lib/a.ts" });
    expect(resolveSpecifier(tree, "src/lib/a.ts", "./icons.generated")).toEqual({ kind: "module", path: "src/lib/icons.generated.ts" });
    expect(resolveSpecifier(tree, "src/lib/a.ts", "./b.tsx")).toEqual({ kind: "module", path: "src/lib/b.tsx" });
    expect(resolveSpecifier(tree, "src/lib/a.ts", ".//./dir")).toEqual({ kind: "module", path: "src/lib/dir/index.ts" });
  });

  it("stops at a non-source asset and hands a bare specifier back as a package", () => {
    expect(resolveSpecifier(tree, "src/app/page.tsx", "./sheet.module.css")).toEqual({ kind: "asset", path: "src/app/sheet.module.css" });
    expect(resolveSpecifier(tree, "src/app/page.tsx", "node:fs")).toEqual({ kind: "package", specifier: "node:fs" });
    expect(resolveSpecifier(tree, "src/app/page.tsx", "drizzle-orm/sqlite-core")).toEqual({ kind: "package", specifier: "drizzle-orm/sqlite-core" });
  });

  it("refuses a local specifier that resolves to nothing, naming the importer", () => {
    expect(() => resolveSpecifier(tree, "src/app/page.tsx", "@/lib/gone")).toThrow(
      `src/app/page.tsx imports "@/lib/gone", which resolves to no file`,
    );
  });
});

describe("findClientBundleLeaks", () => {
  const forbidden: ForbiddenTargets = { files: ["src/db/client.ts"], packages: ["better-sqlite3", "node:fs"] };

  it("reports the shortest chain from the root to a forbidden file, and does not walk past it", () => {
    const tree = treeOf({
      "src/c.tsx": `"use client";\nimport { a } from "./a";\nimport { b } from "./b";`,
      "src/a.ts": `import { deep } from "./deep";`,
      "src/deep.ts": `import { db } from "./db/client";`,
      "src/b.ts": `import { db } from "@/db/client";`,
      "src/db/client.ts": `import Database from "better-sqlite3";\nimport fs from "node:fs";`,
    });
    const leaks = findClientBundleLeaks(tree, ["src/c.tsx"], forbidden);
    expect(leaks).toEqual([{ root: "src/c.tsx", target: "src/db/client.ts", chain: ["src/c.tsx", "src/b.ts", "src/db/client.ts"] }]);
    expect(formatLeak(leaks[0]!)).toBe("src/c.tsx → src/b.ts → src/db/client.ts");
  });

  it("flags a forbidden package and its subpaths, and nothing that merely shares a prefix", () => {
    const tree = treeOf({
      "src/c.tsx": `"use client";\nimport fs from "node:fs/promises";\nimport x from "better-sqlite3-helpers";\nimport y from "drizzle-orm/better-sqlite3";`,
    });
    expect(findClientBundleLeaks(tree, ["src/c.tsx"], forbidden).map(formatLeak)).toEqual(["src/c.tsx → node:fs/promises"]);
  });

  it("does not follow a type-only import to the database", () => {
    const tree = treeOf({
      "src/c.tsx": `"use client";\nimport type { AppDatabase } from "./db/client";\nimport { type DbBundle } from "./db/client";`,
      "src/db/client.ts": `import Database from "better-sqlite3";`,
    });
    expect(findClientBundleLeaks(tree, ["src/c.tsx"], forbidden)).toEqual([]);
  });

  it("stops at a \"use server\" module — the bundle holds a reference to the action, not its module", () => {
    const tree = treeOf({
      "src/c.tsx": `"use client";\nimport { save } from "./actions";`,
      "src/actions.ts": `"use server";\nimport { db } from "./db/client";`,
      "src/db/client.ts": `import Database from "better-sqlite3";`,
    });
    expect(findClientBundleLeaks(tree, ["src/c.tsx"], forbidden)).toEqual([]);
  });

  it("walks through a stylesheet and a shared module without reporting either, each module once", () => {
    const tree = treeOf({
      "src/c.tsx": `"use client";\nimport "./c.css";\nimport { a } from "./a";\nimport { b } from "./b";`,
      "src/c.css": `.c {}`,
      "src/a.ts": `import { shared } from "./shared";`,
      "src/b.ts": `import { shared } from "./shared";`,
      "src/shared.ts": `import fs from "node:fs";`,
    });
    expect(findClientBundleLeaks(tree, ["src/c.tsx"], forbidden).map(formatLeak)).toEqual([
      "src/c.tsx → src/a.ts → src/shared.ts → node:fs",
    ]);
  });

  it("reports each root separately, and nothing with no forbidden targets", () => {
    const tree = treeOf({
      "src/one.tsx": `"use client";\nimport { s } from "./shared";`,
      "src/two.tsx": `"use client";\nimport { s } from "./shared";`,
      "src/shared.ts": `import Database from "better-sqlite3";`,
    });
    expect(findClientBundleLeaks(tree, ["src/one.tsx", "src/two.tsx"], forbidden).map(formatLeak)).toEqual([
      "src/one.tsx → src/shared.ts → better-sqlite3",
      "src/two.tsx → src/shared.ts → better-sqlite3",
    ]);
    expect(findClientBundleLeaks(tree, ["src/one.tsx", "src/two.tsx"], NONE)).toEqual([]);
  });

  it("refuses a root that is not in the tree", () => {
    expect(() => findClientBundleLeaks(treeOf({}), ["src/gone.tsx"], forbidden)).toThrow(
      "src/gone.tsx is not a file in the source tree",
    );
  });
});
