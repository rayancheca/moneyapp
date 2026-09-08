import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import {
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
