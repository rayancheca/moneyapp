/**
 * REAL-DB WRITE — file the rows his Wells Fargo statement of Sep 25 → Oct 26 (imported 2026-10-29) brought in with NO
 * category, and the two self-Zelles the September statement left, each the way his ledger already files a like row —
 * through the app's own paths (`attachTransactions`, `linkTransferPair`, `bulkApply`), so each lands as his click would.
 *
 * 🔴 Measured on his ledger after the 2026-10-29 import: 13 of the 16 new rows carried no category, and the app read
 * them as he would not — "4 paydays have passed since Sep 24 with no deposit … so the pay did not reach a bank",
 * October's income $0.00, "$695.04 has not posted" (the car lease, posted Oct 15), and $2,695.04 of October's spending
 * Uncategorized (the two Venture X payments and the lease). The precedents:
 *
 *   It America LLC Payroll ×4, $1,141.92 Oct 1/8/15/22 → attached to It America LLC (weekly pay), Salary — as Sep 24
 *   It America LLC Payroll $200.00 Oct 15 (the off-cycle format) → the same series, Salary — as Sep 23's $4,567.68
 *   Mbfs.Com Auto Pay −$695.04 Oct 15 → attached to Car lease, Car › Car Payment — as Sep 2's Mbfs Web Pay
 *   the card payments — Discover −$251.58 Sep 28, Venture X −$1,500 Oct 5 and −$500 Oct 6 → linked to the card's own
 *     leg (same day, same cents), Transfers › Credit Card Payment — as Aug 10's Capital One payment
 *   Robinhood Debits −$2,500 Sep 30 → Transfers › Investment Contribution — as Chase's ROBINHOOD DEBITS (Jun 24)
 *   Zelle From Rayan Karim Checa ×4 (Aug 31, Sep 1, Oct 5 ×2) → Transfers › Internal Transfer — as Jul 29, Aug 11, Aug 24
 *   Promotion Bonus - II +$325.00 Sep 25 → Rewards › Cash Back — as the ledger files SoFi's Bonus Money Promo Bonus
 *     (2023-12-10; that row names no source, so it is the ledger's precedent rather than provably his)
 *
 * The Robinhood and Zelle rows are filed, NOT linked: their other legs arrive with Robinhood's September and Chase's
 * post-Aug-12 statements, and the detector pairs only rows with no group — a self-group here would block it.
 *
 * ## The runbook — the dev server stopped; the restore point goes to the main checkout's data/backups
 *
 *   pnpm exec tsx scripts/file-wells-fargo-october-2026-10-29.ts --db=data/moneyapp.db             # dry run
 *   pnpm exec tsx scripts/file-wells-fargo-october-2026-10-29.ts --db=data/moneyapp.db --confirm   # write
 *   … the same again                                                                               # ALREADY APPLIED
 *   pnpm ledger-check
 *
 * ⛔ Only these rows' category, its source and confidence, the review flag, the series link and the transfer group may
 * change, and the two series' derived stats. Every other transaction, every daily balance, every other series, the
 * series' own settings and the transfer questions are compared before and after, on the rehearsal copy and on the
 * ledger. A row in any state but the measured one or its target is refused — never overwritten.
 */
import { withPreMutationSnapshot } from "@/db/backup";
import { createDatabase, type DbBundle } from "@/db/client";
import { formatCents } from "@/lib/money";
import { bulkApply } from "@/services/bulk-edit";
import { attachTransactions } from "@/services/recurring-links";
import { linkTransferPair } from "@/services/transfer-links";
import { balancesHash, changedKeys, onRehearsalCopy, parseGuardedArgs, sha256Json, statusCounts } from "./guarded-write-harness";

const LABEL = "file-wells-fargo-october";

const WF = "Wells Fargo Everyday Checking";
const DISCOVER = "Discover";
const VENTURE = "Venture X";

