"use client";

import Link from "next/link";
import { usePageLinks } from "@/hooks/usePageLinks";

export const RECURRING_TABS = ["upcoming", "all", "calendar"] as const;
export type RecurringTab = (typeof RECURRING_TABS)[number];

const LABELS: Record<RecurringTab, string> = { upcoming: "Upcoming", all: "All", calendar: "Calendar" };

/**
 * The params a tab link replaces: its `tab`. Every other param of the URL rides along (the
 * calendar's `cal`) — never the `?error=` a refused "Detect now" or confirm redirected back with:
 * the banner reports an action that already happened, and a tab moves on from it, as it always has
 * and as a press does since 2026-10-06 (`ONE_SHOT_PARAMS`, lib/page-asks.ts).
 */
export const RECURRING_TAB_LINK_KEYS: readonly string[] = ["tab"];

interface RecurringTabsProps {
  tab: RecurringTab;
  /** per-tab counts shown as a subtle badge */
  counts: Record<RecurringTab, number>;
}

/**
 * Sub-view tabs (ux-overhaul-plan §4.1) — the view lives in `?tab=`.
 *
 * ⚖️ Owner 2026-10-06 (§6A 40), the period arrows' rule: a link that changes only params beside
 * the page's views keeps every view its URL holds (`usePageLinks`). 🔴 A tab wrote `tab` alone:
 * `?tab=calendar&cal=compact` with Regular saved, All, Calendar — and the linked Compact was gone.
 */
export function RecurringTabs({ tab, counts }: RecurringTabsProps) {
  const links = usePageLinks("/recurring", RECURRING_TAB_LINK_KEYS);
  return (
    <nav aria-label="Recurring views" className="flex gap-1 border-b border-line">
      {RECURRING_TABS.map((value) => {
        const isActive = tab === value;
        return (
          <Link
            key={value}
            {...links.link({ tab: value })}
            aria-current={isActive ? "page" : undefined}
            className={`-mb-px inline-flex items-baseline gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors duration-(--duration-fast) ${
              isActive
                ? "border-accent font-medium text-ink"
                : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink"
            }`}
          >
            {LABELS[value]}
            <span className="figures text-[11px] text-ink-faint">{counts[value]}</span>
          </Link>
        );
      })}
    </nav>
  );
}
