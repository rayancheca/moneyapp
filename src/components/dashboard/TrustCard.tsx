import Link from "next/link";
import { Icon } from "@/components/shell/Icon";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { verdictToneClass } from "@/lib/provenance-verdict";
import { dayWindowLabel } from "@/lib/period";
import type { TrustAccountLine, TrustCard as TrustCardData } from "@/services/trust-card";

/**
 * Can you trust this?
 *
 * Every other card here answers a question about money. This one answers a
 * question about the app: how much of what it just told you is standing on a
 * document, and how far back that is still true.
 *
 * ⛔ Presentation only. The headline, the sentence under it, every group's word
 * and every account's clause arrive from `trustCard()` already written — the
 * card cannot count an account, grade one, or describe a basis in its own
 * words. That is deliberate: the same phrases appear on the badge beside net
 * worth, and a second author for them is how "verified" and "nothing checks it"
 * end up on the same account in two places.
 *
 * The weak groups come first and wear the loud glyph. An account that is fine
 * still gets its date, because "adds up through Jul 31" is the normal statement
 * rhythm and must not read as a fault — the same rule the coverage panel on
 * /imports follows.
 */
export function TrustCard({ data }: { data: TrustCardData }) {
  const { days } = data;

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">Can you trust this?</h3>
        <Link
          href="/imports"
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Coverage →
        </Link>
      </div>

      <p className="figures mt-2 text-3xl font-semibold tracking-tight text-ink">
        {data.headline}
        <span className="ml-1.5 text-base font-normal text-ink-muted">{data.headlineNoun}</span>
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{data.summary}</p>

      <div className="mt-4 space-y-3 border-t border-line pt-3">
        {data.groups.map((g) => (
          <div key={g.grade}>
            <p className={`flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] ${verdictToneClass(g.tone)}`}>
              <Icon name={g.icon} className="size-3.5 shrink-0" />
              {g.word}
              <span className="text-ink-faint">
                {g.accounts.length} account{g.accounts.length === 1 ? "" : "s"}
              </span>
            </p>
            <ul className="mt-1.5 space-y-1">
              {g.accounts.map((a) => (
                <AccountRow key={a.accountId} account={a} />
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
        {/* the days, and what they are NOT. `carried` looks like a weak basis
            and is not one, so the card says so rather than leaving the reader
            to wonder what the other 785 days were. */}
        <p className={days.unchecked > 0 ? "text-warning" : undefined}>{days.sentence}</p>
        {days.carriedNote && <p>{days.carriedNote}</p>}
        {data.emptyNote && <p>{data.emptyNote}</p>}
        {data.checkedThrough ? (
          <p>
            {/* ⛔ the day in a SENTENCE, so the same rule as every other date in
                one — `provenance.ts` already says "checked through Jul 31,
                2026" through its own formatter, and this card said
                "2026-07-31" of the same fact. */}
            The whole picture is checked through{" "}
            <span className="figures text-ink-muted">
              {dayWindowLabel(data.checkedThrough, data.checkedThrough)}
            </span>
            {/* ⛔ the phrase, not the number — see `checkedThroughAgo` */}
            {data.checkedThroughAgo !== null && ` — ${data.checkedThroughAgo}`}.{" "}
            {data.checkedThroughExplanation}
          </p>
        ) : (
          <p className="text-warning">
            No account is checked through any date yet, so there is no day the whole picture provably added
            up.
          </p>
        )}
      </div>
    </SurfaceCard>
  );
}

function AccountRow({ account }: { account: TrustAccountLine }) {
  // the "nothing checks it since <day>" clause, and only it, is about a RUN
  const runPaired =
    account.grade === "unverified" &&
    account.uncheckedRunDays > 0 &&
    account.uncheckedRunDays !== account.uncheckedDays;
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
      <span className="min-w-0 truncate text-ink">{account.name}</span>
      <span className="flex shrink-0 items-baseline gap-2 text-xs text-ink-muted">
        {account.detail}
        {/*
          🔴 "52 days" on its own, sitting immediately after "nothing checks it
          since Dec 5, 2023", reads as the SPAN — and that span is 1,001 days,
          not 52. Both halves were true and the pair was not. Worse, the card's
          own closing sentence uses `<date> — N days ago` for an elapsed count
          ("checked through 2026-07-31 — 33 days ago"), so one card was using
          the same shape for two different quantities.

          The word is the fix, and it is the vocabulary /imports already uses
          for this exact number: "52 days rest on an export with no closing
          balance". */}
        {/* ⛔ …and the count has to be the one that date is ABOUT. Robinhood
            Cash's 52 unchecked days fall in two runs 946 checked days apart, so
            "52 days" beside "nothing checks it SINCE Aug 3" is a span nobody can
            find. That row prints the run, with the account's total after it.

            ⚠️ Only that row. A `broken` account's clause is "stopped adding up
            on <the first gap>", which is a different date about a different
            question, and the total is what belongs beside it. */}
        {/* ⚖️ His answer, 2026-10-06: beside a VERIFIED account the count is quiet, in the faint
            tone "what you owe"'s note has. Its days all lie before its first balance — Robinhood
            Agentic's 26, under "adds up" — and were amber, the colour of Robinhood Cash's run still
            open. Amber stays for every other grade: a run open, his count, a chain that broke. */}
        {account.uncheckedDays > 0 && (
          <span className={`figures ${account.grade === "verified" ? "text-ink-faint" : "text-warning"}`}>
            {(runPaired ? account.uncheckedRunDays : account.uncheckedDays).toLocaleString("en-US")} day
            {(runPaired ? account.uncheckedRunDays : account.uncheckedDays) === 1 ? "" : "s"} unchecked
            {runPaired ? `, of ${account.uncheckedDays.toLocaleString("en-US")} in all` : ""}
          </span>
        )}
        {/* a HOLE, not an absence: rows the ledger holds that no total can
            see. The count comes from the service; the emphasis is the card's,
            because this is the one row a reader should act on. */}
        {account.isHole && <span className="text-negative">not in any total</span>}
      </span>
    </li>
  );
}
