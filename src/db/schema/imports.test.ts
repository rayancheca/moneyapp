import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { IMPORT_STATUSES, LIVE_FILE, isLiveFile, type ImportStatus } from "./imports";

/**
 * The statuses of a file still imported — its rows, periods and printed lines in the ledger. Pinned here rather than
 * read from `LIVE_FILE`, so the scan below looks for copies of the rule with its own reading of it, and a change to the
 * rule is a change to this test as well.
 */
const LIVE: readonly ImportStatus[] = ["parsed", "parsed_with_claude"];
const NOT_LIVE: readonly ImportStatus[] = IMPORT_STATUSES.filter((s) => !LIVE.includes(s));
const HOME = "src/db/schema/imports.ts";

describe("a live import file", () => {
  test("is a parsed one, read by a parser or with Claude's help", () => {
    expect(LIVE_FILE).toEqual(LIVE);
  });

  test("is asked of one status by isLiveFile, which reads the rule", () => {
    expect(IMPORT_STATUSES.filter((s) => isLiveFile(s))).toEqual(LIVE);
  });
});

/**
 * ⛔ ONE HOME. Which `import_files` statuses leave a file imported was spelled out nine times: a `LIVE_FILE` of its own
 * in printed-lines, statement-copies, kept-openings and import-records (the empty-book review found the first three),
 * three inline lists in service.ts, one in import-records/reread.ts, and a raw SQL `IN (…)` in
 * scripts/probe-identity-transaction-day.ts — counted 2026-10-01. All nine agreed, which is exactly why no behavioural
 * test could tell a copy from the rule: they differ only on the day a status is added, or one of them is edited.
 *
 * A copy is a statement — a declaration, a query, a condition, a type, a switch — or a part of one, whose code names
 * two or more live statuses but not every status (a list of every status is `IMPORT_STATUSES`), or names every status
 * that is not live and none that is: `notInArray(status, ["failed", "needs_claude", "superseded"])` is the same rule
 * inside out. What names every status can still group the live ones: a switch's cases that share a body, an object's
 * keys that share a value, a list inside a map of lists — each group is read as a list is. In the app, `parsed`
 * compared alone is the rule narrowed. The scan reads the parsed file, so a comment quoting an old list is not a copy,
 * and the statuses a raw SQL string quotes are; it reports each statement, so the home holds the one declaration and
 * nothing else. Tests are not scanned: a fixture's status is a value, not the rule.
 */
