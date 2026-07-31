import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { failedRunMessage } from "./HeaderStrip";
import type { ClaudeRunResult } from "@/services/claude-categorize";

function run(overrides: Partial<ClaudeRunResult> = {}): ClaudeRunResult {
  return {
    ran: true,
    queued: 12,
    classified: 0,
    needsReview: 0,
    estCostUsd: 0.01,
    ...overrides,
  };
}

describe("failedRunMessage", () => {
  it("says nothing about a run that did not fail", () => {
    expect(failedRunMessage(run())).toBeNull();
    expect(failedRunMessage(run({ failed: false, error: "leftover" }))).toBeNull();
    // a stopped or capped run is a result, not a failure — those have their own spans
    expect(failedRunMessage(run({ stopped: true, capReached: true }))).toBeNull();
  });

  it("states the cause of a failed run", () => {
    expect(failedRunMessage(run({ failed: true, error: "401 Unauthorized" }))).toBe(
      "Claude run failed: 401 Unauthorized",
    );
  });

  it("still says something when the cause is missing or blank", () => {
    // regression: a throw with an empty message, or a run stored before the
    // failure fields existed, must not render as "Claude run failed: "
    expect(failedRunMessage(run({ failed: true }))).toBe("Claude run failed: Unexpected error");
    expect(failedRunMessage(run({ failed: true, error: "   " }))).toBe(
      "Claude run failed: Unexpected error",
    );
  });

  it("calls out committed batches as partial progress", () => {
    // the summary line above reads "N transactions classified" — without this
    // the failure looks like it undid them
    expect(failedRunMessage(run({ failed: true, error: "rate limited", classified: 34 }))).toBe(
      "Claude run failed: rate limited · the counts above are partial progress, not a result",
    );
  });

  it("collapses a multi-line provider body onto one line", () => {
    const message = failedRunMessage(
      run({ failed: true, error: "429 Too Many Requests\n{\n  \"type\": \"error\"\n}" }),
    );
    expect(message).toBe('Claude run failed: 429 Too Many Requests { "type": "error" }');
    expect(message).not.toContain("\n");
  });

  it("clamps a runaway cause so the strip stays readable at 440px", () => {
    const message = failedRunMessage(run({ failed: true, error: "x".repeat(500) }))!;
    expect(message.endsWith("…")).toBe(true);
    // "Claude run failed: " + 160 chars + the ellipsis
    expect(message.length).toBe("Claude run failed: ".length + 161);
    expect(message).not.toContain("…x");
  });

  it("does not double-punctuate a cause that ends in a period", () => {
    expect(
      failedRunMessage(run({ failed: true, error: "Could not reach the API.", classified: 2 })),
    ).toBe(
      "Claude run failed: Could not reach the API · the counts above are partial progress, not a result",
    );
  });
});

/**
 * The MARKUP contract. `failedRunMessage` above is pure and thoroughly tested,
 * but the value it returns reached the DOM through JSX that nothing asserted —
 * and this runner is `environment: "node"`, so there is no DOM to render into.
 * Source-text assertions are the repo's answer to that (precedent:
 * `components/charts/NetWorthTerrain.test.ts`), and they are enough to catch the
 * regressions that actually matter here: the call being dropped, or the live
 * region being removed so the failure becomes silent.
 *
 * Why it needs guarding at all: the redirect back from a failed categorize run is
 * a CLIENT navigation. Without `role="alert"` the page looks unchanged and a
 * screen-reader user is never told the run failed — the same class of silence the
 * `?error=` banner exists to prevent, and one that three handoffs in a row
 * described as "not rendered at all" while it was in fact rendered but untested.
 */
describe("the failure line's markup", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/components/transactions/HeaderStrip.tsx"), "utf8");

  it("computes the failure message and renders it, rather than discarding it", () => {
    expect(src).toMatch(/const failure = .*failedRunMessage\(/);
    // the computed value is actually placed in the tree
    expect(src).toMatch(/\{failure && \(/);
    expect(src).toContain("{failure}");
  });

  it("announces the failure in a live region", () => {
    // the <p> that carries {failure} must be the one with role="alert"
    const block = src.slice(src.indexOf("{failure && ("));
    expect(block.slice(0, block.indexOf("{failure}"))).toContain('role="alert"');
  });

  it("keeps the terse ' · failed' chip on the summary line as well", () => {
    expect(src).toContain("lastRun.failed &&");
  });
});
