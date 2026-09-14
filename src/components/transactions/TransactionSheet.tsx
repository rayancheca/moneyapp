"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, LetterBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, Input } from "@/components/ui/Field";
import { InlineEditableText } from "@/components/ui/InlineEditableText";
import { SeriesLinkPanel, TransferLinkPanel } from "./LinkPanels";
import { Money } from "@/components/ui/Money";
import { ProvenancePopover } from "@/components/ui/ProvenancePopover";
import { Sheet } from "@/components/ui/Sheet";
import { Sparkline } from "@/components/ui/Sparkline";
import { toast } from "@/components/ui/Toast";
import { Icon } from "@/components/shell/Icon";
import { formatCents } from "@/lib/money";
import {
  recategorizeGroupAction,
  renameMerchantAction,
  setFlagsAction,
} from "@/app/transactions/actions";
import { loadSheetPanel, type SheetPanel } from "@/app/transactions/sheet-actions";
import type { CategorySuggestion } from "@/services/txn-detail";
import type { UndoPatch } from "@/app/transactions/action-types";
import { CategoryPicker, type CategoryPickerOption } from "./CategoryPicker";
import { runCategoryCorrection } from "./correct-category";
import { SplitEditor } from "./SplitEditor";
import type { LedgerRow } from "./TransactionsLedger";
import { offerUndoToast } from "./undo-toast";

/** How the suggestion was reached — the "why you can trust this" half-sentence. */
function suggestionReason(s: CategorySuggestion): string {
  if (s.reason === "rule") return "matches a rule";
  if (s.reason === "merchant") return "usual for this merchant";
  return `${s.support ?? 0} like it before`;
}

interface TransactionSheetProps {
  txn: LedgerRow;
  categories: readonly CategoryPickerOption[];
  onClose: () => void;
  /** ↑/↓ flip through the ledger with the sheet open (§3.2) */
  onFlip?: (delta: -1 | 1) => void;
  /** notifies the ledger to patch a row after a mutation (optimistic) */
  onRowChanged: () => void;
  /** position in a guided walk ("3 of 40") — the Categorize mode header */
  progress?: { index: number; total: number };
  /** fired after a category is set (accept / pick / recategorize-all) — the
   * Categorize mode uses it to auto-advance, so flag/notes edits don't move on */
  onCategorized?: () => void;
}

/**
 * Transaction detail drawer (ux-overhaul-plan §3.2): the displayed value IS the
 * control for classification; imported facts (amount, date, raw description)
 * stay read-only. Every mutation is a value-returning action → a Toast with a
 * lossless Undo, and a category correction offers "Create rule → applies to N".
 */
/**
 * The History card's one line: how many rows, how many of them spent, and the
 * mean and total of THOSE.
 *
 * A group with no outflow has nothing to average — "avg $0.00 · $0.00 total"
 * is two measured zeroes over money that really moved, which is the one shape
 * this app refuses.
 */
/**
 * One account's line in the History card: its rows, and the population the
 * figure beside it is a sum over.
 *
 * 🔴 THE SAME DEFECT AS `historyLine`, IN THE LIST DIRECTLY UNDER IT. That fix
 * named the denominator for the group and stopped at the per-account rows,
 * which went on printing a GROSS count beside a debits-only sum:
 * `/transactions?q=CAPITAL+ONE+MOBILE` read **"Venture X · 36" next to
 * "$395.00"**, where 35 of those 36 rows are $26,921.32 of CREDITS. An account
 * with no outflow at all read "SoFi Savings · 31" beside "$0.00" — a count of
 * rows that exist over a total of rows that do not.
 */
export function accountHistoryLine(a: { accountName: string; count: number; outCount: number }): string {
  const rows = `${a.count} ${a.count === 1 ? "transaction" : "transactions"}`;
  if (a.outCount === 0) return `${a.accountName} · ${rows}, none of them spending`;
  if (a.outCount === a.count) return `${a.accountName} · ${rows}`;
  return `${a.accountName} · ${rows}, ${a.outCount} of them spending`;
}

