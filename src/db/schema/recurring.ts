import { integer, real, sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
import { categories } from "./categories";
import { merchants } from "./merchants";

export const SERIES_KINDS = ["income", "bill", "subscription", "transfer", "other"] as const;
export type SeriesKind = (typeof SERIES_KINDS)[number];

export const CADENCES = [
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
  "quarterly",
  "annual",
] as const;
export type Cadence = (typeof CADENCES)[number];

export const SERIES_STATUSES = ["detected", "confirmed", "dismissed", "ended"] as const;
export type SeriesStatus = (typeof SERIES_STATUSES)[number];

/**
 * One PAST period of a series' rate: what each occurrence was worth through `throughOn` (inclusive), net-worth-signed
 * cents — from the day after the period before it, or from the series' start for the first. A history is the past
 * only, oldest first, strictly increasing; the rate in force now is the series' own amount (`seriesAmountCents`).
 * Read only by `parseAmountHistory` (lib/series-kind), strictly — the column has no constraint of its own.
 */
export interface RatePeriod {
  readonly throughOn: string;
  readonly amountCents: number;
}

/**
 * Detection statistics are stored so the forecast math stays inspectable
 * (brief: statistics, not a black box).
 */
export const recurringSeries = sqliteTable("recurring_series", {
  id: id(),
  name: text("name").notNull(),
  merchantId: text("merchant_id").references(() => merchants.id),
  accountId: text("account_id").references(() => accounts.id),
  kind: text("kind", { enum: SERIES_KINDS }).notNull(),
  cadence: text("cadence", { enum: CADENCES }).notNull(),
  intervalDaysAvg: real("interval_days_avg"),
  amountCentsAvg: integer("amount_cents_avg"),
  amountCentsStddev: real("amount_cents_stddev"),
  toleranceDays: integer("tolerance_days").notNull().default(3),
  nextExpectedOn: text("next_expected_on"),
  /**
   * The day-of-month this series is really billed on, when the calendar can
   * clamp it (29..31). Null for everything else, which is almost everything.
   *
   * `next_expected_on` cannot carry this: a date that has been clamped looks
   * exactly like one that has not. A month-end bill posts 2027-02-28, detection
   * re-anchors there, and every long month after it lands on the 28th — the
   * newest posting is itself the clamped value, so no amount of re-deriving from
   * it recovers the truth. Written by `analyzeGroup` from ALL of a group's
   * postings (see `deriveAnchorDay`), read by `stepPlan`.
   */
  anchorDay: integer("anchor_day"),
  nextExpectedAmountCents: integer("next_expected_amount_cents"),
  status: text("status", { enum: SERIES_STATUSES }).notNull().default("detected"),
  confidence: real("confidence"),
  lastMatchedOn: text("last_matched_on"),
  // User overrides (ux-overhaul-plan §4.4): detection keeps writing its own
  // columns above; the UI and the forecast read user-first. Null = no override.
  userAmountCents: integer("user_amount_cents"),
  /**
   * ⚖️ What the series was worth BEFORE its amount now — dated past periods, `[{"throughOn":"2026-08-26",
   * "amountCents":104700}]` (owner decision 2026-10-08, §6A 55: his cash weeks through Aug 26 at $1,047.00, payroll
   * from Aug 27 at $1,141.92). Each past occurrence is measured against its own time's rate (`rateOn`); the rate now
   * stays `user_amount_cents`, else detection's — one home for "now". NULL = the rate has never changed.
   *
   * ⛔ JSON with no constraint: every reader goes through `parseAmountHistory`, which refuses what it cannot read in
   * exactly one way, and `pnpm ledger-check` names any history it refuses (`rateHistoryRefusals`).
   * ⚠️ An Amount edit re-prices every occurrence after the last period — a later raise needs a dated period of its
   * own. A merge keeps the target's history; the source's stays on the ended source and prices nothing.
   */
  userAmountHistory: text("user_amount_history", { mode: "json" }).$type<readonly RatePeriod[]>(),
  userCadence: text("user_cadence", { enum: CADENCES }),
  userNextExpectedOn: text("user_next_expected_on"),
  /**
   * Which category this series belongs to, when the ledger cannot say.
   *
   * Series→category is otherwise derived from POSTED rows
   * (`recurringSeriesIdsForCategory`), which is unanswerable for a commitment
   * that has not charged yet — a lease signed today posts nothing until next
   * month's statement, so its budget could never see it coming.
   *
   * ⚠️ An OVERRIDE, never a union. A series carrying this is removed from the
   * posted-row derivation entirely; otherwise it would belong to two categories
   * at once and `budgetTail` would project the whole amount into both.
   */
  userCategoryId: text("user_category_id").references(() => categories.id),
  /**
   * Last day this series can occur — a commitment with a KNOWN end.
   *
   * A 24-payment car lease is not "monthly forever"; without this it projects
   * past its final payment and every long-range forecast over-counts. Null
   * means open-ended, which is the right default for a subscription or a
   * paycheque.
   */
  userEndsOn: text("user_ends_on"),
  /**
   * ⚖️ The series this one is BILLED INSIDE — its money posts as part of that series' payment, never as a row of its
   * own (owner decision 2026-10-08, §6A 59: `Rent utilities & fees`, $182.21, is paid inside the rent — Sep 2's
   * $2,291.21 is the rent's $2,109.00 + $182.21). Its EVIDENCE is the carrier's postings (`lastSeenOn`, read through
   * `billingCarriers`): "billed with the rent, last seen Sep 2", never "never billed". Its amount, its schedule and
   * its arrears stay its own. NULL = billed on its own.
   *
   * ⚠️ One hop: the carrier's own `last_matched_on`, whatever IT is billed with. A merge of the carrier leaves this
   * naming the ended source, and the reading follows the merge to the live series (`billingCarriers`) — nothing for
   * him to repoint by hand.
   */
  userBilledWithSeriesId: text("user_billed_with_series_id").references((): AnySQLiteColumn => recurringSeries.id),
  // Set when this series is merged INTO another: it becomes `ended` and its
  // occurrences relink to the target. Detection forward-maps through this so a
  // merged-away identity is never resurrected (§4.3).
  mergedIntoId: text("merged_into_id"),
  ...timestamps(),
});
