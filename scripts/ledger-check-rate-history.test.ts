import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * ⚖️ A series' past rates (`user_amount_history`, owner decision 2026-10-08, §6A 55) are JSON with no constraint, and
 * the app reads them strictly — a history its reader refuses refuses every page that projects the series. So
 * `pnpm ledger-check` FAILS on each, through that same reader (`rateHistoryRefusals`).
 *
 * A source gate, as ledger-check-left-out.test.ts: the rule and its sentence are tested where they live
 * (services/rate-history-check.test.ts, lib/series-kind.test.ts); this pins only that the script asks that rule, counts
 * what it finds and fails on each. Measured on copies of his ledger, 2026-10-08: with his history written, "rate
 * histories: 1 stored · 0 the app cannot read", exit 0; with `[]` stored instead, the one finding, exit 1.
 */
const script = fs.readFileSync(path.join(process.cwd(), "scripts/ledger-check.ts"), "utf8");

describe("ledger-check — rate histories", () => {
  test("asks the app's own reader, and counts what is stored beside what it refuses", () => {
    expect(script).toContain(
      "const rateHistoryFailures = rateHistoryRefusals(db).map((r) => `[rate-history ${r.seriesId}] ${r.sentence}`);",
    );
    expect(script).toContain(
      "console.log(`rate histories: ${storedRateHistoryCount(db)} stored · ${rateHistoryFailures.length} the app cannot read`);",
    );
  });

  test("each one the reader refuses is a finding: it fails the check, and is printed with it", () => {
    expect(script).toContain(
      "const findings = failures.length + recordFailures.length + leftOutFailures.length + rateHistoryFailures.length;",
    );
    expect(script).toContain(
      "for (const line of [...recordFailures, ...leftOutFailures, ...rateHistoryFailures]) console.error(`  ${line}`);",
    );
  });

  test("it is asked before the guarded steps exit, so a plain run always asks it", () => {
    const asked = script.indexOf("const rateHistoryFailures = rateHistoryRefusals(db)");
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(script.indexOf('if (MODE.mode === "acknowledge") {'));
  });
});