const CATEGORY = {
  salary: { id: "019f4c7d-cc89-78ca-a88a-79daad01e20a", path: "Income › Salary" },
  carPayment: { id: "019ff1a2-1363-7000-8b0c-a36532610ce4", path: "Car › Car Payment" },
  cardPayment: { id: "019f4c7d-cc8c-774c-b128-98b85c21162e", path: "Transfers › Credit Card Payment" },
  investment: { id: "019f4c7d-cc8c-7a56-b13b-29cd16582ad6", path: "Transfers › Investment Contribution" },
  internal: { id: "019f4c7d-cc8c-7b65-9a52-bb7195e88080", path: "Transfers › Internal Transfer" },
  cashBack: { id: "019f4c7d-cc8c-7113-84a7-81755cdb4ca0", path: "Rewards › Cash Back" },
} as const;
type CategoryKey = keyof typeof CATEGORY;

const SERIES = {
  pay: { id: "019f72da-1fbc-7000-a434-6840bae2d231", name: "It America LLC (weekly pay)", files: "salary" },
  lease: { id: "019ff202-9d0b-7000-9d80-6c48210459b3", name: "Car lease", files: "carPayment" },
} as const satisfies Record<string, { id: string; name: string; files: CategoryKey }>;
type SeriesKey = keyof typeof SERIES;

/** id, account, posted day, amount and the normalized description read on his ledger after the import */
interface Want {
  id: string;
  account: string;
  postedOn: string;
  amountCents: number;
  nd: string;
}
const want = (id: string, account: string, postedOn: string, amountCents: number, nd: string): Want => ({
  id,
  account,
  postedOn,
  amountCents,
  nd,
});

/** `was` is the series the import's detection already linked it to, or null */
const ATTACH: readonly (Want & { series: SeriesKey; was: SeriesKey | null })[] = [
  { ...want("01a18860-f8a0-7003-8f9b-e08359a3b0e7", WF, "2026-10-01", 114192, "IT AMERICA LLC PAYROLL 9303446743548QJ KARIM CHECA,RAYAN"), series: "pay", was: null },
  { ...want("01a18860-f8a1-7004-963b-b9a16ac9dd28", WF, "2026-10-08", 114192, "IT AMERICA LLC PAYROLL 7820845303038QJ KARIM CHECA,RAYAN"), series: "pay", was: null },
  { ...want("01a18860-f8a1-7006-a01e-51361aa8bf98", WF, "2026-10-15", 114192, "IT AMERICA LLC PAYROLL 5970777473238QJ KARIM CHECA,RAYAN"), series: "pay", was: null },
  { ...want("01a18860-f8a1-7005-83bb-49abd0f4b549", WF, "2026-10-15", 20000, "IT AMERICA LLC PAYROLL RAYANCHECA RAYAN CHECA"), series: "pay", was: "pay" },
  { ...want("01a18860-f8a2-7002-a1a5-5811dd684e63", WF, "2026-10-22", 114192, "IT AMERICA LLC PAYROLL 9288454030138QJ KARIM CHECA,RAYAN"), series: "pay", was: null },
  { ...want("01a18860-f8a2-7000-a8f0-b387596d2c40", WF, "2026-10-15", -69504, "MBFS.COM AUTO PAY RAYAN KARIM CHECA"), series: "lease", was: null },
];

/** the bank leg out, the card's own leg in — the outflow keys the group, as the detector's convention */
const PAIRS: readonly { out: Want; in: Want }[] = [
  {
    out: want("01a18860-f8a0-7000-9154-6d13f8d755b0", WF, "2026-09-28", -25158, "DISCOVER CAP ONE MOBILE PMT CA0377129A94715 RAYAN KARIM CHECA"),
    in: want("01a15fdb-4b7d-7002-933a-f4d7987ed9e3", DISCOVER, "2026-09-28", 25158, "CAPITAL ONE MOBILE PYMT"),
  },
  {
    out: want("01a18860-f8a1-7002-9db1-4d531450ac51", WF, "2026-10-05", -150000, "CAPITAL ONE MOBILE PMT CA0FDA683870046 RAYAN KARIM CHECA"),
    in: want("01a15fdb-4b5e-7000-b392-a801b62f22da", VENTURE, "2026-10-05", 150000, "CAPITAL ONE MOBILE PYMT"),
  },
  {
    out: want("01a18860-f8a1-7003-af95-58db2e277330", WF, "2026-10-06", -50000, "CAPITAL ONE MOBILE PMT CA05961FD73B0EF RAYAN KARIM CHECA"),
    in: want("01a15fdb-4b5e-7001-9d19-7e8c2e36b316", VENTURE, "2026-10-06", 50000, "CAPITAL ONE MOBILE PYMT"),
  },
];

