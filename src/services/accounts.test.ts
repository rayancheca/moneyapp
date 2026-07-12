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
  createAccount,
  createInstitution,
  editAccount,
  getAccount,
  listAccounts,
  reorderAccounts,
} from "./accounts";

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
