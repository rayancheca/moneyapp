/**
 * The owner's answer to §6A 23 (2026-09-28), step 1 of 2, as plan, write and guards: before
 * `data/statements/chase-checking-3522` is re-dropped to clean the 13 Chase Checking descriptions that still carry the
 * statement's 20-digit margin id, the three Fordham aid deposits that re-read would refile Income › Financial Aid →
 * Education are pinned as HIS. "Only the 13 descriptions may change." The CLI and the runbook are
 * `scripts/pin-fordham-aid-2026-09-28.ts`; everything here is importable so the plan, the write and every guard are
 * unit-tested against the app's own import.
 *
 * ## Measured, read-only, on a byte copy of the live ledger (2026-09-28)
 *
 *  | row   | posted     | amount     | category               | source       | read from                          |
 *  |-------|------------|------------|------------------------|--------------|------------------------------------|
 *  | …7caf | 2022-09-15 | +$3,238.00 | Income › Financial Aid | merchant_map | 20221013-statements-3522-.pdf, v1  |
 *  | …ebb8 | 2023-09-28 | +$5,681.00 | Income › Financial Aid | merchant_map | 20231012-statements-3522-.pdf, v1  |
 *  | …f9fa | 2023-10-10 | +$2,500.00 | Income › Financial Aid | merchant_map | 20231012-statements-3522-.pdf, v1  |
 *
 * All three print "Fordham Universi Invoice PPD ID: 3131740451", sit on Chase Checking under the merchant Fordham
 * University — whose default is Education — and carry no split, no transfer group and no open transfer question. The
 * Part B recategorization of 2026-07-13 filed them as aid (docs/future-ideas.md, his words: his father pays the tuition,
 * the aid is deducted, and the balance is refunded to him — money in from outside), and their source still reads
 * `merchant_map`, a map that says Education. The other three Fordham invoice deposits
 * (2024-09-10, 2025-01-28, 2026-01-27) came from the activity CSV with Claude's category, which a re-read keeps
 * (`engineCategoryCarry`), and the re-drop does not re-read that CSV.
 *
 * ## Why they move, and why the pin holds
 *
 * A re-read at a newer parser version supersedes every row the file wrote and inserts its lines afresh. A merchant-map
 * category does not travel: categorizeAll derives it again once the batch settles, and the map says Education. A
 * category the owner set by hand always travels (`isHandCategory` — the import's own rule, which this write asks rather
 * than restating).
 *
 * ## What is written — his own correction, in ONE transaction, behind a restore point
 *
 * `applyCorrection(row, Income › Financial Aid)` on each: what /transactions writes when he picks a category with
 * "apply to the merchant" unticked. The category stays; the source becomes `user`; confidence 1 and review cleared,
 * both already so. Fordham's default stays Education, so a NEW Fordham line is still the map's to file.
 *
 * ## Guards — refuse before, throw after
 *
 * Before, each row: in the ledger, active, on Chase Checking, on its day, for its amount, in its words, filed under
 * Financial Aid, no split, no transfer group, no open transfer question anchored on it (pinning would answer it); and
 * either the merchant map's (to pin) or already his (done). A row a re-read has replaced is done only when the ONE live
 * row recording its money is his and filed as aid — the re-read ran after the pin. Anything else is refused: a
 * successor filed under Education means the re-read ran BEFORE the pin.
 * After, before vs after: every table but `transactions` byte-identical (no merchant learned a default, no question was
 * dismissed, no balance, anchor or period moved) · net worth on every day · every transaction column but the source
 * and `updated_at`, on every row · the source moved on exactly the planned rows, merchant map → his hand · no other
 * row's `updated_at` · a second run plans ALREADY APPLIED.
 */
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import type { AppDatabase, DbBundle } from "@/db/client";
import { transactionSplits } from "@/db/schema/transaction-splits";
import { transactions, type CategorizationSource } from "@/db/schema/transactions";
import { transferAmbiguities } from "@/db/schema/transfer-ambiguities";
import { formatCents } from "@/lib/money";
import { applyCorrection } from "@/services/categorize";
import { netWorthSeries } from "@/services/derivation";
import { isHandCategory } from "@/services/import/service";
import { dbTargetFrom, strayFlags, type DbTargetOptions } from "./db-target";
import { changedKeys, sha256Json } from "./guarded-write-harness";

export interface AidRow {
  readonly id: string;
  readonly postedOn: string;
  readonly amountCents: number;
}

