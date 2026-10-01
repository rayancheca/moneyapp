import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Copies of a status rule in source: the scan behind each one-home guard for a list of statuses — the live import
 * files (`LIVE_FILE`, imports.test.ts) and the live rows (`LIVE_ROW`, transactions.test.ts).
 *
 * ⛔ ONE scan. The review of the first guard found three holes in it on the day it landed (2026-10-01): one copy per
 * file, the shapes that group every status, and `parsed` compared alone. A second guard with a scan of its own would
 * have to be found and mended the same way. Only tests import this, and it names no status: the rule comes in.
 */

/** A rule over one status column, as its guard reads it — pinned in the test, never read from the rule's home. */
export interface StatusRule {
  /** every status the column takes */
  readonly statuses: readonly string[];
  /** the statuses the rule admits */
  readonly admits: readonly string[];
  /**
   * The status the rule is mistaken for: compared alone in the app (src/), it is the rule narrowed. A file read with
   * Claude's help is imported too, and five places asked `parsed` alone (the review, 2026-10-01).
   */
  readonly mistakenFor?: string;
}

export interface StatusRuleScan {
  /** Each copy of the rule in `source`, by the line of the statement it sits in. */
  copiesIn(source: string, fileName: string): number[];
  /** Every copy in src/ and scripts/ — tests excepted — as `file:line`, and how many files the walk read. */
  copiesInTree(): { copies: string[]; scanned: number };
}

/**
 * The scan for one rule.
 *
 * A copy is a statement — a declaration, a query, a condition, a type, a switch — or a part of one, whose code names
 * every status the rule admits but not every status (a list of every status is the status type's own), or names every
 * status it leaves out and none it admits, where it leaves out two or more (`readsInsideOut`):
 * `notInArray(status, ["failed", "needs_claude", "superseded"])` is the import files' rule inside out. Some of the
 * admitted statuses, named without the rest, are another rule: replay reads a row's `active` and `excluded`.
 *
 * What names every status can still group the admitted ones: a switch's cases that share a body, an object's keys that
 * share a value, a list inside a map of lists — each group is read as a list is. In the app, the status the rule is
 * mistaken for, compared alone, is the rule narrowed (`mistakenFor`). The scan reads the parsed file, so a comment
 * quoting an old list is not a copy, and the statuses a raw SQL string quotes are — read as code is, by its parts, so
 * the `superseded` a write sets does not hide the list it retires; it reports each statement, so a home holds its one
 * declaration and nothing else. Tests are not scanned: a fixture's status is a value, not the rule.
 */
export function statusRuleScan(rule: StatusRule): StatusRuleScan {
  const copiesIn = (source: string, fileName: string): number[] => copiesOf(rule, source, fileName);
  return { copiesIn, copiesInTree: () => copiesInTree(copiesIn) };
}

/** The 1-based line of `file`'s first line that starts with `prefix` — where a guard expects its rule's home. */
export function lineOf(file: string, prefix: string): number {
  const lines = fs.readFileSync(path.join(process.cwd(), file), "utf8").split("\n");
  const at = lines.findIndex((l) => l.startsWith(prefix));
  if (at === -1) throw new Error(`${file} has no line starting ${prefix}`);
  return at + 1;
}

function copiesInTree(copiesIn: StatusRuleScan["copiesIn"]): { copies: string[]; scanned: number } {
  const copies: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        scanned += 1;
        for (const line of copiesIn(fs.readFileSync(path.join(process.cwd(), file), "utf8"), file)) copies.push(`${file}:${line}`);
      }
    }
  };
  walk("src");
  walk("scripts");
  return { copies, scanned };
}

/**
 * Each copy of the rule in `source`, by the line of the statement it sits in — every one, so a second copy in the home
 * is seen beside the first.
 *
 * A statement is read whole, and so is each part of it — a list, a call, a condition — so a statement that names every
 * status still shows a list of the admitted ones inside it; a statement inside another is read on its own. A switch is
 * read again by its cases as they share a body, an object or a type keyed by status by its keys as they share a value,
 * a raw SQL string by its parenthesized groups, its clauses and a `CASE`'s arms (`groupsOf`): an exhaustive `switch` or
 * `Record<ImportStatus, boolean>` names every status, and says which are admitted by how it groups them. In the app, a
 * status compared with `mistakenFor` alone is one too (`narrowsTheRule`).
 */
