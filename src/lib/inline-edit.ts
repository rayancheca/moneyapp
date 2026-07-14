import { parseAmountToCents } from "@/lib/money";

/**
 * Pure state + decision logic for inline "click-to-edit" fields (the "nothing
 * read-only" primitives). Kept free of React so the open/draft transitions, the
 * keyboard grammar, and every commit decision (save vs silent no-op vs invalid)
 * are unit-testable without rendering. The <InlineEditableText> /
 * <InlineEditableAmount> components and useInlineEdit hook are thin shells over
 * this.
 */

// ── edit-state reducer (idle ↔ editing-with-draft) ───────────────────
export type InlineEditState = { editing: false } | { editing: true; draft: string };

export type InlineEditAction =
  | { type: "begin"; value: string }
  | { type: "change"; draft: string }
  | { type: "close" };

export const IDLE: InlineEditState = { editing: false };

export function inlineEditReducer(state: InlineEditState, action: InlineEditAction): InlineEditState {
  switch (action.type) {
    case "begin":
      return { editing: true, draft: action.value };
    case "change":
      // guard against a stray change after close — never resurrect a draft
      return state.editing ? { editing: true, draft: action.draft } : state;
    case "close":
      return IDLE;
    default:
      return state;
  }
}

// ── keyboard grammar ─────────────────────────────────────────────────
export type InlineEditIntent = "commit" | "cancel";

/** Enter commits, Escape cancels; every other key is the input's own. */
export function keyToIntent(key: string): InlineEditIntent | null {
  if (key === "Enter") return "commit";
  if (key === "Escape") return "cancel";
  return null;
}

// ── commit resolution ────────────────────────────────────────────────
export type CommitOutcome<T> =
  | { kind: "save"; value: T }
  | { kind: "noop" }
  | { kind: "invalid"; error: string };

export interface TextCommitOptions {
  /** blank reverts silently instead of saving empty (default true) */
  required?: boolean;
  /** reject drafts longer than this after trim */
  maxLength?: number;
}

/**
 * Resolve a text edit. Trims; a blank required field and an unchanged value are
 * silent no-ops (revert, no error nag); a too-long draft is invalid.
 */
export function resolveTextCommit(
  original: string,
  draft: string,
  options: TextCommitOptions = {},
): CommitOutcome<string> {
  const { required = true, maxLength } = options;
  const trimmed = draft.trim();
  if (maxLength !== undefined && trimmed.length > maxLength) {
    return { kind: "invalid", error: `Keep it to ${maxLength} characters or fewer` };
  }
  if (trimmed === "") {
    // blanking a required field is a silent cancel; an optional field may clear
    if (required) return { kind: "noop" };
    // compare on the trimmed original so a whitespace-only original is "already
    // empty" (no-op), never a spurious empty save
    return original.trim() === "" ? { kind: "noop" } : { kind: "save", value: "" };
  }
  if (trimmed === original.trim()) return { kind: "noop" };
  return { kind: "save", value: trimmed };
}

/**
 * Resolve a money edit to integer cents. Parses via the ledger's string-math
 * parser (never floats); unchanged cents are a no-op regardless of formatting.
 */
export function resolveAmountCommit(originalCents: number, draft: string): CommitOutcome<number> {
  let cents: number;
  try {
    cents = parseAmountToCents(draft);
  } catch {
    // MoneyParseError → a friendly, uniform message (the parser is the only throw)
    return { kind: "invalid", error: "Enter a valid amount" };
  }
  if (cents === originalCents) return { kind: "noop" };
  return { kind: "save", value: cents };
}
