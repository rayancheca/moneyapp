"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { offerUndoToast } from "@/components/transactions/undo-toast";
import { settleAction, useAction } from "@/hooks/useAction";
import {
  deleteRuleAction,
  moveRuleAction,
  reapplyRuleAction,
  restoreRuleAction,
  setRuleEnabledAction,
} from "@/app/settings/rules-actions";
import type { RuleView } from "@/services/rules-manager";

/** The row itself is the focus target (tabIndex -1); it outlives its buttons. */
function focusRow(ruleId: string): void {
  document.querySelector<HTMLElement>(`[data-rule-id="${CSS.escape(ruleId)}"]`)?.focus();
}

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
  // every mutation below goes through one runner: pending cleared in a finally,
  // a failure always surfaced, and the newest run owning the shared state
  const { run, pending: acting } = useAction();
  const busy = isPending || acting;
  // rule id to focus once the list re-renders (a move/delete blurs the clicked
  // control when it becomes disabled or unmounts — restore focus to the row)
  const focusAfterRef = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfterRef.current;
    if (id === null) return;
    focusAfterRef.current = null;
    focusRow(id);
  }, [rules]);

  function refresh(): void {
    startTransition(() => router.refresh());
  }

  /**
   * Report a failure and hand focus back to the rule's row: `busy` disables
   * (and so blurs) the control that was just clicked, and a failure never
   * re-renders the list, so nothing else would return it.
   */
  function failed(ruleId: string): (message: string) => void {
    return (message) => {
      toast({ title: message, tone: "negative" });
      focusRow(ruleId);
    };
  }

  function toggle(rule: RuleView): void {
    const enabled = !rule.isEnabled;
    void run(() => setRuleEnabledAction({ ruleId: rule.id, enabled }), {
      onSuccess: () => {
        focusAfterRef.current = rule.id;
        refresh();
        toast({ title: `${enabled ? "Enabled" : "Disabled"} "${rule.name}"`, durationMs: 2000 });
      },
      onError: failed(rule.id),
    });
  }

  function move(rule: RuleView, direction: "up" | "down"): void {
    void run(() => moveRuleAction({ ruleId: rule.id, direction }), {
      onSuccess: () => {
        focusAfterRef.current = rule.id;
        refresh();
        toast({ title: direction === "up" ? "Moved up" : "Moved down", durationMs: 1500 });
      },
      onError: failed(rule.id),
    });
  }

  function neighborId(rule: RuleView): string | null {
    const i = rules.findIndex((r) => r.id === rule.id);
    return rules[i + 1]?.id ?? rules[i - 1]?.id ?? null;
  }

  function remove(rule: RuleView): void {
    const focus = neighborId(rule);
    void run(() => deleteRuleAction(rule.id), {
      onSuccess: ({ snapshot }) => {
        if (focus) focusAfterRef.current = focus;
        refresh();
        // delete gets the same Undo safety as every other mutation — the snapshot
        // re-creates the rule's conditions, actions, precedence, and history
        toast({
          title: `Deleted "${rule.name}"`,
          action: snapshot
            ? {
                // inside a toast action we settle and RETURN: the card reports the
                // failure and stays alive, so this snapshot is still restorable
                label: "Undo",
                onAction: async () => {
                  const result = await settleAction(
                    () => restoreRuleAction(snapshot),
                    `Couldn’t restore "${rule.name}" — try again`,
                  );
                  if (result.ok) refresh();
                  return result;
                },
              }
            : undefined,
        });
      },
      onError: failed(rule.id),
    });
  }

  function reapply(rule: RuleView): void {
    void run(() => reapplyRuleAction(rule.id), {
      onSuccess: ({ affected, undo }) => {
        focusAfterRef.current = rule.id;
        refresh();
        if (affected === 0) {
          toast({ title: "No transactions to re-apply" });
          return;
        }
        offerUndoToast(`Re-applied to ${affected}`, undo, refresh);
      },
      onError: failed(rule.id),
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
                  disabled={busy || rule.isFirst}
                  onClick={() => move(rule, "up")}
                />
                <IconButton
                  icon="chevron-down"
                  size="sm"
                  aria-label={`Lower precedence of ${rule.name}`}
                  disabled={busy || rule.isLast}
                  onClick={() => move(rule, "down")}
                />
              </div>
              {rule.matchCount > 0 ? (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => reapply(rule)}>
                  Re-apply {rule.matchCount}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle(rule)}>
                {rule.isEnabled ? "Disable" : "Enable"}
              </Button>
              <IconButton
                icon="delete"
                size="sm"
                aria-label={`Delete ${rule.name}`}
                disabled={busy}
                onClick={() => remove(rule)}
              />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