function copiesOf(rule: StatusRule, source: string, fileName: string): number[] {
  const app = fileName.startsWith("src/");
  // a file naming fewer statuses than the least a copy names, and quoting no status the app could compare alone,
  // holds no copy; most files are such, and parsing them all is the cost here
  const mentioned = rule.statuses.filter((s) => new RegExp(`\\b${s}\\b`).test(source)).length;
  const fewest = Math.min(rule.admits.length, readsInsideOut(rule) ? leftOut(rule).length : Infinity);
  const quotesMistaken = rule.mistakenFor !== undefined && new RegExp(`(['"\`])${rule.mistakenFor}\\1`).test(source);
  if (mentioned < fewest && !(app && quotesMistaken)) return [];
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const lines = new Set<number>();
  // the statuses `node`'s own code names, in its statement
  const scan = (node: ts.Node, statement: ts.Node): Set<string> => {
    const owner = ts.isStatement(node) ? node : statement;
    const named = new Set<string>(isCodeString(node) ? statusesIn(rule, node.text) : []);
    ts.forEachChild(node, (child) => {
      const inner = scan(child, owner);
      if (!ts.isStatement(child)) for (const s of inner) named.add(s);
    });
    if ([named, ...groupsOf(rule, node, file)].some((g) => isACopy(rule, g)) || (app && narrowsTheRule(rule, node))) {
      lines.add(file.getLineAndCharacterOfPosition(owner.getStart(file)).line + 1);
    }
    return named;
  };
  scan(file, file);
  return [...lines].sort((a, b) => a - b);
}

/** A string in code — a literal, a template's text, a JSX attribute — and never a property's name: a key counts by its value. */
function isCodeString(node: ts.Node): node is ts.StringLiteralLike | ts.TemplateLiteralToken {
  return (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && (node.parent as { name?: ts.Node }).name !== node;
}

/** The statuses the code strings in `node` name — a case's label, say. */
function namedIn(rule: StatusRule, node: ts.Node): string[] {
  const named: string[] = isCodeString(node) ? statusesIn(rule, node.text) : [];
  // a block body: `forEachChild` stops at the first child its callback returns something for
  ts.forEachChild(node, (child) => {
    named.push(...namedIn(rule, child));
  });
  return named;
}

/**
 * The statuses `node` groups by what it does with them: a switch's cases by the body they run — falling through to it,
 * or repeating it — and the keys of an object or a type by the value they share. `{ parsed: true, … }` keys a set; a
 * label map, its every value different, groups nothing. A raw SQL string groups them by its parts (`sqlGroupsOf`).
 */
function groupsOf(rule: StatusRule, node: ts.Node, file: ts.SourceFile): Set<string>[] {
  if (isCodeString(node)) return sqlGroupsOf(rule, node.text);
  const groups = new Map<string, string[]>();
  const join = (key: string, statuses: readonly string[]): void => {
    groups.set(key, [...(groups.get(key) ?? []), ...statuses]);
  };
  const textOf = (nodes: readonly ts.Node[]): string => nodes.map((n) => n.getText(file)).join(" ").replace(/\s+/g, " ");
  if (ts.isCaseBlock(node)) {
    let falling: string[] = [];
    for (const clause of node.clauses) {
      falling = [...falling, ...(ts.isCaseClause(clause) ? namedIn(rule, clause.expression) : [])];
      if (clause.statements.length === 0) continue;
      join(textOf(clause.statements), falling);
      falling = [];
    }
    if (falling.length > 0) join("", falling);
  } else if (ts.isObjectLiteralExpression(node) || ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node)) {
    const members: readonly ts.Node[] = ts.isObjectLiteralExpression(node) ? node.properties : node.members;
    for (const member of members) {
      const value = ts.isPropertyAssignment(member) ? member.initializer : ts.isPropertySignature(member) ? member.type : undefined;
      const name = (member as { name?: ts.Node }).name;
      const key = name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
      const status = rule.statuses.find((s) => s === key);
      if (value !== undefined && status !== undefined) join(textOf([value]), [status]);
    }
  }
  return [...groups.values()].map((statuses) => new Set(statuses));
}

const EQUALITY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * Whether `node` compares a status with `mistakenFor` alone — `===`, `!==`, `==`, `!=`, drizzle's `eq` or `ne`, a SQL
 * `=`, `!=` or `<>`, a switch's cases that leave an admitted status out: the rule narrowed to the status it is mistaken
 * for. Asked only of the app: a runbook in scripts/ checks the one status a write recorded. Another admitted status
 * compared alone asks how a row came to be admitted, which is another question.
 */
