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
    expect(script).toMatch(/import \{ listed \} from "@\/lib\/ledger-check-listing";/);
    expect(script).not.toMatch(/console\.log\(\s*`  (⚠️ )?\[/);
    expect(script).not.toMatch(/`  ⚠️ \$\{/);
  });

  test("each kind, by its tag", () => {
    expect(script).toContain("console.log(listed(\"kept opening\", sentence));");
    expect(script).toMatch(/console\.log\(\s*listed\(\s*"beyond the backfills",/);
    expect(script).toContain("for (const line of acknowledged) console.log(listed(\"line-left-out, acknowledged\", lineLeftOutNotice(line)));");
    expect(script).toContain("console.log(listed(\"acknowledgement matching no line\", ");
    expect(script).toContain("for (const read of acrossBanks) console.log(listed(\"read at two banks\", readAcrossBanksNotice(read), { warns: true }));");
  });

  test("an account standing only on a kept opening is counted on a line of its own, every run, and listed under it", () => {
    const count = script.indexOf(
      "console.log(`accounts standing only on the opening of a statement you un-imported: ${onKeptOpenings.length}`);",
    );
    const listing = script.indexOf("for (const [name, day] of onKeptOpenings) {");
    expect(script.slice(listing, script.indexOf("console.log(`stale verdicts:"))).toContain('console.log(listed("kept opening", sentence));');
    expect(count).toBeGreaterThan(0);
    expect(listing).toBeGreaterThan(count);
  });
});
