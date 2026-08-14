import { and, desc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import {
  recurringSeries,
  type Cadence,
  type SeriesKind,
  type SeriesStatus,
} from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { isValidIsoDate, todayIso } from "@/lib/dates";
import { stepFrom, stepPlan } from "@/lib/recurring-step";
import {
  annualizedCentsOf,
  effectiveSeries,
  isSeriesActive,
  projectOccurrences,
  rollForwardNextExpected,
  toProjectable,
  type SeriesOccurrence,
} from "./recurring";

/**
 * Series-detail read + write services (ux-overhaul-plan §4.2). The detail page
 * closes the merchant⇄category chain, exposes the detected statistics as
 * editable user overrides, and hosts the attach / merge / detach flows whose
 * transactional core already lives in recurring-links.ts.
 */

export interface SeriesLinkedTxn {
  id: string;
  postedOn: string;
  amountCents: number;
  description: string;
  accountName: string;
  /** who owns this link: detection, the user, or (defensively) neither */
  linkSource: "detected" | "user" | null;
}

export interface AmountHistoryPoint {
  date: string;
  amountCents: number;
}

export interface SeriesCategoryRef {
  id: string;
  name: string;
  hue: string | null;
  icon: string | null;
}

export interface SeriesMergeCandidate {
  id: string;
  name: string;
  kind: SeriesKind;
}

export interface SeriesDetail {
  id: string;
  name: string;
  kind: SeriesKind;
  status: SeriesStatus;
  merchant: { id: string; name: string } | null;
  /** set when this series was merged away — its editing is closed, it links on */
  mergedInto: { id: string; name: string } | null;
  /** modal category of the linked charges — the chain's other end */
  category: SeriesCategoryRef | null;
  accountName: string | null;
  // effective (override-first) values the sentence reads
  cadence: Cadence;
  /** rolled forward off a stale stored value — never a date in the past */
  nextExpectedOn: string | null;
  /** the un-rolled stored value, so the UI can distinguish shown from saved */
  storedNextExpectedOn: string | null;
  nextExpectedAmountCents: number | null;
  // the raw override columns, so the UI can show "detected: X" and offer reset
  userCadence: Cadence | null;
  userNextExpectedOn: string | null;
  userAmountCents: number | null;
  // detected statistics
  detectedCadence: Cadence;
  detectedNextExpectedOn: string | null;
  amountCentsAvg: number | null;
  amountCentsStddev: number | null;
  intervalDaysAvg: number | null;
  toleranceDays: number;
  confidence: number | null;
  lastMatchedOn: string | null;
  isActive: boolean;
  annualizedCents: number | null;
  /** the next few projected occurrences (override-aware) */
  nextExpected: SeriesOccurrence[];
  /** full linked history, newest first */
  linkedTxns: SeriesLinkedTxn[];
  /** linked charge amounts oldest → newest, for the drift chart */
  amountHistory: AmountHistoryPoint[];
  /** other live series this one can merge in */
  mergeCandidates: SeriesMergeCandidate[];
}

interface CatRow {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  icon: string | null;
}

/** Modal category id of the linked rows — the one the chain points back to. */
function modalCategory(
  linked: readonly { categoryId: string | null }[],
  catById: ReadonlyMap<string, CatRow>,
): SeriesCategoryRef | null {
  const counts = new Map<string, number>();
  for (const t of linked) {
    if (t.categoryId === null) continue;
    counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
  }
  const modalId = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];
  if (!modalId) return null;
  const cat = catById.get(modalId);
  if (!cat) return null;
  const parent = cat.parentId ? catById.get(cat.parentId) : undefined;
  return {
    id: cat.id,
    name: cat.name,
    hue: cat.color ?? parent?.color ?? null,
    icon: cat.icon ?? parent?.icon ?? null,
  };
}

const NEXT_EXPECTED_COUNT = 3;