const FILE: readonly (Want & { to: CategoryKey })[] = [
  { ...want("01a18860-f8a0-7002-a531-6a5d754600d9", WF, "2026-09-30", -250000, "ROBINHOOD DEBITS RAYAN KARIM CHECA"), to: "investment" },
  { ...want("01a0e898-c5c9-7001-8d79-484d926c8f0b", WF, "2026-08-31", 152973, "ZELLE FROM RAYAN KARIM CHECA ON 08/29 REF # JPM99CUSQDUO RENT"), to: "internal" },
  { ...want("01a0e898-c5c9-7002-a3d6-36497ee02ba8", WF, "2026-09-01", 70000, "ZELLE FROM RAYAN KARIM CHECA ON 09/01 REF # JPM99CV4L2ZZ RENT"), to: "internal" },
  { ...want("01a18860-f8a1-7000-8b1f-89645a47273d", WF, "2026-10-05", 100, "ZELLE FROM RAYAN KARIM CHECA ON 10/05 REF # JPM99CYWDIG3 TEST TRANSFER"), to: "internal" },
  { ...want("01a18860-f8a1-7001-b713-70c58a3b02ab", WF, "2026-10-05", 60000, "ZELLE FROM RAYAN KARIM CHECA ON 10/05 REF # JPM99CYWDZHC CAR"), to: "internal" },
  { ...want("01a18860-f89f-7000-ac3a-68a6c00322f3", WF, "2026-09-25", 32500, "PROMOTION BONUS - II"), to: "cashBack" },
];

const TOUCHED = [...ATTACH.map((r) => r.id), ...PAIRS.flatMap((p) => [p.out.id, p.in.id]), ...FILE.map((r) => r.id)];
/** the columns these paths write; every other column of a touched row must not move */
const WRITABLE = [
  "category_id",
  "categorization_source",
  "categorization_confidence",
  "needs_review",
  "recurring_series_id",
  "series_link_source",
  "transfer_group_id",
  "updated_at",
] as const;
/** what `recomputeSeriesStats` re-derives on an attach; a series' name, kind, account and his settings must not move */
const SERIES_DERIVED = [
  "interval_days_avg",
  "amount_cents_avg",
  "amount_cents_stddev",
  "next_expected_on",
  "next_expected_amount_cents",
  "confidence",
  "last_matched_on",
  "updated_at",
] as const;

interface Fact {
  id: string;
  status: string;
  accountName: string;
  postedOn: string;
  amountCents: number;
  nd: string;
  categoryId: string | null;
  source: string | null;
  seriesId: string | null;
  linkSource: string | null;
  groupId: string | null;
}

interface Plan {
  attach: Map<SeriesKey, string[]>;
  pairs: { outId: string; inId: string }[];
  file: Map<CategoryKey, string[]>;
}

type Verdict = { kind: "plan"; plan: Plan; pending: number } | { kind: "applied" } | { kind: "refuse"; reasons: string[] };

function loadFacts(bundle: DbBundle): Map<string, Fact> {
  const stmt = bundle.sqlite.prepare(`
    SELECT t.id, t.status, a.name AS accountName, t.posted_on AS postedOn, t.amount_cents AS amountCents,
           t.normalized_description AS nd, t.category_id AS categoryId, t.categorization_source AS source,
           t.recurring_series_id AS seriesId, t.series_link_source AS linkSource, t.transfer_group_id AS groupId
      FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ?`);
  const facts = new Map<string, Fact>();
  for (const id of TOUCHED) {
    const fact = stmt.get(id) as Fact | undefined;
    if (fact !== undefined) facts.set(id, fact);
  }
  return facts;
}

