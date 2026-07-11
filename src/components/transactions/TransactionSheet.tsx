"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, LetterBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { Checkbox, Field, Input } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { Sheet } from "@/components/ui/Sheet";
import { toast, dismissToast, focusNewestToastAction } from "@/components/ui/Toast";
import { Icon } from "@/components/shell/Icon";
import {
  correctCategory,
  createRuleAction,
  renameMerchantAction,
  retroApplyRuleAction,
  setFlagsAction,
} from "@/app/transactions/actions";
import { loadSheetPanel, type SheetPanel } from "@/app/transactions/sheet-actions";
import type { UndoPatch } from "@/app/transactions/action-types";
import { CategoryPicker, type CategoryPickerOption } from "./CategoryPicker";
import type { LedgerRow } from "./TransactionsLedger";
import { offerUndoToast } from "./undo-toast";

interface TransactionSheetProps {
  txn: LedgerRow;
  categories: readonly CategoryPickerOption[];
  onClose: () => void;
  /** ↑/↓ flip through the ledger with the sheet open (§3.2) */
  onFlip?: (delta: -1 | 1) => void;
  /** notifies the ledger to patch a row after a mutation (optimistic) */
  onRowChanged: () => void;
}

/**
 * Transaction detail drawer (ux-overhaul-plan §3.2): the displayed value IS the
 * control for classification; imported facts (amount, date, raw description)
 * stay read-only. Every mutation is a value-returning action → a Toast with a
 * lossless Undo, and a category correction offers "Create rule → applies to N".
 */