export function seriesDetail(
  db: AppDatabase,
  seriesId: string,
  today: string = todayIso(),
): SeriesDetail {
  const s = db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get();
  if (!s) throw new Error(`Unknown recurring series ${seriesId}`);

  const merchant = s.merchantId
    ? db
        .select({ id: merchants.id, name: merchants.canonicalName })
        .from(merchants)
        .where(eq(merchants.id, s.merchantId))
        .get() ?? null
    : null;

  const accountName = s.accountId
    ? db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, s.accountId)).get()?.name ??
      null
    : null;

  const mergedInto = s.mergedIntoId
    ? db
        .select({ id: recurringSeries.id, name: recurringSeries.name })
        .from(recurringSeries)
        .where(eq(recurringSeries.id, s.mergedIntoId))
        .get() ?? null
    : null;

  // full linked history (active rows), newest first
  const linked = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      description: sql<string>`coalesce(nullif(${transactions.normalizedDescription}, ''), ${transactions.rawDescription})`,
      categoryId: transactions.categoryId,
      linkSource: transactions.seriesLinkSource,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(eq(transactions.recurringSeriesId, seriesId), eq(transactions.status, "active")))
    .orderBy(desc(transactions.postedOn), desc(transactions.amountCents), desc(transactions.id))
    .all();

  const catById = new Map<string, CatRow>(
    db
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        color: categories.color,
        icon: categories.icon,
      })
      .from(categories)
      .all()
      .map((c) => [c.id, c]),
  );

  const linkedTxns: SeriesLinkedTxn[] = linked.map((t) => ({
    id: t.id,
    postedOn: t.postedOn,
    amountCents: t.amountCents,
    description: t.description,
    accountName: t.accountName,
    linkSource: t.linkSource,
  }));
  const amountHistory: AmountHistoryPoint[] = [...linked]
    .reverse()
    .map((t) => ({ date: t.postedOn, amountCents: t.amountCents }));

  const eff = effectiveSeries(s);
  // Size the projection window off the series' own step so even a long-interval
  // annual series reaches NEXT_EXPECTED_COUNT occurrences: the first can land up
  // to one whole step out, so (count+1) steps covers count of them with slack.
  // Stepped by the SAME plan the projection walks, or a calendar-monthly series
  // whose months run long could have its last occurrence fall outside a window
  // sized in 30-day units.
  const nextExpected = projectOccurrences(
    toProjectable(s),
    today,
    stepFrom(today, stepPlan(eff.cadence, eff.intervalDaysAvg), NEXT_EXPECTED_COUNT + 1),
  ).slice(0, NEXT_EXPECTED_COUNT);

  const mergeCandidates: SeriesMergeCandidate[] = db
    .select({ id: recurringSeries.id, name: recurringSeries.name, kind: recurringSeries.kind })
    .from(recurringSeries)
    .where(
      and(
        ne(recurringSeries.id, seriesId),
        isNull(recurringSeries.mergedIntoId),
        or(eq(recurringSeries.status, "detected"), eq(recurringSeries.status, "confirmed")),
      ),
    )
    .orderBy(recurringSeries.name)
    .all();

  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    status: s.status,
    merchant,
    mergedInto,
    category: modalCategory(linked, catById),
    accountName,
    cadence: eff.cadence,
    // Same rule as listSeries: the detail page must not show a date in the past
    // as "next" while the list shows the rolled-forward one. Only the statuses
    // the forecast actually projects roll — rolling a dismissed/ended series
    // forward would invent a future charge.
    nextExpectedOn:
      s.status === "detected" || s.status === "confirmed"
        ? rollForwardNextExpected(eff, today)
        : eff.nextExpectedOn,
    storedNextExpectedOn: eff.nextExpectedOn,
    nextExpectedAmountCents: eff.nextExpectedAmountCents,
    userCadence: s.userCadence,
    userNextExpectedOn: s.userNextExpectedOn,
    userAmountCents: s.userAmountCents,
    detectedCadence: s.cadence,
    detectedNextExpectedOn: s.nextExpectedOn,
    amountCentsAvg: s.amountCentsAvg,
    amountCentsStddev: s.amountCentsStddev,
    intervalDaysAvg: s.intervalDaysAvg,
    toleranceDays: s.toleranceDays,
    confidence: s.confidence,
    lastMatchedOn: s.lastMatchedOn,
    isActive: isSeriesActive(s, today),
    annualizedCents: annualizedCentsOf(eff),
    nextExpected,
    linkedTxns,
    amountHistory,
    mergeCandidates,
  };
}

