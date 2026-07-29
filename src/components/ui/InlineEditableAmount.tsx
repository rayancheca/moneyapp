"use client";

import type { KeyboardEvent } from "react";
import { useInlineEdit, type InlineSaveResult } from "@/hooks/useInlineEdit";
import { resolveAmountCommit } from "@/lib/inline-edit";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { PRESSED_SLOT } from "./letterpress";

interface InlineEditableAmountProps {
  /** integer cents, net-worth-signed */
  valueCents: number;
  /** persist the new cents; optimistic UI reverts if this resolves !ok */
  onSave: (nextCents: number) => Promise<InlineSaveResult>;
  /** accessible name for the control (e.g. "Amount") */
  label: string;
  /** show an explicit +/− sign on display (flow style) */
  signed?: boolean;
  /** toast title on a committed save (the toast carries Undo) */
  describe?: (nextCents: number) => string;
  /** typography applied to trigger AND input — no size jump */
  className?: string;
}

/**
 * Click-to-edit money — the amount twin of <InlineEditableText>. Displays
 * formatted dollars, edits as free text through the ledger's string-math
 * parser (resolveAmountCommit → integer cents, never floats). Unchanged cents
 * are a silent no-op regardless of formatting; Enter/blur commits, Escape
 * cancels; optimistic with Toast+Undo. Only ever wired to MANUAL transaction
 * amounts — imported rows are the audit trail and stay immutable.
 */
export function InlineEditableAmount({
  valueCents,
  onSave,
  label,
  signed = false,
  describe,
  className,
}: InlineEditableAmountProps) {
  const edit = useInlineEdit<number>({
    value: valueCents,
    format: (cents) => (signed ? formatCentsSigned(cents) : formatCents(cents)),
    resolve: resolveAmountCommit,
    onSave,
    label,
    describe: describe ?? ((cents) => `Amount set to ${formatCentsSigned(cents)}`),
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
          inputMode="decimal"
          size={Math.max(edit.draft.length + 1, 8)}
          data-inline-edit="input"
          className={`figures -mx-1.5 max-w-full min-w-0 rounded-md border border-accent bg-surface-leaf ${PRESSED_SLOT} px-1.5 py-0.5 text-right outline-none ${shared}`}
        />
        {edit.error ? (
          <span role="alert" className="text-xs font-normal text-negative">
            {edit.error}
          </span>
        ) : null}
      </span>
    );
  }

  // edit.display is integer cents (T = number) — always render it formatted
  const displayText = signed ? formatCentsSigned(edit.display) : formatCents(edit.display);
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
      aria-label={`${label}: ${displayText}. Click to edit.`}
      aria-busy={edit.pending || undefined}
      className={`figures group/ie cursor-text rounded-[3px] underline-offset-[6px] outline-none transition-[text-decoration-color] duration-(--duration-fast) hover:underline hover:decoration-line-strong hover:decoration-dotted focus-visible:underline focus-visible:decoration-accent focus-visible:decoration-dotted ${shared}`}
    >
      {displayText}
    </span>
  );
}
