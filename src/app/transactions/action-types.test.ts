import { describe, expect, test } from "vitest";
import { z } from "zod";
import { AMOUNT_HINT, actionErrorMessage, firstIssueMessage, parseAmountField } from "./action-types";

/**
 * The reporting layer every server action funnels its failures through. These
 * are the branches that decide what a person actually reads when a form is
 * wrong, so they are tested against REAL zod output rather than hand-built
 * issue objects wherever the shape matters.
 */

const schema = z.object({
  name: z.string().trim().min(1, "Name the account"),
  type: z.enum(["checking", "savings"]),
});

function issuesFor(input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("expected the fixture to fail validation");
  return parsed.error.issues;
}

describe("firstIssueMessage", () => {
  test("returns a hand-written schema message untouched when it already names the field", () => {
    const message = firstIssueMessage(issuesFor({ name: "", type: "checking" }), { name: "Name" });
    expect(message).toBe("Name the account");
  });

  test("prefixes the field label when zod's default message names no field", () => {
    const message = firstIssueMessage(issuesFor({ name: "Chase", type: "brokerage" }), {
      type: "Account type",
    });
    expect(message).toMatch(/^Account type: /);
    expect(message).toContain("checking");
  });

  test("returns the raw message when the field has no label", () => {
    expect(firstIssueMessage(issuesFor({ name: "Chase", type: "nope" }))).not.toMatch(/^undefined/);
  });

  test("falls back when there are no issues at all", () => {
    expect(firstIssueMessage([], {}, "Nothing to report")).toBe("Nothing to report");
  });

  test("falls back when the issue carries an empty message", () => {
    expect(firstIssueMessage([{ path: ["name"], message: "   " }], {}, "Blank")).toBe("Blank");
  });

  test("ignores labels for a top-level issue with an empty path", () => {
    expect(firstIssueMessage([{ path: [], message: "Bad shape" }], { "": "Root" })).toBe("Bad shape");
  });

  test("matches the label case-insensitively before deciding to prefix", () => {
    const message = firstIssueMessage([{ path: ["balance"], message: "Enter a balance" }], {
      balance: "Balance",
    });
    expect(message).toBe("Enter a balance");
  });
});

describe("actionErrorMessage", () => {
  test("unwraps a thrown ZodError instead of dumping its JSON issue array", () => {
    let caught: unknown;
    try {
      schema.parse({ name: "", type: "checking" });
    } catch (error: unknown) {
      caught = error;
    }
    // ZodError.message is a pretty-printed array — the whole reason this exists
    expect((caught as Error).message).toContain("[");
    expect(actionErrorMessage(caught, { name: "Name" })).toBe("Name the account");
  });

  test("keeps a plain Error's own message", () => {
    expect(actionErrorMessage(new Error("Unknown account"), {}, "fallback")).toBe("Unknown account");
  });

  test("falls back for a non-Error throw", () => {
    expect(actionErrorMessage("boom", {}, "Something went wrong")).toBe("Something went wrong");
  });

  test("falls back for an Error with a blank message", () => {
    expect(actionErrorMessage(new Error("  "), {}, "Something went wrong")).toBe(
      "Something went wrong",
    );
  });

  test("does not mistake an unrelated object with an issues array for a ZodError", () => {
    const impostor = { issues: [{ nope: true }] };
    expect(actionErrorMessage(impostor, {}, "fallback")).toBe("fallback");
  });

  test("ignores an empty issues array and uses the Error message", () => {
    const empty = Object.assign(new Error("real message"), { issues: [] });
    expect(actionErrorMessage(empty, {}, "fallback")).toBe("real message");
  });
});

describe("parseAmountField", () => {
  test("reads a formatted amount as cents", () => {
    expect(parseAmountField("Balance", "1,250.00")).toEqual({ ok: true, data: 125_000 });
  });

  test("reports the hint, never MoneyParseError's parser diagnostic", () => {
    const result = parseAmountField("Balance", "not a number");
    expect(result).toEqual({ ok: false, error: `Balance: ${AMOUNT_HINT}` });
    // the raw parser text must never reach a person
    expect(result.ok === false && result.error).not.toContain("Cannot parse amount");
  });

  test("names the field it was given", () => {
    expect(parseAmountField("Initial balance", "??")).toEqual({
      ok: false,
      error: `Initial balance: ${AMOUNT_HINT}`,
    });
  });
});
