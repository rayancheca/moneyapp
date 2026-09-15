import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import {
  accountLiquidity,
  cashPosition,
  updateAccount,
  createAccount,
  createInstitution,
  editAccount,
  getAccount,
  listAccountOptions,
  listAccounts,
  reorderAccounts,
} from "./accounts";
import { upsertHolding } from "./holdings";

let dir: string;
let bundle: DbBundle;
let instId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-accounts-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createInstitution", () => {
  test("creates a new institution and returns its id", () => {
    const id = createInstitution(bundle.db, "Ally");
    const row = bundle.db.select().from(institutions).where(eq(institutions.id, id)).get();
    expect(row?.name).toBe("Ally");
  });

  test("is find-or-create — the same name returns the existing id", () => {
    const a = createInstitution(bundle.db, "Ally");
    const b = createInstitution(bundle.db, "  Ally  ");
    expect(b).toBe(a);
    expect(bundle.db.select().from(institutions).where(eq(institutions.name, "Ally")).all()).toHaveLength(1);
  });

  test("rejects a blank name", () => {
    expect(() => createInstitution(bundle.db, "   ")).toThrow();
  });
});

describe("editAccount", () => {
  test("renames, re-homes to another institution, and fixes last4", () => {
    const id = createAccount(bundle.db, { institutionId: instId, name: "Old", type: "checking" });
    const ally = createInstitution(bundle.db, "Ally");
    editAccount(bundle.db, id, { name: "New Checking", institutionId: ally, last4: "4321" });
    const row = getAccount(bundle.db, id)!;
    expect(row.name).toBe("New Checking");
    expect(row.institutionId).toBe(ally);
    expect(row.last4).toBe("4321");
  });

  test("clears last4 when null is passed", () => {
    const id = createAccount(bundle.db, { institutionId: instId, name: "Card", type: "credit", last4: "1111" });
    editAccount(bundle.db, id, { name: "Card", institutionId: instId, last4: null });
    expect(getAccount(bundle.db, id)!.last4).toBeNull();
  });

  test("does not touch type or subtype (derivation-critical fields stay put)", () => {
    const id = createAccount(bundle.db, {
      institutionId: instId,
      name: "Brokerage",
      type: "investment",
      subtype: "brokerage",
    });
    editAccount(bundle.db, id, { name: "Renamed", institutionId: instId, last4: null });
    const row = getAccount(bundle.db, id)!;
    expect(row.type).toBe("investment");
    expect(row.subtype).toBe("brokerage");
  });

  test("rejects a bad last4 and an empty name", () => {
    const id = createAccount(bundle.db, { institutionId: instId, name: "A", type: "checking" });
    expect(() => editAccount(bundle.db, id, { name: "A", institutionId: instId, last4: "12" })).toThrow();
    expect(() => editAccount(bundle.db, id, { name: "", institutionId: instId, last4: null })).toThrow();
  });

  test("throws on an unknown account", () => {
    expect(() => editAccount(bundle.db, "nope", { name: "X", institutionId: instId, last4: null })).toThrow(
      /Unknown account/,
    );
  });
});

describe("reorderAccounts", () => {
  test("writes displayOrder 0..n in the supplied order", () => {
    const a = createAccount(bundle.db, { institutionId: instId, name: "A", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: instId, name: "B", type: "savings" });
    const c = createAccount(bundle.db, { institutionId: instId, name: "C", type: "credit" });

    reorderAccounts(bundle.db, [c, a, b]);

    const orderOf = (id: string) =>
      bundle.db.select({ o: accounts.displayOrder }).from(accounts).where(eq(accounts.id, id)).get()!.o;
    expect(orderOf(c)).toBe(0);
    expect(orderOf(a)).toBe(1);
    expect(orderOf(b)).toBe(2);
  });

  test("reordering flips the listAccounts order within an institution", () => {
    const a = createAccount(bundle.db, { institutionId: instId, name: "Zzz", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: instId, name: "Aaa", type: "savings" });
    reorderAccounts(bundle.db, [a, b]);
    const chase = listAccounts(bundle.db).filter((x) => x.institutionId === instId);
    expect(chase.map((x) => x.id).slice(0, 2)).toEqual([a, b]);
  });

  test("ignores unknown ids — a stale drag can't renumber the wrong account", () => {
    const a = createAccount(bundle.db, { institutionId: instId, name: "A", type: "checking" });
    const before = bundle.db.select({ o: accounts.displayOrder }).from(accounts).where(eq(accounts.id, a)).get()!.o;
    reorderAccounts(bundle.db, ["ghost-1", "ghost-2"]);
    const after = bundle.db.select({ o: accounts.displayOrder }).from(accounts).where(eq(accounts.id, a)).get()!.o;
    expect(after).toBe(before);
  });
});

