import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { withPreMutationSnapshot } from "@/db/backup";
import type { AppDatabase, DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { createAccount } from "@/services/accounts";
import { parseContextFor } from "@/services/import/service";
import type { KnownAccount } from "@/services/import/types";
import { dbTargetFrom, strayFlags, type DbTargetOptions } from "./db-target";

/**
 * The account Robinhood #655929651 becomes — the owner's decision, 2026-09-14:
 * "i gave claude agentic in robinhood 25$ to trade so yes i guess it a new
 * acocunt". Pinned rather than taken from flags: the name alone decides whether
 * `isInvestmentSide` counts it as part of the brokerage, so it is not a thing a
 * command line gets to vary.
 *
 * Why `checking`, measured on all three statements it has printed (2026-06..08):
 * `Brokerage Cash Balance $26.64 100.00%`, `Total Securities $0.00`. A checking
 * account replays its one transaction between printed anchors; an investment
 * account with no holdings would step-hold its anchors, ignore the $26.64, and
 * value to $0 against every printed ending balance.
 */
export interface AgenticAccountSpec {
  readonly institutionId: string;
  readonly institution: "Robinhood";
  readonly name: string;
  readonly type: "checking";
  readonly last4: string;
}

export const AGENTIC_ACCOUNT: AgenticAccountSpec = {
  institutionId: "019f4c7d-cc88-75eb-86a9-652dfb01df4d",
  institution: "Robinhood",
  name: "Robinhood Agentic",
  type: "checking",
  last4: "9651",
};

export const SNAPSHOT_LABEL = "create-robinhood-agentic-account";

/** Nothing was written, because something about the ledger is not what the write expects. */
export class Refusal extends Error {}

export interface GuardRow {
  readonly label: string;
  readonly ok: boolean;
}

/** A guard failed inside the write's transaction, so it rolled back. */
export class GuardFailure extends Error {
  constructor(readonly guards: readonly GuardRow[]) {
    super(`guard failed: ${guards.filter((g) => !g.ok).map((g) => g.label).join("; ")}`);
  }
}

export interface AgenticCli {
  readonly dbPath: string;
  readonly confirm: boolean;
}

export function parseAgenticCli(argv: readonly string[], env: Pick<DbTargetOptions, "cwd" | "exists">): AgenticCli {
  const stray = [...strayFlags(argv, ["--confirm", "--db"]), ...argv.filter((a) => !a.startsWith("--"))];
  if (stray.length > 0) {
    throw new Refusal(`unknown argument "${stray[0]}" — the account's name, type and number are the owner's decision, not flags`);
  }
  const target = dbTargetFrom(argv, { flag: "--db", required: true, ...env });
  return { dbPath: target.path, confirm: argv.includes("--confirm") };
}

export type AgenticPlan = { readonly kind: "create" } | { readonly kind: "already-tracked"; readonly accountId: string };

type AccountRow = typeof accounts.$inferSelect;

function shapeOf(row: AccountRow): string {
  const type = row.subtype ? `${row.type}/${row.subtype}` : row.type;
  return row.isActive ? type : `${type}, inactive`;
}

function isTheAccount(row: AccountRow, spec: AgenticAccountSpec): boolean {
  return (
    row.institutionId === spec.institutionId &&
    row.name === spec.name &&
    row.type === spec.type &&
    row.subtype === null &&
    row.last4 === spec.last4 &&
    row.isActive
  );
}

/**
 * Idempotent: the exact account already there is a no-op. Anything else that
 * holds the number or the name — or a ledger whose Robinhood is not the
 * owner's — is refused, because each is a different real-world situation and
 * none of them is this write's to resolve.
 *
 * ⛔ Not `resolveAccount`: with a type and a last4 it ADOPTS an existing account
 * of that type with no last4, and Robinhood Cash is exactly that — ····9651
 * would be stamped on the brokerage's cash ledger.
 */
export function planAgenticAccount(db: AppDatabase, spec: AgenticAccountSpec = AGENTIC_ACCOUNT): AgenticPlan {
  const institution = db.select().from(institutions).where(eq(institutions.name, spec.institution)).get();
  if (!institution) throw new Refusal(`no "${spec.institution}" institution in this ledger — nothing written`);
  if (institution.id !== spec.institutionId) {
    throw new Refusal(
      `this ledger's "${spec.institution}" is ${institution.id}, not the owner's ${spec.institutionId} — not his database? nothing written`,
    );
  }

  const siblings = db.select().from(accounts).where(eq(accounts.institutionId, institution.id)).all();
  const numbered = siblings.filter((a) => a.last4 === spec.last4);
  if (numbered.length > 1) {
    throw new Refusal(`${numbered.length} ${spec.institution} accounts already carry ····${spec.last4} — nothing written`);
  }
  const [existing] = numbered;
  if (existing) {
    if (isTheAccount(existing, spec)) return { kind: "already-tracked", accountId: existing.id };
    throw new Refusal(
      `${spec.institution} already has ····${spec.last4} as "${existing.name}" (${shapeOf(existing)}) — ` +
        `not the account the owner decided on; nothing written`,
    );
  }
  const sameName = siblings.find((a) => a.name === spec.name);
  if (sameName) {
    throw new Refusal(
      `${spec.institution} already has an account named "${spec.name}" (····${sameName.last4 ?? "none"}) — nothing written`,
    );
  }
  return { kind: "create" };
}

/** Every table the write must leave exactly as it found it. */
export const PROTECTED_TABLES = [
  "transactions",
  "balance_anchors",
  "statement_periods",
  "holdings",
  "holding_events",
  "daily_balances",
  "transaction_splits",
  "import_files",
] as const;

export interface LedgerFingerprint {
  readonly accountCount: number;
  /** every account row but the one excluded, verbatim */
  readonly otherAccounts: string;
  /** `<rows>:<sha of every row's every column>` — a changed value moves it even when the count does not */
  readonly tables: Readonly<Record<(typeof PROTECTED_TABLES)[number], string>>;
  /** Robinhood Cash's identity, type and number, as JSON */
  readonly robinhoodCash: string;
}

function contentHash(sqlite: Database.Database, sql: string, ...params: unknown[]): string {
  const rows = (sqlite.prepare(sql).all(...params) as unknown[]).map((r) => JSON.stringify(r)).sort();
  return `${rows.length}:${crypto.createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16)}`;
}

export function fingerprintLedger(sqlite: Database.Database, excludeAccountId: string | null = null): LedgerFingerprint {
  return {
    accountCount: (sqlite.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n,
    otherAccounts: contentHash(sqlite, "SELECT * FROM accounts WHERE id IS NOT ?", excludeAccountId),
    tables: Object.fromEntries(PROTECTED_TABLES.map((t) => [t, contentHash(sqlite, `SELECT * FROM ${t}`)])) as LedgerFingerprint["tables"],
    robinhoodCash: JSON.stringify(
      sqlite
        .prepare(
          `SELECT a.id, a.type, a.subtype, a.last4 FROM accounts a JOIN institutions i ON i.id = a.institution_id
            WHERE i.name = 'Robinhood' AND a.name = 'Robinhood Cash' ORDER BY a.id`,
        )
        .all(),
    ),
  };
}

function isOneNumberlessAccount(json: string): boolean {
  const rows = JSON.parse(json) as { last4: string | null }[];
  return rows.length === 1 && rows[0]!.last4 === null;
}

export interface GuardInput {
  readonly before: LedgerFingerprint;
  /** taken with the created account excluded */
  readonly after: LedgerFingerprint;
  readonly created: AccountRow | undefined;
  /** what `parseContextFor` offers the statement parsers for Robinhood, after the write */
  readonly tracked: readonly KnownAccount[];
  readonly spec: AgenticAccountSpec;
}

/** Pure — every row names one thing the write must be, and each can fail on its own. */
export function guardRows({ before, after, created, tracked, spec }: GuardInput): GuardRow[] {
  const read = tracked.filter((a) => a.last4 === spec.last4);
  return [
    { label: "accounts +1", ok: after.accountCount === before.accountCount + 1 },
    { label: "every existing account unchanged", ok: after.otherAccounts === before.otherAccounts },
    ...PROTECTED_TABLES.map((t) => ({ label: `${t} unchanged`, ok: after.tables[t] === before.tables[t] })),
    {
      label: "Robinhood Cash unchanged, and still carries no number",
      ok: after.robinhoodCash === before.robinhoodCash && isOneNumberlessAccount(after.robinhoodCash),
    },
    { label: "the row is the account the owner decided on", ok: created !== undefined && isTheAccount(created, spec) },
    {
      label: `the import will read ····${spec.last4} as a cash account`,
      ok: read.length === 1 && read[0]!.type === "checking" && read[0]!.subtype === null,
    },
  ];
}

export interface AgenticOutcome {
  readonly kind: "created" | "already-tracked";
  readonly accountId: string;
  readonly guards: readonly GuardRow[];
}

/**
 * The write: ONE account row, through `createAccount`, behind a restore point,
 * inside a transaction that rolls back when any guard fails.
 *
 * ⛔ Nothing else — no transaction, anchor, period or holding. Those come from
 * importing the statements through the app, which the brokerage parser (v4)
 * does only once this account exists: a section is read into an account the
 * ledger already tracks, never into one invented from the file.
 */
export function createAgenticAccount(bundle: DbBundle, spec: AgenticAccountSpec = AGENTIC_ACCOUNT): AgenticOutcome {
  const { db, sqlite } = bundle;
  const plan = planAgenticAccount(db, spec);
  if (plan.kind === "already-tracked") return { kind: "already-tracked", accountId: plan.accountId, guards: [] };

  const before = fingerprintLedger(sqlite);
  return withPreMutationSnapshot(db, SNAPSHOT_LABEL, () =>
    db.transaction((tx) => {
      const accountId = createAccount(tx, {
        institutionId: spec.institutionId,
        name: spec.name,
        type: spec.type,
        last4: spec.last4,
      });
      const guards = guardRows({
        before,
        after: fingerprintLedger(sqlite, accountId),
        created: tx.select().from(accounts).where(eq(accounts.id, accountId)).get(),
        tracked: parseContextFor(tx).knownAccounts[spec.institution] ?? [],
        spec,
      });
      if (guards.some((g) => !g.ok)) throw new GuardFailure(guards);
      return { kind: "created" as const, accountId, guards };
    }),
  );
}
