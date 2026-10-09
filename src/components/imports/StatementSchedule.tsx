import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { pullSentence, rhythmPhrase, type PullStatus } from "@/lib/statement-cadence";
import type { AccountStatementPull } from "@/services/statement-pulls";
import { StatementAccountName } from "./StatementAccountName";

/**
 * Which statement to go and download, per account.
 *
 * Every number here is measured from the account's own close dates — nothing
 * has ever told the app that a cycle is monthly. The panel prints the rhythm it
 * inferred beside the date it predicts, because a prediction the reader cannot
 * check is worth less than one they can: "closes around the 2nd, from 12
 * statements" is falsifiable at a glance, "due" on its own is not.
 *
 * ⛔ A merely QUIET account is not a problem. Statements arrive monthly and this
 * ledger is uploaded in batches, so most rows read "On schedule" most of the
 * time and must look calm. Only a close that has already happened gets colour.
 *
 * This file holds COLOURS AND ORDER ONLY. Every sentence comes from
 * lib/statement-cadence.ts, because the e2e fixture renders `waiting` on all
 * seven of its accounts — `due` and `behind` are unreachable from Playwright,
 * and the lib is what the 100%-branch gate covers.
 *
 * Each account's name opens the bank's statements site (`StatementAccountName`, his request 2026-10-09); where it
 * goes and what the hint says are lib/statement-sites.ts's, shared with the dashboard teaser.
 */

const STATUS_ORDER: Record<PullStatus, number> = { behind: 0, due: 1, unknown: 2, waiting: 3 };

const STATUS_META: Record<PullStatus, { label: string; dot: string; text: string }> = {
  behind: { label: "Behind", dot: "bg-negative", text: "text-negative" },
  due: { label: "Ready to pull", dot: "bg-warning", text: "text-warning" },
  unknown: { label: "No rhythm yet", dot: "bg-ink-faint", text: "text-ink-faint" },
  waiting: { label: "On schedule", dot: "bg-positive", text: "text-ink-muted" },
};

export function StatementSchedule({ pulls }: { pulls: AccountStatementPull[] }) {
  if (pulls.length === 0) return null;

  const rows = [...pulls].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.accountName.localeCompare(b.accountName),
  );
  const toPull = rows.filter((p) => p.status === "due" || p.status === "behind");
  const outstanding = toPull.reduce((n, p) => n + p.closesDue, 0);

  return (
    <SurfaceCard>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">Statement schedule</h2>
        <p className="text-xs text-ink-muted">
          {toPull.length === 0 ? (
            "nothing to download — every account is inside its own cycle"
          ) : (
            <span className="text-warning">
              {outstanding} statement{outstanding === 1 ? "" : "s"} to download ·{" "}
              {toPull.map((p) => p.accountName).join(", ")}
            </span>
          )}
        </p>
      </div>
      <p className="mb-4 text-xs text-ink-faint">
        Each cycle is measured from the statements already imported, so the dates below are
        predictions from that history rather than a setting.
      </p>
      <ul className="divide-y divide-line">
        {rows.map((p) => {
          const meta = STATUS_META[p.status];
          return (
            <li key={p.accountId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
              <span className={`size-1.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden="true" />
              <StatementAccountName name={p.accountName} site={p.site} />
              <span className={`text-xs font-medium ${meta.text}`}>{meta.label}</span>
              <span className="basis-full text-xs text-ink-faint sm:ml-auto sm:basis-auto">
                {rhythmPhrase(p.cadence)}
              </span>
              <span className="basis-full text-xs text-ink-muted">{pullSentence(p)}</span>
            </li>
          );
        })}
      </ul>
    </SurfaceCard>
  );
}
