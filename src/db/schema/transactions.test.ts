import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { lineOf, statusRuleScan } from "./status-rule-scan";
import { LIVE_ROW, TRANSACTION_STATUSES, type TransactionStatus } from "./transactions";

/**
 * The statuses of a row still in the ledger. Pinned here rather than read from `LIVE_ROW`, so the scan below looks for
 * copies of the rule with its own reading of it, and a change to the rule is a change to this test as well.
 */
const LIVE: readonly TransactionStatus[] = ["active", "quarantined", "excluded"];
const HOME = "src/db/schema/transactions.ts";
/** reconciliation's own rule, the rows a statement's arithmetic counts — the same three statuses today */
const RECONCILE_HOME = "src/lib/reconciliation.ts";

const { copiesIn, copiesInTree } = statusRuleScan({ statuses: TRANSACTION_STATUSES, admits: LIVE });

describe("a live row", () => {
  test("is an active, quarantined or excluded one", () => {
    expect(LIVE_ROW).toEqual(LIVE);
  });

  /**
   * The rule's other spelling is `!= 'superseded'`: the schema's partial unique index, and the queries that look a row
   * up by its dedupe hash under it, read a live row so. The two agree only while `superseded` is the one status left
   * out — so a status added to the type and not to the rule fails here, not in a ledger.
   */
  test("is every status but superseded, as the queries that ask `!= 'superseded'` read it", () => {
    expect(TRANSACTION_STATUSES.filter((s) => !(LIVE_ROW as readonly TransactionStatus[]).includes(s))).toEqual(["superseded"]);
  });
});

/**
 * ⛔ ONE HOME. Which transaction statuses leave a row in the ledger was spelled out eleven times: a `LIVE_ROW` of its
 * own in printed-lines, statement-copies and kept-openings, and eight inline lists — kept-openings, spending's
 * `ledgerFirstDay`, unimport-counts, three in import/service.ts (`captureCarryForward`, `coveredRanges`,
 * `supersedeFileContribution`), import-records/printed-lines and scripts/fix-card-payment-mirrors.ts — counted
 * 2026-10-01. All eleven agreed, so no behavioural test could tell a copy from the rule: they differ only on the day a
 * status is added, or one of them is edited.
 *
 * A copy (`status-rule-scan`, the scan LIVE_FILE's guard runs) is a statement, or a part of one, whose code names all
 * three live statuses but not every status (a list of every status is `TRANSACTION_STATUSES`). Two of them are other
 * rules — replay's `active` and `excluded` (`REPLAY_STATUSES`), a takeover's `active` and `quarantined` — and so is
 * `active` alone, the rows analytics count. `superseded` alone is not the rule inside out here: one status left out is
 * named by everything that speaks of it, and `!= 'superseded'` is the rule's other spelling (above).
 *
 * `RECONCILE_STATUSES` names the same three: the rows a statement's arithmetic counts, a rule of its own with its own
 * home and pin (lib/reconciliation.test.ts), so the tree holds exactly the two declarations.
 */