describe("editAccount — type/subtype (S3, guarded)", () => {
  test("a type change re-derives and normalizes subtype away from non-investment types", () => {
    const id = createAccount(bundle.db, {
      institutionId: instId,
      name: "Flex",
      type: "investment",
      subtype: "brokerage",
    });
    const result = editAccount(bundle.db, id, {
      name: "Flex",
      institutionId: instId,
      last4: null,
      type: "savings",
    });
    expect(result.rederived).toBe(true);
    const row = getAccount(bundle.db, id)!;
    expect(row.type).toBe("savings");
    expect(row.subtype).toBeNull(); // normalized — subtype is investment-only
  });

  test("rejects a subtype on a non-investment effective type", () => {
    const id = createAccount(bundle.db, { institutionId: instId, name: "Chk", type: "checking" });
    expect(() =>
      editAccount(bundle.db, id, { name: "Chk", institutionId: instId, last4: null, subtype: "crypto" }),
    ).toThrow(/only to investment accounts/);
  });

  test("refuses to flip an investment account with holdings to a cash type (history would vanish)", () => {
    const id = createAccount(bundle.db, {
      institutionId: instId,
      name: "Holdings",
      type: "investment",
      subtype: "brokerage",
    });
    upsertHolding(bundle.db, { accountId: id, symbol: "VOO", assetType: "etf", quantityE8: 5_0000_0000 });
    expect(() =>
      editAccount(bundle.db, id, { name: "Holdings", institutionId: instId, last4: null, type: "checking" }),
    ).toThrow(/derived from its holdings/);
    expect(getAccount(bundle.db, id)!.type).toBe("investment"); // nothing committed
  });

  test("an unchanged type/subtype does not re-derive", () => {
    const id = createAccount(bundle.db, { institutionId: instId, name: "Same", type: "checking" });
    const result = editAccount(bundle.db, id, {
      name: "Same",
      institutionId: instId,
      last4: null,
      type: "checking",
    });
    expect(result.rederived).toBe(false);
  });
});

/**
 * ⛔ `/accounts/[id]` writes the account's name into a fact subject, and
 * `insight-facts` refuses `< > { } \\` by THROWING — so a name accepted here is
 * a page that renders its error boundary instead of a balance. The charset is
 * part of the schema for the same reason the length is. See
 * `lib/printable-name`.
 */
describe("a name the app could never print", () => {
  test("is refused on create and on update, and nothing is written", () => {
    const before = bundle.db.select().from(accounts).all().length;
    /*
     * ⚠️ The message is asserted, not just "it threw". `updateAccount` was
     * missing from this file's imports on the first run and the bare `.toThrow()`
     * passed on the ReferenceError — a test that asserted nothing, caught by
     * `tsc` rather than by the suite.
     */
    expect(() => createAccount(bundle.db, { institutionId: instId, name: "<UNKNOWN>", type: "checking" })).toThrow(
      /cannot contain/,
    );
    expect(bundle.db.select().from(accounts).all().length).toBe(before);

    const id = createAccount(bundle.db, { institutionId: instId, name: "Real Checking", type: "checking" });
    expect(() => updateAccount(bundle.db, id, { name: "Che{cking}" })).toThrow(/cannot contain/);
    /*
     * ⛔ And through `editAccount`, which is the schema the rename UI actually
     * uses — the create-path guard alone would have left the reachable path open.
     */
    expect(() =>
      editAccount(bundle.db, id, { name: "Che<cking>", institutionId: instId, last4: null }),
    ).toThrow(/cannot contain/);
    expect(bundle.db.select().from(accounts).where(eq(accounts.id, id)).get()!.name).toBe("Real Checking");
  });
});

/**
 * 🔴 `/transactions`' account picker ran `orderBy(displayOrder, name)` of its
 * own. `displayOrder` is an ordinal `reorderAccounts` writes across ONE
 * institution, so used globally it interleaves institutions by an arbitrary
 * number: on the owner's ledger it listed nine accounts alphabetically and then
 * appended the two 1s and the 2 — Chase Checking, Robinhood Cash, Robinhood
 * Crypto — after Wells Fargo.
 *
 * ⚠️ The e2e fixture cannot catch this. Its eight seed accounts all carry
 * `display_order = 0` and each name starts with its own institution's, so the
 * broken sort and the right one produce the identical list. This test builds
 * the shape that separates them.
 */
