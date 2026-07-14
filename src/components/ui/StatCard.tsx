import Link from "next/link";
import { Icon } from "@/components/shell/Icon";

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  /** with an href the whole card becomes a drill-down link */
  href?: string;
  ariaLabel?: string;
  /** extra classes on the outer element (e.g. a grid-span for mobile layout) */
  className?: string;
}

const CARD = "rounded-(--radius-card) border border-line bg-surface-raised p-4";

function StatBody({ label, value, delta }: Pick<StatCardProps, "label" | "value" | "delta">) {
  return (
    <>
      <span className="block text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </span>
      <span className="figures mt-1 block text-xl font-semibold">{value}</span>
      {delta !== undefined && <span className="mt-1 block text-xs text-ink-muted">{delta}</span>}
    </>
  );
}

export function StatCard({ label, value, delta, href, ariaLabel, className }: StatCardProps) {
  if (!href) {
    return (
      <section aria-label={ariaLabel} className={`${CARD} ${className ?? ""}`.trim()}>
        <StatBody label={label} value={value} delta={delta} />
      </section>
    );
  }
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className={`group relative block ${CARD} transition-colors duration-(--duration-fast) hover:border-line-strong hover:bg-surface-sunken ${className ?? ""}`.trim()}
    >
      <span
        aria-hidden
        className="absolute right-3 top-3 opacity-0 transition-opacity duration-(--duration-fast) group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Icon name="arrow-up-right" className="size-3 text-ink-faint" />
      </span>
      <StatBody label={label} value={value} delta={delta} />
    </Link>
  );
}