export function historyLine(h: { count: number; outCount: number; avgCents: number; totalCents: number }): string {
  const rows = `${h.count} ${h.count === 1 ? "transaction" : "transactions"}`;
  if (h.outCount === 0) return `${rows}, none of them spending`;
  const scope = h.outCount === h.count ? rows : `${rows}, ${h.outCount} of them spending`;
  return `${scope} · avg ${formatCents(h.avgCents)} · ${formatCents(h.totalCents)} spent`;
}

export function TransactionSheet({
  txn,
  categories,
  onClose,
  onFlip,
  onRowChanged,
  progress,
  onCategorized,
}: TransactionSheetProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [panel, setPanel] = useState<SheetPanel | null>(null);
  const [notes, setNotes] = useState(txn.notes ?? "");
  // bumped on every mutation so the split editor reloads even when the part-count
  // is unchanged (e.g. undoing a same-size re-split)
  const [splitRefresh, setSplitRefresh] = useState(0);

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
    setSplitRefresh((n) => n + 1);
    startTransition(() => router.refresh());
  }

  function offerUndo(title: string, undo: UndoPatch, extra?: { deleteRuleId?: string }): void {
    offerUndoToast(title, undo, afterMutation, extra);
  }

  function pickCategory(categoryId: string): void {
    const option = categories.find((c) => c.id === categoryId);
    runCategoryCorrection({
      transactionId: txn.id,
      categoryId,
      categoryName: option?.name ?? "category",
      onChanged: () => {
        afterMutation();
        onCategorized?.();
      },
    });
  }

  /** "Recategorize all N" — the whole same-name group, past & future (§3.2.5). */
  function recategorizeAll(categoryId: string): void {
    const option = categories.find((c) => c.id === categoryId);
    void recategorizeGroupAction({ transactionId: txn.id, categoryId }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      afterMutation();
      onCategorized?.();
      const { affected, ruleId } = r.data;
      const name = option?.name ?? "category";
      offerUndo(
        ruleId ? `${affected} set to ${name} · rule created` : `${affected} set to ${name}`,
        r.data.undo,
        ruleId ? { deleteRuleId: ruleId } : undefined,
      );
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

  return (
    <Sheet open onClose={onClose} title={panel?.merchant?.name ?? txn.normalizedDescription}>
      <div className="space-y-5">
        <header>
          {progress ? (
            <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-accent">
              {progress.index + 1} of {progress.total}
            </p>
          ) : null}
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
          {/*
            * ⛔ A <div>, NOT a <p>. `Popover` renders its panel as a SIBLING of
            * the trigger — `ProvenancePopover` says so itself — and that panel
            * is a <div popover="auto">. A <div> inside a <p> is invalid HTML:
            * the parser CLOSES the <p> before it, so the tree the browser
            * builds is not the tree React rendered, and React logs "In HTML,
            * <div> cannot be a descendant of <p>. This will cause a hydration
            * error." Found 2026-09-11 in the dev server's own log, not by any
            * gate — the popover arrives with the lazily loaded panel, so it is
            * in no server-rendered HTML and no screenshot has ever contained
            * it. This row is a line of metadata spans, never a paragraph of
            * prose; the classes are unchanged and not a pixel moves.
            */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
            <span className="figures">{txn.postedOn}</span>
            <span aria-hidden>·</span>
            <span>{txn.accountName}</span>
            {txn.status !== "active" ? <Badge tone="warning">{txn.status}</Badge> : null}
            {/* "prove it" for this row — beside the date and account it is a
                claim about, never wrapping the amount. Arrives with the lazily
                loaded panel, so the ledger pays nothing for it. */}
            {panel?.provenance ? (
              <ProvenancePopover label="this transaction" provenance={panel.provenance} />
            ) : null}
          </div>
        </header>

        {/* one-tap suggestion — the learning loop's fast path (§3.2) */}
        {panel?.suggestion ? (
          <div className="flex items-center justify-between gap-3 rounded-(--radius-card) border border-accent/40 bg-accent-soft/50 px-3 py-2">
            <div className="min-w-0 text-sm">
              <span className="text-ink-muted">Suggested </span>
              <span className="font-medium">{panel.suggestion.categoryLabel}</span>
              <span className="block text-[11px] text-ink-faint">{suggestionReason(panel.suggestion)}</span>
            </div>
            <Button size="sm" onClick={() => pickCategory(panel!.suggestion!.categoryId)}>
              Accept
            </Button>
          </div>
        ) : null}

        {/* merchant rename (§3.2) — inline where the name shows, S3 primitive */}
        {txn.merchantId && panel?.merchant ? (
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">Merchant</span>
            <p className="text-sm">
              <InlineEditableText
                value={panel.merchant.name}
                label="Merchant name"
                maxLength={80}
                className="text-sm font-medium"
                onSave={async (next) => {
                  const result = await renameMerchantAction({ merchantId: txn.merchantId!, newName: next });
                  if (result.ok) {
                    // the panel loads once per txn — patch it with the
                    // server-canonical name so the title + "At …" header track truth
                    setPanel((p) =>
                      p && p.merchant ? { ...p, merchant: { ...p.merchant, name: result.data.name } } : p,
                    );
                    afterMutation();
                  }
                  return { ok: result.ok, error: result.ok ? undefined : result.error };
                }}
              />
            </p>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">Category</span>
          {(txn.splitCount ?? 0) > 0 ? (
            // a split row is categorized by its parts below — a single-category
            // picker here would silently disagree with the split analytics
            <p className="text-xs text-ink-faint">Categorized across {txn.splitCount} parts — edit the split below.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <CategoryPicker options={categories} currentId={txn.categoryId} suggestedIds={txn.suggestedCategoryIds} onPick={pickCategory} />
              {txn.lowConfidence ? <Badge tone="warning">low confidence</Badge> : null}
            </div>
          )}
        </div>

        {/* split one transaction's amount across categories (RocketMoney-style) */}
        <SplitEditor txnId={txn.id} refreshKey={splitRefresh} categories={categories} onChanged={afterMutation} />

        <div className="grid gap-2">
          <Checkbox
            label="Transfer"
            checked={txn.isTransfer}
            disabled={(txn.splitCount ?? 0) > 0}
            title={(txn.splitCount ?? 0) > 0 ? "Remove the split to mark this a transfer" : undefined}
            onChange={(e) => toggleFlag("transfer", e.target.checked)}
          />
          <Checkbox label="Exclude from analytics" checked={txn.status === "excluded"} onChange={(e) => toggleFlag("exclude", e.target.checked)} />
          <Checkbox label="Reviewed" checked={!txn.needsReview} onChange={(e) => toggleFlag("reviewed", e.target.checked)} />
        </div>

        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} placeholder="Add a note…" />
        </Field>

        {/* S5 linkable: pair with the transfer counterpart / attach to a series
            — right where the transaction is shown, candidates load on demand. A
            split row can't be a transfer leg, so its transfer-link panel is hidden. */}
        {(txn.splitCount ?? 0) === 0 ? (
          <TransferLinkPanel txnId={txn.id} isTransfer={txn.isTransfer} onChanged={afterMutation} />
        ) : null}
        {/* the LINK, not the badge: a row in a dismissed series has no R but is
            still taken — offering "Make recurring" there throws "This
            transaction already belongs to a recurring series" */}
        <SeriesLinkPanel
          txnId={txn.id}
          hasSeriesLink={txn.hasSeriesLink}
          isRecurring={txn.isRecurring}
          onChanged={afterMutation}
        />

        {/* same-name panel — the headline ask (§3.2.5): the merchant (or the
            merchantless stripped-key group) and the one-gesture "Recategorize
            all N" that fixes the whole group's past AND future. */}
        {panel && (panel.merchant || panel.siblings.length > 0) ? (
          <section className="rounded-(--radius-card) border border-line bg-surface-sunken/50 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium">
                {panel.merchant
                  ? `At ${panel.merchant.name} · ${panel.merchant.txnCount} txns`
                  : `Similar transactions · ${panel.similarCount}`}
              </h3>
              {/* 🔴 An unlabelled figure beside a count of a DIFFERENT window.
                  The heading counts every row at the merchant, all time; this
                  is the calendar year alone, so `Netflix` read "At Netflix · 18
                  txns" over a bare "$0.00" against an all-time -$319.57.
                  Measured 2026-09-10: 512 of 851 merchants differ and 389 print
                  exactly $0.00 beside a real history. */}
              {panel.merchant ? (
                <span className="shrink-0 text-xs text-ink-muted">
                  <Money cents={panel.merchant.totalCentsThisYear} className="figures" /> in{" "}
                  {panel.merchant.totalYear}
                </span>
              ) : null}
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
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {panel.similarCount > 1 ? (
                <CategoryPicker options={categories} currentId={txn.categoryId} onPick={recategorizeAll}>
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium transition-colors duration-(--duration-fast) hover:border-line-strong">
                    <Icon name="tag" className="size-3.5" /> Recategorize all {panel.similarCount} →
                  </span>
                </CategoryPicker>
              ) : null}
              {panel.merchant ? (
                <Button variant="ghost" onClick={() => router.push(`/merchants/${panel!.merchant!.id}`)}>
                  View merchant →
                </Button>
              ) : null}
            </div>
          </section>
        ) : panel ? null : (
          <p className="text-xs text-ink-faint">Loading similar transactions…</p>
        )}

        {/* spend history for the merchant / same-name group — context to decide */}
        {panel?.history && panel.history.count > 1 ? (
          <section className="rounded-(--radius-card) border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium">History</h3>
              <Sparkline values={panel.history.monthly.map((m) => m.cents)} tone="neutral" width={72} height={22} />
            </div>
            {/* 🔴 A COUNT, A MEAN AND A TOTAL IN ONE BREATH, and the mean was
                not total ÷ count. `Zelle` read "140 transactions · avg $76.48 ·
                $4,053.69 total" — $4,053.69 ÷ 140 is $28.95; ÷ 53, its
                outflows, is $76.48. And a group with no outflow at all read
                "83 transactions · avg $0.00 · $0.00 total" over +$16,386.82.
                The denominator is named now, and where there is nothing to
                average the sentence says so instead of asserting two zeroes. */}
            <p className="mt-1 text-xs text-ink-muted">{historyLine(panel.history)}</p>
            {panel.history.byAccount.length > 1 ? (
              <ul className="mt-2 space-y-1">
                {panel.history.byAccount.map((a) => (
                  <li key={a.accountName} className="flex items-center justify-between gap-2 text-xs text-ink-muted">
                    <span className="min-w-0 truncate">{accountHistoryLine(a)}</span>
                    {/* the figure is money OUT, which is why the line beside it
                        has to name how many of the rows that is */}
                    <span className="shrink-0">{a.outCount === 0 ? "—" : formatCents(a.cents)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {/* rules whose conditions match this row (§3.4). Framed as "matching",
            not "auto-categorized": the engine is first-match-wins and only runs
            on uncategorized non-user rows, so a match here is what WOULD fire if
            this row were re-run, not necessarily what set its current category.
            The first (highest-precedence) rule is the one that would win. */}
        {panel && panel.matchingRules.length > 0 ? (
          <section className="rounded-(--radius-card) border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium">
                {panel.matchingRules.length === 1 ? "Matching rule" : "Matching rules"}
              </h3>
              <Link href="/settings" className="text-xs text-accent hover:underline">
                Manage →
              </Link>
            </div>
            <ul className="mt-2 space-y-1">
              {panel.matchingRules.map((r, i) => (
                <li key={r.id} className="text-xs text-ink-muted">
                  {r.sentence}
                  {i === 0 && panel.matchingRules.length > 1 ? (
                    <span className="text-ink-faint"> · applies first</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

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
