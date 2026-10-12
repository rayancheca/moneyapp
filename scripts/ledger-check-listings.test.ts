import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every line `pnpm ledger-check` NAMES and fails nothing on is printed through `listed` (src/lib/ledger-check-listing.ts),
 * under its count line — the one shape the pre-commit hook prints of a passing run (scripts/pre-commit-hook.test.ts runs
 * the hook on it). A source gate, as ledger-check-left-out.test.ts: the sentences are tested where they live; this pins
 * only that each listing is printed in that shape, so the hook shows it.
 *
 * 🔴 Two were not in it: an account standing only on the opening of a statement he un-imported was printed at the margin
 * with no count line, and the files read at a version their profile has moved past with no tag — the hook would have
 * dropped both, or printed the first under the count line of whatever came before it.
 */
const script = fs.readFileSync(path.join(process.cwd(), "scripts/ledger-check.ts"), "utf8");

describe("ledger-check — what it names and fails nothing on", () => {
  test("is printed through `listed`, never shaped by hand", () => {
    expect(script).toMatch(/import \{ beyondBackfillsNotice, keptOpeningNotice, listed, namedFiles \} from "@\/lib\/ledger-check-listing";/);
    expect(script).not.toMatch(/console\.log\(\s*`  (⚠️ )?\[/);
    expect(script).not.toMatch(/`  ⚠️ \$\{/);
  });

  /* 🔴 built inline, the hook's test stood for them with copies that drifted (the handoff of 2026-10-09, §6C) */
  test("its sentences are built where the hook's test reads them, never in the script", () => {
    expect(script).not.toContain("stands only on the opening of a statement you un-imported (");
    expect(script).not.toContain("the backfills read a file only at the version that imported it");
    expect(script).not.toMatch(/files\.slice\(0, 3\)/);
  });

  test("each kind, by its tag", () => {
    expect(script).toContain('console.log(listed("kept opening", keptOpeningNotice(name, day)));');
    expect(script).toContain('console.log(listed("beyond the backfills", beyondBackfillsNotice(beyondBackfills), { warns: true }));');
    expect(script).toContain("for (const line of acknowledged) console.log(listed(\"line-left-out, acknowledged\", lineLeftOutNotice(line)));");
    expect(script).toContain("console.log(listed(\"acknowledgement matching no line\", ");
    expect(script).toContain("for (const read of acrossBanks) console.log(listed(\"read at two banks\", readAcrossBanksNotice(read), { warns: true }));");
  });

  test("an account standing only on a kept opening is counted on a line of its own, every run, and listed under it", () => {
    const count = script.indexOf(
      "console.log(`accounts standing only on the opening of a statement you un-imported: ${onKeptOpenings.length}`);",
    );
    const listing = script.indexOf("for (const [name, day] of onKeptOpenings) {");
    expect(script.slice(listing, script.indexOf("console.log(`stale verdicts:"))).toContain(
      'console.log(listed("kept opening", keptOpeningNotice(name, day)));',
    );
    expect(count).toBeGreaterThan(0);
    expect(listing).toBeGreaterThan(count);
  });

  /*
   * 🔴 It was listed under the count of the lines left out, so a ledger with none printed "lines left out by a re-read:
   * 0" directly above the acknowledgement it named — and the hook, which prints a listing under its count line, printed
   * the 0 above it (the handoff of 2026-10-09, §6C).
   */
  test("an acknowledgement matching no line is counted on a line of its own, every run, and listed under it", () => {
    const leftOut = script.indexOf("\nconsole.log(`lines left out by a re-read: ");
    const countLine = "\nconsole.log(`acknowledgements matching no line left out: ${matchingNoLine.length}`);";
    const count = script.indexOf(countLine);
    const listing = script.indexOf("for (const ack of matchingNoLine) {");
    expect(leftOut).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(leftOut);
    expect(listing).toBeGreaterThan(count);
    expect(script.slice(count + countLine.length, listing)).not.toContain("console.log(");
    expect(script.slice(listing, script.indexOf("console.log(`reads of accounts at two banks:"))).toContain(
      'console.log(listed("acknowledgement matching no line", ',
    );
    // under the count of the lines left out, only the ones a session acknowledged
    expect(script.slice(leftOut, count).match(/listed\("[^"]+"/g)).toEqual(['listed("line-left-out, acknowledged"']);
  });
});
