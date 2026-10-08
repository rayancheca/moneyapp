/**
 * The guarded write of the owner's decision 59 (2026-10-08, §6A 59): `Rent utilities & fees` ($182.21 a month) is
 * paid INSIDE the rent payment — Sep 2's $2,291.21 is the rent's $2,109.00 + $182.21, and the payments before it
 * ($2,237.11 Aug 4, $2,285.70 Jul 8, $1,100.00 + $1,334.80 Jun 16) carried it too:
 *
 *   recurring_series.user_billed_with_series_id = '019f72f5-055f-7000-a3ef-2ac408a6044b'   (Flamingo South Beach (rent))
 *
 * 🔴 Measured on a copy of his ledger, 2026-10-08: the series has never had a posting linked, so it read "never
 * billed" everywhere that says so — the Subscriptions card's "$477.90 of the figure above — 12.5% of it — has never
 * been billed by a bank", /recurring's "$651.07 never billed", the All tab's Never billed section, the calendar and its
 * own page — of money the bank takes every month inside the rent. The code that reads the link (`billingCarriers`,
 * `lastSeenOn`) is on main; this is the ledger's half.
 *
 * The runner is `scripts/link-utilities-to-rent-2026-10-08.ts`; this module is what it decides and checks, so the
 * test can hold every guard to his ledger's shape.
 *
 * ⛔ Refused unless both series are exactly as measured — the utilities: id and name, a confirmed monthly bill at his
 * -$182.21, no posting of its own, no link; the rent: id and name, a confirmed monthly bill at his -$2,109.00, billed
 * with nothing itself — with exactly the five rent payments he named linked to the rent (ids, days, amounts). A link
 * equal to this one is ALREADY APPLIED, read before the row guards: a rent payment linked later does not make a re-run
 * refuse. Any other link is never overwritten.
 *
 * ⛔ After the write — on the rehearsal copy and on the ledger — exactly one series row differs, in exactly two columns
 * (`user_billed_with_series_id`, `updated_at`); every transaction, every daily balance and the status counts are
 * identical; the utilities read exactly the rent's evidence, and "billed with the rent, last seen Sep 2" on the
 * Subscriptions card; the card's never-billed figure falls by exactly its $182.21 and its headline holds; and his
 * amount, the forecast (every line, every total, the next 400 days of occurrences), the arrears and the committed
 * book's money are identical to the cent.
 */
import { eq, inArray } from "drizzle-orm";
import type { DbBundle } from "@/db/client";
import { recurringSeries } from "@/db/schema/recurring";
import { formatCents } from "@/lib/money";
import { arrearsThisMonth } from "@/services/arrears";
import { committedBook } from "@/services/committed";
import { forecastCurrentMonth } from "@/services/forecast";
import { listSeries, upcomingOccurrences } from "@/services/recurring";
import { subscriptionsCard } from "@/services/subscriptions-card";
import { balancesHash, changedKeys, sha256Json, statusCounts } from "./guarded-write-harness";

export const SNAPSHOT_LABEL = "link-utilities-to-rent";

/** The commitment billed inside the rent, as his ledger stores it on 2026-10-08. */
export const UTILITIES = {
  id: "01a05909-a688-7000-9898-39563628004d",
  name: "Rent utilities & fees",
  amountCents: -18_221,
} as const;

/** The rent it is paid inside — the carrier. */
export const RENT = {
  id: "019f72f5-055f-7000-a3ef-2ac408a6044b",
  name: "Flamingo South Beach (rent)",
  amountCents: -210_900,
} as const;

/** ⚖️ The five rent payments he named (decision 59): each carried the utilities. Linked to the rent, all active. */
export const PAYMENTS = [
  { id: "019f6801-95ab-7007-aaff-3a7bad5e7aab", postedOn: "2026-06-16", amountCents: -110_000 },
  { id: "019f6801-95ab-7008-a9fd-949c52e8aa20", postedOn: "2026-06-16", amountCents: -133_480 },
  { id: "019f4ca7-a6c0-7b26-b6cc-7da242413677", postedOn: "2026-07-08", amountCents: -228_570 },
  { id: "01a03f46-db0a-7000-a19b-aba68b185a8d", postedOn: "2026-08-04", amountCents: -223_711 },
  { id: "01a0e898-c5ca-7001-94fd-7fa1b967780f", postedOn: "2026-09-02", amountCents: -229_121 },
] as const;

