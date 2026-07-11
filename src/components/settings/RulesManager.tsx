"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { offerUndoToast } from "@/components/transactions/undo-toast";
import {
  deleteRuleAction,
  moveRuleAction,
  reapplyRuleAction,
  restoreRuleAction,
  setRuleEnabledAction,
} from "@/app/settings/rules-actions";
import type { RuleView } from "@/services/rules-manager";

/**
 * The rules manager (ux-overhaul-plan §3.4): each rule as a readable sentence
 * with its precedence (drag replaced by accessible up/down reordering), an
 * enable toggle, a live "would change N" preview (disabled rules advertise
 * none), times-applied, re-apply, and delete — every mutation value-returning
 * with a lossless Undo and an accessible confirmation, and keyboard focus is
 * restored after the list re-renders.
 */
export function RulesManager({ rules }: { rules: readonly RuleView[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // rule id to focus once the list re-renders (a move/delete blurs the clicked
  // control when it becomes disabled or unmounts — restore focus to the row)
  const focusAfterRef = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfterRef.current;
    if (id === null) return;
    focusAfterRef.current = null;
    document.querySelector<HTMLElement>(`[data-rule-id="${CSS.escape(id)}"]`)?.focus();
  }, [rules]);

  function refresh(): void {
    startTransition(() => router.refresh());
  }

  function toggle(rule: RuleView): void {
    const enabled = !rule.isEnabled;
    void setRuleEnabledAction({ ruleId: rule.id, enabled }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      focusAfterRef.current = rule.id;
      refresh();
      toast({ title: `${enabled ? "Enabled" : "Disabled"} "${rule.name}"`, durationMs: 2000 });
    });
  }

  function move(rule: RuleView, direction: "up" | "down"): void {
    void moveRuleAction({ ruleId: rule.id, direction }).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      focusAfterRef.current = rule.id;
      refresh();
      toast({ title: direction === "up" ? "Moved up" : "Moved down", durationMs: 1500 });
    });
  }

  function neighborId(rule: RuleView): string | null {
    const i = rules.findIndex((r) => r.id === rule.id);
    return rules[i + 1]?.id ?? rules[i - 1]?.id ?? null;
  }

  function remove(rule: RuleView): void {
    const focus = neighborId(rule);
    void deleteRuleAction(rule.id).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      if (focus) focusAfterRef.current = focus;
      refresh();
      const snapshot = r.data.snapshot;
      // delete gets the same Undo safety as every other mutation — the snapshot
      // re-creates the rule's conditions, actions, precedence, and history
      toast({
        title: `Deleted "${rule.name}"`,
        action: snapshot
          ? {
              label: "Undo",
              onAction: () =>
                void restoreRuleAction(snapshot).then((rr) => {
                  if (rr.ok) refresh();
                }),
            }
          : undefined,
      });
    });
  }

  function reapply(rule: RuleView): void {
    void reapplyRuleAction(rule.id).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      focusAfterRef.current = rule.id;
      refresh();
      if (r.data.affected === 0) {
        toast({ title: "No transactions to re-apply" });
        return;
      }
      offerUndoToast(`Re-applied to ${r.data.affected}`, r.data.undo, refresh);
    });
  }

  if (rules.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No rules yet. Correcting a category on a transaction offers to turn it into a rule — they
        appear here to reorder, disable, or remove.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {rules.map((rule) => (
        <li
          key={rule.id}
          data-rule-id={rule.id}
          tabIndex={-1}
          className="rounded-(--radius-card) border border-line p-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className={`text-sm ${rule.isEnabled ? "text-ink" : "text-ink-faint line-through"}`}>
                {rule.sentence}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                {rule.matchCount > 0 ? <Badge tone="info">would change {rule.matchCount}</Badge> : null}
                <span>applied {rule.timesApplied}×</span>
                {!rule.isEnabled ? <span className="text-warning">disabled</span> : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <div className="flex flex-col">
                <IconButton
                  icon="chevron-up"
                  size="sm"
                  aria-label={`Raise precedence of ${rule.name}`}
                  disabled={isPending || rule.isFirst}
                  onClick={() => move(rule, "up")}
                />
                <IconButton
                  icon="chevron-down"
                  size="sm"
                  aria-label={`Lower precedence of ${rule.name}`}
                  disabled={isPending || rule.isLast}
                  onClick={() => move(rule, "down")}
                />
              </div>
              {rule.matchCount > 0 ? (
                <Button variant="secondary" size="sm" disabled={isPending} onClick={() => reapply(rule)}>
                  Re-apply {rule.matchCount}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" disabled={isPending} onClick={() => toggle(rule)}>
                {rule.isEnabled ? "Disable" : "Enable"}
              </Button>
              <IconButton
                icon="delete"
                size="sm"
                aria-label={`Delete ${rule.name}`}
                disabled={isPending}
                onClick={() => remove(rule)}
              />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