describe("listAccountOptions", () => {
  test("groups an institution's accounts together, whatever their displayOrder", () => {
    const chase = instId;
    const robinhood = bundle.db
      .select()
      .from(institutions)
      .where(eq(institutions.name, "Robinhood"))
      .get()!.id;

    // names chosen so plain alphabetical order interleaves the two institutions
    const chaseFirst = createAccount(bundle.db, { institutionId: chase, name: "Amber", type: "checking" });
    const chaseSecond = createAccount(bundle.db, { institutionId: chase, name: "Cobalt", type: "savings" });
    const rhOnly = createAccount(bundle.db, { institutionId: robinhood, name: "Beryl", type: "checking" });
    // the second Chase account is dragged to the top of ITS list — a 0 and a 1
    // that mean nothing to Robinhood's own 0
    reorderAccounts(bundle.db, [chaseSecond, chaseFirst]);

    const options = listAccountOptions(bundle.db);
    const ids = options.map((o) => o.id);
    expect(ids.indexOf(chaseSecond)).toBeLessThan(ids.indexOf(chaseFirst));
    expect(ids.indexOf(chaseFirst)).toBeLessThan(ids.indexOf(rhOnly));
    // Chase's two are adjacent — Robinhood's Beryl does not fall between them
    expect(ids.indexOf(chaseFirst) - ids.indexOf(chaseSecond)).toBe(1);
  });

  test("carries only what a picker needs — id and name, and every account", () => {
    const id = createAccount(bundle.db, { institutionId: instId, name: "Solo", type: "checking" });
    const options = listAccountOptions(bundle.db);
    expect(options.map((o) => o.id)).toEqual(listAccounts(bundle.db).map((a) => a.id));
    expect(options.find((o) => o.id === id)).toEqual({ id, name: "Solo" });
  });
});

let statementSeq = 0;