/** What the card's line reads once written: the rent's newest payment, Sep 2 (`billedWithLabel`). */
export const LABEL_PREFIX = "billed with the rent, last seen Sep 2";

interface SeriesFact {
  id: string;
  name: string;
  kind: string;
  cadence: string;
  userCadence: string | null;
  status: string;
  userAmountCents: number | null;
  lastMatchedOn: string | null;
  link: string | null;
}

interface RowFact {
  id: string;
  postedOn: string;
  amountCents: number;
  status: string;
  seriesId: string | null;
  seriesName: string | null;
}

export interface Facts {
  /** whether migration 0026 has added `user_billed_with_series_id` (createDatabase applies it on open) */
  hasColumn: boolean;
  utilities: SeriesFact | undefined;
  rent: SeriesFact | undefined;
  /** the five, by id — those this ledger has */
  payments: ReadonlyMap<string, RowFact>;
  /** every OTHER active row linked to the rent */
  otherPayments: readonly RowFact[];
  /** every active row linked to the utilities — there must be none */
  ownRows: readonly RowFact[];
}

export type Verdict = { kind: "plan" } | { kind: "applied" } | { kind: "refuse"; reasons: string[] };

const ROW_SQL = `
  SELECT t.id, t.posted_on AS postedOn, t.amount_cents AS amountCents, t.status, t.recurring_series_id AS seriesId,
         s.name AS seriesName
    FROM transactions t LEFT JOIN recurring_series s ON s.id = t.recurring_series_id`;

export function loadFacts(bundle: DbBundle): Facts {
  const columns = bundle.sqlite.prepare("PRAGMA table_info(recurring_series)").all() as { name: string }[];
  const hasColumn = columns.some((c) => c.name === "user_billed_with_series_id");
  const rowStmt = bundle.sqlite.prepare(`${ROW_SQL} WHERE t.id = ?`);
  const payments = new Map<string, RowFact>();
  for (const want of PAYMENTS) {
    const fact = rowStmt.get(want.id) as RowFact | undefined;
    if (fact !== undefined) payments.set(want.id, fact);
  }
  const five = PAYMENTS.map(() => "?").join(", ");
  const otherPayments = bundle.sqlite
    .prepare(
      `${ROW_SQL} WHERE t.recurring_series_id = ? AND t.status = 'active' AND t.id NOT IN (${five})
        ORDER BY t.posted_on, t.id`,
    )
    .all(RENT.id, ...PAYMENTS.map((p) => p.id)) as RowFact[];
  const ownRows = bundle.sqlite
    .prepare(`${ROW_SQL} WHERE t.recurring_series_id = ? AND t.status = 'active' ORDER BY t.posted_on, t.id`)
    .all(UTILITIES.id) as RowFact[];
  if (!hasColumn) return { hasColumn, utilities: undefined, rent: undefined, payments, otherPayments, ownRows };

  const rows = bundle.db
    .select({
      id: recurringSeries.id,
      name: recurringSeries.name,
      kind: recurringSeries.kind,
      cadence: recurringSeries.cadence,
      userCadence: recurringSeries.userCadence,
      status: recurringSeries.status,
      userAmountCents: recurringSeries.userAmountCents,
      lastMatchedOn: recurringSeries.lastMatchedOn,
      link: recurringSeries.userBilledWithSeriesId,
    })
    .from(recurringSeries)
    .where(inArray(recurringSeries.id, [UTILITIES.id, RENT.id]))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { hasColumn, utilities: byId.get(UTILITIES.id), rent: byId.get(RENT.id), payments, otherPayments, ownRows };
}

const refuse = (reasons: string[]): Verdict => ({ kind: "refuse", reasons });

