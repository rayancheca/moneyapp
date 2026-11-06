import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resolveSpecifier, type SourceTree } from "./client-bundle-graph";

/**
 * The server actions in src, and where each file binds one: the scan behind the gates that read a server action where
 * it is used — every press settled where it is made (hooks/useAction.test.ts), every form that stays on its page
 * taking away a refusal it shows (app/refusal-landing.test.ts). And what each file imports (`importsIn`), so a gate can
 * follow a prop from the page that hands it to the form that reads it: each form is handed the refusal its page shows.
 *
 * ⛔ ONE scan, as status-rule-scan.ts is for a status rule: a second gate resolving imports its own way would have to be
 * found and mended apart. A server action is an exported async function of a `"use server"` module — `export async
 * function f`, or `export const f = async (…) =>` / `async function (…)`; a file binds one by importing it, under its
 * own name or another (`import { a as b }`), resolved as the bundler resolves it (`resolveSpecifier`). Only tests
 * import this, and it names no action: the gates bring their rules.
 *
 * 🔴 The review of 63847994 (2026-11-06): it read only `export async function`, and an adapter written `export const
 * addAnchorAction = async (formData: FormData): Promise<void> =>` was no server action to any gate — its form unwired,
 * every gate green. A "use server" module exports async functions and nothing else (Next's own rule,
 * next-flight-loader/action-validate.js), so each value one exports is read as an action, or the scan stops and names
 * it: a reading that skips what it cannot read reports clean for exactly what it did not see (client-bundle-graph.ts).
 */

/** A server action's declaration: `export async function f(…)`, or the async arrow or function `export const f =`. */
export type ServerAction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

export interface ScannedFile {
  /** the path from the repo root, `src/…` */
  readonly file: string;
  readonly text: string;
  readonly ast: ts.SourceFile;
  /** the directive in its prologue, if it has one */
  readonly directive: "use server" | "use client" | null;
}

export interface ServerActionScan {
  /** every source file under src/, tests excepted */
  readonly files: readonly ScannedFile[];
  /** each server action's declaration, by `file#name` */
  readonly actions: ReadonlyMap<string, ServerAction>;
  /** the local names `file`'s named imports bind, each with the `file#name` in src it resolves to */
  importsIn(file: ScannedFile): ReadonlyMap<string, string>;
  /** the local names `file`'s imports bind to a server action, each with that action's `file#name` */
  bindingsIn(file: ScannedFile): ReadonlyMap<string, string>;
}

/** The tree a scan reads: each path under src/, and each one's text — another stages a case (a test's edit). */
export interface ScanTree extends SourceTree {
  /** every path under src/, `src/…` */
  paths(): readonly string[];
}

/** The working tree under src/ — what every gate reads. */
export const SRC_TREE: ScanTree = {
  read(relative) {
    const absolute = path.join(process.cwd(), relative);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? fs.readFileSync(absolute, "utf8") : undefined;
  },
  paths() {
    return fs
      .readdirSync(path.join(process.cwd(), "src"), { recursive: true, encoding: "utf8" })
      .map((relative) => path.posix.join("src", relative.split(path.sep).join("/")));
  },
};

function directiveOf(ast: ts.SourceFile): ScannedFile["directive"] {
  const first = ast.statements[0];
  if (first === undefined || !ts.isExpressionStatement(first) || !ts.isStringLiteral(first.expression)) return null;
  const text = first.expression.text;
  return text === "use server" || text === "use client" ? text : null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/** Each value `statement` exports — the statement, or each of an `export const`'s names — and none for a type. */
function exportedValues(statement: ts.Statement): ts.Node[] {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    const types = clause !== undefined && ts.isNamedExports(clause) && clause.elements.every((e) => e.isTypeOnly);
    return statement.isTypeOnly || types ? [] : [statement];
  }
  if (ts.isExportAssignment(statement)) return [statement];
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return [];
  return ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [statement];
}

/** An exported value read as a server action, with its name: `async function f`, or `const f = async …` — or none. */
function asAction(exported: ts.Node): readonly [string, ServerAction] | undefined {
  if (ts.isFunctionDeclaration(exported)) {
    // an `export default` is imported under no name `importsIn` reads
    const name = hasModifier(exported, ts.SyntaxKind.DefaultKeyword) ? undefined : exported.name;
    return name !== undefined && hasModifier(exported, ts.SyntaxKind.AsyncKeyword) ? [name.text, exported] : undefined;
  }
  if (!ts.isVariableDeclaration(exported) || !ts.isIdentifier(exported.name)) return undefined;
  const fn = exported.initializer;
  const isConst = (ts.getCombinedNodeFlags(exported) & ts.NodeFlags.Const) !== 0;
  if (!isConst || fn === undefined || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return undefined;
  return hasModifier(fn, ts.SyntaxKind.AsyncKeyword) ? [exported.name.text, fn] : undefined;
}

export function scanServerActions(tree: ScanTree = SRC_TREE): ServerActionScan {
  const files: ScannedFile[] = tree
    .paths()
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => {
      const text = tree.read(file)!;
      const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
      return { file, text, ast, directive: directiveOf(ast) };
    });

  const actions = new Map<string, ServerAction>();
  const unread: string[] = [];
  for (const scanned of files.filter((f) => f.directive === "use server")) {
    for (const exported of scanned.ast.statements.flatMap(exportedValues)) {
      const action = asAction(exported);
      if (action !== undefined) actions.set(`${scanned.file}#${action[0]}`, action[1]);
      else unread.push(`${lineOf(scanned, exported)} ${exported.getText(scanned.ast).split("\n")[0]}`);
    }
  }
  if (unread.length > 0) {
    const what = 'a "use server" module exports what the scan cannot read as a server action, and every gate would';
    const cure = 'write an action `export async function`, and anything else in a module without "use server"';
    throw new Error([`${what} pass on it unseen — ${cure}:`, ...unread].join("\n"));
  }

  const importsIn = (scanned: ScannedFile): ReadonlyMap<string, string> => {
    const bound = new Map<string, string>();
    for (const statement of scanned.ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const named = statement.importClause?.namedBindings;
      if (named === undefined || !ts.isNamedImports(named)) continue;
      const resolved = resolveSpecifier(tree, scanned.file, statement.moduleSpecifier.text);
      if (resolved.kind !== "module") continue;
      for (const element of named.elements) {
        bound.set(element.name.text, `${resolved.path}#${(element.propertyName ?? element.name).text}`);
      }
    }
    return bound;
  };

  const bindingsIn = (scanned: ScannedFile): ReadonlyMap<string, string> =>
    new Map([...importsIn(scanned)].filter(([, key]) => actions.has(key)));

  return { files, actions, importsIn, bindingsIn };
}

/** The name a call is made by: `f` for `f(…)` and `x.f(…)`. */
export function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

/** Every node under `root` that `match` admits, in source order. */
export function nodesUnder<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** `file:line` of a node, as a gate lists it. */
export function lineOf(scanned: ScannedFile, node: ts.Node): string {
  return `${scanned.file}:${scanned.ast.getLineAndCharacterOfPosition(node.getStart(scanned.ast)).line + 1}`;
}
