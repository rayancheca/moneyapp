/**
 * How many COMPLETE calendar months the spend baseline averages.
 *
 * Six, and the current month is excluded rather than prorated. A partial month
 * dragged into the mean understates the rate by however much of the month is
 * left — measured 2026-08-24, August alone reads $6,683.25 against a $8,025.92
 * six-month mean, and including it would publish a runway a fifth too long.
 *
 * ⚖️ …and "complete" means READ in full, not only over (his decision 71, 2026-10-13): the six end at the last month
 * every account you spend from has been imported through to its end — `baselineWindow` (services/committed) says
 * which, and why.
 *
 * A leaf of its own: the movers card reads it, and 🔴 importing it from `committed` closed a 6-module import cycle —
 * movers-card → committed → budgets → forecast → movers-card (the review of batch 9 F, 2026-10-30).
 */
export const SPEND_BASELINE_MONTHS = 6;
