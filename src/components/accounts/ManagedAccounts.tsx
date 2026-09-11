"use client";

import { useRef, useState, useTransition } from "react";
import { ACCOUNT_TYPE_LABEL } from "@/lib/account-label";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { reorderAccountsAction } from "@/app/accounts/actions";
import type { AccountCard, InstitutionGroup } from "@/services/institution-groups";
import { Icon } from "@/components/shell/Icon";
import { IconButton } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { BalanceFigure } from "@/components/accounts/BalanceFigure";
import { Sparkline, type SparklineTone } from "@/components/ui/Sparkline";
import { toast } from "@/components/ui/Toast";
import { asOfSpanTerm } from "@/lib/day-change-label";
import { formatCentsSigned } from "@/lib/money";
import { EditAccountSheet, type EditableAccount } from "./EditAccountSheet";

function toneOf(cents: number | null): SparklineTone {
  if (cents === null || cents === 0) return "neutral";
  return cents > 0 ? "positive" : "negative";
}

/**
 * The small print under an institution's name: WHEN the total beside it is as
 * of, and whether it nets a debt off.
 *
 * 🔴 THE DATES WERE MISSING — the same omission as the day-change figure below,
 * in the same file. `totalCents` is each child's own last covered day added up,
 * so on the owner's ledger 2026-09-08 Chase came to $3,090.32 from $3,007.60
 * last seen Aug 14 beside $82.72 last seen Sep 3 — and this lens printed it
 * with no date on it anywhere, while the Table lens one click away says "so
 * this is not one moment, and every row prints its own" and the dashboard's
 * card names the span. Third reader of one service, third answer;
 * `asOfSpanTerm` is the one the other two already share.
 */
function GroupNote({ group }: { group: InstitutionGroup }) {
  const note = [
    asOfSpanTerm(group.asOf, group.oldestAsOf),
    group.accounts.some((a) => a.isLiability) ? "net of what you owe" : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
  if (note === "") return null;
  // its own line, like the dashboard's card: at 320px an inline clause breaks
  // "as of 2026-07-08" across two lines, mid-date
  return <div className="mt-0.5 text-[11px] font-normal text-ink-faint">{note}</div>;
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
              actually happen — see `GroupNote`, which carries it. */}
          <header className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{group.institutionName}</div>
              <GroupNote group={group} />
            </div>
            <Money cents={group.totalCents} className="shrink-0 text-sm font-semibold" />
          </header>

          <ul>
            {group.accounts.map((a, i) => {
              const meta = [ACCOUNT_TYPE_LABEL[a.type], a.last4 ? `····${a.last4}` : null, a.holdingsSummary]
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
                        <BalanceFigure balanceCents={a.balanceCents} isLiability={a.isLiability} />
                      ) : (
                        <span className="text-xs text-ink-faint">no balance</span>
                      )}
                      {/* 🔴 THE PERIOD, NAMED. This printed a bare figure, and
                          the Table lens one click away gives a DIFFERENT number
                          for the same account under a column simply headed
                          "Change": Robinhood Brokerage read "+$1,138.63" here
                          (Sep 3 vs Sep 2) and "+$1,339.68" there (30 covered
                          days). The service already built the words —
                          `dayChangeTerm`, written after this figure was called
                          "today" for a move weeks old — and the dashboard's own
                          accounts strip prints them. Only this lens dropped
                          them. */}
                      {a.dayChangeCents !== null && a.dayChangeCents !== 0 && (
                        <div
                          className={`figures text-[11px] ${a.dayChangeCents > 0 ? "text-positive" : "text-negative"}`}
                        >
                          {formatCentsSigned(a.dayChangeCents)}{" "}
                          <span className="text-ink-faint">{a.dayChangeTerm}</span>
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
