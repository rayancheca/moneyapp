"use client";

import { useState, useTransition } from "react";
import type { DuplicatePairRow, DuplicatePairSideRow } from "@/services/duplicate-resolution";
import type { DuplicateResolution } from "@/db/schema/duplicate-candidates";
import { formatCents } from "@/lib/money";
import { resolveDuplicateAction, undoDuplicateAction } from "@/app/transactions/actions";
import { Button } from "@/components/ui/Button";
import { countPhrase } from "@/components/ui/blast-radius";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

/**
 * The duplicates queue (duplicate_candidates): two rows that may be one charge,
 * shown side by side with where each came from, and what the owner can do.
 *
 * It is its own surface rather than a shape inside the review inbox, because the
 * review inbox groups by MERCHANT and clears a whole cluster with one button —
 * a duplicate pair dropped in there would be swallowed by unrelated rows and its
 * warning dismissed by the existing primary action. A pair is not a cluster: it
 * is two specific rows, and the only useful question is which of the two to keep.
 *
 * Nothing here decides anything on the owner's behalf. There is no "resolve all",
 * no suggested winner, and no default selection — an earlier revision picked
 * winners on (day, amount) alone and destroyed real charges (reverted in 3e5a7fc).
 */

interface DuplicatePairsProps {
  pairs: DuplicatePairRow[];
}

