"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, navLabel } from "./nav-items";
import { Icon } from "./Icon";

const BADGE_CAP = 99;

export function SideNav({
  reviewCount,
  duplicateCount,
}: {
  reviewCount: number;
  duplicateCount: number;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main navigation" className="flex-1 space-y-0.5 px-3 py-4">
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const showBadge = item.href === "/transactions" && reviewCount > 0;
        // A second, warning-toned pill rather than one merged total. Review and
        // duplicates are different questions with different answers — a single
        // number would tell the owner neither what is wrong nor where to go.
        const showDuplicates = item.href === "/transactions" && duplicateCount > 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            aria-label={navLabel(item.label, showBadge ? reviewCount : 0, showDuplicates ? duplicateCount : 0)}
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors duration-(--duration-fast) ${
              isActive
                ? "bg-accent-soft font-medium text-accent"
                : "text-ink-muted hover:bg-surface-raised hover:text-ink"
            }`}
          >
            <Icon name={item.icon} className="size-4 shrink-0" />
            {item.label}
            {showBadge && (
              <span
                aria-hidden
                className="figures ml-auto rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent"
              >
                {reviewCount > BADGE_CAP ? `${BADGE_CAP}+` : reviewCount}
              </span>
            )}
            {showDuplicates && (
              <span
                aria-hidden
                className={`figures ${showBadge ? "ml-1" : "ml-auto"} rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning`}
              >
                {duplicateCount > BADGE_CAP ? `${BADGE_CAP}+` : duplicateCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
