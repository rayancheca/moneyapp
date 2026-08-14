import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
  // Set when this series is merged INTO another: it becomes `ended` and its
  // occurrences relink to the target. Detection forward-maps through this so a
  // merged-away identity is never resurrected (§4.3).
  mergedIntoId: text("merged_into_id"),
  ...timestamps(),
});