describe("the live import statuses have one home", () => {
  test("no source file names them but the schema's, and the schema names them once", () => {
    const { copies, scanned } = copiesInTree();
    // guards the guard: a walk that read next to nothing would pass on the home alone
    expect(scanned).toBeGreaterThan(600);
    expect(copies).toEqual([`${HOME}:${homeLine("export const LIVE_FILE =")}`]);
  });

  /**
   * 🔴 The scan answered per FILE, so the home could hold any number of copies — and a partial index on `import_files`,
   * beside the table, is the likeliest second one: `transactions` keeps one on its own status. Planted, the tree still
   * read as the home alone (the review, 2026-10-01).
   */
  test("a second copy in the schema's own file is one too many: a partial index beside the table", () => {
    const home = fs.readFileSync(path.join(process.cwd(), HOME), "utf8");
    const index = 'uniqueIndex("ux_import_files_sha_parser").on(table.fileSha256, table.parserVersion)';
    const live = "index(\"ix_import_files_live\").on(table.fileSha256).where(sql`${table.status} in ('parsed', 'parsed_with_claude')`)";
    const planted = home.replace(`${index}]`, `${index}, ${live}]`);
    expect(planted).not.toBe(home);
    expect(copiesIn(planted, HOME)).toEqual([homeLine("export const LIVE_FILE ="), homeLine("export const importFiles =")]);
  });

  test.each([
    ["the copy printed-lines exported", 'export const LIVE_FILE = ["parsed", "parsed_with_claude"] as const;'],
    ["an inline list in a query", 'db.select().from(importFiles).where(inArray(importFiles.status, ["parsed", "parsed_with_claude"]));'],
    ["a list with another status beside them", 'inArray(importFiles.status, ["superseded", "parsed", "parsed_with_claude"]);'],
    ["the order reversed, in a Set", 'const LIVE = new Set<ImportStatus>(["parsed_with_claude", "parsed"]);'],
    ["raw SQL", "all(db, `SELECT id FROM import_files WHERE status IN ('parsed','parsed_with_claude')`);"],
    ["raw SQL around an interpolation", "sql`(${importFiles.status} = 'parsed' OR ${importFiles.status} = \"parsed_with_claude\")`;"],
    ["a comparison chain", 'const live = (s: string) => s === "parsed" || s === "parsed_with_claude";'],
    ["a union type", 'type Live = "parsed" | "parsed_with_claude";'],
    ["a switch", 'function live(s: string) {\n  switch (s) {\n    case "parsed":\n    case "parsed_with_claude":\n      return true;\n  }\n  return false;\n}'],
    ["the rule inside out", 'notInArray(importFiles.status, ["failed", "needs_claude", "superseded"]);'],
    // 🔴 the review, 2026-10-01: these name every status, and say which are live by how they group them
    [
      "an exhaustive switch",
      'function isLive(s: ImportStatus): boolean {\n  switch (s) {\n    case "parsed":\n    case "parsed_with_claude":\n      return true;\n' +
        '    case "failed":\n    case "needs_claude":\n    case "superseded":\n      return false;\n  }\n}',
    ],
    [
      "an exhaustive switch that repeats one body",
      'switch (s) {\n  case "parsed": return true;\n  case "parsed_with_claude": return true;\n  case "failed": return false;\n' +
        '  case "needs_claude": return false;\n  case "superseded": return false;\n}',
    ],
    ["a map grouping every status", 'const STATUS_GROUPS = { live: ["parsed", "parsed_with_claude"], retired: ["superseded"], empty: ["failed", "needs_claude"] } as const;'],
    [
      "a lookup by status",
      "const IS_LIVE: Record<ImportStatus, boolean> = { parsed: true, parsed_with_claude: true, failed: false, needs_claude: false, superseded: false };",
    ],
    ["a key set", "const LIVE = { parsed: true, parsed_with_claude: true } as const;\nexport const isLive = (s: string) => s in LIVE;"],
    ["a type keyed by status", "type Live = { parsed: true; parsed_with_claude: true };"],
    // 🔴 the rule narrowed to the status it is mistaken for: a file read with Claude's help is in the ledger too
    ["one status compared", 'if (file.status !== "parsed" || file.error === null) return null;'],
    ["one status in a query", 'db.select().from(importFiles).where(and(eq(importFiles.status, "parsed"), isNotNull(importFiles.error)));'],
    ["one status in raw SQL", "db.all(sql`SELECT id FROM import_files WHERE ${importFiles.status} = 'parsed'`);"],
    ["one status in a switch's cases", 'switch (file.status) {\n  case "parsed":\n    return withheldNoticeOf(file);\n  default:\n    return null;\n}'],
  ])("flags %s", (_label, code) => {
    expect(copiesIn(code, "src/planted.ts")).not.toEqual([]);
  });

  test("flags a filter's options in JSX, and single-quoted strings in a plain JavaScript script", () => {
    const options = 'export const F = () => <select><option value="parsed" /><option value="parsed_with_claude" /></select>;';
    expect(copiesIn(options, "src/planted.tsx")).not.toEqual([]);
    expect(copiesIn("const LIVE = ['parsed', 'parsed_with_claude'];", "scripts/planted.mjs")).not.toEqual([]);
  });

  test.each([
    ["the rule itself, spread", "inArray(importFiles.status, [...LIVE_FILE]);"],
    ["the rule with another status", 'inArray(importFiles.status, ["superseded", ...LIVE_FILE]);'],
    ["the rule, asked of one status", 'if (row !== undefined && !isLiveFile(row.status)) markFailed(row);'],
    ["one status written", 'tx.update(importFiles).set({ status: "parsed" }).where(eq(importFiles.id, id)).run();'],
    ["how a file was read, asked of the status that says so", 'const assisted = file.status === "parsed_with_claude";'],
    ["every status", 'const IMPORT_STATUSES = ["parsed", "failed", "needs_claude", "parsed_with_claude", "superseded"] as const;'],
    ["another rule's pair", 'const REIMPORTABLE_STATUSES: readonly ImportStatus[] = ["superseded", "failed"];'],
    ["a label map keyed by status", 'const TONE = { parsed: { label: "Parsed" }, parsed_with_claude: { label: "Parsed (Claude)" } };'],
    ["a label map with quoted keys", 'const TONE = { "parsed": "Parsed", "parsed_with_claude": "Parsed (Claude)" };'],
    [
      "a label and a tone for every status, two of them alike in tone",
      'const STATUS_META: Record<ImportStatus, { label: string; tone: string }> = {\n  parsed: { label: "Parsed", tone: "bg-positive" },\n' +
        '  parsed_with_claude: { label: "Parsed (Claude assisted)", tone: "bg-positive" },\n  needs_claude: { label: "Waiting for Claude", tone: "bg-warning" },\n' +
        '  failed: { label: "Failed", tone: "bg-negative" },\n  superseded: { label: "Superseded", tone: "bg-ink-faint" },\n};',
    ],
    [
      "an exhaustive label switch",
      'switch (s) {\n  case "parsed": return "Parsed";\n  case "parsed_with_claude": return "Parsed (Claude)";\n  case "failed": return "Failed";\n' +
        '  case "needs_claude": return "Waiting for Claude";\n  case "superseded": return "Superseded";\n}',
    ],
    ["a count of every status", "const counts: Record<ImportStatus, number> = { parsed: 0, failed: 0, needs_claude: 0, parsed_with_claude: 0, superseded: 0 };"],
    ["a line comment quoting an old list", '// was ["parsed", "parsed_with_claude"]\ninArray(importFiles.status, [...LIVE_FILE]);'],
    ["a docstring quoting old SQL", "/**\n * WHERE status IN ('parsed','parsed_with_claude')\n */\nexport const ROW_CHUNK = 500;"],
    ["prose naming both", 'throw new Error("a parsed file is live, and so is a parsed_with_claude one");'],
  ])("does not flag %s", (_label, code) => {
    expect(copiesIn(code, "src/planted.ts")).toEqual([]);
  });

  test("a runbook checks the one status a write recorded: `parsed` compared alone is the rule narrowed in the app only", () => {
    const check = 'if (file.status !== "parsed" || file.parserVersion !== 3) throw new Refusal("REFUSED — not the measured read");';
    expect(copiesIn(check, "scripts/planted.ts")).toEqual([]);
    expect(copiesIn(check, "src/planted.ts")).not.toEqual([]);
  });
});

