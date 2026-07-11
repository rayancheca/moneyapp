import Link from "next/link";

export const RECURRING_TABS = ["upcoming", "all", "calendar"] as const;
export type RecurringTab = (typeof RECURRING_TABS)[number];

const LABELS: Record<RecurringTab, string> = { upcoming: "Upcoming", all: "All", calendar: "Calendar" };

interface RecurringTabsProps {
  tab: RecurringTab;
  /** per-tab counts shown as a subtle badge */
  counts: Record<RecurringTab, number>;
}

/** Sub-view tabs (ux-overhaul-plan §4.1) — the view lives in `?tab=`. */
export function RecurringTabs({ tab, counts }: RecurringTabsProps) {
  return (
    <nav aria-label="Recurring views" className="flex gap-1 border-b border-line">
      {RECURRING_TABS.map((value) => {
        const isActive = tab === value;
        return (
          <Link
            key={value}
            href={`/recurring?tab=${value}`}
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
