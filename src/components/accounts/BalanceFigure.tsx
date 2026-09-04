import { Money } from "@/components/ui/Money";
import { balanceHeading } from "@/lib/side-magnitude";

/**
 * What an account row's bare figure IS, and the word that says so when the
 * figure alone cannot.
 *
 * 🔴 Both card lenses printed `-balanceCents` for every liability, always in
 * `text-negative`. On 2026-09-04 that made Chase Sapphire read, on `/accounts`
 * and again in the dashboard's accounts strip:
 *
 *     Sapphire
 *     Credit card · ····9805
 *     -$82.72                  (in red)
 *
 * of a card the bank owes HIM $82.72 on — the debt-red of the two cards beside
 * it that really are debts, and no word between them. Four other surfaces said
 * the opposite about the same balance on the same day: the account's own page
 * "IN CREDIT · $82.72", the table lens one click away "in credit — no share of
 * the debt", the dashboard's cards card "$82.72 · in credit", and the terrain
 * "Owed · in credit".
 *
 * `balanceHeading` is the rule and this is where the two lenses read it, so a
 * fix to one cannot leave the other behind again. The words match
 * `CardsOwedCard`'s, which had them first.
 *
 * ⚠️ An OVERDRAWN asset keeps the negative and the debt-red: an overdraft is a
 * debt, not a credit, exactly as `balanceHeading` says.
 */
export function BalanceFigure({
  balanceCents,
  isLiability,
  className = "text-sm font-medium",
}: {
  balanceCents: number;
  isLiability: boolean;
  className?: string;
}) {
  const heading = balanceHeading(balanceCents, isLiability);
  const inCredit = isLiability && !heading.isAgainstYou && heading.cents > 0;
  return (
    <span className="inline-flex items-baseline gap-1">
      <Money
        cents={heading.cents}
        className={`${className} ${inCredit ? "text-positive" : heading.isAgainstYou ? "text-negative" : ""}`}
      />
      {inCredit && <span className="text-[11px] font-normal text-ink-faint">in credit</span>}
    </span>
  );
}
