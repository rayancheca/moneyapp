/**
 * Result types for the value-returning transaction actions (ux-overhaul-plan
 * §3.0), now the shared contract for EVERY server action in the app. Dependency
 * free — client packages import from here without pulling any server code (the
 * service imports below are type-only and fully erased) and without pulling zod.
 */

import { MoneyParseError, parseAmountToCents } from "@/lib/money";
import type { UndoPatch } from "@/services/bulk-edit";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * One validation failure, described structurally so this module stays zod-free
 * while zod's `error.issues` still passes straight in.
 */
export interface FieldIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * The first validation failure as one sentence a person can act on, naming the
 * field when the schema's own message doesn't already.
 *
 * Actions report through this instead of letting a throwing `.parse()` escape:
 * an unhandled throw inside a form action replaces the whole document with a
 * Next.js error digest and loses every other field the user had typed.
 */
export function firstIssueMessage(
  issues: readonly FieldIssue[],
  labels: Readonly<Record<string, string>> = {},
  fallback = "Check the highlighted field",
): string {
  const issue = issues[0];
  if (issue === undefined) return fallback;
  const message = issue.message.trim() === "" ? fallback : issue.message;
  const key = issue.path.length > 0 ? String(issue.path[0]) : null;
  const label = key === null ? undefined : labels[key];
  if (label === undefined) return message;
  // A hand-written message ("Name the account") already says which field it is;
  // zod's default ("Invalid option: expected one of …") does not, so only that
  // one gets the prefix.
  return message.toLowerCase().includes(label.toLowerCase()) ? message : `${label}: ${message}`;
}

/**
 * Zod issues carried by a thrown ZodError, recognised STRUCTURALLY so this
 * module never imports zod. Returns null for anything that isn't one.
 */
function issuesOf(error: unknown): readonly FieldIssue[] | null {
  if (typeof error !== "object" || error === null) return null;
  const { issues } = error as { issues?: unknown };
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const looksLikeIssue = (i: unknown): i is FieldIssue =>
    typeof i === "object" &&
    i !== null &&
    Array.isArray((i as FieldIssue).path) &&
    typeof (i as FieldIssue).message === "string";
  return issues.every(looksLikeIssue) ? (issues as FieldIssue[]) : null;
}

/**
 * Any caught error as something a person can read.
 *
 * The zod branch matters: `ZodError.message` is a JSON dump of every issue, so
 * an action that `.parse()`s inside a try/catch and reports `error.message` was
 * putting a pretty-printed array in front of the user instead of "Expected
 * YYYY-MM". Non-zod errors keep their own message; anything else gets the
 * fallback.
 */
export function actionErrorMessage(
  error: unknown,
  labels: Readonly<Record<string, string>> = {},
  fallback = "Something went wrong",
): string {
  const issues = issuesOf(error);
  if (issues !== null) return firstIssueMessage(issues, labels, fallback);
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return fallback;
}

/** What a money field should say when the parser rejects it. */
export const AMOUNT_HINT = "that amount didn't parse — try 250 or 1,250.00";

/**
 * Read a money field as cents, reporting the failure as an {@link ActionResult}
 * naming the field. MoneyParseError's own text ("Cannot parse amount: \"x\"") is
 * a parser diagnostic, not something to put in front of a person.
 */
export function parseAmountField(label: string, raw: string): ActionResult<number> {
  try {
    return { ok: true, data: parseAmountToCents(raw) };
  } catch (error: unknown) {
    if (error instanceof MoneyParseError) return { ok: false, error: `${label}: ${AMOUNT_HINT}` };
    return { ok: false, error: `${label}: could not read that amount` };
  }
}

/**
 * What a post-correction rule keys on (§3.2/§3.4): a linked merchant when the
 * row has one, else the stripped name key — so "apply to every transaction with
 * this name, past & future" works for the ~47% of rows with no merchant too.
 */
export type RulePromptTarget =
  | { kind: "merchant"; merchantId: string }
  | { kind: "name"; descriptionKey: string };

/** Payload for the post-correction "Apply to all with this name" toast (§3.4). */
export interface RulePromptPreview {
  target: RulePromptTarget;
  /** readable subject for the toast, e.g. "Netflix" or "COKE dividends" */
  subjectLabel: string;
  categoryLabel: string;
  /**
   * server-computed retro count — how many OTHER active, non-user rows a retro
   * apply would recategorize (the just-corrected row and prior user decisions
   * are excluded, so the number is exactly what will change).
   */
  matchCount: number;
}

export interface CorrectCategoryData {
  rulePrompt: RulePromptPreview | null;
  undo: UndoPatch;
}

/** Every bulk mutation returns its blast radius and a lossless inverse. */
export interface BulkMutationData {
  affected: number;
  undo: UndoPatch;
}

/**
 * "Recategorize all N" (sheet same-merchant/name panel): recategorizes the whole
 * server-recomputed group (past) and creates the forward rule (future) in one
 * gesture. `ruleId` is null when the row has no rule-able identity; the client's
 * Undo reverts the recategorize AND deletes the rule.
 */
export interface RecategorizeGroupData {
  affected: number;
  undo: UndoPatch;
  ruleId: string | null;
}

export interface CreatedRuleData {
  ruleId: string;
  name: string;
  priority: number;
  /** matches at creation time under the retro-apply predicate */
  matchCount: number;
}

export type { TxnPatch, TxnFlags, UndoPatch } from "@/services/bulk-edit";
export type { ManualTxnInput } from "@/services/manual-transactions";
