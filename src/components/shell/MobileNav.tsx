"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, navLabel } from "./nav-items";

const BADGE_CAP = 99;

export function MobileNav({
  reviewCount,
  duplicateCount,
}: {
  reviewCount: number;
  duplicateCount: number;
}) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main navigation"
      className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2 md:hidden"
    >
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const showBadge = item.href === "/transactions" && reviewCount > 0;
        const showDuplicates = item.href === "/transactions" && duplicateCount > 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            aria-label={navLabel(item.label, showBadge ? reviewCount : 0, showDuplicates ? duplicateCount : 0)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs transition-colors duration-(--duration-fast) ${
              isActive
                ? "bg-accent-soft font-medium text-accent"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            {item.label}
            {showBadge && (
              <span
                aria-hidden
                className="figures rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent"
              >
                {reviewCount > BADGE_CAP ? `${BADGE_CAP}+` : reviewCount}
              </span>
            )}
            {showDuplicates && (
              <span
                aria-hidden
                className="figures ml-1 rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning"
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