function narrowsTheRule(rule: StatusRule, node: ts.Node): boolean {
  const mistaken = rule.mistakenFor;
  if (mistaken === undefined) return false;
  const isMistaken = (n: ts.Node): boolean => ts.isStringLiteralLike(n) && n.text === mistaken;
  if (ts.isBinaryExpression(node)) return EQUALITY.has(node.operatorToken.kind) && (isMistaken(node.left) || isMistaken(node.right));
  if (ts.isCallExpression(node)) return ts.isIdentifier(node.expression) && ["eq", "ne"].includes(node.expression.text) && node.arguments.some(isMistaken);
  if (ts.isCaseBlock(node)) {
    const cases = node.clauses.flatMap((c) => (ts.isCaseClause(c) ? namedIn(rule, c.expression) : []));
    return cases.includes(mistaken) && !rule.admits.every((s) => cases.includes(s));
  }
  return isCodeString(node) && new RegExp(`(?:=|<>)\\s*(['"])${mistaken}\\1`).test(node.text);
}

/** The statuses a string names: itself, or — a fragment of SQL — each status it quotes. */
function statusesIn(rule: StatusRule, text: string): string[] {
  const words = rule.statuses.includes(text) ? [text] : [...text.matchAll(/(['"])([a-z_]+)\1/g)].map((m) => m[2] ?? "");
  return rule.statuses.filter((s) => words.includes(s));
}

/** The keywords that open a SQL clause: what a `SET` writes is read apart from what the `WHERE` after it compares. */
const SQL_CLAUSE = /\b(?:select|from|join|where|set|values|group\s+by|having|order\s+by)\b/i;
/** A SQL `CASE`'s arm: what its `WHEN` names, and the `THEN` it leads to. */
const CASE_ARM = /\bwhen\b([\s\S]*?)\bthen\b([\s\S]*?)(?=\bwhen\b|\belse\b|\bend\b|$)/gi;

/**
 * The statuses a raw SQL string groups, read as code is: each parenthesized group — an `IN (…)` list, a grouped
 * condition, a sub-select — each clause, and a `CASE`'s arms by the `THEN` they share, as a switch's cases share
 * a body. 🔴 Read whole only, a write that retires rows named every status: `SET status = 'superseded' WHERE status
 * IN ('active', 'quarantined', 'excluded')`, the usual shape of a runbook's, hid the list beside it (the review,
 * 2026-10-01).
 */
function sqlGroupsOf(rule: StatusRule, sql: string): Set<string>[] {
  const arms = new Map<string, string[]>();
  for (const [, when = "", then = ""] of sql.matchAll(CASE_ARM)) {
    arms.set(then.trim(), [...(arms.get(then.trim()) ?? []), ...statusesIn(rule, when)]);
  }
  const parts = [...parenthesizedIn(sql), ...sql.split(SQL_CLAUSE)].map((part) => statusesIn(rule, part));
  return [...parts, ...arms.values()].map((statuses) => new Set(statuses));
}

/** Each parenthesized group in `sql`, the groups inside a group too. */
function parenthesizedIn(sql: string): string[] {
  const groups: string[] = [];
  const open: number[] = [];
  for (let at = 0; at < sql.length; at += 1) {
    if (sql.charAt(at) === "(") open.push(at + 1);
    if (sql.charAt(at) !== ")") continue;
    const start = open.pop();
    if (start !== undefined) groups.push(sql.slice(start, at));
  }
  return groups;
}

/** The statuses the rule leaves out. */
function leftOut(rule: StatusRule): string[] {
  return rule.statuses.filter((s) => !rule.admits.includes(s));
}

/**
 * Whether the rule inside out reads as a copy: only where it leaves out two or more statuses. One status left out —
 * `superseded`, for a row — is named by everything that speaks of it: a write that retires a row, a check for a
 * retired one, the import files' own `superseded`.
 */
function readsInsideOut(rule: StatusRule): boolean {
  return leftOut(rule).length >= 2;
}

function isACopy(rule: StatusRule, named: ReadonlySet<string>): boolean {
  if (rule.admits.every((s) => named.has(s))) return named.size < rule.statuses.length;
  return readsInsideOut(rule) && rule.admits.every((s) => !named.has(s)) && leftOut(rule).every((s) => named.has(s));
}
