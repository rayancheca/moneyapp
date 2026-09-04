"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { reorderAccountsAction } from "@/app/accounts/actions";
import type { AccountCard, InstitutionGroup } from "@/services/institution-groups";
import { Icon } from "@/components/shell/Icon";
import { IconButton } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { Sparkline, type SparklineTone } from "@/components/ui/Sparkline";
import { toast } from "@/components/ui/Toast";
import { formatCentsSigned } from "@/lib/money";
import { EditAccountSheet, type EditableAccount } from "./EditAccountSheet";

const TYPE_LABEL: Record<AccountCard["type"], string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  investment: "Investment",
};

function toneOf(cents: number | null): SparklineTone {
  if (cents === null || cents === 0) return "neutral";
  return cents > 0 ? "positive" : "negative";
}

/**
 * The accounts management surface (ux-overhaul-plan §7.2): institution cards
 * stay, now editable. Each account row carries an unreviewed dot, reorders with
 * accessible Move up/down buttons (drag from the grip is a pointer bonus — both
 * write `displayOrder`), and opens the edit sheet. Reorder is scoped within an
 * institution; re-homing to another institution is the edit sheet's job.
 */
export function ManagedAccounts({
  groups,
  institutions,
}: {
  groups: readonly InstitutionGroup[];
  institutions: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<EditableAccount | null>(null);
  const dragRef = useRef<{ institution: string; index: number } | null>(null);

  function commitOrder(orderedIds: string[]): void {
    void reorderAccountsAction(orderedIds).then((r) => {
      if (!r.ok) {
        toast({ title: r.error, tone: "negative" });
        return;
      }
      startTransition(() => router.refresh());
    });
  }

  function move(accounts: readonly AccountCard[], from: number, to: number): void {
    if (to < 0 || to >= accounts.length || from === to) return;
    const ids = accounts.map((a) => a.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    commitOrder(ids);
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section
          key={group.institutionName}
          aria-label={group.institutionName}
          className="overflow-hidden rounded-(--radius-card) border border-line bg-surface-raised shadow-[0_1px_2px_oklch(0%_0_0/0.04)]"
        >
          {/* 🔴 The heading is a NET across the group's sides while every row
              under it prints a card as what you owe, so on the owner's ledger
              2026-09-04 "Capital One -$367.99" sat directly above "Venture X
              $367.99" — one debt, two signs, nothing saying why. Same clause and
              same reason as `InstitutionCard`; printed only where the flip can
              actually happen. */}
          <header className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-3">
            <div className="text-sm font-semibold">
              {group.institutionName}
              {group.accounts.some((a) => a.isLiability) && (
                <span className="ml-2 text-[11px] font-normal text-ink-faint">
                  net of what you owe
                </span>
              )}
            </div>
            <Money cents={group.totalCents} className="text-sm font-semibold" />
          </header>

          <ul>
            {group.accounts.map((a, i) => {
              const meta = [TYPE_LABEL[a.type], a.last4 ? `····${a.last4}` : null, a.holdingsSummary]
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  key={a.id}
                  onDragOver={(e) => {
                    if (dragRef.current?.institution === group.institutionName) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    const d = dragRef.current;
                    if (d && d.institution === group.institutionName) {
                      e.preventDefault();
                      move(group.accounts, d.index, i);
                    }
                    dragRef.current = null;
                  }}
                  className="flex items-center gap-2 border-b border-line px-3 py-2.5 last:border-b-0"
                >
                  <span
                    draggable
                    onDragStart={() => (dragRef.current = { institution: group.institutionName, index: i })}
                    onDragEnd={() => (dragRef.current = null)}
                    aria-hidden
                    className="cursor-grab touch-none px-1 text-ink-faint active:cursor-grabbing"
                  >
                    <Icon name="more" className="size-4 rotate-90" />
                  </span>

                  {/* aria-disabled (not `disabled`) at the boundaries so the
                      focused button is never removed from the tab order mid-move
                      — disabling the active element drops focus to <body>. move()
                      already no-ops an out-of-range target. */}
                  <div className="flex flex-col">
                    <button
                      type="button"
                      aria-label={`Move ${a.shortName} up`}
                      aria-disabled={i === 0 || undefined}
                      onClick={() => move(group.accounts, i, i - 1)}
                      className="text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink aria-disabled:pointer-events-none aria-disabled:opacity-30"
                    >
                      <Icon name="chevron-up" className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${a.shortName} down`}
                      aria-disabled={i === group.accounts.length - 1 || undefined}
                      onClick={() => move(group.accounts, i, i + 1)}
                      className="text-ink-faint transition-colors duration-(--duration-fast) hover:text-ink aria-disabled:pointer-events-none aria-disabled:opacity-30"
                    >
                      <Icon name="chevron-down" className="size-3.5" />
                    </button>
                  </div>

                  <Link
                    href={`/accounts/${a.id}`}
                    className="group flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1 transition-colors duration-(--duration-fast) hover:bg-surface-sunken"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium group-hover:text-accent">
                          {a.shortName}
                        </span>
                        {a.unreviewedCount > 0 && (
                          <span
                            className="inline-block size-1.5 shrink-0 rounded-full bg-info"
                            aria-label={`${a.unreviewedCount} to review`}
                          />
                        )}
                      </div>
                      <div className="truncate text-[11px] text-ink-faint">{meta}</div>
                    </div>
                    <Sparkline
                      values={a.spark.map((p) => p.cents)}
                      tone={toneOf(a.dayChangeCents)}
                      width={64}
                      height={22}
                      className="hidden sm:block"
                    />
                    <div className="text-right">
                      {a.balanceCents !== null ? (
                        <Money
                          cents={a.isLiability ? -a.balanceCents : a.balanceCents}
                          className={`text-sm font-medium ${a.isLiability ? "text-negative" : ""}`}
                        />
                      ) : (
                        <span className="text-xs text-ink-faint">no balance</span>
                      )}
                      {a.dayChangeCents !== null && a.dayChangeCents !== 0 && (
                        <div
                          className={`figures text-[11px] ${a.dayChangeCents > 0 ? "text-positive" : "text-negative"}`}
                        >
                          {formatCentsSigned(a.dayChangeCents)}
                        </div>
                      )}
                    </div>
                  </Link>

                  <IconButton
                    icon="edit"
                    aria-label={`Edit ${a.shortName}`}
                    onClick={() =>
                      setEditing({
                        id: a.id,
                        name: a.name,
                        institutionId: a.institutionId,
                        last4: a.last4,
                        type: a.type,
                        subtype: a.subtype,
                        paymentSourceAccountId: a.paymentSourceAccountId,
                      })
                    }
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {editing && (
        <EditAccountSheet
          account={editing}
          institutions={institutions}
          fundingCandidates={groups
            .flatMap((g) => g.accounts)
            .filter((a) => (a.type === "checking" || a.type === "savings") && a.id !== editing.id)
            .map((a) => ({ id: a.id, name: a.name }))}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