describe("the live row statuses have one home", () => {
  test("no source file names them but the schema's — and reconciliation's own rule — and each names them once", () => {
    const { copies, scanned } = copiesInTree();
    // guards the guard: a walk that read next to nothing would pass on the homes alone
    expect(scanned).toBeGreaterThan(600);
    expect([...copies].sort()).toEqual([
      `${HOME}:${lineOf(HOME, "export const LIVE_ROW =")}`,
      `${RECONCILE_HOME}:${lineOf(RECONCILE_HOME, "export const RECONCILE_STATUSES =")}`,
    ]);
  });

  test("a second copy in the schema's own file is one too many: a partial index beside the table", () => {
    const home = fs.readFileSync(path.join(process.cwd(), HOME), "utf8");
    const index = 'index("ix_transactions_transfer_group").on(table.transferGroupId),';
    const live = "index(\"ix_transactions_live\").on(table.accountId).where(sql`status in ('active', 'quarantined', 'excluded')`),";
    const planted = home.replace(index, `${index}\n    ${live}`);
    expect(planted).not.toBe(home);
    expect(copiesIn(planted, HOME)).toEqual([lineOf(HOME, "export const LIVE_ROW ="), lineOf(HOME, "export const transactions =")]);
  });

  test.each([
    ["the copy printed-lines kept", 'const LIVE_ROW = ["active", "quarantined", "excluded"] as const;'],
    [
      "an inline list in a query",
      'db.select().from(transactions).where(inArray(transactions.status, ["active", "quarantined", "excluded"]));',
    ],
    ["the order changed, in a Set", 'const LIVE = new Set<TransactionStatus>(["excluded", "active", "quarantined"]);'],
    ["raw SQL", "db.all(sql`SELECT MIN(posted_on) FROM transactions WHERE status IN ('active','quarantined','excluded')`);"],
    ["raw SQL in a script's string", "sqlite.prepare(\"SELECT count(*) FROM transactions WHERE status IN ('active', 'quarantined', 'excluded')\").get();"],
    ["raw SQL around an interpolation", "sql`${transactions.status} IN ('active', 'quarantined', ${\"excluded\"})`;"],
    ["a comparison chain", 'const live = (s: string) => s === "active" || s === "quarantined" || s === "excluded";'],
    ["a union type", 'type Live = "active" | "quarantined" | "excluded";'],
    ["a switch", 'switch (s) {\n  case "active":\n  case "quarantined":\n  case "excluded":\n    return true;\n}'],
    [
      "an exhaustive switch",
      'switch (s) {\n  case "active":\n  case "quarantined":\n  case "excluded":\n    return true;\n  case "superseded":\n    return false;\n}',
    ],
    ["a map grouping every status", 'const GROUPS = { live: ["active", "quarantined", "excluded"], retired: ["superseded"] } as const;'],
    [
      "a lookup by status",
      "const IS_LIVE: Record<TransactionStatus, boolean> = { active: true, quarantined: true, excluded: true, superseded: false };",
    ],
    ["a key set", "const LIVE = { active: 1, quarantined: 1, excluded: 1 } as const;"],
    // 🔴 the review, 2026-10-01: a SQL string was read whole, and one that also names `superseded` names every status
    [
      "raw SQL that retires the rows it lists",
      "db.run(sql`UPDATE transactions SET status = 'superseded' " +
        "WHERE status IN ('active','quarantined','excluded') AND import_file_id = ${id}`);",
    ],
    [
      "a list in raw SQL, in the clause that names superseded",
      "db.all(sql`SELECT id, status IN ('active','quarantined','excluded') AS live, " +
        "status = 'superseded' AS retired FROM transactions`);",
    ],
    [
      "a comparison chain in raw SQL, beside the status it sets",
      "sqlite.prepare(\"UPDATE transactions SET status = 'superseded' " +
        "WHERE status = 'active' OR status = 'quarantined' OR status = 'excluded'\").run();",
    ],
    [
      "a SQL CASE grouping every status",
      "db.all(sql`SELECT id, CASE status WHEN 'active' THEN 1 WHEN 'quarantined' THEN 1 WHEN 'excluded' THEN 1 " +
        "WHEN 'superseded' THEN 0 END AS live FROM transactions`);",
    ],
  ])("flags %s", (_label, code) => {
    expect(copiesIn(code, "src/planted.ts")).not.toEqual([]);
  });

  /**
   * 🔴 A raw SQL string was read whole, so a write that retires rows — the usual shape of a runbook's — named every
   * status, and the list beside its `SET status = 'superseded'` was not a copy (the review, 2026-10-01).
   */
  test("flags a runbook's write that retires the rows it lists", () => {
    const retire =
      "sqlite.prepare(\"UPDATE transactions SET status = 'superseded' " +
      "WHERE status IN ('active', 'quarantined', 'excluded') AND import_file_id = ?\").run(fileId);";
    expect(copiesIn(retire, "scripts/planted.ts")).toEqual([1]);
  });

  test.each([
    ["the rule itself, spread", "inArray(transactions.status, [...LIVE_ROW]);"],
    ["the rule's other spelling, in a query", 'and(eq(transactions.dedupeHash, hash), ne(transactions.status, "superseded"));'],
    [
      "the rule's other spelling, the schema's partial index",
      "uniqueIndex(\"ux\").on(table.accountId, table.dedupeHash).where(sql`status != 'superseded'`);",
    ],
    [
      "a row retired",
      'tx.update(transactions).set({ status: "superseded" }).where(inArray(transactions.status, [...LIVE_ROW])).run();',
    ],
    // a file naming all three can still hold two rules that each name two, or one: each statement is read on its own
    [
      "replay's pair, in a file that quarantines",
      'export const REPLAY_STATUSES = ["active", "excluded"] as const;\nconst held = eq(transactions.status, "quarantined");',
    ],
    [
      "replay's pair in raw SQL, beside a count of the quarantined",
      "db.all(sql`SELECT 1 FROM transactions WHERE status IN ('active','excluded')`);\ndb.all(sql`SELECT count(*) FROM transactions WHERE status = 'quarantined'`);",
    ],
    [
      "a takeover's pair, in a file that excludes",
      'inArray(transactions.status, ["active", "quarantined"]);\ntx.update(transactions).set({ status: "excluded" }).run();',
    ],
    [
      "the rows analytics count, beside the rows it hides",
      'const counted = eq(transactions.status, "active");\nconst hidden = ["quarantined", "excluded"];',
    ],
    ["every status", 'const TRANSACTION_STATUSES = ["active", "quarantined", "excluded", "superseded"] as const;'],
    [
      "a view per status, every value different",
      'const EMPTY = { active: "No transactions", quarantined: "None quarantined", excluded: "None excluded" };',
    ],
    [
      "a view switch, a body per status",
      'switch (view) {\n  case "quarantined":\n    return eq(transactions.status, "quarantined");\n' +
        '  case "excluded":\n    return eq(transactions.status, "excluded");\n  case "all":\n    return eq(transactions.status, "active");\n}',
    ],
    [
      "a count of every status",
      "const counts: Record<TransactionStatus, number> = { active: 0, quarantined: 0, excluded: 0, superseded: 0 };",
    ],
    ["a line comment quoting an old list", '// was ["active", "quarantined", "excluded"]\ninArray(transactions.status, [...LIVE_ROW]);'],
    ["prose naming all three", "console.log(`ledgerFirstDay (active+quarantined+excluded): ${day}`);"],
    // a SQL string is read by its parts, and a part that names every status is still the status type's
    [
      "every status in raw SQL",
      "db.all(sql`SELECT status, COUNT(*) n FROM transactions " +
        "WHERE status IN ('active','quarantined','excluded','superseded') GROUP BY status`);",
    ],
    [
      "a SQL label per status",
      "db.all(sql`SELECT CASE status WHEN 'active' THEN 'Active' WHEN 'quarantined' THEN 'Held' " +
        "WHEN 'excluded' THEN 'Hidden' WHEN 'superseded' THEN 'Retired' END FROM transactions`);",
    ],
  ])("does not flag %s", (_label, code) => {
    expect(copiesIn(code, "src/planted.ts")).toEqual([]);
  });

  test("flags a list in a plain JavaScript script, single-quoted", () => {
    expect(copiesIn("const LIVE = ['active', 'quarantined', 'excluded'];", "scripts/planted.mjs")).not.toEqual([]);
  });
});