/** Which rows the write pins — the live ledger's in `REAL_AID`, the import's own in the tests. */
export interface AidIds {
  readonly checkingAccountId: string;
  /** Income › Financial Aid — what the three are filed under, and stay filed under */
  readonly financialAidId: string;
  /** the words the statement prints for all three */
  readonly rawDescription: string;
  readonly rows: readonly AidRow[];
}

export const REAL_AID: AidIds = {
  checkingAccountId: "019f4ca7-a6bd-7cc7-9a5f-e7f91c499722",
  financialAidId: "bc9ef765-a32c-467f-9742-2546180dcc55",
  rawDescription: "Fordham Universi Invoice PPD ID: 3131740451",
  rows: [
    { id: "019f5d66-0af3-7001-b0da-d632d0d27caf", postedOn: "2022-09-15", amountCents: 323_800 },
    { id: "019f5d66-0c5e-7005-a140-82cd4865ebb8", postedOn: "2023-09-28", amountCents: 568_100 },
    { id: "019f5d66-0c60-7002-a349-0629082bf9fa", postedOn: "2023-10-10", amountCents: 250_000 },
  ],
};

export const SNAPSHOT_LABEL = "pin-fordham-aid";

/** Nothing was written: the command line or the ledger is not what this write expects. */
export class PinRefusal extends Error {}

export interface AidFact {
  readonly row: typeof transactions.$inferSelect;
  readonly splits: number;
  /** PASS-2 transfer questions still open with this row as their anchor */
  readonly openQuestions: number;
}

export interface PinFacts {
  /** each planned row, by id, whatever its status */
  readonly byId: ReadonlyMap<string, AidFact>;
  /** per planned row: the live rows recording its money (account, day, amount) — read once a re-read replaced it */
  readonly liveByRow: ReadonlyMap<string, readonly AidFact[]>;
}

export type PinVerdict =
  | { readonly kind: "plan"; readonly pin: readonly string[] }
  /** every row is his; `live` names the row holding each one's money now, in plan order */
  | { readonly kind: "applied"; readonly live: readonly string[] }
  | { readonly kind: "refuse"; readonly reasons: readonly string[] };

type RowState = { kind: "measured" } | { kind: "his"; liveId: string } | { kind: "refuse"; reason: string };

export function loadPinFacts({ db }: Pick<DbBundle, "db">, ids: AidIds = REAL_AID): PinFacts {
  const factOf = (row: typeof transactions.$inferSelect): AidFact => ({
    row,
    splits: db.select({ id: transactionSplits.id }).from(transactionSplits).where(eq(transactionSplits.transactionId, row.id)).all().length,
    openQuestions: db
      .select({ id: transferAmbiguities.id })
      .from(transferAmbiguities)
      .where(and(eq(transferAmbiguities.anchorTransactionId, row.id), eq(transferAmbiguities.resolution, "unresolved")))
      .all().length,
  });
  const byId = new Map<string, AidFact>();
  const liveByRow = new Map<string, AidFact[]>();
  for (const want of ids.rows) {
    const row = db.select().from(transactions).where(eq(transactions.id, want.id)).get();
    if (row !== undefined) byId.set(want.id, factOf(row));
    const live = db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, ids.checkingAccountId),
          eq(transactions.postedOn, want.postedOn),
          eq(transactions.amountCents, want.amountCents),
          ne(transactions.status, "superseded"),
        ),
      )
      .orderBy(transactions.id)
      .all();
    liveByRow.set(want.id, live.map(factOf));
  }
  return { byId, liveByRow };
}

/** What is off about a row that should record `want` and be filed as aid — or null when it is as measured. */
function offShape({ row, splits, openQuestions }: AidFact, want: AidRow, ids: AidIds): string | null {
  const shaped =
    row.accountId === ids.checkingAccountId &&
    row.postedOn === want.postedOn &&
    row.amountCents === want.amountCents &&
    row.rawDescription === ids.rawDescription &&
    row.status === "active" &&
    row.categoryId === ids.financialAidId &&
    row.transferGroupId === null &&
    splits === 0;
  if (!shaped) {
    const seen = { account: row.accountId, day: row.postedOn, cents: row.amountCents, words: row.rawDescription, status: row.status };
    return `is not as measured: ${JSON.stringify({ ...seen, category: row.categoryId, group: row.transferGroupId, splits })}`;
  }
  // applyCorrection dismisses them — his click answers them, and this write must not answer them for him
  if (openQuestions > 0) return `has ${openQuestions} open transfer question(s) anchored on it — pinning it would answer them`;
  return null;
}