export function TransactionSheet({ txn, categories, onClose, onFlip, onRowChanged }: TransactionSheetProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [panel, setPanel] = useState<SheetPanel | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [notes, setNotes] = useState(txn.notes ?? "");

  // one debounced round-trip per settle for the same-merchant panel
  useEffect(() => {
    let live = true;
    setPanel(null);
    void loadSheetPanel(txn.id).then((r) => {
      if (live && r.ok) setPanel(r.data);
    });
    setNotes(txn.notes ?? "");
    return () => {
      live = false;
    };
  }, [txn.id, txn.notes]);

  function afterMutation(): void {
    onRowChanged();
    startTransition(() => router.refresh());
  }

  function offerUndo(title: string, undo: UndoPatch, extra?: { deleteRuleId?: string }): void {
    offerUndoToast(title, undo, afterMutation, extra);
  }

  function pickCategory(categoryId: string): void {
    const option = categories.find((c) => c.id === categoryId);
    void correctCategory({ transactionId: txn.id, categoryId }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      afterMutation();
      const { rulePrompt, undo } = r.data;
      // the correction toast doubles as the rule prompt (§3.4) — Undo reverts
      // the categorize AND, if the rule was created, the rule itself
      if (rulePrompt && rulePrompt.matchCount > 0) {
        const id = toast({
          title: `Categorized as ${option?.name ?? "category"}`,
          description: `Always ${rulePrompt.merchantName} → ${rulePrompt.categoryLabel}? Applies to ${rulePrompt.matchCount} existing.`,
          action: {
            label: `Create rule (${rulePrompt.matchCount})`,
            onAction: () =>
              void createRuleAction({ merchantId: rulePrompt.merchantId, categoryId }).then((rr) => {
                if (!rr.ok) {
                  toast({ title: rr.error, tone: "negative" });
                  return;
                }
                void retroApplyRuleAction(rr.data.ruleId).then((applied) => {
                  if (applied.ok) {
                    afterMutation();
                    offerUndo(`Rule created · ${applied.data.affected} recategorized`, applied.data.undo, { deleteRuleId: rr.data.ruleId });
                  }
                });
              }),
          },
        });
        // let Stage-0's A mnemonic path reach it; also expose Undo separately
        void id;
      } else {
        offerUndo(`Categorized as ${option?.name ?? "category"}`, undo);
      }
    });
  }

  function toggleFlag(flag: "transfer" | "exclude" | "reviewed", value: boolean): void {
    void setFlagsAction({ transactionId: txn.id, flags: { [flag]: value } }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      afterMutation();
      offerUndo(`${flag[0]!.toUpperCase()}${flag.slice(1)} ${value ? "on" : "off"}`, r.data.undo);
    });
  }

  function saveNotes(): void {
    if ((txn.notes ?? "") === notes) return;
    void setFlagsAction({ transactionId: txn.id, flags: { notes: notes === "" ? null : notes } }).then((r) => {
      if (r.ok) afterMutation();
    });
  }

  function submitRename(newName: string): void {
    if (!txn.merchantId || newName.trim() === "" || newName === panel?.merchant?.name) {
      setRenaming(false);
      return;
    }
    void renameMerchantAction({ merchantId: txn.merchantId, newName: newName.trim() }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      setRenaming(false);
      afterMutation();
      toast({ title: `Renamed to ${r.data.name}` });
    });
  }

  return (
    <Sheet open onClose={onClose} title={panel?.merchant?.name ?? txn.normalizedDescription}>
      <div className="space-y-5">
        <header>
          <div className="flex items-start justify-between gap-3">
            <Money cents={txn.amountCents} flow className="figures text-3xl font-semibold" />
            {onFlip ? (
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="sm" aria-label="Previous transaction" onClick={() => onFlip(-1)}>
                  <Icon name="chevron-left" className="size-4" />
                </Button>
                <Button variant="ghost" size="sm" aria-label="Next transaction" onClick={() => onFlip(1)}>
                  <Icon name="chevron-right" className="size-4" />
                </Button>
              </div>
            ) : null}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
            <span className="figures">{txn.postedOn}</span>
            <span aria-hidden>·</span>
            <span>{txn.accountName}</span>
            {txn.status !== "active" ? <Badge tone="warning">{txn.status}</Badge> : null}
          </p>
        </header>

        {/* merchant rename (§3.2) */}
        {txn.merchantId ? (
          renaming ? (
            <Field label="Merchant name">
              <Input
                autoFocus
                defaultValue={panel?.merchant?.name ?? ""}
                onBlur={(e) => submitRename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRename((e.target as HTMLInputElement).value);
                  if (e.key === "Escape") setRenaming(false);
                }}
              />
            </Field>
          ) : (
            <button
              type="button"
              onClick={() => setRenaming(true)}
              className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
            >
              <Icon name="edit" className="size-3" /> Rename merchant
            </button>
          )
        ) : null}

        <div className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">Category</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <CategoryPicker options={categories} currentId={txn.categoryId} suggestedIds={txn.suggestedCategoryIds} onPick={pickCategory} />
            {txn.lowConfidence ? <Badge tone="warning">low confidence</Badge> : null}
          </div>
        </div>

        <div className="grid gap-2">
          <Checkbox label="Transfer" checked={txn.isTransfer} onChange={(e) => toggleFlag("transfer", e.target.checked)} />
          <Checkbox label="Exclude from analytics" checked={txn.status === "excluded"} onChange={(e) => toggleFlag("exclude", e.target.checked)} />
          <Checkbox label="Reviewed" checked={!txn.needsReview} onChange={(e) => toggleFlag("reviewed", e.target.checked)} />
        </div>

        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} placeholder="Add a note…" />
        </Field>

        {/* same-merchant panel — the headline ask (§3.2) */}
        {panel?.merchant ? (
          <section className="rounded-(--radius-card) border border-line bg-surface-sunken/50 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium">
                At {panel.merchant.name} · {panel.merchant.txnCount} txns
              </h3>
              <Money cents={panel.merchant.totalCentsThisYear} className="figures text-xs text-ink-muted" />
            </div>
            {panel.siblings.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {panel.siblings.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-ink-muted">{s.postedOn}</span>
                    <span className="min-w-0 flex-1 truncate">{s.description}</span>
                    <Money cents={s.amountCents} flow />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-3">
              <Button variant="ghost" onClick={() => router.push(`/merchants/${panel!.merchant!.id}`)}>
                View merchant →
              </Button>
            </div>
          </section>
        ) : panel ? null : (
          <p className="text-xs text-ink-faint">Loading merchant history…</p>
        )}

        {/* raw audit detail — present, not shouting (§3.2.6) */}
        <details className="text-xs text-ink-faint">
          <summary className="cursor-pointer select-none">Raw detail</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-ink-faint">Raw</dt>
            <dd className="break-words text-ink-muted">{txn.rawDescription}</dd>
            <dt className="text-ink-faint">Badges</dt>
            <dd className="flex gap-1">
              {txn.isTransfer ? <LetterBadge letter="T" /> : null}
              {txn.isRecurring ? <LetterBadge letter="R" /> : null}
              {!txn.isTransfer && !txn.isRecurring ? <span>—</span> : null}
            </dd>
          </dl>
        </details>
      </div>
    </Sheet>
  );
}

// re-export so the ledger and sheet share the toast focus helper wiring
export { dismissToast, focusNewestToastAction };
