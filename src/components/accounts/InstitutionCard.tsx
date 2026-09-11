"use client";

import { useId, useState } from "react";
import { ACCOUNT_TYPE_LABEL } from "@/lib/account-label";
import Link from "next/link";
import type { InstitutionGroup, AccountCard as AccountCardData } from "@/services/institution-groups";
import { asOfSpanTerm } from "@/lib/day-change-label";
import { formatCentsSigned } from "@/lib/money";
import { BalanceFigure } from "@/components/accounts/BalanceFigure";
import { Money } from "@/components/ui/Money";
import { Sparkline, type SparklineTone } from "@/components/ui/Sparkline";

function toneOf(dayChangeCents: number | null): SparklineTone {
  if (dayChangeCents === null || dayChangeCents === 0) return "neutral";
  return dayChangeCents > 0 ? "positive" : "negative";
}

/**
 * ⛔ The period is NAMED, never assumed — `term` comes from the service, which
 * built it from the same two days the figure was measured between.
 *
 * 🔴 This said "today" unconditionally. Measured on the owner's real ledger at
 * today = 2026-09-01: the Chase row read "-$50.00 today" for a move between
 * 2026-08-04 and 2026-08-05 while both of its children read "$0.00 today", and
 * the Robinhood row read "+$585.31 today" (2026-08-27 → 2026-08-28) while the
 * investments teaser on the same screen read "-$447.83 today" for the same
 * holdings. `daily_balances` is a cached derivation that stops wherever `today`
 * stood at the last rebuild, so on this ledger those two days are routinely
 * weeks old — and for a GROUP they are older still, because the combined series
 * only keeps days every account covers.
 *
 * The same rule already lives in `lib/day-change-label.ts`, written for the
 * portfolio header after it made exactly this claim. This was the third surface
 * asking the question and the only one still answering it by hand.
 */
function DayChange({ cents, term }: { cents: number | null; term: string }) {
  if (cents === null) return null;
  const tone =
    cents > 0 ? "text-positive" : cents < 0 ? "text-negative" : "text-ink-muted";
  return (
    <span className={`figures text-xs ${tone}`}>
      {formatCentsSigned(cents)} <span className="text-ink-faint">{term}</span>
    </span>
  );
}

function SubCard({ account }: { account: AccountCardData }) {
  const meta = [
    ACCOUNT_TYPE_LABEL[account.type],
    account.last4 ? `····${account.last4}` : null,
    account.holdingsSummary,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Link
      href={`/accounts/${account.id}`}
      className="group/sub rounded-(--radius-card) border border-line bg-surface p-4 transition-[color,border-color,transform] duration-(--duration-fast) hover:-translate-y-0.5 hover:border-line-strong motion-reduce:hover:translate-y-0"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium group-hover/sub:text-accent">
              {account.shortName}
            </span>
            {account.unreviewedCount > 0 && (
              <span
                className="inline-block size-1.5 shrink-0 rounded-full bg-info"
                aria-label={`${account.unreviewedCount} to review`}
              />
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-ink-faint">{meta}</div>
        </div>
        <Sparkline
          values={account.spark.map((p) => p.cents)}
          tone={toneOf(account.dayChangeCents)}
          width={72}
          height={24}
        />
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        {account.balanceCents !== null ? (
          <BalanceFigure
            balanceCents={account.balanceCents}
            isLiability={account.isLiability}
            className="text-base font-medium"
          />
        ) : (
          <span className="text-xs text-ink-faint">no balance yet</span>
        )}
        <DayChange cents={account.dayChangeCents} term={account.dayChangeTerm} />
      </div>
    </Link>
  );
}

/**
 * One card per institution: collapsed it reads "Robinhood · total ·
 * sparkline"; clicking expands (animated, reduced-motion aware via the
 * global media query) into one sub-card per account, each linking to its
 * detail page. Day color is semantic: green up, red down.
 */
export function InstitutionCard({ group }: { group: InstitutionGroup }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const tone = toneOf(group.dayChangeCents);
  const asOfTerm = asOfSpanTerm(group.asOf, group.oldestAsOf);

  return (
    <section
      aria-label={group.institutionName}
      className="rounded-(--radius-card) border border-line bg-surface-raised shadow-[0_1px_2px_oklch(0%_0_0/0.04)]"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={regionId}
        className="flex w-full items-center justify-between gap-4 rounded-(--radius-card) px-5 py-4 text-left transition-colors duration-(--duration-fast) hover:bg-surface-sunken/40"
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold">{group.institutionName}</div>
          <div className="mt-0.5 text-[11px] text-ink-faint">
            {group.accounts.length} account{group.accounts.length === 1 ? "" : "s"}
            {/* 🔴 The total is each child's own last covered day added up, so a
                single "as of" is only true when they share one. The Chase card
                read "as of 2026-09-03 · $3,090.32" of a balance last seen Aug 14
                plus one last seen Sep 3. `AccountsTable` refuses the same claim
                about the same balances; see `InstitutionGroup.oldestAsOf`. */}
            {asOfTerm ? ` · ${asOfTerm}` : ""}
            {/* 🔴 The heading is a NET across the group's sides and every sub-card
                under it prints a card as what you owe, so the same money appeared
                twice with opposite signs and nothing said why: on the owner's
                ledger 2026-09-04 "Capital One · -$367.99" collapsed, opening to
                "Venture X · $367.99". `daily_balances` stores a debt negative and
                the group total is their sum — correct, and unreadable beside a row
                that flips it. The clause is printed only where the flip can
                happen, and only for the reader who is about to see it. */}
            {group.accounts.some((a) => a.isLiability) ? " · net of what you owe" : ""}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Sparkline
            values={group.spark.map((p) => p.cents)}
            tone={tone}
            className="hidden sm:block"
          />
          <div className="text-right">
            <Money cents={group.totalCents} className="text-lg font-semibold" />
            <div className="min-h-4">
              <DayChange cents={group.dayChangeCents} term={group.dayChangeTerm} />
            </div>
          </div>
          <svg
            viewBox="0 0 16 16"
            width={16}
            height={16}
            aria-hidden="true"
            className={`shrink-0 text-ink-faint transition-transform duration-(--duration-normal) ${open ? "rotate-180" : ""}`}
          >
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </button>

      <div
        id={regionId}
        className={`grid transition-[grid-template-rows] duration-(--duration-normal) ease-(--ease-out-expo) ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        {/* inert removes the hidden sub-links from tab order and the a11y tree */}
        <div className="overflow-hidden" inert={!open ? true : undefined}>
          <div
            className={`grid gap-3 border-t border-line px-5 py-4 transition-[opacity,transform] duration-(--duration-normal) ease-(--ease-out-expo) sm:grid-cols-2 lg:grid-cols-3 ${
              open ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"
            }`}
          >
            {group.accounts.map((a) => (
              <SubCard key={a.id} account={a} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
