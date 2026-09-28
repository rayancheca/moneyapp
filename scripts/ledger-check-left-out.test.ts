import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * ⚖️ Owner, 2026-09-28: `pnpm ledger-check` names every line a re-read left out of the ledger, and fails on it.
 *
 * A source gate: the script is the I/O around rules tested where they live — the rule in
 * services/import/lines-left-out.test.ts, the sentence in lib/import-file-label.test.ts — so this pins only that it asks
 * that rule, prints that sentence and counts each as a finding. Measured on copies of the real ledger, 2026-09-28: 0
 * today, exit 0; 1 after the Aug–Sep Robinhood activity export was read again at a version that drops its +$0.07 GOOG
 * dividend while a re-download of it was still imported, exit 1 — where the check before this exited 0.
 */
const script = fs.readFileSync(path.join(process.cwd(), "scripts/ledger-check.ts"), "utf8");

describe("ledger-check — lines left out by a re-read", () => {
  test("asks the rule the upload outcome and /imports ask, and prints their one sentence", () => {
    expect(script).toMatch(/const leftOut = linesLeftOut\(db\);/);
    expect(script).toContain("const leftOutFailures = leftOut.map((line) => `[line-left-out] ${lineLeftOutNotice(line)}`);");
  });

  test("each one is a finding: it fails the check", () => {
    expect(script).toContain("const findings = failures.length + recordFailures.length + leftOutFailures.length;");
    expect(script).toContain("for (const line of [...recordFailures, ...leftOutFailures]) console.error(`  ${line}`);");
  });
});
