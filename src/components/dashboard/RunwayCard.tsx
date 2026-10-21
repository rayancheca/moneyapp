import Link from "next/link";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { arrearsAlarms } from "@/lib/arrears-reading";
import { arrearsReadingOf, arrearsSentence, baselineCaption, committedBillsNamed, shrinkCaption } from "@/lib/committed";
import { RUNWAY_JARGON } from "@/lib/jargon";
import { formatCents } from "@/lib/money";
import type { RunwayAssumption, RunwayAssumptionId } from "@/lib/runway";
import type { RunwayCard as RunwayCardData } from "@/services/committed";

/**
 * How long the money lasts.
 *
 * The headline is the LIQUID horizon and the portfolio is a second line, because
 * that is what the owner chose on 2026-08-24 when asked which cash base the card
 * should use. Collapsing them would either alarm about money that exists or
 * reassure with money he would have to sell to spend.
 *
 * Every figure comes from one `runway()` call — headline, the sentence under it,
 * and both duration labels leave the engine together, so the words and the
 * number cannot drift the way `/budgets` once let them.
 *
 * The rows are GROUPED under the subtotal each one actually feeds. Flat, they
 * read as a single column summing to `Net cash`, which is false: only the first
 * two reach it, the next two make the burn rate, and the portfolio belongs to
 * the second horizon alone. A list whose subtotal does not follow from the rows
 * above it is a worse lie than no list.
 */

/**
 * Where each assumption sends the reader to check it.
 *
 * ⛔ Not `spend`: its figure is an average over complete months that never
 * include the running one, and a bare `/spending` opens the running one. That
 * link is the service's `spendingHref`, built from the months averaged.
 *
 * ⛔ Not `income` either: what is behind its figure depends on the basis that chose it, so the link is the service's
 * `incomeHref` (`monthIncomeLink`, the Earned vs banked card's too). 🔴 It was `/spending` here, for every basis:
 * measured on his ledger copy 2026-10-12, "What you earn a month $4,948.32" — a rate levelled from his confirmed
 * weekly pay — opened October, which read "not imported yet". A levelled rate opens the pay schedule it comes from.
 *
 * ⛔ Not `/investments` for `investments`: that page values the investment
 * accounts' holdings and nothing else, and this figure also carries the
 * brokerage's own cash (`cashPosition` — Robinhood Cash and Robinhood Agentic,
 * the owner's decision of 2026-09-15). Measured on his ledger that day the row
 * read $109,002.47 against $108,974.93 of holdings. `/accounts` lists every
 * account the figure sums.
 */
const ASSUMPTION_HREF: Record<Exclude<RunwayAssumptionId, "spend" | "income">, string> = {
  liquid: "/accounts",
  cards: "/accounts",
  investments: "/accounts",
};

/** Rows the card prints as a subtraction rather than as a balance. */
const SUBTRACTED: ReadonlySet<RunwayAssumptionId> = new Set<RunwayAssumptionId>(["cards"]);

/** A row: its label and its figure on one line. */
const ROW = "flex items-baseline justify-between gap-3";
/** …and one with a caption, a grid so the caption can span the line under both — no other row changes. */
const CAPTIONED_ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3";

function AssumptionRow({
  a,
  href,
  tip,
  caption,
}: {
  a: RunwayAssumption;
  href: string;
  tip?: string;
  /** how the figure was reached, under it — a second `<dd>` of the same term, spanning the row */
  caption?: string | null;
}) {
  const subtracted = SUBTRACTED.has(a.id);
  return (
    <div className={caption ? CAPTIONED_ROW : ROW}>
      <dt className="flex min-w-0 items-center gap-1.5">
        <Link
          href={href}
          className="truncate text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          {a.label}
        </Link>
        {tip && <InfoTip term={a.label}>{tip}</InfoTip>}
      </dt>
      <dd className="shrink-0">
        {/* an operand that is taken AWAY carries its sign, so the column below
            it reads as arithmetic rather than as a list of balances */}
        <span className={`figures ${subtracted ? "text-negative" : ""}`}>
          {subtracted ? "−" : ""}
          {formatCents(a.cents)}
        </span>
      </dd>
      {caption && <dd className="col-span-2 mt-0.5 text-[11px] leading-relaxed text-ink-faint">{caption}</dd>}
    </div>
  );
}

