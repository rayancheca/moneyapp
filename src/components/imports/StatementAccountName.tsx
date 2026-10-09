import { statementSiteHint, statementSiteLabel, type StatementSite } from "@/lib/statement-sites";

/**
 * An account's name where a statement is waiting for it — a link straight to the bank's site when it has one.
 *
 * ⚖️ His request 2026-10-09: "make it so i can click on each and it leads me straight to the website so i can pull
 * the statement". Shared by /imports' Statement schedule and its "Statements you do not have" panel, and the
 * dashboard's Statements teaser, so the account he is told to pull opens the same page from all three.
 *
 * A plain `<a>`, never `next/link`: nothing is prefetched, and the bank hears from this Mac only when he clicks.
 * `noopener noreferrer` — the bank's tab gets no handle on this window and no Referer naming the app.
 */
export function StatementAccountName({ name, site }: { name: string; site: StatementSite | null }) {
  if (!site) return <span className="text-sm font-medium">{name}</span>;
  return (
    <a
      href={site.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={statementSiteLabel(name, site)}
      className="group/site inline-flex flex-wrap items-baseline gap-x-2 rounded-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className="text-sm font-medium decoration-line-strong underline-offset-4 group-hover/site:underline">
        {name}
      </span>
      <span className="text-xs text-ink-faint transition-colors duration-(--duration-fast) group-hover/site:text-ink-muted group-focus-visible/site:text-ink-muted">
        {statementSiteHint(site)} <span aria-hidden="true">↗</span>
      </span>
    </a>
  );
}
