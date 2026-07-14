"use client";

import type { KeyboardEvent } from "react";
import { useInlineEdit, type InlineSaveResult } from "@/hooks/useInlineEdit";
import { resolveTextCommit, type CommitOutcome } from "@/lib/inline-edit";

interface InlineEditableTextProps {
  value: string;
  /** persist the new value; optimistic UI reverts if this resolves !ok */
  onSave: (next: string) => Promise<InlineSaveResult>;
  /** accessible name for the control (e.g. "Account name") */
  label: string;
  /** blanking reverts silently instead of saving empty (default true) */
  required?: boolean;
  maxLength?: number;
  /** shown when the value is empty (optional fields) */
  placeholder?: string;
  /** toast title on a committed save (the toast carries Undo) */
  describe?: (next: string) => string;
  /** typography/classes applied to BOTH the display trigger and the input so
   *  the field reads identically in view and edit mode (no size jump) */
  className?: string;
  /** override the commit decision (e.g. resolveDateCommit for ISO dates);
   *  defaults to the plain text resolver with required/maxLength */
  resolve?: (original: string, draft: string) => CommitOutcome<string>;
}

/**
 * Click-to-edit text — the reusable "nothing read-only" primitive. Click (or
 * focus + Enter/Space) turns the value into an input; Enter/blur commits,
 * Escape cancels, blanking a required field reverts. Optimistic with Toast+Undo.
 * The trigger is an inline role=button span so the text flows and wraps exactly
 * like the surrounding copy (a heading, a cell) — never truncated. All decision
 * logic is the pure lib/inline-edit core; this is only the renderer.
 */
export function InlineEditableText({
  value,
  onSave,
  label,
  required = true,
  maxLength,
  placeholder,
  describe,
  className,
  resolve,
}: InlineEditableTextProps) {
  const edit = useInlineEdit<string>({
    value,
    format: (v) => v,
    resolve: resolve ?? ((original, draft) => resolveTextCommit(original, draft, { required, maxLength })),
    onSave,
    label,
    describe: describe ?? ((v) => `Renamed to “${v}”`),
  });

  const shared = className ?? "";

  if (edit.editing) {
    return (
      <span className="inline-flex min-w-0 flex-col gap-1 align-baseline">
        <input
          ref={edit.inputRef}
          value={edit.draft}
          onChange={(e) => edit.change(e.target.value)}
          onKeyDown={edit.onKeyDown}
          onBlur={edit.commit}
          aria-label={label}
          aria-invalid={edit.error ? true : undefined}
          maxLength={maxLength}
          size={Math.max(edit.draft.length + 1, 8)}
          data-inline-edit="input"
          className={`-mx-1.5 max-w-full min-w-0 rounded-md border border-accent bg-surface-raised px-1.5 py-0.5 outline-none ${shared}`}
        />
        {edit.error ? (
          <span role="alert" className="text-xs font-normal text-negative">
            {edit.error}
          </span>
        ) : null}
      </span>
    );
  }

  const empty = edit.display.trim() === "";
  const activate = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      edit.begin();
    }
  };
  return (
    <span
      ref={(node) => {
        edit.triggerRef.current = node;
      }}
      role="button"
      tabIndex={0}
      onClick={edit.begin}
      onKeyDown={activate}
      data-inline-edit="trigger"
      aria-label={`${label}: ${empty ? "empty" : edit.display}. Click to edit.`}
      aria-busy={edit.pending || undefined}
      className={`group/ie cursor-text break-words rounded-[3px] underline-offset-[6px] outline-none transition-[text-decoration-color] duration-(--duration-fast) hover:underline hover:decoration-line-strong hover:decoration-dotted focus-visible:underline focus-visible:decoration-accent focus-visible:decoration-dotted ${empty ? "text-ink-faint" : ""} ${shared}`}
    >
      {empty ? placeholder ?? "—" : edit.display}
      <PencilGlyph />
    </span>
  );
}

/** Tiny inline pencil (the app's Icon set has no edit glyph); opacity-only reveal. */
function PencilGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width="0.7em"
      height="0.7em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ml-1.5 inline-block shrink-0 align-baseline text-ink-faint opacity-0 transition-opacity duration-(--duration-fast) group-hover/ie:opacity-100 group-focus-visible/ie:opacity-100"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </svg>
  );
}