export function RunwayCard({ data }: { data: RunwayCardData }) {
  const { runway, committed, spend, incomeBasisExplanation } = data;
  const shrink = shrinkCaption(committed);
  // the bills inside the rate — never a line that carries only arrears (`committedBillsNamed`)
  const billsNamed = committedBillsNamed(committed.lines);
  const arrears = arrearsSentence(committed);
  const arrearsAlarm = arrearsAlarms(arrearsReadingOf(committed));
  const burning = runway.kind === "burning";
  // three states, not two: `unknown` is a WITHHELD verdict and must not borrow
  // the positive tone `covered` earns by actually measuring something
  const withheld = runway.kind === "unknown";
  const by = (id: RunwayAssumptionId): RunwayAssumption | undefined =>
    runway.assumptions.find((a) => a.id === id);
  const hrefOf = (id: RunwayAssumptionId): string =>
    id === "spend" ? data.spendingHref : id === "income" ? data.incomeHref : ASSUMPTION_HREF[id];

  const cashRows = (["liquid", "cards"] as const).map(by).filter((a) => a !== undefined);
  const flowRows = (["spend", "income"] as const).map(by).filter((a) => a !== undefined);
  const investments = by("investments");

  return (
    <SurfaceCard>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
          Runway
          <InfoTip term="Runway">{RUNWAY_JARGON.runway}</InfoTip>
        </h3>
        {/* the months the spend term averaged — a bare /spending opens the running one; see `spendingHref` */}
        <Link
          href={data.spendingHref}
          className="text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink"
        >
          Spending →
        </Link>
      </div>

      <p
        className={`figures mt-2 text-3xl font-semibold tracking-tight ${
          withheld ? "text-ink-muted" : burning ? "text-ink" : "text-positive"
        }`}
      >
        {runway.headline}
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{runway.explanation}</p>

      {/* what you have */}
      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        {cashRows.map((a) => (
          <AssumptionRow key={a.id} a={a} href={hrefOf(a.id)} />
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
          <dt className="flex items-center gap-1.5 font-medium">
            Net cash
            <InfoTip term="Net cash">{RUNWAY_JARGON.netCash}</InfoTip>
          </dt>
          <dd>
            <Money cents={runway.netCashCents} className="font-semibold" />
          </dd>
        </div>
      </dl>

      {/* how fast it goes. The income row carries `incomeBasis`'s OWN
          explanation of how its figure was chosen — the three arithmetics it
          picks between have nothing in common, so the page must not paraphrase
          whichever one is live. It was computed and dropped in the first
          version of this card: the same defect pass 62 filed as
          "axisStartsAtZero computed, never rendered".
          ⚖️ The spend row carries its arithmetic under it, his decision 61 (2026-10-12) — the operands as /spending
          and the car card print them (`spendArithmetic`), so the row can be checked without leaving its link. */}
      <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
        {flowRows.map((a) => (
          <AssumptionRow
            key={a.id}
            a={a}
            href={hrefOf(a.id)}
            tip={a.id === "income" ? incomeBasisExplanation : undefined}
            caption={a.id === "spend" ? data.spendArithmetic : undefined}
          />
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
          <dt className="flex items-center gap-1.5 font-medium">
            {burning ? "Running down by" : "Covered by"}
            <InfoTip term="Running down by">{RUNWAY_JARGON.burn}</InfoTip>
          </dt>
          <dd
            className={`figures font-semibold ${
              withheld ? "text-ink-muted" : burning ? "text-negative" : "text-positive"
            }`}
          >
            {withheld ? "—" : `${formatCents(Math.abs(runway.netBurnCents))} a month`}
          </dd>
        </div>
      </dl>

      {/* the second horizon, and the money behind it. Quieter than the headline
          and never instead of it: selling the portfolio is a decision, not a
          balance. Hidden when there is nothing to sell, so the card never
          offers a lever that does not exist. */}
      {investments && investments.cents > 0 && (
        <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
          <AssumptionRow a={investments} href={hrefOf(investments.id)} />
          {burning && (
            <p className="text-ink-muted">
              …or <span className="font-medium text-ink">{runway.withInvestments.label}</span> if you sell
              them.
            </p>
          )}
        </dl>
      )}

      {/* ⛔ This deliberately does NOT say "of that spending, X is committed".
          Committed is a FORECAST and the spend baseline is a MEASUREMENT, so the
          subset that phrasing asserts is not guaranteed: measured on the e2e
          fixture, committed bills come to more per month than the six-month
          spend average, and the sentence would have been simply false there.
          The standalone claim is true either way, and the disagreement gets its
          own line rather than being phrased around. */}
      {(committed.totalCents > 0 || committed.overdueCents > 0) && (
        <div className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-ink-muted">
          {/* 🔴 A one-time charge past its day was one of the bills named here, at $0.00 of the rate — and with
              nothing else inside it the card read "come to $0.00 a month — Insurance balance." It is owed: the
              arrears sentence below says it. */}
          {billsNamed !== null && (
            <p className="flex items-start gap-1.5">
              <span>
                <span className="text-ink">Committed bills</span> come to{" "}
                <Money cents={committed.perMonthCents} className="text-ink" /> a month — {billsNamed}.
              </span>
              <InfoTip term="Committed bills">{RUNWAY_JARGON.committed}</InfoTip>
            </p>
          )}
          {/* ⛔ WHY THIS RATE IS LOWER THAN THE BILLS THEMSELVES COME TO — his
              call on 2026-09-02. The subscriptions card on this same screen
              levels each bill to a month and read $210.87 higher, and both were
              right: this is a RATE over the horizon, so a series that stops
              inside it contributes fewer payments. The sentence is built in
              `lib/committed`, where a test can reach the branches a pinned e2e
              clock never renders — and it names only what THIS book can prove,
              never the other card's total. */}
          {shrink !== null && <p className="mt-1">{shrink}</p>}
          {committed.perMonthCents > spend.monthlyCents && (
            <p className="mt-1">
              That is more than the monthly average above, so some of it has not been landing as
              measured spending.
            </p>
          )}
          {/* ⛔ "of it" would be false. Arrears sit BESIDE the rate above, not
              inside it: the rate covers [today, today + 12 months) and this
              money came due before today. Folding it in is what published
              $2,284.75 a month for a $2,109.00 bill.
              ⛔ "Has not posted" only of days the ledger has read — the sentence
              is `lib/committed`'s `arrearsSentence`, where a test reaches each
              branch.
              🔴 …and red only for them. On a copy of his ledger 2026-10-08 this
              printed "…and no import has covered it yet." in `text-negative`,
              the one surface still sounding an alarm over money the rent's page,
              the Next column and /categories said quietly. ⚖️ Staleness between
              uploads is normal, never a warning (his words 2026-08-05) — the
              tone is `arrearsAlarms`, every arrears surface's. */}
          {arrears !== null && <p className={arrearsAlarm ? "mt-1 text-negative" : "mt-1"}>{arrears}</p>}
        </div>
      )}

      {/* ⛔ The sentence is built in `lib/committed`, where a test can reach
          the zero-month branch a pinned e2e clock never renders. */}
      <p className="mt-2 text-[11px] text-ink-faint">{baselineCaption(spend)}</p>
    </SurfaceCard>
  );
}
