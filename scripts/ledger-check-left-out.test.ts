import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * ⚖️ Owner, 2026-09-28: `pnpm ledger-check` names every line a re-read left out of the ledger, and fails on it.
 * ⚖️ Owner, 2026-10-02 (§6A 30): …unless a session, having read it on the statement, acknowledged it — then it is still
 * named, with the day it was acknowledged, and is no finding.
 *
 * A source gate: the script is the I/O around rules tested where they live — the rule and its acknowledgements in
 * services/import/lines-left-out.test.ts and lib/left-out-acknowledgement.test.ts, the sentence in
 * lib/import-file-label.test.ts, the command line in lib/witness-floor.test.ts — so this pins only that it asks that
 * rule, prints that sentence and counts each line nobody acknowledged as a finding. Measured on copies of the real
 * ledger, 2026-09-28: 0 today, exit 0; 1 after the Aug–Sep Robinhood activity export was read again at a version that
 * drops its +$0.07 GOOG dividend while a re-download of it was still imported, exit 1 — where the check before this
 * exited 0.
 */
const script = fs.readFileSync(path.join(process.cwd(), "scripts/ledger-check.ts"), "utf8");

describe("ledger-check — lines left out by a re-read", () => {
  test("asks the rule the upload outcome and /imports ask, and prints their one sentence, with the line's mark", () => {
    expect(script).toMatch(/const leftOut = linesLeftOut\(db\);/);
    expect(script).toContain("`[line-left-out ${leftOutToken(line)}] ${lineLeftOutNotice(line)}`");
  });

  test("each one nobody acknowledged is a finding: it fails the check", () => {
    expect(script).toMatch(/const leftOutFailures = leftOut\s*\.filter\(\(line\) => line\.acknowledged === null\)/);
    expect(script).toContain("const findings = failures.length + recordFailures.length + leftOutFailures.length;");
    expect(script).toContain("for (const line of [...recordFailures, ...leftOutFailures]) console.error(`  ${line}`);");
  });

  /* the sentence carries the day and what the session read (`acknowledgedSentence`, lib/import-file-label.test.ts) */
  test("an acknowledged one is named still, saying so and why — and an acknowledgement matching no line is named too", () => {
    expect(script).toMatch(/const acknowledged = leftOut\.filter\(\(line\) => line\.acknowledged !== null\);/);
    expect(script).toContain("for (const line of acknowledged) console.log(`  [line-left-out, acknowledged] ${lineLeftOutNotice(line)}`);");
    expect(script).toMatch(/for \(const ack of acknowledgementsMatchingNothing\(db, leftOut\)\)/);
  });

  test("the way out it prints for a failing line asks for what the session read on the statement", () => {
    expect(script).toContain("pnpm ledger-check --acknowledge-left-out=<mark> --reason='<what the statement shows>' --confirm");
  });

  /*
   * ⛔ "An entry without a reason is a check that has been quieted rather than passed" (BASELINE, above): the write
   * stores the reason the command line was given — and the command line refuses --confirm without one
   * (`ledgerCheckMode`, lib/witness-floor.test.ts), before the ledger is opened.
   */
  test("acknowledging is the guarded step: a dry run, --confirm writes with the reason, a mark matching nothing refuses", () => {
    expect(script).toMatch(/if \(MODE\.mode === "acknowledge"\) \{/);
    expect(script).toContain("const acknowledging = { on: todayIso(), reason: MODE.reason };");
    expect(script).toContain("const plan = planAcknowledging(leftOut, MODE.tokens, acknowledging);");
    const step = script.slice(script.indexOf('if (MODE.mode === "acknowledge") {'));
    const [refuse, dryRun, write] = [
      step.indexOf("if (plan.unmatched.length > 0)"),
      step.indexOf("if (!MODE.confirm)"),
      step.indexOf("writeLeftOutAcknowledgements(db, acknowledgementWrites(plan.open, { ...acknowledging, reason: MODE.reason }));"),
    ];
    expect(refuse).toBeGreaterThan(0);
    expect(dryRun).toBeGreaterThan(refuse);
    expect(write).toBeGreaterThan(dryRun);
    expect(step.slice(refuse, dryRun)).toContain("process.exit(2);");
  });

  /*
   * 🔴 It picked its last words by whether a reason was given only: after two marks it said "the same command with
   * --reason='…' --confirm", which the command line refuses (a reason says what ONE line is). The rule words the run that
   * confirms (`confirmingStep`, lib/left-out-acknowledgement.test.ts): one a mark, when the dry run named several.
   */
  test("a dry run ends with the run that confirms it, as the rule words it — never one the command line refuses", () => {
    const step = script.slice(script.indexOf('if (MODE.mode === "acknowledge") {'));
    const dryRun = step.slice(step.indexOf("if (!MODE.confirm)"), step.indexOf("writeLeftOutAcknowledgements("));
    expect(dryRun).toContain(
      'console.log(`\\ndry run: nothing was written. ${confirmingStep(MODE.tokens, plan.open, MODE.reason).join("\\n")}`);',
    );
    expect(script).not.toMatch(/MODE\.reason === null \?/);
  });
});
