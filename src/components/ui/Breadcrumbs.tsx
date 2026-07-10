import Link from "next/link";
import { Icon } from "@/components/shell/Icon";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
}

/** Server-safe breadcrumb trail for detail pages; the last item is the current page. */
export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1.5 text-xs">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 && <Icon name="chevron-right" className="size-3 text-ink-faint" />}
              {isLast ? (
                <span aria-current="page" className="text-ink">
                  {item.label}
                </span>
              ) : item.href ? (
                <Link
                  href={item.href}
                  className="text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
                >
                  {item.label}
                </Link>
              ) : (
                <span className="text-ink-muted">{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
