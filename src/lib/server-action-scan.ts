import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resolveSpecifier, type SourceTree } from "./client-bundle-graph";

/**
 * The server actions in src, and where each file binds one: the scan behind the gates that read a server action where
 * it is used — every press settled where it is made (hooks/useAction.test.ts), every form that stays on its page
 * taking away a refusal it shows (app/refusal-landing.test.ts).
 *
 * ⛔ ONE scan, as status-rule-scan.ts is for a status rule: a second gate resolving imports its own way would have to be
 * found and mended apart. A server action is an exported async function of a `"use server"` module; a file binds one by
 * importing it, under its own name or another (`import { a as b }`), resolved as the bundler resolves it
 * (`resolveSpecifier`). Only tests import this, and it names no action: the gates bring their rules.
 */

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
  readonly actions: ReadonlyMap<string, ts.FunctionDeclaration>;
  /** the local names `file`'s imports bind to a server action, each with that action's `file#name` */
  bindingsIn(file: ScannedFile): ReadonlyMap<string, string>;
}

const TREE: SourceTree = {
  read(relative) {
    const absolute = path.join(process.cwd(), relative);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? fs.readFileSync(absolute, "utf8") : undefined;
  },
};

function directiveOf(ast: ts.SourceFile): ScannedFile["directive"] {
  const first = ast.statements[0];
  if (first === undefined || !ts.isExpressionStatement(first) || !ts.isStringLiteral(first.expression)) return null;
  const text = first.expression.text;
  return text === "use server" || text === "use client" ? text : null;
}

function exportedAsync(statement: ts.Statement): statement is ts.FunctionDeclaration & { name: ts.Identifier } {
  if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) return false;
  const modifiers = ts.getModifiers(statement) ?? [];
  return (
    modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
    modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

export function scanServerActions(): ServerActionScan {
  const files: ScannedFile[] = fs
    .readdirSync(path.join(process.cwd(), "src"), { recursive: true, encoding: "utf8" })
    .map((relative) => path.posix.join("src", relative.split(path.sep).join("/")))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => {
      const text = TREE.read(file)!;
      const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
      return { file, text, ast, directive: directiveOf(ast) };
    });

  const actions = new Map<string, ts.FunctionDeclaration>();
  for (const scanned of files.filter((f) => f.directive === "use server")) {
    for (const statement of scanned.ast.statements) {
      if (exportedAsync(statement)) actions.set(`${scanned.file}#${statement.name.text}`, statement);
    }
  }

  const bindingsIn = (scanned: ScannedFile): ReadonlyMap<string, string> => {
    const bound = new Map<string, string>();
    for (const statement of scanned.ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const named = statement.importClause?.namedBindings;
      if (named === undefined || !ts.isNamedImports(named)) continue;
      const resolved = resolveSpecifier(TREE, scanned.file, statement.moduleSpecifier.text);
      if (resolved.kind !== "module") continue;
      for (const element of named.elements) {
        const key = `${resolved.path}#${(element.propertyName ?? element.name).text}`;
        if (actions.has(key)) bound.set(element.name.text, key);
      }
    }
    return bound;
  };

  return { files, actions, bindingsIn };
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