export function classify(facts: Facts): Verdict {
  if (!facts.hasColumn) {
    const missing = "recurring_series.user_billed_with_series_id does not exist";
    return refuse([`${missing} — migration 0026_series_billed_with not run`]);
  }
  const u = facts.utilities;
  if (u === undefined) return refuse([`${UTILITIES.id} (${UTILITIES.name}): not in this ledger`]);

  // ⛔ before the row guards: once written, a rent payment linked later must not make a re-run refuse
  if (u.link === RENT.id) return { kind: "applied" };
  if (u.link !== null) return refuse([`${UTILITIES.name}: already billed with ${u.link} — never overwritten`]);

  const posted = `${UTILITIES.name}: last matched ${u.lastMatchedOn} — it was measured never posted`;
  const reasons = [
    ...seriesReasons(u, UTILITIES),
    ...(u.lastMatchedOn === null ? [] : [posted]),
    ...facts.ownRows.map((r) => `${r.id}: ${r.postedOn} ${formatCents(r.amountCents)} is linked to ${UTILITIES.name}`),
  ];
  const r = facts.rent;
  if (r === undefined) reasons.push(`${RENT.id} (${RENT.name}): not in this ledger`);
  else {
    reasons.push(...seriesReasons(r, RENT));
    if (r.link !== null) reasons.push(`${RENT.name}: billed with ${r.link} itself — a carrier carries, one hop`);
  }
  reasons.push(...paymentReasons(facts));
  return reasons.length > 0 ? refuse(reasons) : { kind: "plan" };
}

function seriesReasons(s: SeriesFact, want: { id: string; name: string; amountCents: number }): string[] {
  const reasons: string[] = [];
  const cadence = s.userCadence ?? s.cadence;
  if (s.name !== want.name) reasons.push(`${want.id}: named "${s.name}", not "${want.name}"`);
  if (s.kind !== "bill") reasons.push(`${want.name}: a ${s.kind} series, not a bill`);
  if (cadence !== "monthly") reasons.push(`${want.name}: ${cadence}, not monthly`);
  if (s.status !== "confirmed") reasons.push(`${want.name}: ${s.status}, not confirmed`);
  if (s.userAmountCents !== want.amountCents) {
    const now = s.userAmountCents === null ? "not set" : formatCents(s.userAmountCents);
    reasons.push(`${want.name}: his amount is ${now}, not ${formatCents(want.amountCents)}`);
  }
  return reasons;
}

function paymentReasons(facts: Facts): string[] {
  const reasons: string[] = [];
  for (const want of PAYMENTS) {
    const f = facts.payments.get(want.id);
    if (f === undefined) {
      reasons.push(`${want.id}: not in this ledger`);
      continue;
    }
    if (f.status !== "active") reasons.push(`${want.id}: ${f.status}, not active`);
    if (f.postedOn !== want.postedOn || f.amountCents !== want.amountCents) {
      const wanted = `${want.postedOn} ${formatCents(want.amountCents)}`;
      reasons.push(`${want.id}: ${f.postedOn} ${formatCents(f.amountCents)}, not ${wanted}`);
    }
    if (f.seriesId !== RENT.id) {
      reasons.push(`${want.id}: attached to ${f.seriesName ?? "no series"}, not ${RENT.name}`);
    }
  }
  for (const o of facts.otherPayments) {
    const row = `${o.postedOn} ${formatCents(o.amountCents)}`;
    reasons.push(`${o.id}: ${row} is linked to ${RENT.name} too — it was measured with five payments`);
  }
  return reasons;
}

/** The ONE statement this write runs — over NULL only, so a link stored meanwhile is never overwritten. */
export function applyLink(bundle: DbBundle): void {
  const written = bundle.sqlite
    .prepare(
      `UPDATE recurring_series SET user_billed_with_series_id = ?, updated_at = ?
        WHERE id = ? AND user_billed_with_series_id IS NULL`,
    )
    .run(RENT.id, new Date().toISOString(), UTILITIES.id).changes;
  if (written !== 1) {
    throw new Error(`${UTILITIES.id}: not written — the series is gone, or its link is no longer NULL`);
  }
}

