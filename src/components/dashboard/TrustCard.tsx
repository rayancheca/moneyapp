import Link from "next/link";
import { Icon } from "@/components/shell/Icon";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { verdictToneClass } from "@/lib/provenance-verdict";
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
            The whole picture is checked through{" "}
            <span className="figures text-ink-muted">{data.checkedThrough}</span>
            {data.daysSinceChecked !== null && ` — ${data.daysSinceChecked} days ago`}.{" "}
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
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
      <span className="min-w-0 truncate text-ink">{account.name}</span>
      <span className="flex shrink-0 items-baseline gap-2 text-xs text-ink-muted">
        {account.detail}
        {account.uncheckedDays > 0 && (
          <span className="figures text-warning">
            {account.uncheckedDays.toLocaleString("en-US")} day
            {account.uncheckedDays === 1 ? "" : "s"}
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
