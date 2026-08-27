import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { addDays, todayIso } from "@/lib/dates";
import { formatDayShort } from "@/lib/format-date";
import { countFact, deltaFact, multipleFact, scalarFact, type Fact } from "@/lib/insight-facts";
import { loadCategoryIndex } from "./analytics";
import { runInsights, type InsightCandidate } from "./insights";
import { provenanceFor, type Provenance } from "./provenance";
import { recurringCalendar } from "./recurring-calendar";

/**
 * PASS 69 — neutral notices. Things that happened, described and never judged.
 *
 * ⛔ **Neutral wording is the whole design, and it is not a style preference.**
 * The owner travels and drives an EV; three charges once flagged as
 * "card-testing probes" were every one of them legitimate. A notice that
 * accused would be wrong about him personally. So every sentence here goes
 * through the same closed vocabulary as every other insight, which carries a
 * sweep test refusing "should", "unusual", "suspicious" and the rest — the
 * neutrality is enforced by a test rather than by good intentions.
 *
 * ## What was measured, and what was cut
 *
 * The pass asked for three notice classes. All three were measured against the
 * real ledger before any of them was built:
 *
 *   a charge far above a merchant's own median   19 in 2026 at 4×
 *   a first charge at a new merchant              6 in 2026 above $500
 *   a recurring charge that posted differently    2 ever
 *
 * ⚠️ At 4× the outlier notice is NOISE. Apple at 27× its median means he bought
 * a device instead of an app; Target at 21× means a big shop instead of a
 * sandwich. Two or three a month of "you spent more than usual" tells him
 * nothing he does not know, and dressing it as notable is the card-testing
 * mistake in a new costume. It survives only at **8× AND $100**, which fires
 * twice in ninety days.
 *
 * The first-charge notice turned out to be the valuable one, and not for the
 * reason the pass expected: over ninety days it names his car insurance's first
 * payment, HBO Max — the annual subscription he asked about on the day this was
 * built, invisible until then — and a $2,285.70 charge the merchant map calls
 * "Flamingos Restaurant", which is his RENT. A first sighting is the shape a
 * new commitment has.
 */

/** How far back a notice can be and still be news. */
export const NOTICE_WINDOW_DAYS = 90;

/** At least this many sightings before a merchant has a "usual" worth comparing to. */
export const MIN_VISITS_FOR_USUAL = 6;

/** A charge must be this many times the usual AND this large to be worth a line. */
export const OUTLIER_MULTIPLE = 8;
export const OUTLIER_FLOOR_CENTS = 10_000;

/** A first charge must be at least this large — every merchant has a first one. */
export const FIRST_CHARGE_FLOOR_CENTS = 20_000;

/** Most notices a card will show. */
export const MAX_NOTICES = 6;

export interface Notice {
  id: string;
  /** the sentence, rendered by the app from its own vocabulary */
  text: string;
  claimId: string;
  day: string;
  dayLabel: string;
  provenance: Provenance;
  /** where the reader goes to see it for themselves */
  href: string | null;
}

export interface NoticesCard {
  fromLabel: string;
  notices: Notice[];
  /**
   * What was looked at, so an empty card is a measurement rather than a shrug.
   * ⛔ "Nothing to report" and "nothing was checked" are different sentences and
   * this app has confused them in four services already.
   */
  summary: string;
}

interface Candidate {
  facts: Fact[];
  candidate: Omit<InsightCandidate, "prove">;
  day: string;
  href: string | null;
  prove: () => Provenance | null;
}

