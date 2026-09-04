/**
 * What each way of measuring a return is CALLED, and what it means — one
 * vocabulary, so two surfaces cannot give one measure two names.
 *
 * 🔴 They did. `/investments` labels the time-weighted return "Total return"
 * (with "time-weighted · in total since Jul 2024" beneath it) and its
 * performance card calls the against-cost figure "Held, against what you paid",
 * warning in so many words that *"the largest is not the best of them"*. The
 * HOLDING page labelled the against-cost figure **"Total return"** too, with no
 * qualifier, directly above "Money-weighted" — as though the two were a pair.
 *
 * Measured on /investments/crypto/ETH, 2026-09-04:
 *
 *     header         +$6,023.43  (-29.72% time-weighted) · since Oct 16, 2025
 *     Total return   +$8,119.73  +28.50%
 *     Money-weighted             +41.62%
 *
 * A page carrying a −29.72% time-weighted return called a +28.50% against-cost
 * figure the "total return", four lines below it.
 */

export type ReturnMeasureKey = "twr" | "xirr" | "unrealized" | "realized";

export interface ReturnMeasureWords {
  /** the tile's heading */
  label: string;
  /** one line saying which question it answers */
  meaning: string;
}

export const RETURN_MEASURE: Record<Exclude<ReturnMeasureKey, "realized">, ReturnMeasureWords> = {
  twr: {
    label: "Time-weighted",
    meaning: "the holdings' own return, whenever money happened to go in",
  },
  xirr: {
    label: "Money-weighted",
    meaning: "your own dollars, weighted by how long each one was in the market",
  },
  unrealized: {
    label: "Held, against what you paid",
    meaning: "positions you still hold, at average cost — measured against price, not against time",
  },
};
