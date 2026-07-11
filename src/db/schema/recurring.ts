import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
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
  nextExpectedAmountCents: integer("next_expected_amount_cents"),
  status: text("status", { enum: SERIES_STATUSES }).notNull().default("detected"),
  confidence: real("confidence"),
  lastMatchedOn: text("last_matched_on"),
  // User overrides (ux-overhaul-plan §4.4): detection keeps writing its own
  // columns above; the UI and the forecast read user-first. Null = no override.
  userAmountCents: integer("user_amount_cents"),
  userCadence: text("user_cadence", { enum: CADENCES }),
  userNextExpectedOn: text("user_next_expected_on"),
  // Set when this series is merged INTO another: it becomes `ended` and its
  // occurrences relink to the target. Detection forward-maps through this so a
  // merged-away identity is never resurrected (§4.3).
  mergedIntoId: text("merged_into_id"),
  ...timestamps(),
});
