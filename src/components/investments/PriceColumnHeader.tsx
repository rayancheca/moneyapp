import type { HoldingPriceAge } from "@/lib/holding-price-age";

/**
 * The "Price" column header, carrying the close date when ONE date describes
 * every priced row beneath it.
 *
 * This is where a uniformly stale portfolio says so — the normal shape of this
 * ledger, and the state of the owner's own holdings, whose ten positions have
 * all carried an Aug 6 close since Aug 6. The alternative considered and
 * rejected was stamping that same date onto all ten rows: the column is the
 * altitude the fact actually lives at, it costs one line instead of ten, and
 * unlike the per-row sub-line it is adjacent to every number it qualifies.
 *
 * `priceColumnAge` decides whether this speaks or the rows do, so the two can
 * never double up on one fact or both fall silent about it.
 *
 * The date is deliberately INSIDE the `<th>` rather than beside the table: it
 * joins the column's accessible name, so a screen reader announcing a price
 * cell says "Price as of Aug 6" and carries the same caveat a sighted reader
 * gets. `normal-case` and `tracking-normal` undo the header's uppercase
 * treatment — a date rendered as "AS OF AUG 6" reads as a label, not a fact.
 */
export function PriceColumnHeader({ age }: { age: HoldingPriceAge | null }) {
  if (age === null) return <>Price</>;
  return (
    <span className="inline-flex flex-col items-end" title={age.title}>
      <span>Price</span>
      <span className="text-[10px] font-normal normal-case tracking-normal text-ink-faint">
        {age.text}
      </span>
    </span>
  );
}