function rowState(want: AidRow, facts: PinFacts, ids: AidIds): RowState {
  const name = `${want.id} (${want.postedOn} +${formatCents(want.amountCents)})`;
  const refuse = (reason: string): RowState => ({ kind: "refuse", reason: `${name} ${reason}` });
  const fact = facts.byId.get(want.id);
  if (fact === undefined) return refuse("is not in this ledger");
  if (fact.row.status === "superseded") {
    // a re-read replaced it: its money is on the row that read inserted, and the pin is done only if it travelled
    const live = facts.liveByRow.get(want.id) ?? [];
    if (live.length !== 1) return refuse(`was replaced by a re-read, and ${live.length} live rows record its money`);
    const successor = live[0]!;
    const off = offShape(successor, want, ids) ?? (isHandCategory(successor.row) ? null : `is filed by ${successor.row.categorizationSource}, not by his hand`);
    if (off !== null) return refuse(`was replaced by a re-read, and its row ${successor.row.id} ${off} — the re-read ran before the pin`);
    return { kind: "his", liveId: successor.row.id };
  }
  const off = offShape(fact, want, ids);
  if (off !== null) return refuse(off);
  if (fact.row.categorizationSource === "merchant_map") return { kind: "measured" };
  if (isHandCategory(fact.row)) return { kind: "his", liveId: fact.row.id };
  return refuse(`is categorized by ${fact.row.categorizationSource ?? "no recorded source"} — neither the merchant map, as measured, nor his hand`);
}

/** The measured before-state (what is left to pin), this write's after-state, or a refusal that says what is off. */
export function classifyPin(facts: PinFacts, ids: AidIds = REAL_AID): PinVerdict {
  const states = ids.rows.map((want) => rowState(want, facts, ids));
  const reasons = states.flatMap((s) => (s.kind === "refuse" ? [s.reason] : []));
  if (reasons.length > 0) return { kind: "refuse", reasons };
  const pin = ids.rows.filter((_, i) => states[i]!.kind === "measured").map((r) => r.id);
  if (pin.length > 0) return { kind: "plan", pin };
  return { kind: "applied", live: states.flatMap((s) => (s.kind === "his" ? [s.liveId] : [])) };
}

/**
 * The write: his correction on each planned row, in ONE transaction. A row no longer as planned rolls all of it back.
 * `applyCorrection` opens its own transaction, which nests here as a savepoint.
 */
export function applyPin(bundle: DbBundle, pin: readonly string[], ids: AidIds = REAL_AID): void {
  bundle.db.transaction((tx) => {
    const db = tx as unknown as AppDatabase;
    const facts = loadPinFacts({ db }, ids);
    for (const id of pin) {
      const want = ids.rows.find((r) => r.id === id);
      if (want === undefined) throw new PinRefusal(`${id} is not one of the rows this write pins`);
      const state = rowState(want, facts, ids);
      if (state.kind !== "measured") throw new PinRefusal(state.kind === "refuse" ? state.reason : `${id} is already his`);
      const result = applyCorrection(db, { transactionId: id, categoryId: ids.financialAidId });
      // "apply to the merchant" is unticked, so neither can happen — checked, not assumed
      if (result.merchantUpdated || result.retroactivelyUpdated !== 0) throw new PinRefusal(`${id}: the correction reached the merchant`);
    }
  });
}

export interface PinState {
  /** every table but `transactions`, hashed — a correction with "apply to the merchant" unticked touches none */
  readonly tables: ReadonlyMap<string, string>;
  readonly netWorth: string;
  readonly lastNetWorth: { readonly day: string; readonly cents: number } | null;
  /** every transaction column but the source and `updated_at`, per row */
  readonly besideSource: ReadonlyMap<string, string>;
  readonly sources: ReadonlyMap<string, string>;
  readonly stamps: ReadonlyMap<string, string>;
}

