"use client";

import { dayWindowLabel } from "@/lib/period";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loadPeriodActivity } from "@/app/period-activity-action";
import { formatCents } from "@/lib/money";
import type { PeriodActivity } from "@/services/period-activity";
import { useDashboardWindow } from "@/components/dashboard/DashboardWindowContext";
import type { CategoryPickerOption } from "@/components/transactions/CategoryPicker";
import { RecentTransactions } from "@/components/transactions/RecentTransactions";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { Icon } from "@/components/shell/Icon";

/**
 * The linked "activity in this window" panel (dashboard-dynamic §2). It
 * subscribes to the shared active-window context: brushing the net-worth chart
 * (or stepping through timeframe history) cross-filters this panel to the same
 * [start, end]. The cash-flow numbers roll to their new values while the
 * transaction list swaps with a fade-rise — a coordinated overview→detail view.
 *
 * At the base (no brushed window) it's a calm, single-line invitation, never a
 * dead gap. Data is fetched on demand via a server action keyed on the window,
 * so the whole two-year ledger never ships to the client.
 */
export function PeriodActivityPanel({ categories }: { categories: readonly CategoryPickerOption[] }) {
  const win = useDashboardWindow();
  const current = win?.current ?? null;
  const router = useRouter();
  const [data, setData] = useState<PeriodActivity | null>(null);
  const [errored, setErrored] = useState(false);
  const [, startTransition] = useTransition();
  const [reloadNonce, setReloadNonce] = useState(0);
  const reqRef = useRef(0);

  const start = current?.start ?? null;
  const end = current?.end ?? null;

  useEffect(() => {
    if (start === null || end === null) {
      setData(null);
      setErrored(false);
      return;
    }
    const myReq = ++reqRef.current;
    startTransition(async () => {
      try {
        const res = await loadPeriodActivity(start, end);
        // ignore a stale response from a superseded window (latest-request guard)
        if (reqRef.current === myReq) {
          setData(res);
          setErrored(false);
        }
      } catch {
        // a rejected load must never leave the previous window's money sitting
        // under the new window's date label — surface an error state, don't swallow it
        if (reqRef.current === myReq) setErrored(true);
      }
    });
  }, [start, end, reloadNonce]);

  // base state: an inviting prompt that teaches the brush interaction
  if (start === null || end === null) {
    return (
      <div className="mt-4 flex items-center gap-3 rounded-(--radius-card) border border-dashed border-line bg-surface-raised/60 px-4 py-3 text-sm text-ink-muted">
        <Icon name="arrow-left-right" className="size-4 shrink-0 text-accent" />
        <span>
          Drag across the chart to break down any window — money in, out, and every transaction in it.
        </span>
      </div>
    );
  }

  // Only surface figures whose LOADED window matches the active selection, so the
  // date label and the money never describe different windows. During a fetch the
  // numbers read "—" (never the previous window's values), and a failed load shows
  // an error instead of stale money.
  const shown = data && data.summary.from === start && data.summary.to === end ? data : null;
  const summary = shown?.summary ?? null;
  /* 🔴 A WINDOW THAT CROSSES A YEAR WAS NAMED BY NEITHER. `formatDayShort`
     drops the year always, so 2025-11-15 → 2026-02-03 read "Nov 15 – Feb 3"
     beside a header on the same line printing "opened Jan 13, 2026" and an
     sr-only readout printing "Tue, Feb 3, 2026" — one screen, two conventions,
     and the one a reader needs is unidentifiable. `dayWindowLabel` is the app's
     rule for naming a window by its own ends and drops only what repeats. */
  const rangeLabel = dayWindowLabel(start, end);
  // key the animated block on the LOADED window, so the fade plays when real data
  // arrives (not on a placeholder) and the previous window stays put until then
  const contentKey = summary ? `${summary.from}_${summary.to}` : "loading";

  return (
    <section
      aria-label={`Activity from ${rangeLabel}`}
      className="mt-4 space-y-4 rounded-(--radius-card) border border-line bg-surface-raised p-4"
    >
      {/* header: window + hero "spent" (rolls between windows) */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h2 className="flex items-baseline gap-2 text-sm font-medium">
          <span className="text-ink-faint">In this window</span>
          <span className="figures text-ink">{rangeLabel}</span>
        </h2>
        <p className="figures text-2xl font-semibold tracking-tight text-ink" aria-live="polite">
          <NumberRoll value={summary ? formatCents(summary.outCents) : "—"} />
          <span className="ml-1 text-xs font-normal text-ink-faint">spent</span>
        </p>
      </div>

      {/* secondary stats — income + transaction count */}
      <dl className="grid grid-cols-2 gap-3">
        <Stat label="Income" tone="text-positive">
          {summary ? formatCents(summary.inCents) : "—"}
        </Stat>
        <Stat label="Transactions" tone="text-ink">
          {summary ? summary.txnCount.toLocaleString() : "—"}
        </Stat>
      </dl>

      {/* animated detail: top categories + the windowed transaction list. Keyed
          on the window so each new selection fades in; the header/range above
          updates instantly, so the swap reads as stale-while-revalidate. */}
      <div key={contentKey} className="animate-fade-rise space-y-3">
        {summary && summary.topCategories.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {summary.topCategories.map((c) => (
              <li key={c.categoryId ?? "uncategorized"} className="inline-flex items-center gap-1.5">
                <CategoryChip label={c.name} hue={c.hue} icon={c.icon} compact />
                <span className="figures text-xs text-ink-muted">{formatCents(c.spentCents)}</span>
              </li>
            ))}
          </ul>
        )}

        {shown && shown.rows.length > 0 ? (
          <RecentTransactions
            rows={shown.rows}
            categories={categories}
            onRowChanged={() => {
              router.refresh();
              setReloadNonce((n) => n + 1);
            }}
          />
        ) : summary ? (
          <p className="rounded-(--radius-card) border border-dashed border-line px-4 py-6 text-center text-sm text-ink-muted">
            No transactions in this window.
          </p>
        ) : errored ? (
          <p className="rounded-(--radius-card) border border-dashed border-line px-4 py-6 text-center text-sm text-ink-muted">
            Couldn&rsquo;t load this window.{" "}
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="font-medium text-accent underline decoration-line underline-offset-4 transition-colors duration-(--duration-fast) hover:decoration-accent"
            >
              Retry
            </button>
          </p>
        ) : null}

        {shown && summary && summary.txnCount > shown.rows.length && (
          <Link
            href={shown.href}
            className="inline-flex items-center gap-1 text-xs font-medium text-accent transition-colors duration-(--duration-fast) hover:text-accent/80"
          >
            View all {summary.txnCount} transactions →
          </Link>
        )}
      </div>
    </section>
  );
}

/** One labelled cash-flow figure; the value rolls between windows. */
function Stat({ label, tone, children }: { label: string; tone: string; children: string }) {
  return (
    <div className="rounded-md bg-surface-sunken px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className={`figures mt-0.5 text-sm font-semibold ${tone}`}>
        <NumberRoll value={children} />
      </dd>
    </div>
  );
}