export function noticesCard(db: AppDatabase, today: string = todayIso()): NoticesCard | null {
  const from = addDays(today, -NOTICE_WINDOW_DAYS);
  const idx = loadCategoryIndex(db);
  const merchantNames = new Map(db.select().from(merchants).all().map((m) => [m.id, m.canonicalName]));

  /* one pass over the active rows: every notice class reads the same history */
  const byMerchant = new Map<string, { id: string; day: string; cents: number }[]>();
  for (const t of db.select().from(transactions).where(eq(transactions.status, "active")).all()) {
    if (t.merchantId === null || t.categoryId === null || t.amountCents >= 0) continue;
    if (idx.topLevelOf(t.categoryId).kind !== "expense") continue;
    const list = byMerchant.get(t.merchantId) ?? [];
    list.push({ id: t.id, day: t.postedOn, cents: -t.amountCents });
    byMerchant.set(t.merchantId, list);
  }

  const candidates: Candidate[] = [];
  const prove = (id: string) => () => provenanceFor(db, { kind: "transaction", id });

  for (const [merchantId, rows] of byMerchant) {
    rows.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
    const name = merchantNames.get(merchantId);
    if (name === undefined) continue;

    // ── the only charge ────────────────────────────────────────────────
    const first = rows[0]!;
    if (rows.length === 1 && first.day >= from && first.cents >= FIRST_CHARGE_FLOOR_CENTS) {
      candidates.push({
        facts: [countFact("f1", name, 1, "charge"), scalarFact("f2", name, first.cents, "money")],
        candidate: { claimId: "only_charge", a: "f1", b: "f2" },
        day: first.day,
        href: `/transactions?q=${encodeURIComponent(name)}`,
        prove: prove(first.id),
      });
    }

    // ── far above this merchant's own usual ────────────────────────────
    if (rows.length < MIN_VISITS_FOR_USUAL) continue;
    const usual = medianCents(rows.map((r) => r.cents));
    // a median at or below zero is not a magnitude to divide by — it happens
    // when refunds outweigh charges, and `multipleFact` would throw on it
    if (usual <= 0) continue;
    for (const row of rows) {
      if (row.day < from || row.cents < OUTLIER_FLOOR_CENTS || row.cents < OUTLIER_MULTIPLE * usual) continue;
      candidates.push({
        facts: [
          multipleFact("f1", `The ${name} charge on ${formatDayShort(row.day)}`, row.cents / usual, "what you usually pay there"),
        ],
        candidate: { claimId: "times_the_usual", a: "f1" },
        day: row.day,
        href: `/transactions?q=${encodeURIComponent(name)}`,
        prove: prove(row.id),
      });
    }
  }

  // ── a recurring charge that posted at a different amount ─────────────
  for (const entry of driftedOccurrences(db, from, today)) {
    /*
     * ⛔ MAGNITUDES, not signed amounts. A bill is stored negative, so his rent
     * posting $1,100.00 against an expected $2,285.70 gives a signed difference
     * of **+$1,185.70** — and the first build of this printed "rose by
     * +$1,185.70" over a month he paid LESS. Caught by reading the output, not
     * by any gate: the vocabulary guarantees the sentence matches the fact, and
     * it can say nothing about whether the fact matches the world.
     */
    const drift = Math.abs(entry.amountCents) - Math.abs(entry.expectedCents);
    candidates.push({
      facts: [deltaFact("f1", entry.name, drift, "money", "its usual amount", formatDayShort(entry.day))],
      candidate: { claimId: drift > 0 ? "rose_between" : "fell_between", a: "f1" },
      day: entry.day,
      href: entry.transactionId ? `/transactions?q=${encodeURIComponent(entry.name)}` : null,
      prove: entry.transactionId ? prove(entry.transactionId) : () => null,
    });
  }

  /*
   * Newest first. A notice is news, and the oldest thing in a ninety-day window
   * is the least of it — so a cap that has to drop some drops those.
   */
  candidates.sort((a, b) => b.day.localeCompare(a.day));

  const notices: Notice[] = [];
  for (const c of candidates) {
    if (notices.length >= MAX_NOTICES) break;
    const built = runInsights(c.facts, [{ ...c.candidate, prove: c.prove }], { label: c.day });
    // the claim's own predicate refused it, or it could not be proved
    if (built === null) continue;
    const insight = built.insights[0]!;
    notices.push({
      id: `${c.candidate.claimId}:${c.day}:${insight.text}`,
      text: insight.text,
      claimId: insight.claimId,
      day: c.day,
      dayLabel: formatDayShort(c.day),
      provenance: insight.provenance,
      href: c.href,
    });
  }

  if (notices.length === 0) return null;
  return {
    fromLabel: formatDayShort(from),
    notices,
    summary:
      `Charges since ${formatDayShort(from)} that stand out from the rest of your own history — a first ` +
      `sighting at a merchant, a charge well above what you usually pay there, or a recurring bill that ` +
      `posted at a different amount. Each is a description, not a verdict.`,
  };
}

/**
 * The middle value, rounded to a whole cent.
 *
 * ⚠️ An even-length list's median is the mean of two, which is a half-cent as
 * often as not — and `formatCents` REFUSES a fractional cent rather than
 * rendering one. Found by a probe throwing `Invalid cents value: 2012.5`.
 */
export function medianCents(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

interface Drifted {
  name: string;
  day: string;
  amountCents: number;
  expectedCents: number;
  transactionId: string | null;
}

/**
 * Recurring occurrences that posted at an amount the series did not expect.
 *
 * ⛔ Read from `recurringCalendar`, never re-derived. Its `paid_different` state
 * is the app's ONE definition of "the price changed", it is the state the
 * calendar already paints amber, and a second implementation here would be a
 * second opinion about whether a bill moved. This is also the first rendered
 * consumer that state has ever had outside the calendar itself.
 */
function driftedOccurrences(db: AppDatabase, from: string, today: string): Drifted[] {
  const out: Drifted[] = [];
  const seen = new Set<string>();
  // walk the months the window touches, newest last so `seen` keeps the newest
  for (const month of monthsBetween(from, today)) {
    for (const [day, entries] of Object.entries(recurringCalendar(db, month, today).entriesByDay)) {
      if (day < from || day > today) continue;
      for (const entry of entries) {
        if (entry.state !== "paid_different" || entry.expectedAmountCents === null) continue;
        const key = `${entry.seriesId}:${day}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          name: entry.name,
          day,
          amountCents: entry.amountCents,
          expectedCents: entry.expectedAmountCents,
          transactionId: entry.transactionId,
        });
      }
    }
  }
  return out;
}

/** Every "YYYY-MM" the window touches, in order. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (let guard = 0; guard < 24; guard += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    months.push(key);
    if (key >= last) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}
