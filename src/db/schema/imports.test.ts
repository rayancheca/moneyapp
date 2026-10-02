import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { IMPORT_STATUSES, LIVE_FILE, isLiveFile, type ImportStatus } from "./imports";
import { lineOf, statusRuleScan } from "./status-rule-scan";

/**
 * The statuses of a file still imported — its rows, periods and printed lines in the ledger. Pinned here rather than
 * read from `LIVE_FILE`, so the scan below looks for copies of the rule with its own reading of it, and a change to the
 * rule is a change to this test as well.
 */
const LIVE: readonly ImportStatus[] = ["parsed", "parsed_with_claude"];
const HOME = "src/db/schema/imports.ts";

/**
 * `parsed` is the status the rule is mistaken for. 🔴 Five places asked "is this read in the ledger?" with it alone, in
 * the app: `failedUnexpectedly`, `copiesWithheldFor`, `withheldSectionsOf`, `withheldNoticeOf` and the statement gaps'
 * withheld windows — each reading a file parsed with Claude's help as not imported (the review, 2026-10-01). A runbook
 * in scripts/ checks the one status a write recorded, and a parser's read is recorded `parsed`; `parsed_with_claude`
 * compared alone asks how a file was read, which is another question.
 */
const { copiesIn, copiesInTree } = statusRuleScan({ statuses: IMPORT_STATUSES, admits: LIVE, mistakenFor: "parsed" });

/** The 1-based line of the home's first line that starts with `prefix`. */
const homeLine = (prefix: string): number => lineOf(HOME, prefix);

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
 * A copy (`status-rule-scan`, the one scan every status rule's guard runs) is a statement, or a part of one, whose code
 * names both live statuses but not every status (a list of every status is `IMPORT_STATUSES`), or names every status
 * that is not live and none that is: `notInArray(status, ["failed", "needs_claude", "superseded"])` is the same rule
 * inside out. A switch's cases and an object's keys are read as the groups they make, and in the app `parsed` compared
 * alone is the rule narrowed. Comments are not scanned, the statuses a raw SQL string quotes are, and each statement is
 * reported, so the home holds the one declaration and nothing else. Tests are not scanned.
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
