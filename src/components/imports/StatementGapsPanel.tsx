import { Icon } from "@/components/shell/Icon";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { MONTHS_SHORT } from "@/lib/format-date";
import type { AccountStatementGaps } from "@/services/statement-gaps";
import { StatementAccountName } from "./StatementAccountName";

/**
 * "Which statements do I not have" — the question `/imports` could not answer.
 *
 * Every other panel here is about what arrived: the files, what they proved,
 * whether the balances close. This one is about what never did. On the owner's
 * ledger it names five Discover statements across 152 days, on an account the
 * Coverage panel correctly grades **VERIFIED** — the chain closes across those
 * holes because an anchor on the far side pins it, so the arithmetic is sound
 * and the documents are simply absent.
 *
 * ⚠️ Neutral, and that is the design rather than the tone. Statement staleness
 * on this ledger is the normal rhythm; these are old windows, not failures, and
 * the panel says where they are without grading him for them. It is also
 * present when there is nothing to report, for the reason `StatementsTeaser`
 * gives: a panel that vanishes when satisfied cannot tell you it is satisfied.
 *
 * ⛔ A withheld window is listed under its account but never counted as a
 * statement to fetch: its file is already imported, and fetching it again adds
 * nothing (`statementGaps`). The intro paragraph is unchanged for every ledger
 * with no such window, which is every ledger today.
 *
 * ⚖️ Each account with a window to fetch opens its bank's statements site (`StatementAccountName`, his request
 * 2026-10-09), through the schedule's own resolver. 🔴 The schedule linked its rows first and this panel kept them
 * plain — on his ledger the Discover row, five statements to fetch, opened Capital One above and nothing here.
 */

/** "Aug 19 – Sep 18, 2024", collapsing a shared year and a shared month. */
export function holeRange(from: string, to: string): string {
  const [fy, fm, fd] = from.split("-");
  const [ty, tm, td] = to.split("-");
  const fMonth = MONTHS_SHORT[Number(fm) - 1];
  const tMonth = MONTHS_SHORT[Number(tm) - 1];
  if (!fMonth || !tMonth || !fy || !ty) return `${from} – ${to}`;
  const left = fy === ty ? `${fMonth} ${Number(fd)}` : `${fMonth} ${Number(fd)}, ${fy}`;
  return `${left} – ${tMonth} ${Number(td)}, ${ty}`;
}

export function StatementGapsPanel({ gaps }: { gaps: readonly AccountStatementGaps[] }) {
  const totalCloses = gaps.reduce((n, g) => n + (g.missingCloses ?? 0), 0);
  const totalDays = gaps.reduce((n, g) => n + g.missingDays, 0);

  return (
    <SurfaceCard>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">Statements you do not have</h2>
        {totalDays > 0 && (
          <p className="figures text-xs text-ink-muted">
            {totalCloses > 0 && `${totalCloses} ${totalCloses === 1 ? "statement" : "statements"} · `}
            {totalDays} {totalDays === 1 ? "day" : "days"} uncovered
          </p>
        )}
      </div>
      <p className="mb-4 text-xs text-ink-muted">
        Windows between two statements that were never imported. The balance chain can still close
        across one of these — an anchor on the far side pins it — so an account can be{" "}
        <em>verified</em> and still be missing documents. These are files to fetch, not errors.
      </p>

      {gaps.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <Icon name="check" className="size-4 shrink-0 text-positive" />
          Every statement between the first and the last is in the ledger.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {gaps.map((g) => (
            <li key={g.accountId} className="py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <StatementAccountName name={g.accountName} site={g.site} />
                {g.holes.length > 0 && (
                  <span className="figures ml-auto text-xs text-ink-faint">
                    {g.missingCloses === null
                      ? `${g.missingDays} ${g.missingDays === 1 ? "day" : "days"}`
                      : `${g.missingCloses} ${g.missingCloses === 1 ? "statement" : "statements"} · ${g.missingDays} days`}
                  </span>
                )}
              </div>
              <ul className="mt-1 space-y-0.5">
                {g.holes.map((h) => (
                  <li key={h.from} className="figures text-xs text-ink-muted">
                    {holeRange(h.from, h.to)}
                    <span className="text-ink-faint">
                      {" · "}
                      {h.days} {h.days === 1 ? "day" : "days"}
                      {h.closes !== null && `, ${h.closes} ${h.closes === 1 ? "statement" : "statements"}`}
                    </span>
                  </li>
                ))}
                {g.withheld.map((w) => (
                  <li key={`withheld-${w.from}`} className="figures text-xs text-ink-muted">
                    {holeRange(w.from, w.to)}
                    <span className="text-warning">
                      {" · "}imported in {w.fileName} without this account&apos;s section — fetching it again adds nothing
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </SurfaceCard>
  );
}
