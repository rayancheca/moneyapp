import ts from "typescript";

/**
 * 🔴 WHAT A BROWSER BUNDLE REACHES — walked from every `"use client"` file.
 *
 * `next build` failed on 0b8d2af with "Module not found: Can't resolve 'fs'"
 * while tsc and 5,934 unit tests were green. The chain was six modules long and
 * only its LAST link was new:
 *
 *   SpendHeatmap.tsx ("use client", imports the value dayLedgerHref)
 *     → services/spending → movers-card → committed → budgets
 *     → manual-transactions → db/backup → better-sqlite3
 *
 * A `"use client"` module drags every module it imports a VALUE from into the
 * browser, and every module THOSE import, whether or not the value that crossed
 * the boundary needed any of it. No per-file review sees that; a service author
 * adding one import to a service has no way to know a client component is six
 * hops upstream. So this walks the graph the bundler walks.
 *
 * What it follows, and why:
 *   - `import x from`, `import { x }`, `import * as`, a bare `import "m"`,
 *     `export … from`, and `import("m")` — every one of them puts "m" in the
 *     bundle.
 *   - NOT `import type`, `export type … from`, or an import/export whose every
 *     specifier is marked `type` — the compiler erases those before the bundler
 *     sees them.
 *   - NOT past a `"use server"` module. The client bundle holds a reference to a
 *     server action, never the action's module, so `saveViewPreferenceAction`
 *     reaching the database is correct and must not be reported.
 *
 * ⚠️ It is deliberately CONSERVATIVE about one thing: a value-named import used
 * only in type positions (`import { Foo }` where Foo is only ever a type) is
 * followed, although the compiler would erase it. Writing `type` is the cure,
 * and it is the honest spelling anyway.
 *
 * A local specifier that resolves to nothing is an ERROR, not a skip: a walker
 * that silently stops at an edge it cannot read reports "clean" for exactly the
 * graph it did not see.
 */

/** A read-only view of the source tree, keyed by repo-relative POSIX path. */
export interface SourceTree {
  /** The file's text, or undefined when no FILE exists at that path. */
  read(path: string): string | undefined;
}

/** What must never be reachable from a client module. */
export interface ForbiddenTargets {
  /** repo-relative source files, e.g. "src/db/client.ts" */
  files: readonly string[];
  /** bare specifiers; a subpath counts ("node:fs" also forbids "node:fs/promises") */
  packages: readonly string[];
}

export interface ClientBundleLeak {
  /** the `"use client"` file the chain starts at */
  root: string;
  /** the forbidden file or package the chain ends at */
  target: string;
  /** root first, target last — every module the bundler walks through */
  chain: readonly string[];
}

type Resolution =
  | { kind: "module"; path: string }
  | { kind: "asset"; path: string }
  | { kind: "package"; specifier: string };

const TS_EXTENSIONS = [".ts", ".tsx"] as const;

function parse(path: string, text: string): ts.SourceFile {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
}

/** The directives in a file's prologue — the string statements before any other. */
function directivesOf(file: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    found.add(statement.expression.text);
  }
  return found;
}

/** Whether a file is a client-bundle entry: `"use client"` in its prologue. */
export function isClientModule(path: string, text: string): boolean {
  return directivesOf(parse(path, text)).has("use client");
}

function importCarriesValue(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return true; // import "m" — a side effect IS the point
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportCarriesValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

/**
 * The specifiers a file pulls into a bundle, in source order, once each.
 * Type-only imports and exports are not among them.
 */
export function valueImportsOf(path: string, text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (importCarriesValue(node)) found.push(node.moduleSpecifier.text);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      if (exportCarriesValue(node)) found.push(node.moduleSpecifier.text);
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteral(argument)) found.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  return [...new Set(found)];
}

function normalize(segments: readonly string[]): string {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/**
 * Where a specifier written in `from` lands: a source module to walk, a
 * non-source asset (a stylesheet) to stop at, or a package outside the tree.
 * `@/` is `src/`, as tsconfig's `paths` says.
 */
export function resolveSpecifier(tree: SourceTree, from: string, specifier: string): Resolution {
  const isAlias = specifier.startsWith("@/");
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (!isAlias && !isRelative) return { kind: "package", specifier };

  const base = isAlias
    ? normalize(["src", ...specifier.slice(2).split("/")])
    : normalize([...from.split("/").slice(0, -1), ...specifier.split("/")]);
  const candidates = [
    ...(TS_EXTENSIONS.some((extension) => base.endsWith(extension)) ? [base] : []),
    ...TS_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...TS_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  const module = candidates.find((candidate) => tree.read(candidate) !== undefined);
  if (module !== undefined) return { kind: "module", path: module };
  if (tree.read(base) !== undefined) return { kind: "asset", path: base };
  throw new Error(`${from} imports "${specifier}", which resolves to no file — the walk cannot see past it`);
}

function packageIsForbidden(specifier: string, forbidden: ForbiddenTargets): string | undefined {
  return forbidden.packages.find((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/**
 * Every forbidden file or package reachable from each client root, with the
 * shortest chain that reaches it. A forbidden FILE ends its branch — the leak
 * is reported once, at the first forbidden thing on the path, not again at
 * every package that file imports.
 */
export function findClientBundleLeaks(
  tree: SourceTree,
  roots: readonly string[],
  forbidden: ForbiddenTargets,
): ClientBundleLeak[] {
  const leaks: ClientBundleLeak[] = [];
  const parsed = new Map<string, { imports: string[]; isServer: boolean }>();
  const load = (path: string) => {
    const cached = parsed.get(path);
    if (cached !== undefined) return cached;
    const text = tree.read(path);
    if (text === undefined) throw new Error(`${path} is not a file in the source tree`);
    const entry = { imports: valueImportsOf(path, text), isServer: directivesOf(parse(path, text)).has("use server") };
    parsed.set(path, entry);
    return entry;
  };

  for (const root of roots) {
    const parent = new Map<string, string | null>([[root, null]]);
    const chainTo = (end: string): string[] => {
      const chain: string[] = [];
      for (let at: string | null | undefined = end; at != null; at = parent.get(at)) chain.unshift(at);
      return chain;
    };
    const queue = [root];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      const { imports, isServer } = load(current);
      if (isServer && current !== root) continue;
      for (const specifier of imports) {
        const resolved = resolveSpecifier(tree, current, specifier);
        if (resolved.kind === "asset") continue;
        const node = resolved.kind === "module" ? resolved.path : resolved.specifier;
        if (parent.has(node)) continue;
        parent.set(node, current);
        const forbiddenPackage = resolved.kind === "package" ? packageIsForbidden(node, forbidden) : undefined;
        if (forbiddenPackage !== undefined || forbidden.files.includes(node)) {
          leaks.push({ root, target: node, chain: chainTo(node) });
          continue;
        }
        if (resolved.kind === "module") queue.push(node);
      }
    }
  }
  return leaks;
}

/** One leak as a line a failing test can print: `a → b → c`. */
export function formatLeak(leak: ClientBundleLeak): string {
  return leak.chain.join(" → ");
}
