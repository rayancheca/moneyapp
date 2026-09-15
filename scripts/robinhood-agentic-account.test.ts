import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { createAccount } from "@/services/accounts";
import { parseContextFor, resolveAccount } from "@/services/import/service";
import {
  AGENTIC_ACCOUNT,
  GuardFailure,
  PROTECTED_TABLES,
  SNAPSHOT_LABEL,
  createAgenticAccount,
  fingerprintLedger,
  guardRows,
  parseAgenticCli,
  planAgenticAccount,
  type AgenticAccountSpec,
  type LedgerFingerprint,
} from "./robinhood-agentic-account";

test("AGENTIC_ACCOUNT is the owner's decision of 2026-09-14, verbatim", () => {
  // "i gave claude agentic in robinhood 25$ to trade so yes i guess it a new acocunt"
  expect(AGENTIC_ACCOUNT).toEqual({
    institutionId: "019f4c7d-cc88-75eb-86a9-652dfb01df4d",
    institution: "Robinhood",
    name: "Robinhood Agentic",
    type: "checking",
    last4: "9651",
  });
});

describe("parseAgenticCli", () => {
  const env = { cwd: "/repo", exists: (): boolean => true };

  test("a dry run unless --confirm", () => {
    expect(parseAgenticCli(["--db=/copy.db"], env)).toEqual({ dbPath: "/copy.db", confirm: false });
    expect(parseAgenticCli(["--db=/copy.db", "--confirm"], env)).toEqual({ dbPath: "/copy.db", confirm: true });
  });

  test("⛔ --db is required — it never defaults to the real ledger", () => {
    expect(() => parseAgenticCli(["--confirm"], env)).toThrow(/--db=<path> is required/);
  });

  test("⛔ the name is the owner's decision, not a flag", () => {
    expect(() => parseAgenticCli(["--db=/copy.db", "--name=Robinhood Agentic Cash"], env)).toThrow(/unknown argument "--name=Robinhood Agentic Cash"/);
    expect(() => parseAgenticCli(["--db=/copy.db", "stray"], env)).toThrow(/unknown argument "stray"/);
  });
});

let dir: string;
let bundle: DbBundle;
let spec: AgenticAccountSpec;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-agentic-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const robinhood = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  // the seeded institution's id stands in for the owner's
  spec = { ...AGENTIC_ACCOUNT, institutionId: robinhood.id };
  // the owner's Robinhood today: the brokerage carries ····3525, its cash ledger no number
  resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "brokerage", name: "Robinhood Brokerage", last4: "3525" });
  resolveAccount(bundle.db, { institution: "Robinhood", type: "checking", name: "Robinhood Cash" });
  resolveAccount(bundle.db, { institution: "Robinhood", type: "investment", subtype: "crypto", name: "Robinhood Crypto", last4: "8474" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const robinhoodRows = () =>
  bundle.db
    .select({ name: accounts.name, type: accounts.type, subtype: accounts.subtype, last4: accounts.last4, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.institutionId, spec.institutionId))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name));
const restorePoints = (): string[] =>
  fs.existsSync(path.join(dir, "backups")) ? fs.readdirSync(path.join(dir, "backups")).filter((n) => n.includes(SNAPSHOT_LABEL)) : [];
const add = (over: Partial<{ name: string; type: "checking" | "savings" | "investment"; subtype: "brokerage"; last4: string }>) =>
  createAccount(bundle.db, { institutionId: spec.institutionId, name: spec.name, type: "checking", last4: spec.last4, ...over });

describe("planAgenticAccount", () => {
  test("create, when the ledger has no ····9651", () => {
    expect(planAgenticAccount(bundle.db, spec)).toEqual({ kind: "create" });
  });

  test("a no-op when the exact account already exists", () => {
    const id = add({});
    expect(planAgenticAccount(bundle.db, spec)).toEqual({ kind: "already-tracked", accountId: id });
  });

  test("⛔ refuses ····9651 in any other shape — another name, another type, a subtype", () => {
    add({ name: "Robinhood Agentic Cash" });
    expect(() => planAgenticAccount(bundle.db, spec)).toThrow(/already has ····9651 as "Robinhood Agentic Cash" \(checking\)/);
  });

  test.each([
    [{ type: "savings" as const }, /\(savings\)/],
    [{ type: "investment" as const, subtype: "brokerage" as const }, /\(investment\/brokerage\)/],
  ])("⛔ refuses ····9651 tracked as %o", (over, message) => {
    add(over);
    expect(() => planAgenticAccount(bundle.db, spec)).toThrow(message);
  });

  test("⛔ refuses the exact account when it has been deactivated — re-running must not bring it back", () => {
    const id = add({});
    bundle.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, id)).run();
    expect(() => planAgenticAccount(bundle.db, spec)).toThrow(/inactive/);
  });

  test("⛔ refuses the name held by an account with another number, or none", () => {
    add({ last4: "1234" });
    expect(() => planAgenticAccount(bundle.db, spec)).toThrow(/already has an account named "Robinhood Agentic" \(····1234\)/);
  });

  test("⛔ refuses a ledger whose Robinhood is not the owner's — the wrong database", () => {
    // the seeded ledger's institution id is not 019f4c7d-cc88-…
    expect(() => planAgenticAccount(bundle.db, AGENTIC_ACCOUNT)).toThrow(/not the owner's 019f4c7d-cc88-75eb-86a9-652dfb01df4d/);
  });
});

