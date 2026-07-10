"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { Checkbox, Field, Input } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { Sheet } from "@/components/ui/Sheet";
import { toast } from "@/components/ui/Toast";

export interface SiblingTxn {
  id: string;
  postedOn: string;
  description: string;
  amountCents: number;
  categoryLabel: string;
  hue: string | null;
  icon: string | null;
}

export interface SheetTxn extends SiblingTxn {
  accountName: string;
  merchantName: string;
  siblingCount: number;
  siblingTotalCents: number;
}

interface StageZeroAOverlaysProps {
  subject: SheetTxn | null;
  siblings: SiblingTxn[];
}

/**
 * Client half of the Stage-0a checkpoint: the transaction Sheet (open on
 * load) and the correction-becomes-rule toast — the two overlay states the
 * design sign-off must show. Interactions are real; mutations are not.
 */
export function StageZeroAOverlays({ subject, siblings }: StageZeroAOverlaysProps) {
  const [open, setOpen] = useState(false);

  // Click-driven on purpose: opening a modal during hydration composites a
  // stale pre-theme frame (Chromium), and the rule toast must enter the top
  // layer AFTER the dialog to paint above its backdrop. Real flows have this
  // ordering naturally — sheet on row click, toast on edit.
  const openPreview = () => {
    if (subject === null) return;
    setOpen(true);
    window.setTimeout(() => {
      toast({
        title: `Always categorize ${subject.merchantName} as ${subject.categoryLabel}?`,
        description: `Create rule — applies to ${subject.siblingCount} existing transactions`,
        action: { label: "Create rule", onAction: () => undefined },
      });
    }, 400);
  };

  if (subject === null) return null;

  return (
    <>
      {!open ? (
        <div className="mt-6">
          <Button variant="primary" onClick={openPreview}>
            Open preview sheet
          </Button>
        </div>
      ) : null}
      <Sheet open={open} onClose={() => setOpen(false)} title={subject.merchantName}>
        <div className="space-y-5">
          <header>
            <Money cents={subject.amountCents} flow className="figures text-3xl font-semibold" />
            <p className="mt-1 text-xs text-ink-muted">
              {subject.postedOn} · {subject.accountName}
            </p>
          </header>

          <div className="space-y-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
              Category
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <CategoryChip label={subject.categoryLabel} hue={subject.hue} icon={subject.icon} />
              <Badge tone="accent">Claude · 0.94</Badge>
            </div>
          </div>

          <div className="grid gap-2">
            <Checkbox label="Transfer" />
            <Checkbox label="Exclude from analytics" />
            <Checkbox label="Recurring" />
          </div>

          <Field label="Notes">
            <Input placeholder="Add a note…" />
          </Field>

          <section className="rounded-(--radius-card) border border-line bg-surface-sunken/50 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium">
                At {subject.merchantName} · {subject.siblingCount} transactions
              </h3>
              <Money
                cents={subject.siblingTotalCents}
                className="figures text-xs text-ink-muted"
              />
            </div>
            <ul className="mt-2 space-y-1.5">
              {siblings.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-ink-muted">{s.postedOn}</span>
                  <span className="min-w-0 flex-1 truncate">{s.description}</span>
                  <Money cents={s.amountCents} flow />
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-2">
              <Button variant="secondary">Recategorize all {subject.siblingCount} →</Button>
              <Button variant="ghost">View all</Button>
            </div>
          </section>

          <details className="text-xs text-ink-muted">
            <summary className="cursor-pointer text-ink-faint">Raw detail</summary>
            <p className="mt-2 leading-relaxed">
              {subject.description} · imported from statement · categorization source: claude
            </p>
          </details>
        </div>
      </Sheet>
    </>
  );
}