/** the row is the one measured — or a reason it is not */
function identityOf(facts: ReadonlyMap<string, Fact>, w: Want): { fact: Fact } | { reason: string } {
  const f = facts.get(w.id);
  if (f === undefined) return { reason: `${w.id}: not in this ledger` };
  const wrong: string[] = [];
  if (f.status !== "active") wrong.push(`status ${f.status}`);
  if (f.accountName !== w.account) wrong.push(`on ${f.accountName}`);
  if (f.postedOn !== w.postedOn || f.amountCents !== w.amountCents) wrong.push(`${f.postedOn} ${formatCents(f.amountCents)}`);
  if (f.nd !== w.nd) wrong.push(`reads "${f.nd}"`);
  return wrong.length === 0 ? { fact: f } : { reason: `${w.id} (${w.postedOn} ${formatCents(w.amountCents)}): ${wrong.join(", ")}` };
}

function settingsReasons(bundle: DbBundle): string[] {
  const reasons: string[] = [];
  const cat = bundle.sqlite.prepare(
    "SELECT coalesce(p.name || ' › ', '') || c.name AS path FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = ?",
  );
  for (const c of Object.values(CATEGORY)) {
    const row = cat.get(c.id) as { path: string } | undefined;
    if (row?.path !== c.path) reasons.push(`category ${c.id} is ${row?.path ?? "missing"}, not ${c.path}`);
  }
  const series = bundle.sqlite.prepare("SELECT name, merged_into_id AS mergedInto FROM recurring_series WHERE id = ?");
  for (const s of Object.values(SERIES)) {
    const row = series.get(s.id) as { name: string; mergedInto: string | null } | undefined;
    if (row?.name !== s.name || row.mergedInto !== null) reasons.push(`series ${s.id} is ${row?.name ?? "missing"}, not a live "${s.name}"`);
  }
  return reasons;
}

function classify(bundle: DbBundle): Verdict {
  const reasons = settingsReasons(bundle);
  const facts = loadFacts(bundle);
  const plan: Plan = { attach: new Map(), pairs: [], file: new Map() };
  let pending = 0;

  for (const w of ATTACH) {
    const got = identityOf(facts, w);
    if ("reason" in got) {
      reasons.push(got.reason);
      continue;
    }
    const f = got.fact;
    const target = SERIES[w.series];
    const filedTo = CATEGORY[target.files].id;
    const done = f.seriesId === target.id && f.linkSource === "user" && f.categoryId === filedTo && f.source === "user";
    const measured =
      f.categoryId === null &&
      f.groupId === null &&
      (w.was === null ? f.seriesId === null : f.seriesId === SERIES[w.was].id && f.linkSource === "detected");
    if (done) continue;
    if (!measured) {
      reasons.push(`${w.id} (${w.postedOn} ${formatCents(w.amountCents)}): category ${f.categoryId}/${f.source}, series ${f.seriesId}/${f.linkSource}, group ${f.groupId} — neither as measured nor attached`);
      continue;
    }
    plan.attach.set(w.series, [...(plan.attach.get(w.series) ?? []), w.id]);
    pending += 1;
  }

  for (const p of PAIRS) {
    const out = identityOf(facts, p.out);
    const inn = identityOf(facts, p.in);
    if ("reason" in out || "reason" in inn) {
      if ("reason" in out) reasons.push(out.reason);
      if ("reason" in inn) reasons.push(inn.reason);
      continue;
    }
    const o = out.fact;
    const i = inn.fact;
    const card = CATEGORY.cardPayment.id;
    const done = [o, i].every((leg) => leg.groupId === o.id && leg.categoryId === card && leg.source === "user");
    const measured =
      o.groupId === null && o.categoryId === null && o.seriesId === null && i.groupId === null && i.categoryId === card && i.seriesId === null;
    if (done) continue;
    if (!measured) {
      reasons.push(`pair ${o.id} ↔ ${i.id}: groups ${o.groupId}/${i.groupId}, categories ${o.categoryId}/${i.categoryId} — neither as measured nor linked`);
      continue;
    }
    plan.pairs.push({ outId: o.id, inId: i.id });
    pending += 1;
  }

  for (const w of FILE) {
    const got = identityOf(facts, w);
    if ("reason" in got) {
      reasons.push(got.reason);
      continue;
    }
    const f = got.fact;
    const done = f.categoryId === CATEGORY[w.to].id && f.source === "user" && f.groupId === null;
    const measured = f.categoryId === null && f.groupId === null && f.seriesId === null;
    if (done) continue;
    if (!measured) {
      reasons.push(`${w.id} (${w.postedOn} ${formatCents(w.amountCents)}): category ${f.categoryId}/${f.source}, group ${f.groupId} — neither unfiled nor filed to ${CATEGORY[w.to].path}`);
      continue;
    }
    plan.file.set(w.to, [...(plan.file.get(w.to) ?? []), w.id]);
    pending += 1;
  }

  if (reasons.length > 0) return { kind: "refuse", reasons };
  if (pending === 0) return { kind: "applied" };
  return { kind: "plan", plan, pending };
}

