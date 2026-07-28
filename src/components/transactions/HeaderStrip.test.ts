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