export interface AttachCandidate {
  id: string;
  postedOn: string;
  amountCents: number;
  description: string;
  accountName: string;
}

/** Default amount-window half-width when no text query narrows the search. */
const ATTACH_AMOUNT_BAND_PCT = 0.15;
const ATTACH_AMOUNT_BAND_FLOOR_CENTS = 500;
const ATTACH_LIMIT = 25;

/**
 * Unlinked (recurring_series_id IS NULL), non-future active rows a user could
 * attach to this series (§4.2 "Find transactions"). A text query matches the
 * description (LIKE wildcards escaped); with no query the search falls back to
 * an amount window around the series' expected charge so the list is relevant
 * rather than the whole ledger. Rows already linked anywhere are excluded — an
 * attach re-homes nothing behind the user's back.
 */
export function searchAttachCandidates(
  db: AppDatabase,
  seriesId: string,
  query: string,
  today: string = todayIso(),
  limit: number = ATTACH_LIMIT,
): AttachCandidate[] {
  const s = db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).get();
  if (!s) throw new Error(`Unknown recurring series ${seriesId}`);

  const conds = [
    eq(transactions.status, "active"),
    isNull(transactions.recurringSeriesId),
    lte(transactions.postedOn, today),
  ];

  const q = query.trim();
  if (q !== "") {
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    const clause = or(
      sql`${transactions.rawDescription} LIKE ${pattern} ESCAPE '\\'`,
      sql`${transactions.normalizedDescription} LIKE ${pattern} ESCAPE '\\'`,
    );
    if (clause) conds.push(clause);
  } else {
    const expected = effectiveSeries(s).nextExpectedAmountCents;
    if (expected !== null) {
      const band = Math.max(
        ATTACH_AMOUNT_BAND_FLOOR_CENTS,
        Math.round(Math.abs(expected) * ATTACH_AMOUNT_BAND_PCT),
      );
      conds.push(sql`${transactions.amountCents} >= ${expected - band}`);
      conds.push(sql`${transactions.amountCents} <= ${expected + band}`);
    }
  }

  return db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      amountCents: transactions.amountCents,
      description: sql<string>`coalesce(nullif(${transactions.normalizedDescription}, ''), ${transactions.rawDescription})`,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...conds))
    .orderBy(desc(transactions.postedOn), desc(transactions.amountCents), desc(transactions.id))
    .limit(limit)
    .all();
}

export interface SeriesOverridesInput {
  /** undefined = leave unchanged; null = clear the override (use detected) */
  userCadence?: Cadence | null;
  userAmountCents?: number | null;
  userNextExpectedOn?: string | null;
}

/** Writes user overrides (§4.4). Detection keeps its own columns; the UI reads user-first. */
export function setSeriesOverrides(
  db: AppDatabase,
  seriesId: string,
  input: SeriesOverridesInput,
): void {
  const patch: Partial<typeof recurringSeries.$inferInsert> = {};
  if ("userCadence" in input) patch.userCadence = input.userCadence ?? null;
  if ("userAmountCents" in input) patch.userAmountCents = input.userAmountCents ?? null;
  if ("userNextExpectedOn" in input) {
    // a calendar-invalid date would poison every future projection — reject it
    // here too, not only at the zod boundary (the service must not trust callers)
    if (input.userNextExpectedOn != null && !isValidIsoDate(input.userNextExpectedOn)) {
      throw new Error(`Invalid next-expected date: ${input.userNextExpectedOn}`);
    }
    patch.userNextExpectedOn = input.userNextExpectedOn ?? null;
  }
  if (Object.keys(patch).length === 0) return;
  const res = db.update(recurringSeries).set(patch).where(eq(recurringSeries.id, seriesId)).run();
  if (res.changes === 0) throw new Error(`Unknown recurring series ${seriesId}`);
}

/** Renames a series (a user-visible label; does not affect grouping). */
export function renameSeries(db: AppDatabase, seriesId: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("Series name cannot be empty");
  const res = db
    .update(recurringSeries)
    .set({ name: trimmed })
    .where(eq(recurringSeries.id, seriesId))
    .run();
  if (res.changes === 0) throw new Error(`Unknown recurring series ${seriesId}`);
  return trimmed;
}
