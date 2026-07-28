import Link from "next/link";
import { Icon, type IconName } from "@/components/shell/Icon";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

/* No `metadata` export: Next reads metadata from layout.tsx and page.tsx only,
   so the root layout's "MoneyApp" default is the title here.

   Reached two ways: an unmatched URL, and an explicit notFound() from a detail
   page whose id isn't in the database — so the copy has to be true of both. */
const DESTINATIONS: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/accounts", label: "Accounts", icon: "accounts" },
  { href: "/transactions", label: "Transactions", icon: "transactions" },
];

export default function NotFound() {
  return (
    <SurfaceCard className="flex flex-col items-start gap-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-surface-sunken text-ink-faint"
        >
          <Icon name="search" className="size-4" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Nothing lives at this address.</h1>
          <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-muted">
            Either the URL doesn&rsquo;t match a page, or it points at an account, category or
            merchant that isn&rsquo;t in the database — a deleted record and a typo look the same
            from here.
          </p>
        </div>
      </div>

      <nav aria-label="Go somewhere that exists" className="flex flex-wrap gap-2">
        {DESTINATIONS.map((destination) => (
          <Link
            key={destination.href}
            href={destination.href}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line bg-surface-raised px-3 py-1.5 text-sm font-medium transition-colors duration-(--duration-fast) hover:border-line-strong"
          >
            <Icon name={destination.icon} className="size-3.5" />
            {destination.label}
          </Link>
        ))}
      </nav>

      <p className="text-xs text-ink-faint">
        Press{" "}
        <kbd className="rounded border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px]">
          ⌘K
        </kbd>{" "}
        to search accounts, categories and merchants by name.
      </p>
    </SurfaceCard>
  );
}