/** What the owner reads off the write, and what must not move. */
export interface Figures {
  /** the Subscriptions card: its never-billed figure, its headline, and the utilities' line */
  neverBilledCents: number | null;
  liveMonthlyCents: number | null;
  line: { neverBilled: boolean; billedWithLabel: string | null; monthlyCents: number } | null;
  /** the evidence word of each, as the All tab files them */
  utilitiesEvidence: string | null;
  rentEvidence: string | null;
  /** ⛔ must not move: the forecast (lines and totals), 400 days of occurrences, the arrears, the committed money */
  money: string;
  /** the committed book's "not charged yet" money, and the utilities' own committed line in it */
  unevidencedCents: number;
  utilitiesCommittedCents: number;
}

function figuresOf(bundle: DbBundle, today: string): Figures {
  const card = subscriptionsCard(bundle.db, today);
  const line = card === null ? undefined : [...card.live, ...card.lapsed].find((l) => l.seriesId === UTILITIES.id);
  const listed = listSeries(bundle.db, today);
  const forecast = forecastCurrentMonth(bundle.db, today);
  const live = new Set(listed.filter((s) => s.status === "detected" || s.status === "confirmed").map((s) => s.id));
  const book = committedBook(bundle.db, today);
  return {
    neverBilledCents: card?.neverBilledMonthlyCents ?? null,
    liveMonthlyCents: card?.liveMonthlyCents ?? null,
    line:
      line === undefined
        ? null
        : { neverBilled: line.neverBilled, billedWithLabel: line.billedWithLabel, monthlyCents: line.monthlyCents },
    utilitiesEvidence: listed.find((s) => s.id === UTILITIES.id)?.evidence ?? null,
    rentEvidence: listed.find((s) => s.id === RENT.id)?.evidence ?? null,
    money: sha256Json({
      lines: forecast.components.map((c) => [c.label, c.kind, c.cents, c.detail]),
      totals: [forecast.projectedSpendCents, forecast.projectedIncomeCents],
      occurrences: upcomingOccurrences(bundle.db, today, 400).map((o) => [o.seriesId, o.date, o.amountCents]),
      arrears: arrearsThisMonth(bundle.db, live, today),
      committed: [
        book.totalCents,
        book.overdueCents,
        book.lines.map((l) => [l.seriesId, l.totalCents, l.overdueCents]),
      ],
    }),
    unevidencedCents: book.unevidencedCents,
    utilitiesCommittedCents: book.lines.find((l) => l.seriesId === UTILITIES.id)?.totalCents ?? 0,
  };
}

export interface WriteState {
  transactions: string;
  balances: string;
  statuses: string;
  /** every series row, by id, as JSON */
  series: ReadonlyMap<string, string>;
  /** the utilities' row, column by column */
  utilities: Readonly<Record<string, unknown>> | undefined;
  figures: Figures;
}

export function captureState(bundle: DbBundle, today: string): WriteState {
  const seriesRows = bundle.sqlite
    .prepare("SELECT * FROM recurring_series ORDER BY id")
    .all() as Record<string, unknown>[];
  return {
    transactions: sha256Json(bundle.sqlite.prepare("SELECT * FROM transactions ORDER BY id").all()),
    balances: balancesHash(bundle),
    statuses: statusCounts(bundle),
    series: new Map(seriesRows.map((r) => [r.id as string, JSON.stringify(r)])),
    utilities: seriesRows.find((r) => r.id === UTILITIES.id),
    figures: figuresOf(bundle, today),
  };
}

const money = (cents: number | null): string => (cents === null ? "nothing" : formatCents(cents));