describe("createAgenticAccount", () => {
  test("creates ONE checking account ····9651 behind a restore point, and the import reads it as a cash account", () => {
    const before = fingerprintLedger(bundle.sqlite);

    const outcome = createAgenticAccount(bundle, spec);

    expect(outcome.kind).toBe("created");
    expect(outcome.guards.length).toBe(PROTECTED_TABLES.length + 5);
    expect(outcome.guards.every((g) => g.ok)).toBe(true);
    expect(robinhoodRows()).toEqual([
      { name: "Robinhood Agentic", type: "checking", subtype: null, last4: "9651", isActive: true },
      { name: "Robinhood Brokerage", type: "investment", subtype: "brokerage", last4: "3525", isActive: true },
      { name: "Robinhood Cash", type: "checking", subtype: null, last4: null, isActive: true },
      { name: "Robinhood Crypto", type: "investment", subtype: "crypto", last4: "8474", isActive: true },
    ]);
    expect(restorePoints()).toHaveLength(1);
    expect(parseContextFor(bundle.db).knownAccounts.Robinhood).toContainEqual({ last4: "9651", type: "checking", subtype: null });
    // nothing but the one account row moved
    const after = fingerprintLedger(bundle.sqlite, outcome.accountId);
    expect(after.tables).toEqual(before.tables);
    expect(after.otherAccounts).toBe(before.otherAccounts);
  });

  test("a second run is a no-op: no row, no restore point", () => {
    const first = createAgenticAccount(bundle, spec);
    const second = createAgenticAccount(bundle, spec);
    expect(second).toEqual({ kind: "already-tracked", accountId: first.accountId, guards: [] });
    expect(robinhoodRows()).toHaveLength(4);
    expect(restorePoints()).toHaveLength(1);
  });

  test("⛔ a refusal writes nothing — no account and no restore point", () => {
    add({ type: "savings" });
    const before = fingerprintLedger(bundle.sqlite);
    expect(() => createAgenticAccount(bundle, spec)).toThrow(/already has ····9651/);
    expect(fingerprintLedger(bundle.sqlite)).toEqual(before);
    expect(restorePoints()).toEqual([]);
  });
});

describe("fingerprintLedger — content, not counts", () => {
  test("a changed value in a protected table changes its fingerprint while the row count stays", () => {
    const cash = bundle.db.select().from(accounts).where(eq(accounts.name, "Robinhood Cash")).get()!;
    bundle.sqlite.prepare("INSERT INTO daily_balances (account_id, day, balance_cents, basis) VALUES (?, '2026-06-05', 2664, 'derived')").run(cash.id);
    const before = fingerprintLedger(bundle.sqlite);
    bundle.sqlite.prepare("UPDATE daily_balances SET balance_cents = 2665 WHERE account_id = ?").run(cash.id);
    const after = fingerprintLedger(bundle.sqlite);
    expect(after.tables.daily_balances).not.toBe(before.tables.daily_balances);
    expect(after.tables.daily_balances.split(":")[0]).toBe(before.tables.daily_balances.split(":")[0]);
  });
});

describe("guardRows — every guard can fail", () => {
  const honest = () => {
    const before = fingerprintLedger(bundle.sqlite);
    const id = add({});
    return {
      before,
      after: fingerprintLedger(bundle.sqlite, id),
      created: bundle.db.select().from(accounts).where(eq(accounts.id, id)).get(),
      tracked: parseContextFor(bundle.db).knownAccounts.Robinhood ?? [],
      spec,
    };
  };
  const failing = (input: Parameters<typeof guardRows>[0]): string[] =>
    guardRows(input)
      .filter((g) => !g.ok)
      .map((g) => g.label);

  test("the honest write passes every guard", () => {
    expect(failing(honest())).toEqual([]);
  });

  test.each(PROTECTED_TABLES)("⛔ a change to %s fails its guard", (table) => {
    const input = honest();
    const after: LedgerFingerprint = { ...input.after, tables: { ...input.after.tables, [table]: "0:changed" } };
    expect(failing({ ...input, after })).toEqual([`${table} unchanged`]);
  });

  test("⛔ two accounts, a changed existing account, a touched Robinhood Cash", () => {
    const input = honest();
    expect(failing({ ...input, after: { ...input.after, accountCount: input.after.accountCount + 1 } })).toEqual(["accounts +1"]);
    expect(failing({ ...input, after: { ...input.after, otherAccounts: "x" } })).toEqual(["every existing account unchanged"]);
    const stamped = JSON.stringify(JSON.parse(input.after.robinhoodCash).map((r: { last4: string | null }) => ({ ...r, last4: "9651" })));
    expect(failing({ ...input, before: { ...input.before, robinhoodCash: stamped }, after: { ...input.after, robinhoodCash: stamped } })).toEqual([
      "Robinhood Cash unchanged, and still carries no number",
    ]);
  });

  test("⛔ the wrong row, or a row the import would not read as cash", () => {
    const input = honest();
    expect(failing({ ...input, created: undefined })).toEqual(["the row is the account the owner decided on"]);
    expect(failing({ ...input, created: { ...input.created!, name: "Robinhood Agentic Cash" } })).toEqual(["the row is the account the owner decided on"]);
    expect(failing({ ...input, tracked: [{ last4: "9651", type: "investment", subtype: "brokerage" }] })).toEqual([
      "the import will read ····9651 as a cash account",
    ]);
  });

  test("a guard failure inside the write rolls it back — GuardFailure carries every row", () => {
    const failure = new GuardFailure([{ label: "accounts +1", ok: false }]);
    expect(failure.message).toMatch(/accounts \+1/);
    expect(failure.guards).toEqual([{ label: "accounts +1", ok: false }]);
  });
});