function apply(bundle: DbBundle, plan: Plan): void {
  for (const [key, ids] of plan.attach) {
    const result = attachTransactions(bundle.db, SERIES[key].id, ids);
    if (result.attached !== ids.length) throw new Error(`${SERIES[key].name}: attached ${result.attached} of ${ids.length}`);
  }
  for (const pair of plan.pairs) linkTransferPair(bundle.db, pair.outId, pair.inId);
  for (const [to, ids] of plan.file) {
    const result = bulkApply(bundle.db, ids, { categoryId: CATEGORY[to].id });
    if (result.affected !== ids.length) throw new Error(`${CATEGORY[to].path}: filed ${result.affected} of ${ids.length}`);
  }
}

function without(row: Record<string, unknown>, columns: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => !columns.includes(k))));
}

interface Snapshot {
  rows: Map<string, string>;
  balances: string;
  series: Map<string, string>;
  statuses: string;
  questions: string;
}

/** Everything as it stands — the touched rows and the two series without the columns this write may change. */
function snapshot(bundle: DbBundle): Snapshot {
  const touched = new Set(TOUCHED);
  const rows = new Map<string, string>();
  for (const row of bundle.sqlite.prepare("SELECT * FROM transactions").all() as Record<string, unknown>[]) {
    const id = row.id as string;
    rows.set(id, touched.has(id) ? without(row, WRITABLE) : JSON.stringify(row));
  }
  const attachedTo = new Set<string>(Object.values(SERIES).map((s) => s.id));
  const series = new Map<string, string>();
  for (const row of bundle.sqlite.prepare("SELECT * FROM recurring_series").all() as Record<string, unknown>[]) {
    const id = row.id as string;
    series.set(id, attachedTo.has(id) ? without(row, SERIES_DERIVED) : JSON.stringify(row));
  }
  return {
    rows,
    balances: balancesHash(bundle),
    series,
    statuses: statusCounts(bundle),
    questions: sha256Json(bundle.sqlite.prepare("SELECT * FROM transfer_ambiguities ORDER BY id").all()),
  };
}

function compare(before: Snapshot, after: Snapshot): string[] {
  const failures: string[] = [];
  const moved = changedKeys(before.rows, after.rows);
  if (moved.length > 0) failures.push(`${moved.length} transaction(s) changed beyond what this write may change: ${moved.slice(0, 5).join(", ")}`);
  const seriesMoved = changedKeys(before.series, after.series);
  if (seriesMoved.length > 0) failures.push(`series moved beyond their derived stats: ${seriesMoved.join(", ")}`);
  if (before.balances !== after.balances) failures.push("daily balances moved");
  if (before.statuses !== after.statuses) failures.push("transaction status counts moved");
  if (before.questions !== after.questions) failures.push("the transfer questions moved");
  return failures;
}

