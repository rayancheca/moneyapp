"use client";

import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { toast } from "@/components/ui/Toast";
import { Icon } from "@/components/shell/Icon";
import { formatCents, MoneyParseError, parseAmountToCents } from "@/lib/money";
import {
  MIN_SPLIT_LINES,
  remainingCents,
  validateSplitDraft,
  type SplitDraftLine,
} from "@/lib/transaction-splits";
import {
  clearSplitsAction,
  restoreSplitsAction,
  setSplitsAction,
} from "@/app/transactions/actions";
import { loadSplitPanel, type SplitPanelData } from "@/app/transactions/sheet-actions";
import { settleAction, useAction } from "@/hooks/useAction";
import type { SplitSnapshot } from "@/services/transaction-splits";
import { CategoryPicker, type CategoryPickerOption } from "./CategoryPicker";

/**
 * Split editor (RocketMoney-style) for the transaction sheet: re-attribute one
 * transaction's amount across categories. Amounts are entered as positive
 * magnitudes — the parent's sign is applied automatically, so the parts always
 * share its sign and the "same-sign" invariant can never be violated from here.
 * The live "remaining to allocate" readout and the save gate both reuse the pure
 * @/lib/transaction-splits math, and every save offers a lossless Undo.
 */

interface DraftLine {
  key: string;
  categoryId: string | null;
  /** raw magnitude text as typed (e.g. "15.00") */
  amountText: string;
}

interface SplitEditorProps {
  txnId: string;
  /** a counter the sheet bumps after ANY mutation (including an undo) — the panel
   *  reloads when it changes so the parts stay in sync even when the part-count is
   *  unchanged (e.g. undoing an edit back to a same-size split). */
  refreshKey: number;
  categories: readonly CategoryPickerOption[];
  onChanged: () => void;
}

/** Parse a magnitude string to positive cents, or null when blank/invalid. */
function parseMagnitude(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return Math.abs(parseAmountToCents(trimmed));
  } catch (error: unknown) {
    if (error instanceof MoneyParseError) return null;
    throw error;
  }
}

/**
 * The undo settles and RETURNS its result: the card reports the failure in
 * place and keeps itself alive, so `snapshot` — the only copy of the parts as
 * they were — is still there to try again with. The old shape dismissed the
 * card on click and dropped the snapshot with it.
 */
function offerSplitUndo(title: string, snapshot: SplitSnapshot, onChanged: () => void): void {
  toast({
    title,
    action: {
      label: "Undo",
      onAction: async () => {
        const result = await settleAction(
          () => restoreSplitsAction(snapshot),
          "Couldn’t restore the split — try again",
        );
        if (result.ok) onChanged();
        return result;
      },
    },
  });
}