export function DuplicatePairs({ pairs }: DuplicatePairsProps) {
  const open = pairs.filter((p) => p.resolution === "unresolved");
  const settled = pairs.filter((p) => p.resolution !== "unresolved");
  return (
    <div className="space-y-6">
      {open.length > 0 ? (
        <section aria-labelledby="dupes-open" className="space-y-3">
          <h2 id="dupes-open" className="text-sm font-medium text-ink">
            {open.length === 1 ? "1 possible duplicate" : `${open.length} possible duplicates`}
          </h2>
          {open.map((pair) => (
            <PairCard key={pair.candidateId} pair={pair} />
          ))}
        </section>
      ) : null}
      {/* 🔴 The tab counts OPEN pairs, and this is the one view that can read
          "Duplicates 0" over a screenful of cards: 71 of them on the owner's
          ledger. Every sibling tab says so when its queue is clear — "Review
          queue is clear", "Empty is exactly what you want" — and the one whose
          zero needs explaining was the one that said nothing. The full
          `EmptyState` still belongs to a ledger with no pairs at all; this is
          the other zero. */}
      {open.length === 0 && settled.length > 0 ? (
        <p className="text-sm text-ink-muted">
          No duplicate is waiting on a decision — that is the zero on the tab. The{" "}
          {countPhrase(settled.length, "pair")} below{" "}
          {settled.length === 1 ? "is one you" : "are ones you"} already settled, and each can be
          taken back.
        </p>
      ) : null}
      {settled.length > 0 ? (
        <section aria-labelledby="dupes-settled" className="space-y-3">
          <h2 id="dupes-settled" className="text-sm font-medium text-ink-muted">
            Already decided
          </h2>
          {/* A retired row is `superseded`, and no other tab renders one — so this
              list is the only place the owner can see what he retired, or take
              it back. Dropping it once resolved would make the retire look
              exactly like a delete. */}
          {settled.map((pair) => (
            <PairCard key={pair.candidateId} pair={pair} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

/**
 * What an "Undo" on a settled pair puts back — its accessible name.
 *
 * ⛔ It names the MONEY and the ROW, not the verb: 71 of these render on
 * `/transactions?view=duplicates` and "Undo" alone is the same sentence for all
 * of them. The retired side is the one that comes back for a confirmed
 * duplicate; a dismissed pair retired nothing, so the undo re-opens the
 * question rather than restoring anything.
 */
export function undoLabel(pair: {
  resolution: DuplicateResolution;
  accountName: string;
  retiredTransactionId: string | null;
  sides: readonly { id: string; postedOn: string; amountCents: number; sourceLabel: string }[];
}): string {
  if (pair.resolution !== "confirmed_duplicate") {
    return `Reopen the ${pair.accountName} pair kept as two real charges`;
  }
  const back = pair.sides.find((s) => s.id === pair.retiredTransactionId) ?? pair.sides[0];
  if (!back) return `Restore the retired copy on ${pair.accountName}`;
  return `Restore the retired ${formatCents(Math.abs(back.amountCents))} copy from ${back.sourceLabel} on ${back.postedOn}`;
}

function PairCard({ pair }: { pair: DuplicatePairRow }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const resolved = pair.resolution !== "unresolved";

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>): void => {
    setError(null);
    startTransition(() => {
      void fn().then((r) => {
        if (!r.ok) setError(r.error ?? "That did not work");
      });
    });
  };

  return (
    <SurfaceCard className="space-y-3 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm text-ink">{pair.reasonDetail}</p>
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          {pair.accountName}
        </span>
      </header>

      <ul className="space-y-1.5">
        {pair.sides.map((side) => (
          <li key={side.id}>
            <SideRow
              side={side}
              retired={pair.retiredTransactionId === side.id}
              actionable={!resolved && !pending}
              onRetire={() =>
                run(() =>
                  resolveDuplicateAction({
                    candidateId: pair.candidateId,
                    decision: "confirmed_duplicate",
                    retiredTransactionId: side.id,
                  }),
                )
              }
            />
          </li>
        ))}
      </ul>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2">
        {resolved ? (
          <>
            <span className="text-xs text-ink-muted">
              {pair.resolution === "confirmed_duplicate"
                ? "One copy retired — it no longer counts toward any total."
                : "Kept both — these are two real charges."}
            </span>
            {/* 🔴 "Undo" was the whole accessible name, 71 times on one page.
                The sibling on the same card was fixed for exactly this — "both
                rows carry this button, and 'Retire this one' twice tells a
                screen-reader user nothing about which one" — and /imports
                states the rule for every trigger on a repeated row. Each of
                these restores a superseded transaction into every total: real
                money, a different amount per pair. */}
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              aria-label={undoLabel(pair)}
              onClick={() => run(() => undoDuplicateAction({ candidateId: pair.candidateId }))}
            >
              Undo
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs text-ink-muted">
              Retire the copy you do not want counted, or keep both.
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(() =>
                  resolveDuplicateAction({ candidateId: pair.candidateId, decision: "dismissed" }),
                )
              }
            >
              Not a duplicate
            </Button>
          </>
        )}
      </footer>
    </SurfaceCard>
  );
}

interface SideRowProps {
  side: DuplicatePairSideRow;
  retired: boolean;
  actionable: boolean;
  onRetire: () => void;
}

function SideRow({ side, retired, actionable, onRetire }: SideRowProps) {
  return (
    <div
      className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md px-2 py-1.5 ${
        retired ? "bg-surface-sunken opacity-60" : "bg-surface-sunken/40"
      }`}
    >
      <span className="figures shrink-0 text-xs text-ink-muted">{side.postedOn}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{side.description}</span>
      <span className="shrink-0 text-[11px] text-ink-faint">{side.sourceLabel}</span>
      <Money cents={side.amountCents} flow />
      {retired ? (
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          Retired
        </span>
      ) : side.provenByStatement ? (
        // Its statement period reconciles to the cent, so this copy's money is
        // already proved real. resolveDuplicate refuses to retire it; saying so
        // here is better than offering a button that throws.
        <span className="shrink-0 text-[11px] text-ink-faint" title="Its statement period balances to the cent">
          Proved by a statement
        </span>
      ) : actionable ? (
        // The accessible name has to name the COPY, not the action: both rows
        // carry this button, and "Retire this one" twice tells a screen-reader
        // user nothing about which one they are about to take out of the ledger.
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Retire the copy from ${side.sourceLabel}`}
          onClick={onRetire}
        >
          Retire this one
        </Button>
      ) : null}
    </div>
  );
}
