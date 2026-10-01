import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { IMPORT_STATUSES, LIVE_FILE, type ImportStatus } from "./imports";

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
});

/**
 * ⛔ ONE HOME. Which `import_files` statuses leave a file imported was spelled out nine times: a `LIVE_FILE` of its own
 * in printed-lines, statement-copies, kept-openings and import-records (the empty-book review found the first three),
 * three inline lists in service.ts, one in import-records/reread.ts, and a raw SQL `IN (…)` in
 * scripts/probe-identity-transaction-day.ts — counted 2026-10-01. All nine agreed, which is exactly why no behavioural
 * test could tell a copy from the rule: they differ only on the day a status is added, or one of them is edited.
 *
 * A copy is one statement — a declaration, a query, a condition, a type, a switch — whose code names two or more live
 * statuses but not every status (a list of every status is `IMPORT_STATUSES`), or names every status that is not live
 * and none that is: `notInArray(status, ["failed", "needs_claude", "superseded"])` is the same rule inside out. The
 * scan reads the parsed file, so a comment quoting an old list is not a copy, and the statuses a raw SQL string quotes
 * are. Tests are not scanned: a fixture's status is a value, not the rule.
 */
describe("the live import statuses have one home", () => {
  test("no source file but the schema's names them", () => {
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
        const file = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(file);
        else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
          scanned += 1;
          if (spellsLiveStatuses(fs.readFileSync(path.join(process.cwd(), file), "utf8"), file)) offenders.push(file);
        }
      }
    };
    walk("src");
    walk("scripts");
    // guards the guard: a walk that read next to nothing would pass on the home alone
    expect(scanned).toBeGreaterThan(600);
    expect(offenders).toEqual([HOME]);
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
  ])("flags %s", (_label, code) => {
    expect(spellsLiveStatuses(code, "planted.ts")).toBe(true);
  });

  test("flags a filter's options in JSX, and single-quoted strings in a plain JavaScript script", () => {
    const options = 'export const F = () => <select><option value="parsed" /><option value="parsed_with_claude" /></select>;';
    expect(spellsLiveStatuses(options, "planted.tsx")).toBe(true);
    expect(spellsLiveStatuses("const LIVE = ['parsed', 'parsed_with_claude'];", "planted.mjs")).toBe(true);
  });

  test.each([
    ["the rule itself, spread", "inArray(importFiles.status, [...LIVE_FILE]);"],
    ["the rule with another status", 'inArray(importFiles.status, ["superseded", ...LIVE_FILE]);'],
    ["one status written", 'tx.update(importFiles).set({ status: "parsed" }).where(eq(importFiles.id, id)).run();'],
    ["one status compared", 'if (file.status !== "parsed" || file.error === null) return null;'],
    ["every status", 'const IMPORT_STATUSES = ["parsed", "failed", "needs_claude", "parsed_with_claude", "superseded"] as const;'],
    ["another rule's pair", 'const REIMPORTABLE_STATUSES: readonly ImportStatus[] = ["superseded", "failed"];'],
    ["a label map keyed by status", 'const TONE = { parsed: { label: "Parsed" }, parsed_with_claude: { label: "Parsed (Claude)" } };'],
    ["a label map with quoted keys", 'const TONE = { "parsed": "Parsed", "parsed_with_claude": "Parsed (Claude)" };'],
    ["a line comment quoting an old list", '// was ["parsed", "parsed_with_claude"]\ninArray(importFiles.status, [...LIVE_FILE]);'],
    ["a docstring quoting old SQL", "/**\n * WHERE status IN ('parsed','parsed_with_claude')\n */\nexport const ROW_CHUNK = 500;"],
    ["prose naming both", 'throw new Error("a parsed file is live, and so is a parsed_with_claude one");'],
  ])("does not flag %s", (_label, code) => {
    expect(spellsLiveStatuses(code, "planted.ts")).toBe(false);
  });
});

/**
 * Whether `source` names the live statuses itself instead of reading `LIVE_FILE`. Each string in code — a literal, a
 * template's text, a JSX attribute; never a property's name, which is how a label map keys its statuses — counts
 * toward the statement it sits in.
 */
function spellsLiveStatuses(source: string, fileName: string): boolean {
  // a file that does not mention two statuses cannot list them; most do not, and parsing them all is the cost here
  if (IMPORT_STATUSES.filter((s) => new RegExp(`\\b${s}\\b`).test(source)).length < 2) return false;
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const named = new Map<ts.Node, Set<ImportStatus>>();
  const visit = (node: ts.Node, statement: ts.Node): void => {
    const owner = ts.isStatement(node) ? node : statement;
    if ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && (node.parent as { name?: ts.Node }).name !== node) {
      const statuses = named.get(owner) ?? new Set<ImportStatus>();
      for (const s of statusesIn(node.text)) statuses.add(s);
      named.set(owner, statuses);
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  };
  visit(file, file);
  return [...named.values()].some(isACopy);
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