export function SplitEditor({ txnId, refreshKey, categories, onChanged }: SplitEditorProps) {
  const [panel, setPanel] = useState<SplitPanelData | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  // one runner for both mutations: pending cleared in a finally (the old
  // hand-rolled flag stayed stuck on if the call rejected) and no silent failure
  const { run, pending } = useAction();
  const keySeq = useRef(0);
  const nextKey = () => `l${(keySeq.current += 1)}`;
  const editingRef = useRef(false);
  editingRef.current = editing;

  const reloadPanel = () => {
    void loadSplitPanel(txnId).then((r) => {
      if (r.ok) setPanel(r.data);
    });
  };

  // full reset when the transaction changes (a ledger flip)
  useEffect(() => {
    let live = true;
    setEditing(false);
    setPanel(null);
    void loadSplitPanel(txnId).then((r) => {
      if (live && r.ok) setPanel(r.data);
    });
    return () => {
      live = false;
    };
  }, [txnId]);

  // an external mutation (an undo elsewhere, a same-size re-split) bumped the
  // sheet's refresh counter — reload the parts, but never clobber a live draft
  // (a Cancel reloads on its own). txnId is intentionally omitted — the effect
  // above owns transaction changes.
  useEffect(() => {
    if (editingRef.current) return;
    let live = true;
    void loadSplitPanel(txnId).then((r) => {
      if (live && r.ok) setPanel(r.data);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const catName = (id: string | null): string =>
    (id && categories.find((c) => c.id === id)?.name) || "Uncategorized";

  function beginEdit(): void {
    if (!panel) return;
    const lines: DraftLine[] =
      panel.splits.length > 0
        ? panel.splits.map((s) => ({
            key: nextKey(),
            categoryId: s.categoryId,
            amountText: (Math.abs(s.amountCents) / 100).toFixed(2),
          }))
        : [
            // seed with the whole amount on line 1 so the user only carves off parts
            { key: nextKey(), categoryId: null, amountText: (Math.abs(panel.amountCents) / 100).toFixed(2) },
            { key: nextKey(), categoryId: null, amountText: "" },
          ];
    setDraft(lines);
    setEditing(true);
  }

  function updateLine(key: string, patch: Partial<DraftLine>): void {
    setDraft((d) => d.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: string): void {
    setDraft((d) => d.filter((l) => l.key !== key));
  }

  function addLine(): void {
    setDraft((d) => [
      ...d,
      { key: nextKey(), categoryId: null, amountText: remainingMagnitudeText(d) },
    ]);
  }

  // ── derived validation state (parent sign applied) ──────────────────
  const parentSign = panel ? Math.sign(panel.amountCents) : 0;
  const lineCents = draft.map((l) => {
    const mag = parseMagnitude(l.amountText);
    return mag === null ? null : parentSign * mag;
  });
  const allocatedCents = lineCents.reduce((sum: number, c) => sum + (c ?? 0), 0);
  const remaining = panel ? panel.amountCents - allocatedCents : 0;

  function remainingMagnitudeText(lines: DraftLine[]): string {
    if (!panel) return "";
    const allocated = lines.reduce((sum, l) => {
      const mag = parseMagnitude(l.amountText);
      return sum + (mag === null ? 0 : parentSign * mag);
    }, 0);
    const rem = panel.amountCents - allocated;
    return Math.sign(rem) === parentSign && rem !== 0 ? (Math.abs(rem) / 100).toFixed(2) : "";
  }

  const signedLines: SplitDraftLine[] | null = lineCents.every((c) => c !== null)
    ? draft.map((l, i) => ({ categoryId: l.categoryId, amountCents: lineCents[i]! }))
    : null;
  const validation = signedLines && panel
    ? validateSplitDraft(panel.amountCents, signedLines)
    : ({ ok: false, error: "sum-mismatch", message: "Enter an amount for every part." } as const);

  function save(): void {
    if (!panel || !signedLines || !validation.ok) return;
    const lines = signedLines;
    void run(
      () =>
        setSplitsAction({
          transactionId: txnId,
          lines: lines.map((l) => ({ categoryId: l.categoryId!, amountCents: l.amountCents })),
        }),
      {
        onSuccess: ({ snapshot }) => {
          offerSplitUndo(`Split into ${lines.length} parts`, snapshot, onChanged);
          setEditing(false);
          onChanged();
          reloadPanel();
        },
      },
    );
  }

  function unsplit(): void {
    void run(() => clearSplitsAction({ transactionId: txnId }), {
      onSuccess: ({ snapshot }) => {
        offerSplitUndo("Split removed", snapshot, onChanged);
        onChanged();
        reloadPanel();
      },
    });
  }

  if (!panel) return null;

  const heading = (
    <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">Split</span>
  );

  if (!panel.canSplit) {
    return (
      <div className="space-y-1.5">
        {heading}
        <p className="text-xs text-ink-faint">{panel.blockedReason}</p>
      </div>
    );
  }

  // ── view mode ───────────────────────────────────────────────────────
  if (!editing) {
    return (
      <div className="space-y-1.5">
        {heading}
        {panel.splits.length > 0 ? (
          <div className="rounded-(--radius-card) border border-line p-3">
            <ul className="space-y-1.5">
              {panel.splits.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{catName(s.categoryId)}</span>
                  <Money cents={s.amountCents} flow className="figures shrink-0 text-sm" />
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" size="sm" onClick={beginEdit}>
                Edit split
              </Button>
              <Button variant="ghost" size="sm" onClick={unsplit} pending={pending}>
                Remove split
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={beginEdit}>
            <Icon name="tag" className="size-3.5" /> Split transaction
          </Button>
        )}
      </div>
    );
  }

  // ── edit mode ───────────────────────────────────────────────────────
  const remainingTone =
    remaining === 0 ? "text-positive" : Math.sign(remaining) === parentSign ? "text-ink-muted" : "text-negative";
  const remainingLabel =
    remaining === 0
      ? "Fully allocated"
      : Math.sign(remaining) === parentSign
        ? `${formatCents(Math.abs(remaining))} left`
        : `${formatCents(Math.abs(remaining))} over`;

  return (
    <div className="space-y-1.5">
      {heading}
      <div className="rounded-(--radius-card) border border-line p-3">
        <ul className="space-y-2">
          {draft.map((l) => (
            <li key={l.key} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <CategoryPicker
                  options={categories}
                  currentId={l.categoryId}
                  onPick={(cid) => updateLine(l.key, { categoryId: cid })}
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-ink-faint">$</span>
                <Input
                  value={l.amountText}
                  inputMode="decimal"
                  aria-label="Split amount"
                  className="figures w-20 text-right"
                  onChange={(e) => updateLine(l.key, { amountText: e.target.value })}
                  placeholder="0.00"
                />
              </div>
              {draft.length > MIN_SPLIT_LINES ? (
                <IconButton
                  icon="close"
                  aria-label="Remove part"
                  size="sm"
                  variant="ghost"
                  onClick={() => removeLine(l.key)}
                />
              ) : (
                <span className="w-7 shrink-0" aria-hidden />
              )}
            </li>
          ))}
        </ul>

        <div className="mt-2 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={addLine}>
            <Icon name="plus" className="size-3.5" /> Add part
          </Button>
          <span className={`figures text-xs font-medium ${remainingTone}`}>{remainingLabel}</span>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={!validation.ok} pending={pending}>
            Save split
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(false);
              reloadPanel(); // pick up any external change that landed during the edit
            }}
          >
            Cancel
          </Button>
          {!validation.ok ? (
            <span className="text-xs text-ink-faint">{validation.message}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