/** One imported statement file that prints every account in `accountIds`. */
function printOnOneStatement(institutionId: string, accountIds: readonly string[]): void {
  statementSeq += 1;
  const fileId = `statement-${statementSeq}`;
  const now = new Date().toISOString();
  bundle.db
    .insert(importFiles)
    .values({
      id: fileId,
      fileName: `${fileId}.pdf`,
      fileSha256: `sha-${fileId}`,
      format: "pdf",
      institutionId,
      status: "parsed",
      storagePath: `/tmp/${fileId}.pdf`,
      importedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  accountIds.forEach((accountId, i) => {
    bundle.db
      .insert(statementPeriods)
      .values({
        id: `${fileId}-${i}`,
        importFileId: fileId,
        accountId,
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        reconciliation: "reconciled",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
}

function setBalance(accountId: string, balanceCents: number): void {
  bundle.db.insert(dailyBalances).values({ accountId, day: "2026-09-15", balanceCents, basis: "anchored" }).run();
}

/**
 * ⚖️ Owner decision 2026-09-15: Robinhood Cash and Robinhood Agentic leave "Cash
 * you can spend today" and the forecast's month-end cash, for what selling
 * investments would add. Both are `checking` so balance replay can run them, so
 * the account TYPE cannot tell them from a bank account.
 */
describe("accountLiquidity", () => {
  /**
   * The owner's thirteen accounts as the ledger held them on 2026-09-15 —
   * institution, type, and which statement file prints each. Measured read-only:
   * of the deposit accounts, exactly Robinhood Cash (25 files) and Robinhood
   * Agentic (3) share a statement file with an investment account; SoFi prints
   * checking and savings on one combined file with no investment on it;
   * Capital One 360 and Cash on Hand have no statement at all.
   */
  test("the owner's thirteen accounts: only the two Robinhood's brokerage statement prints move", () => {
    const acct = (institution: string, name: string, type: "checking" | "savings" | "credit" | "investment") =>
      createAccount(bundle.db, { institutionId: createInstitution(bundle.db, institution), name, type });
    const id = {
      capitalOne360: acct("Capital One", "Capital One 360 Checking", "checking"),
      ventureX: acct("Capital One", "Venture X", "credit"),
      cashOnHand: acct("Cash", "Cash on Hand", "checking"),
      sapphire: acct("Chase", "Chase Sapphire", "credit"),
      chaseChecking: acct("Chase", "Chase Checking", "checking"),
      discover: acct("Discover", "Discover", "credit"),
      robinhoodAgentic: acct("Robinhood", "Robinhood Agentic", "checking"),
      robinhoodBrokerage: acct("Robinhood", "Robinhood Brokerage", "investment"),
      robinhoodCash: acct("Robinhood", "Robinhood Cash", "checking"),
      robinhoodCrypto: acct("Robinhood", "Robinhood Crypto", "investment"),
      sofiChecking: acct("SoFi", "SoFi Checking", "checking"),
      sofiSavings: acct("SoFi", "SoFi Savings", "savings"),
      wellsFargo: acct("Wells Fargo", "Wells Fargo Everyday Checking", "checking"),
    };
    const inst = (name: string) => createInstitution(bundle.db, name);
    printOnOneStatement(inst("Robinhood"), [id.robinhoodCash, id.robinhoodBrokerage, id.robinhoodAgentic]);
    printOnOneStatement(inst("Robinhood"), [id.robinhoodCrypto]);
    printOnOneStatement(inst("Chase"), [id.chaseChecking]);
    printOnOneStatement(inst("Chase"), [id.sapphire]);
    printOnOneStatement(inst("Discover"), [id.discover]);
    printOnOneStatement(inst("Capital One"), [id.ventureX]);
    printOnOneStatement(inst("SoFi"), [id.sofiChecking, id.sofiSavings]);
    printOnOneStatement(inst("Wells Fargo"), [id.wellsFargo]);

    const liquidity = accountLiquidity(bundle.db);
    expect(Object.fromEntries(Object.entries(id).map(([key, accountId]) => [key, liquidity.get(accountId)]))).toEqual({
      capitalOne360: "spendable",
      ventureX: "owed",
      cashOnHand: "spendable",
      sapphire: "owed",
      chaseChecking: "spendable",
      discover: "owed",
      robinhoodAgentic: "investable",
      robinhoodBrokerage: "investable",
      robinhoodCash: "investable",
      robinhoodCrypto: "investable",
      sofiChecking: "spendable",
      sofiSavings: "spendable",
      wellsFargo: "spendable",
    });
  });

  /**
   * ⛔ The institution is NOT the divider. A bank that also runs a brokerage
   * (SoFi Invest, J.P. Morgan self-directed at Chase) prints its checking on the
   * bank's statement and the brokerage on its own, and that checking is still
   * money he spends. "Deposit account at an institution holding an investment
   * account" selects the same two accounts on today's ledger and would have
   * shipped green — this is the case it gets wrong.
   */
  test("a bank that also runs a brokerage keeps its checking spendable", () => {
    const checking = createAccount(bundle.db, { institutionId: instId, name: "Chase Checking", type: "checking" });
    const brokerage = createAccount(bundle.db, {
      institutionId: instId,
      name: "Chase Self-Directed",
      type: "investment",
      subtype: "brokerage",
    });
    printOnOneStatement(instId, [checking]);
    printOnOneStatement(instId, [brokerage]);

    expect(accountLiquidity(bundle.db).get(checking)).toBe("spendable");
    expect(accountLiquidity(bundle.db).get(brokerage)).toBe("investable");
  });
});

describe("cashPosition", () => {
  function robinhoodLedger() {
    const robinhood = createInstitution(bundle.db, "Robinhood");
    const checking = createAccount(bundle.db, { institutionId: instId, name: "Checking", type: "checking" });
    const brokerage = createAccount(bundle.db, {
      institutionId: robinhood,
      name: "Robinhood Brokerage",
      type: "investment",
      subtype: "brokerage",
    });
    const settlement = createAccount(bundle.db, { institutionId: robinhood, name: "Robinhood Cash", type: "checking" });
    const agentic = createAccount(bundle.db, { institutionId: robinhood, name: "Robinhood Agentic", type: "checking" });
    printOnOneStatement(robinhood, [settlement, brokerage, agentic]);
    setBalance(checking, 300760);
    setBalance(brokerage, 7301320);
    setBalance(settlement, 90);
    setBalance(agentic, 2664);
    return { checking, brokerage, settlement, agentic };
  }

  test("brokerage cash is investable, and no money leaves both totals", () => {
    robinhoodLedger();
    const position = cashPosition(bundle.db);
    expect(position.spendableCents).toBe(300760);
    expect(position.investableCents).toBe(7301320 + 90 + 2664);
    expect(position.spendableCents + position.investableCents).toBe(300760 + 7301320 + 90 + 2664);
  });

  test("an archived account is in neither total", () => {
    const { settlement } = robinhoodLedger();
    updateAccount(bundle.db, settlement, { isActive: false });
    expect(cashPosition(bundle.db).investableCents).toBe(7301320 + 2664);
  });

  test("card debt is a positive magnitude, netted down by a card in credit", () => {
    const owing = createAccount(bundle.db, { institutionId: instId, name: "Owing", type: "credit" });
    const inCredit = createAccount(bundle.db, { institutionId: instId, name: "In credit", type: "credit" });
    setBalance(owing, -112693);
    setBalance(inCredit, 8272);
    expect(cashPosition(bundle.db)).toMatchObject({ cardDebtCents: 112693 - 8272, cardCreditCents: 8272 });
  });
});
