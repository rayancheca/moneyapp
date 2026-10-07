import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { addDays, todayIso } from "@/lib/dates";
import { ledgerHref } from "@/lib/ledger-href";
import { formatDayShort } from "@/lib/format-date";
import { isPrintableName } from "@/lib/printable-name";
import { countFact, deltaFact, multipleFact, scalarFact, type Fact } from "@/lib/insight-facts";
import { outsidePortfolioCashAccountIds } from "./accounts";
import { isAgentsCostCategoryRow, loadCategoryIndex } from "./analytics";
import { insightsEnabled } from "./insight-surface";
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
 * built, invisible until then. A first sighting is the shape a new commitment
 * has.
 *
 * ⚠️ The third charge it named then was NOT one: $2,285.70 under a merchant the
 * map calls "Flamingos Restaurant" is his RENT, and the recurring series he
 * linked it to already held two earlier charges with no merchant on them, and
 * later a third. "Appears once" was true of the merchant id and false of the
 * payee. The later charge is what retires the notice, per the owner's rule —
 * see S26 in `noticesCard`.
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
  /*
   * PASS 72d — the kill switch, before any work is done rather than after.
   *
   * ⛔ A notice is an insight: same closed vocabulary, same write gate, same
   * proof. Leaving it outside the switch would mean "turn insights off" left
   * app-written prose on the dashboard, which is the one place the owner looks
   * every day. The ORDER is not selected here — newest-first is a measurement,
   * not an editorial guess, and there is nothing for a model to improve.
   */
  if (!insightsEnabled(db, "notices")) return null;
  const from = addDays(today, -NOTICE_WINDOW_DAYS);
  const idx = loadCategoryIndex(db);
  const agentsCash = outsidePortfolioCashAccountIds(db);
  const merchantNames = new Map(db.select().from(merchants).all().map((m) => [m.id, m.canonicalName]));

  /* one pass over the active rows: every notice class reads the same history */
  const byMerchant = new Map<string, { id: string; day: string; cents: number; seriesId: string | null }[]>();
  /*
   * 🔴 S26 — "APPEARS ONCE" OVER A PAYEE THE LEDGER HAD ALREADY LINKED. The
   * history above is keyed by merchant id, and a row with no merchant was never
   * read, so a merchant with one row was "seen once" even when the recurring
   * series that row belongs to held other charges. Measured on the real ledger
   * 2026-09-15: the dashboard printed "Flamingos Restaurant appears once in your
   * ledger, for $2,285.70." over his July rent, while its series "Flamingo South
   * Beach (rent)" held Jun 16 −$1,100.00 and −$1,334.80 (Venture X) and Aug 4
   * −$2,237.11 (Wells Fargo) — none carrying a merchant.
   *
   * ⛔ A series is the ledger's own identity for a payee (the drift loop below
   * already reads it). The owner's rule (2026-09-14) is that the notice goes when
   * the charge "has since posted again" — the series holds a LATER linked charge.
   * A link is the ledger's claim that the payee charged again, whatever the row
   * is filed under, so the series tally reads every active outflow linked to it,
   * filed or not. A superseded twin is not a second charge, and neither is a
   * credit. A second charge on the SAME day is not an earlier one, so it counts.
   *
   * 🔴 The first version of this fix reused the merchant history's filters
   * (categorized, expense-kind): a later rent row still uncategorized, or filed
   * under Transfers, was not counted and the notice still fired. It also counted
   * EARLIER charges alone, which the owner did not decide — earlier-only stays
   * named until he does.
   */
  const chargesBySeries = new Map<string, { id: string; day: string }[]>();
  for (const t of db.select().from(transactions).where(eq(transactions.status, "active")).all()) {
    if (t.amountCents >= 0) continue;
    if (t.recurringSeriesId !== null) {
      const linked = chargesBySeries.get(t.recurringSeriesId) ?? [];
      linked.push({ id: t.id, day: t.postedOn });
      chargesBySeries.set(t.recurringSeriesId, linked);
    }
    if (t.merchantId === null || t.categoryId === null) continue;
    if (idx.topLevelOf(t.categoryId).kind !== "expense") continue;
    // ⚖️ a merchant's history is HIS charges there: the agent's cash pays its own (owner decision 2026-10-02)
    if (isAgentsCostCategoryRow(idx, agentsCash, t)) continue;
    const list = byMerchant.get(t.merchantId) ?? [];
    list.push({ id: t.id, day: t.postedOn, cents: -t.amountCents, seriesId: t.recurringSeriesId });
    byMerchant.set(t.merchantId, list);
  }

  /*
   * 🔴 EVERY NOTICE LINKED BY NAME, AND THE NAME IS NOT IN THE ROWS. The href
   * was `/transactions?q=${canonicalName}` — but `q` is a literal LIKE over the
   * bank's own text, and a canonical name is the app's tidied version of it.
   * "Mercedes Benz of Coral Springs" against a row reading "Card Purchase 08/12
   * Mercedes Benz of Cora 183-38354662 FL Card 7782" — truncated at "Cora" —
   * matches nothing. Measured 2026-09-11: **268 of 851 merchants (31.5%) have a
   * canonical name that appears in none of their own rows**, and four of the
   * six notices live that day opened "No matching transactions" under a
   * sentence asserting the charge exists.
   *
   * ⛔ These loops hold the merchant ID. `ledgerHref({ merchant })` is exact by
   * construction and needs no text to match at all.
   */
  const candidates: Candidate[] = [];
  const prove = (id: string) => () => provenanceFor(db, { kind: "transaction", id });

  for (const [merchantId, rows] of byMerchant) {
    rows.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
    const name = merchantNames.get(merchantId);
    // see `lib/printable-name`: a merchant the app cannot name is one it cannot
    // write a notice about, and a fact constructor would throw on the dashboard
    if (name === undefined || !isPrintableName(name)) continue;

    // ── the only charge ────────────────────────────────────────────────
    const first = rows[0]!;
    // the series may know a later charge this merchant id never saw — see S26 above
    const postedAgain =
      first.seriesId !== null &&
      (chargesBySeries.get(first.seriesId) ?? []).some((c) => c.id !== first.id && c.day >= first.day);
    if (rows.length === 1 && !postedAgain && first.day >= from && first.cents >= FIRST_CHARGE_FLOOR_CENTS) {
      candidates.push({
        facts: [countFact("f1", name, 1, "charge", "in your ledger"), scalarFact("f2", name, first.cents, "money")],
        candidate: { claimId: "only_charge", a: "f1", b: "f2" },
        day: first.day,
        href: ledgerHref({ merchant: merchantId }),
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
        // the ONE charge the sentence is about, not every charge this merchant
        // ever made — the notice names a day, so the link carries it
        href: ledgerHref({ merchant: merchantId, from: row.day, to: row.day }),
        prove: prove(row.id),
      });
    }
  }

  // ── a recurring charge that posted at a different amount ─────────────
  for (const entry of driftedOccurrences(db, from, today)) {
    // a series named from raw bank text, same reason as the merchant loop above
    if (!isPrintableName(entry.name)) continue;
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
      // a series has no merchant id here; the DAY is what narrows it, and the
      // name is the series' own — which `recurringCalendar` took from the rows
      href: entry.transactionId
        ? ledgerHref({ q: entry.name, from: entry.day, to: entry.day })
        : null,
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
          // a lump is graded per payday (`lib/per-payday`), so the change it
          // states is per payday too: four weeks at $1,200.00 rose $58.08 a week,
          // not $3,658.08 against one
          amountCents: entry.perPayday?.cents ?? entry.amountCents,
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