/** The 1-based line of the home's first line that starts with `prefix`. */
function homeLine(prefix: string): number {
  const lines = fs.readFileSync(path.join(process.cwd(), HOME), "utf8").split("\n");
  const at = lines.findIndex((l) => l.startsWith(prefix));
  if (at === -1) throw new Error(`${HOME} has no line starting ${prefix}`);
  return at + 1;
}

/** Every copy in src/ and scripts/ — tests excepted — as `file:line`. */
function copiesInTree(): { copies: string[]; scanned: number } {
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
 * status still shows a list of the pair inside it; a statement inside another is read on its own. A switch is read
 * again by its cases as they share a body, an object or a type keyed by status by its keys as they share a value
 * (`groupsOf`): an exhaustive `switch` or `Record<ImportStatus, boolean>` names every status, and says which are live
 * by how it groups them. In the app, a status compared with `parsed` alone is one too (`narrowsTheRule`).
 */
function copiesIn(source: string, fileName: string): number[] {
  const app = fileName.startsWith("src/");
  // a file naming fewer than two statuses, and quoting no `parsed` the app could compare, holds no copy; most files
  // are such, and parsing them all is the cost here
  const mentioned = IMPORT_STATUSES.filter((s) => new RegExp(`\\b${s}\\b`).test(source)).length;
  if (mentioned < 2 && !(app && /(['"`])parsed\1/.test(source))) return [];
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const lines = new Set<number>();
  // the statuses `node`'s own code names, in its statement
  const scan = (node: ts.Node, statement: ts.Node): Set<ImportStatus> => {
    const owner = ts.isStatement(node) ? node : statement;
    const named = new Set<ImportStatus>(isCodeString(node) ? statusesIn(node.text) : []);
    ts.forEachChild(node, (child) => {
      const inner = scan(child, owner);
      if (!ts.isStatement(child)) for (const s of inner) named.add(s);
    });
    if ([named, ...groupsOf(node, file)].some(isACopy) || (app && narrowsTheRule(node))) {
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
function namedIn(node: ts.Node): ImportStatus[] {
  const named: ImportStatus[] = isCodeString(node) ? statusesIn(node.text) : [];
  // a block body: `forEachChild` stops at the first child its callback returns something for
  ts.forEachChild(node, (child) => {
    named.push(...namedIn(child));
  });
  return named;
}

/**
 * The statuses `node` groups by what it does with them: a switch's cases by the body they run — falling through to it,
 * or repeating it — and the keys of an object or a type by the value they share. `{ parsed: true, … }` keys a set; a
 * label map, its every value different, groups nothing.
 */
function groupsOf(node: ts.Node, file: ts.SourceFile): Set<ImportStatus>[] {
  const groups = new Map<string, ImportStatus[]>();
  const join = (key: string, statuses: readonly ImportStatus[]): void => {
    groups.set(key, [...(groups.get(key) ?? []), ...statuses]);
  };
  const textOf = (nodes: readonly ts.Node[]): string => nodes.map((n) => n.getText(file)).join(" ").replace(/\s+/g, " ");
  if (ts.isCaseBlock(node)) {
    let falling: ImportStatus[] = [];
    for (const clause of node.clauses) {
      falling = [...falling, ...(ts.isCaseClause(clause) ? namedIn(clause.expression) : [])];
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
      const status = IMPORT_STATUSES.find((s) => s === key);
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
 * Whether `node` compares a status with `parsed` alone — `===`, `!==`, `==`, `!=`, drizzle's `eq` or `ne`, a SQL `=`,
 * `!=` or `<>`, a switch's cases: the rule narrowed to the status it is mistaken for.
 *
 * 🔴 Five places asked "is this read in the ledger?" so, in the app: `failedUnexpectedly`, `copiesWithheldFor`,
 * `withheldSectionsOf`, `withheldNoticeOf` and the statement gaps' withheld windows — each reading a file parsed with
 * Claude's help as not imported (the review, 2026-10-01). Asked only of the app: a runbook in scripts/ checks the one
 * status a write recorded, and a parser's read is recorded `parsed`. `parsed_with_claude` compared alone asks how a
 * file was read, which is another question.
 */
function narrowsTheRule(node: ts.Node): boolean {
  const isParsed = (n: ts.Node): boolean => ts.isStringLiteralLike(n) && n.text === "parsed";
  if (ts.isBinaryExpression(node)) return EQUALITY.has(node.operatorToken.kind) && (isParsed(node.left) || isParsed(node.right));
  if (ts.isCallExpression(node)) return ts.isIdentifier(node.expression) && ["eq", "ne"].includes(node.expression.text) && node.arguments.some(isParsed);
  if (ts.isCaseBlock(node)) {
    const cases = node.clauses.flatMap((c) => (ts.isCaseClause(c) ? namedIn(c.expression) : []));
    return cases.includes("parsed") && !cases.includes("parsed_with_claude");
  }
  return isCodeString(node) && /(?:=|<>)\s*(['"])parsed\1/.test(node.text);
}

/** The statuses a string names: itself, or — a fragment of SQL — each status it quotes. */
function statusesIn(text: string): ImportStatus[] {
  const words = IMPORT_STATUSES.some((s) => s === text) ? [text] : [...text.matchAll(/(['"])([a-z_]+)\1/g)].map((m) => m[2] ?? "");
  return IMPORT_STATUSES.filter((s) => words.includes(s));
}

function isACopy(named: ReadonlySet<ImportStatus>): boolean {
  const live = LIVE.filter((s) => named.has(s)).length;
  if (live >= 2) return named.size < IMPORT_STATUSES.length;
  return live === 0 && NOT_LIVE.every((s) => named.has(s));
}
