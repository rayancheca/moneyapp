import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `pnpm ledger-check` names every read whose accounts are at two banks: the bank it records is the importer's guess
 * (`readsAcrossBanks`, services/import/reads-across-banks.test.ts). A source gate, as ledger-check-left-out.test.ts:
 * the rule and its sentence are tested where they live; this pins only that the script asks that rule, prints that
 * sentence, and NAMES rather than fails — it moves no money, and no command can make it pass.
 */
const script = fs.readFileSync(path.join(process.cwd(), "scripts/ledger-check.ts"), "utf8");

describe("ledger-check — reads of accounts at two banks", () => {
  test("asks the rule, counts what it finds and prints each one's sentence", () => {
    expect(script).toMatch(/const acrossBanks = readsAcrossBanks\(db\);/);
    expect(script).toContain("console.log(`reads of accounts at two banks: ${acrossBanks.length}`);");
    expect(script).toContain('for (const read of acrossBanks) console.log(listed("read at two banks", readAcrossBanksNotice(read), { warns: true }));');
  });

  test("names them and fails nothing: they are no finding", () => {
    expect(script).toContain("const findings = failures.length + recordFailures.length + leftOutFailures.length;");
    expect(script).not.toMatch(/acrossBanks[^\n]*findings|findings[^\n]*acrossBanks/);
    expect(script).not.toMatch(/console\.error\([^\n]*acrossBanks/);
  });
});
