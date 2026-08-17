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

function detail(c: AccountCoverage): string {
  switch (c.grade) {
    case "broken":
      // `brokenSince`, NOT `unverifiedSince`. This sentence pairs a date with a
      // count, and they were drawn from two different populations:
      // `unverifiedSince` is the first `derived_unverified` OR `gap` day, while
      // `days.gap` counts only the latter. On Robinhood Cash that rendered "the
      // balance chain stops closing at 2023-12-05 — 264 days cannot be trusted"
      // when every one of those 264 days is 2025-11 or later, and 2023-12-05 is
      // merely where the replay starts, before the account's first anchor. The
      // date accused a year and a half of reconciled history of being the break.
      return `the balance chain stops closing at ${c.brokenSince} — ${c.days.gap} day${c.days.gap === 1 ? "" : "s"} cannot be trusted`;
    case "unverified":
      return `nothing has checked this account since ${c.unverifiedSince} — ${c.days.derived_unverified} days rest on an export with no closing balance`;
    case "market_value":
      return "priced from holdings; statements here set a value, they never prove the transactions add up";
    case "manual":
      return c.lastManualUpdate
        ? `you are the statement — last counted ${c.lastManualUpdate}`
        : "you are the statement — no balance recorded yet";
    case "unknown":
      return "no balances derived yet — import a statement to start the chain";
    case "verified":
      // Deliberately says nothing about whether the NEXT statement is late. It
      // used to, off a flat 45-day rule, which is not a fact about any
      // particular account: a cycle that closes on the 2nd is 45 days quiet
      // every single month by construction. The Statement schedule panel above
      // answers that question from each account's own close dates, and two
      // panels asserting "overdue" against different definitions is the shape
      // that lets them drift apart.
      return `balances close to the cent through ${c.verifiedThrough}`;
  }
}

export function CoveragePanel({ coverage }: { coverage: AccountCoverage[] }) {
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
              <p className="w-full text-xs text-ink-muted">{detail(c)}</p>
            </li>
          );
        })}
      </ul>
    </SurfaceCard>
  );
}