function print(bundle: DbBundle): void {
  const facts = loadFacts(bundle);
  const state = (id: string): string => {
    const f = facts.get(id);
    if (f === undefined) return "missing";
    return `${f.categoryId === null ? "unfiled" : "filed"}${f.seriesId === null ? "" : ` · series ${f.linkSource}`}${f.groupId === null ? "" : " · linked"}`;
  };
  for (const w of ATTACH) {
    console.log(`  ${w.postedOn} ${formatCents(w.amountCents).padStart(10)}  ${w.nd.slice(0, 44).padEnd(44)} → attach to ${SERIES[w.series].name} (${CATEGORY[SERIES[w.series].files].path}) · now ${state(w.id)}`);
  }
  for (const p of PAIRS) {
    console.log(`  ${p.out.postedOn} ${formatCents(p.out.amountCents).padStart(10)}  ${p.out.nd.slice(0, 44).padEnd(44)} → link to ${p.in.account}'s +${formatCents(p.in.amountCents)} ${p.in.postedOn} · now ${state(p.out.id)} / ${state(p.in.id)}`);
  }
  for (const w of FILE) {
    console.log(`  ${w.postedOn} ${formatCents(w.amountCents).padStart(10)}  ${w.nd.slice(0, 44).padEnd(44)} → ${CATEGORY[w.to].path} · now ${state(w.id)}`);
  }
}

function seriesStats(bundle: DbBundle): string[] {
  const stmt = bundle.sqlite.prepare(
    "SELECT name, last_matched_on AS last, next_expected_on AS next, amount_cents_avg AS avg, interval_days_avg AS days FROM recurring_series WHERE id = ?",
  );
  return Object.values(SERIES).map((s) => {
    const r = stmt.get(s.id) as { name: string; last: string | null; next: string | null; avg: number | null; days: number | null };
    return `${r.name}: last ${r.last}, next ${r.next}, avg ${r.avg === null ? "—" : formatCents(r.avg)}, every ${r.days?.toFixed(1) ?? "—"} days`;
  });
}

async function main(): Promise<void> {
  const args = parseGuardedArgs(process.argv.slice(2));
  const real = createDatabase(args.db);
  try {
    const verdict = classify(real);
    console.log(`\n── plan on ${args.db}: ${verdict.kind.toUpperCase()}`);
    print(real);
    if (verdict.kind === "refuse") {
      for (const reason of verdict.reasons) console.log(`  ✗ ${reason}`);
      process.exitCode = 1;
      return;
    }
    if (verdict.kind === "applied") return void console.log(`ALREADY APPLIED — nothing to do: all ${TOUCHED.length} rows are filed`);

    const rehearsal = await onRehearsalCopy(real, args.scratch, LABEL, (copy) => {
      const before = snapshot(copy);
      const statsBefore = seriesStats(copy);
      apply(copy, verdict.plan);
      const failures = compare(before, snapshot(copy));
      if (classify(copy).kind !== "applied") failures.push("a second run would not be ALREADY APPLIED");
      const statsAfter = seriesStats(copy);
      statsBefore.forEach((line, i) => console.log(`  series before: ${line}\n  series after:  ${statsAfter[i]}`));
      return failures;
    });
    if (rehearsal.length > 0) {
      for (const failure of rehearsal) console.log(`  ✗ rehearsal: ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ rehearsed on a copy: ${verdict.pending} writes, nothing else moves, and a second run is ALREADY APPLIED`);
    if (!args.confirm) return void console.log("DRY RUN — nothing written. Re-run with --confirm to write, with the dev server stopped.");

    const before = snapshot(real);
    withPreMutationSnapshot(real.db, LABEL, () => apply(real, verdict.plan));
    const failures = compare(before, snapshot(real));
    if (failures.length > 0) throw new Error(`WRITTEN, and a guard failed — restore from the pre-*-${LABEL}.db restore point:\n${failures.join("\n")}`);
    const again = classify(real);
    console.log(`APPLIED — every guard holds; ${again.kind === "applied" ? "a second run is ALREADY APPLIED" : `⚠ re-plan is ${again.kind.toUpperCase()}`}`);
    for (const line of seriesStats(real)) console.log(`  ${line}`);
  } finally {
    real.sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