export function capturePinState(bundle: DbBundle): PinState {
  const { sqlite, db } = bundle;
  const names = (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'transactions' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  const tables = new Map(names.map((name) => [name, sha256Json(sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())]));
  const besideSource = new Map<string, string>();
  const sources = new Map<string, string>();
  const stamps = new Map<string, string>();
  for (const row of sqlite.prepare("SELECT * FROM transactions ORDER BY id").all() as Record<string, unknown>[]) {
    const { categorization_source: source, updated_at: stamp, ...rest } = row;
    const id = String(row.id);
    besideSource.set(id, JSON.stringify(rest));
    sources.set(id, String(source ?? "-"));
    stamps.set(id, String(stamp));
  }
  const worth = netWorthSeries(db);
  const last = worth.at(-1);
  return {
    tables,
    netWorth: sha256Json(worth.map((p) => [p.day, p.totalCents])),
    lastNetWorth: last === undefined ? null : { day: last.day, cents: last.totalCents },
    besideSource,
    sources,
    stamps,
  };
}

/** Every guard, before vs after. Empty means the write did exactly what it says and nothing else. */
export function comparePin(before: PinState, after: PinState, pin: readonly string[]): string[] {
  const failures: string[] = [];
  for (const table of changedKeys(before.tables, after.tables)) failures.push(`${table} changed — the pin writes no table but transactions`);
  if (before.netWorth !== after.netWorth) {
    failures.push(`net worth on every day moved: ${JSON.stringify(before.lastNetWorth)} → ${JSON.stringify(after.lastNetWorth)}`);
  }
  const beside = changedKeys(before.besideSource, after.besideSource);
  if (beside.length > 0) {
    failures.push(`a column other than the source changed on ${beside.length} row${beside.length === 1 ? "" : "s"}: ${beside.slice(0, 5).join(", ")}`);
  }
  const planned = [...pin].sort();
  const moved = changedKeys(before.sources, after.sources);
  if (JSON.stringify(moved) !== JSON.stringify(planned)) failures.push(`the source moved on ${JSON.stringify(moved)}, expected ${JSON.stringify(planned)}`);
  for (const id of planned) {
    const from = before.sources.get(id);
    const to = after.sources.get(id);
    if (from !== "merchant_map") failures.push(`${id}: the source was ${from}, not the merchant map's as measured`);
    if (!isHandCategory({ categorizationSource: (to ?? null) as CategorizationSource | null })) failures.push(`${id}: the source is now ${to} — not his hand`);
  }
  const touched = changedKeys(before.stamps, after.stamps).filter((id) => !pin.includes(id));
  if (touched.length > 0) failures.push(`the write touched a row it did not pin: ${touched.slice(0, 5).join(", ")}`);
  return failures;
}

export interface PinRehearsal {
  readonly failures: string[];
  readonly pinned: readonly string[];
  readonly before: PinState;
  readonly after: PinState;
}

/** Plan, write, guard and re-plan on `copy` — a throwaway `.backup` in the CLI, an imported ledger in the tests. */
export function rehearsePin(copy: DbBundle, ids: AidIds = REAL_AID): PinRehearsal {
  const verdict = classifyPin(loadPinFacts(copy, ids), ids);
  if (verdict.kind !== "plan") throw new PinRefusal(`the rehearsal copy planned ${verdict.kind}, not a write`);
  const before = capturePinState(copy);
  applyPin(copy, verdict.pin, ids);
  const after = capturePinState(copy);
  const failures = comparePin(before, after, verdict.pin);
  const again = classifyPin(loadPinFacts(copy, ids), ids);
  if (again.kind !== "applied") failures.push(`a second run on the copy plans ${again.kind.toUpperCase()}, not ALREADY APPLIED`);
  return { failures, pinned: verdict.pin, before, after };
}

export interface PinCli {
  readonly dbPath: string;
  readonly confirm: boolean;
  readonly scratch: string;
}

/**
 * `--db=<path>` (required, never guessed — `dbTargetFrom`), `--confirm`, `--scratch=<dir>`; anything else is refused.
 * ⛔ `--confirm` only bare: `--confirm=yes` reads like a write and ran a dry run in the backfills (`parseBackfillArgs`).
 */
export function parsePinCli(argv: readonly string[], env: Pick<DbTargetOptions, "cwd" | "exists">): PinCli {
  const stray = [...strayFlags(argv.filter((a) => a !== "--confirm"), ["--db", "--scratch"]), ...argv.filter((a) => !a.startsWith("--"))];
  if (stray.length > 0) throw new PinRefusal(`unknown argument "${stray[0]}" — this write takes --db=<path>, --confirm and --scratch=<dir>`);
  const target = dbTargetFrom(argv, { flag: "--db", required: true, ...env });
  const scratchArgs = argv.filter((a) => a === "--scratch" || a.startsWith("--scratch="));
  if (scratchArgs.length > 1) throw new PinRefusal(`--scratch given ${scratchArgs.length} times`);
  const [scratchArg] = scratchArgs;
  if (scratchArg === "--scratch" || scratchArg === "--scratch=") throw new PinRefusal("--scratch needs a directory: --scratch=<dir>");
  const scratch = scratchArg === undefined ? os.tmpdir() : path.resolve(env.cwd, scratchArg.slice("--scratch=".length));
  if (!env.exists(scratch)) throw new PinRefusal(`no scratch directory at ${scratch}`);
  return { dbPath: target.path, confirm: argv.includes("--confirm"), scratch };
}
