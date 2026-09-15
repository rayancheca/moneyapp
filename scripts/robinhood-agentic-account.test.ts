import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { importFiles } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { createAccount } from "@/services/accounts";
import type { Line } from "@/services/import/profiles/pdf-profile";
import { importStatementFiles, parseContextFor, resolveAccount, type ImportInput } from "@/services/import/service";
import {
  AGENTIC_ACCOUNT,
  GuardFailure,
  PROTECTED_TABLES,
  Refusal,
  SNAPSHOT_LABEL,
  createAgenticAccount,
  fingerprintLedger,
  guardRows,
  parseAgenticCli,
  planAgenticAccount,
  type AgenticAccountSpec,
  type LedgerFingerprint,
} from "./robinhood-agentic-account";

/*
 * Text extraction is the one thing faked, keyed by the fake file's bytes — the seam
 * src/services/import/robinhood-parse-context.test.ts uses, so profile routing and the profile's own `parse`
 * run for real on these lines.
 */
const { DOCUMENTS } = vi.hoisted(() => ({ DOCUMENTS: new Map<string, Line[]>() }));
vi.mock("@/services/import/profiles/pdf-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/import/profiles/pdf-profile")>()),
  extractLines: async (buffer: Buffer): Promise<Line[]> => {
    const lines = DOCUMENTS.get(buffer.toString("latin1"));
    if (!lines) throw new Error("no mocked document for these bytes");
    return lines;
  },
}));

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
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
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
  delete process.env.MONEYAPP_ORIGINALS_DIR;
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

/* Every literal below is copied from the extracted file it names, token x-positions included. */
const line = (text: string, tokens: [string, number][] = []): Line => ({ y: 0, text, tokens: tokens.map(([str, x]) => ({ str, x })) });

/** 48afc52f…, 2026-08: #655929651 printed FIRST (lines 2–44), then #487513525 (lines 160–176). */
const AUGUST_SECOND = (period: string): Line[] => [
  line(period),
  line("Individual Account #:655929651"),
  line("Account Summary"),
  line("Net Account Balance $26.64 $26.64"),
  line("Total Securities $0.00 $0.00"),
  line("Portfolio Value $26.64 $26.64"),
  line("Portfolio Summary"),
  line("Total Securities $0.00 $0.00 0.00%"),
  line("Brokerage Cash Balance $26.64 100.00%"),
  line("Account Activity"),
  line("Description Symbol Acct Type Transaction Date Qty Price Debit Credit", [["Debit", 685.13], ["Credit", 743.4]]),
  line("Total Funds Paid and Received $0.00 $0.00", [["Total Funds Paid and Received", 36], ["$0.00", 685.13], ["$0.00", 743.4]]),
  line("Executed Trades Pending Settlement"),
  line("Total Executed Trades Pending Settlement $0.00 $0.00"),
];
const AUGUST_BROKERAGE = (period: string): Line[] => [
  line(period),
  line("Individual Account #:487513525"),
  line("Account Summary"),
  line("Brokerage Cash Balance * $1,679.93 $0.68"),
  line("Deposit Sweep Balance $0.45 $1,000.33"),
  line("Total Securities ** $67,859.26 $72,959.32"),
  line("Portfolio Value $69,539.64 $73,960.33"),
];
const AUGUST = "08/01/2026 to 08/31/2026";
const AUGUST_FILE = "48afc52f-8955-351d-bdad-7248305c5a2b.pdf";

function pdf(name: string, lines: Line[]): ImportInput {
  const buffer = Buffer.from(`%PDF-1.7\n% ${name}\n`, "latin1");
  DOCUMENTS.set(buffer.toString("latin1"), lines);
  return { name, buffer };
}
const importAugust = () => importStatementFiles(bundle.db, [pdf(AUGUST_FILE, [...AUGUST_SECOND(AUGUST), ...AUGUST_BROKERAGE(AUGUST)])]);

/**
 * 🔴 Measured by a second reader on a fresh copy of the real ledger: the three statements imported at v4 BEFORE
 * the account existed ("inserted 24", net worth unchanged), then the account created — all 13 guards passed —
 * then the import re-run: `skipped_duplicate 3`. The account stayed empty for good (no anchor, no period, no
 * balance), the $26.64 unpaired, and no step of the runbook could recover it without a parser bump.
 */
describe("⛔ the statements were imported BEFORE the account existed", () => {
  test("create is refused, and writes nothing: re-importing them would be skipped as a duplicate", async () => {
    const [outcome] = await importAugust();
    expect([outcome!.status, outcome!.error]).toEqual(["parsed", undefined]); // the untracked section skipped, as the parser does
    const before = fingerprintLedger(bundle.sqlite);

    expect(() => planAgenticAccount(bundle.db, spec)).toThrow(Refusal);
    expect(() => planAgenticAccount(bundle.db, spec)).toThrow(
      /48afc52f-8955-351d-bdad-7248305c5a2b\.pdf was already imported at robinhood-brokerage-statement-pdf v4 without ····9651/,
    );
    expect(() => createAgenticAccount(bundle, spec)).toThrow(/already imported .* without ····9651/);
    expect(fingerprintLedger(bundle.sqlite)).toEqual(before);
    expect(restorePoints()).toEqual([]);
  });

  test("an account created anyway, and left empty by that import, is refused — not reported as already tracked", async () => {
    await importAugust();
    add({});
    expect(() => planAgenticAccount(bundle.db, spec)).toThrow(/already imported .* without ····9651/);
  });

  test("in the runbook's order — the account first — the re-run is still a no-op", async () => {
    const { accountId } = createAgenticAccount(bundle, spec);
    const [outcome] = await importAugust();
    expect([outcome!.status, outcome!.error]).toEqual(["parsed", undefined]);
    expect(planAgenticAccount(bundle.db, spec)).toEqual({ kind: "already-tracked", accountId });
  });

  test("a statement from before the account's first month does not block it — none of those prints #655929651", async () => {
    // #487513525's August figures re-dated to 2026-05, alone: the account's first statement is June's
    const MAY = "05/01/2026 to 05/31/2026";
    const [outcome] = await importStatementFiles(bundle.db, [pdf("may-2026.pdf", AUGUST_BROKERAGE(MAY))]);
    expect([outcome!.status, outcome!.error]).toEqual(["parsed", undefined]);
    expect(planAgenticAccount(bundle.db, spec)).toEqual({ kind: "create" });
  });

  test.each([
    ["its row failed — the import reads it again", { status: "failed" }],
    ["its row was superseded", { status: "superseded" }],
    ["was read at an OLDER parser version — a v4 import supersedes it, as the real June–August v3 files are", { parserVersion: 3 }],
    ["was read by another profile", { parserProfile: "robinhood-crypto-statement-pdf" }],
  ] as const)("does not block it: a statement from its months that %s", async (_, change) => {
    await importAugust();
    bundle.db.update(importFiles).set(change).run();
    expect(planAgenticAccount(bundle.db, spec)).toEqual({ kind: "create" });
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
