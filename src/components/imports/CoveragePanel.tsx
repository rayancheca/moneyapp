import { coverageDetail } from "@/lib/coverage-detail";
import type { AccountCoverage, CoverageGrade } from "@/services/coverage";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

/**
 * The answer to "did my monthly upload actually work?", per account.
 *
 * Deliberately ordered by how much it needs the owner, not alphabetically: an
 * account he has to act on is worth more of the top of the panel than six that
 * are fine. The rows that are fine still show their date, because "verified
 * through 36 days ago" is the normal statement rhythm and must not read as an
 * error — the only thing that reads red here is a chain that does not close.
 */

const GRADE_ORDER: Record<CoverageGrade, number> = {
  broken: 0,
  unverified: 1,
  market_value: 2,
  unknown: 3,
  manual: 4,
  verified: 5,
};

const GRADE_META: Record<CoverageGrade, { label: string; dot: string; text: string }> = {
  broken: { label: "Chain broken", dot: "bg-negative", text: "text-negative" },
  unverified: { label: "Unverified", dot: "bg-warning", text: "text-warning" },
  market_value: { label: "Market value", dot: "bg-ink-faint", text: "text-ink-muted" },
  unknown: { label: "No data yet", dot: "bg-ink-faint", text: "text-ink-faint" },
  manual: { label: "Manual", dot: "bg-ink-faint", text: "text-ink-muted" },
  verified: { label: "Verified", dot: "bg-positive", text: "text-positive" },
};

export function CoveragePanel({
  coverage,
  pricedFromHoldingsIds,
}: {
  coverage: AccountCoverage[];
  /** the accounts `derivesFromHoldings` prices from holding events */
  pricedFromHoldingsIds: readonly string[];
}) {
  if (coverage.length === 0) return null;

  const rows = [...coverage].sort(
    (a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade] || a.accountName.localeCompare(b.accountName),
  );
  const needsAction = rows.filter((c) => c.grade === "broken" || c.grade === "unverified").length;

  return (
    <SurfaceCard>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">Coverage by account</h2>
        <p className="text-xs text-ink-muted">
          {needsAction === 0 ? (
            "every account is checked by arithmetic"
          ) : (
            <span className="text-warning">
              {needsAction} account{needsAction === 1 ? "" : "s"} nothing is checking
            </span>
          )}
        </p>
      </div>
      <p className="mb-4 text-xs text-ink-muted">
        Whether the money is <em>checked</em>, not whether statements exist — an account can be
        verified without a monthly statement if its balances still close, and an account can have
        statements that prove nothing.
      </p>

      <ul className="divide-y divide-line">
        {rows.map((c) => {
          const meta = GRADE_META[c.grade];
          return (
            <li key={c.accountId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
              <span aria-hidden="true" className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${meta.dot}`} />
              <span className="text-sm font-medium">{c.accountName}</span>
              <span className={`text-[11px] uppercase tracking-[0.1em] ${meta.text}`}>{meta.label}</span>
              <span className="figures ml-auto text-xs text-ink-faint">
                {c.statementsThrough ? `statements → ${c.statementsThrough}` : "no statements"}
              </span>
              <p className="w-full text-xs text-ink-muted">
                {/* the words live in `lib/coverage-detail` under the 100% gate:
                    the shipped versions of two of them were false on his own
                    ledger and no component test could have seen it */}
                {coverageDetail({
                  grade: c.grade,
                  verifiedThrough: c.verifiedThrough,
                  unverifiedSince: c.unverifiedSince,
                  uncheckedSince: c.uncheckedSince,
                  uncheckedRunDays: c.uncheckedRunDays,
                  brokenSince: c.brokenSince,
                  daysSinceVerified: c.daysSinceVerified,
                  lastManualUpdate: c.lastManualUpdate,
                  gapDays: c.days.gap,
                  unverifiedDays: c.days.derived_unverified,
                  // the SAME field the badge two lines up prints, so the row
                  // cannot say "no statements" and then blame an export
                  hasStatements: c.statementsThrough !== null,
                  pricedFromHoldings: pricedFromHoldingsIds.includes(c.accountId),
                  countedOn: c.countedOn,
                  keptOpeningOn: c.keptOpeningOn,
                })}
              </p>
            </li>
          );
        })}
      </ul>
    </SurfaceCard>
  );
}