export function compareStates(before: WriteState, after: WriteState): string[] {
  const failures: string[] = [];
  if (before.transactions !== after.transactions) failures.push("transactions moved — this write touches none");
  if (before.balances !== after.balances) failures.push("daily balances moved");
  if (before.statuses !== after.statuses) failures.push("transaction status counts moved");

  const moved = changedKeys(before.series, after.series);
  if (moved.join() !== UTILITIES.id) {
    failures.push(`series rows moved: ${moved.join(", ") || "none"} — exactly one may, ${UTILITIES.id}`);
  }
  const was = before.utilities ?? {};
  const now = after.utilities ?? {};
  const columns = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((k) => was[k] !== now[k]).sort();
  if (columns.join() !== "updated_at,user_billed_with_series_id") {
    const listed = columns.join(", ") || "none";
    const two = "updated_at and user_billed_with_series_id";
    failures.push(`${UTILITIES.name}: columns moved: ${listed} — exactly two may, ${two}`);
  }
  if (now.user_billed_with_series_id !== RENT.id) {
    failures.push(`${UTILITIES.name}: billed with ${String(now.user_billed_with_series_id)}, not ${RENT.id}`);
  }

  const b = before.figures;
  const a = after.figures;
  if (b.line === null || !b.line.neverBilled || b.line.billedWithLabel !== null) {
    failures.push(`before: the card's ${UTILITIES.name} line was not "never billed" — ${JSON.stringify(b.line)}`);
  }
  if (a.line === null || a.line.neverBilled || !(a.line.billedWithLabel ?? "").startsWith(LABEL_PREFIX)) {
    failures.push(`after: the card's ${UTILITIES.name} line reads ${JSON.stringify(a.line)}, not "${LABEL_PREFIX}"`);
  }
  const neverBilledFall =
    b.neverBilledCents === null || a.neverBilledCents === null ? null : b.neverBilledCents - a.neverBilledCents;
  if (neverBilledFall !== -UTILITIES.amountCents) {
    const read = `${money(b.neverBilledCents)} → ${money(a.neverBilledCents)}`;
    failures.push(`the card's never-billed figure read ${read}, not a fall of exactly $182.21`);
  }
  if (b.liveMonthlyCents !== a.liveMonthlyCents) {
    failures.push(`the card's headline moved: ${money(b.liveMonthlyCents)} → ${money(a.liveMonthlyCents)}`);
  }
  if (b.utilitiesEvidence !== "never-billed") failures.push(`before: ${UTILITIES.name} read ${b.utilitiesEvidence}`);
  if (a.utilitiesEvidence !== a.rentEvidence || a.utilitiesEvidence === "never-billed") {
    const read = `${UTILITIES.name} reads ${a.utilitiesEvidence}, the rent ${a.rentEvidence}`;
    failures.push(`after: ${read} — not one evidence`);
  }
  if (b.money !== a.money) {
    failures.push("the money moved — the forecast, its occurrences, the arrears or the committed book");
  }
  if (b.unevidencedCents - a.unevidencedCents !== b.utilitiesCommittedCents) {
    const read = `${money(b.unevidencedCents)} → ${money(a.unevidencedCents)}`;
    const its = money(b.utilitiesCommittedCents);
    failures.push(`the committed book's not-charged-yet money read ${read}, not a fall of exactly its ${its}`);
  }
  return failures;
}

/** The write and every guard, on a copy — the dry run's rehearsal and `--confirm`'s first step. */
export function rehearse(copy: DbBundle, today: string): { before: WriteState; after: WriteState; failures: string[] } {
  const before = captureState(copy, today);
  applyLink(copy);
  const after = captureState(copy, today);
  const failures = compareStates(before, after);
  if (classify(loadFacts(copy)).kind !== "applied") failures.push("a second run would not be ALREADY APPLIED");
  return { before, after, failures };
}

/** The utilities' row as the plan prints it. */
export function describeSeries(bundle: DbBundle, id: string): string {
  const s = bundle.db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).get();
  if (s === undefined) return `${id}  not in this ledger`;
  const amount = s.userAmountCents === null ? "no amount of his own" : formatCents(s.userAmountCents);
  const link = s.userBilledWithSeriesId ?? "nothing";
  const seen = `last matched ${s.lastMatchedOn ?? "never"}`;
  return `${s.name} · ${s.kind} · ${s.userCadence ?? s.cadence} · ${s.status} · ${amount} · ${seen} · billed with ${link}`;
}
