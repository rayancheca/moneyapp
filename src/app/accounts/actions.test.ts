import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/**
 * The accounts form actions against a real (temporary) database.
 *
 * These cover the failure the owner hit twice in the live app: typing a
 * non-number into "Record a balance" threw out of a `<form action>`, which Next
 * turns into an error digest that replaces the whole document and loses every
 * other field. Nothing here may throw except `redirect`, which throws by design.
 */

const redirects = vi.hoisted(() => [] as string[]);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    redirects.push(url);
    // mirrors Next's real control flow: redirect() never returns
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// getDb() reads MONEYAPP_DB_PATH lazily on first call, so pointing it at a temp
// file before any action runs keeps the owner's real database untouched.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-account-actions-"));
process.env.MONEYAPP_DB_PATH = path.join(dir, "t.db");
// vitest isolates test files today, but the connection is cached on globalThis —
// drop any inherited handle so this file can never write another file's (or the
// owner's real) database if isolation is ever turned off.
const dbCache = globalThis as { __moneyappDb?: unknown };
delete dbCache.__moneyappDb;

const { getDbBundle } = await import("@/db/client");
const { seedDatabase } = await import("@/db/seed");
const { institutions } = await import("@/db/schema/institutions");
const { accounts } = await import("@/db/schema/accounts");
const { balanceAnchors } = await import("@/db/schema/balances");
const { createAccount } = await import("@/services/accounts");
const {
  addAnchorAction,
  addAnchorResultAction,
  createAccountAction,
  createAccountResultAction,
  deleteAnchorResultAction,
  setAccountActiveResultAction,
} = await import("./actions");

let institutionId: string;
let accountId: string;

beforeAll(() => {
  const { db } = getDbBundle();
  seedDatabase(db);
  institutionId = db.select().from(institutions).all()[0]!.id;
  accountId = createAccount(db, { institutionId, name: "Test Checking", type: "checking" });
});

afterAll(() => {
  getDbBundle().sqlite.close();
  delete dbCache.__moneyappDb;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_DB_PATH;
});

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("addAnchorResultAction", () => {
  test("records a balance and returns the parsed cents", async () => {
    const result = await addAnchorResultAction(
      form({ accountId, anchoredOn: "2026-01-15", balance: "1,234.56" }),
    );
    expect(result).toEqual({ ok: true, data: { accountId, enteredCents: 123_456 } });
    const rows = getDbBundle()
      .db.select()
      .from(balanceAnchors)
      .where(eq(balanceAnchors.accountId, accountId))
      .all();
    expect(rows.some((r) => r.balanceCents === 123_456)).toBe(true);
  });

  test('"not a number" returns a Balance-named error instead of throwing', async () => {
    const result = await addAnchorResultAction(
      form({ accountId, anchoredOn: "2026-01-16", balance: "not a number" }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^Balance: /);
    expect(result.ok === false && result.error).not.toContain("Cannot parse amount");
  });

  test("a blank balance reports the schema's own message", async () => {
    const result = await addAnchorResultAction(
      form({ accountId, anchoredOn: "2026-01-16", balance: "" }),
    );
    expect(result).toEqual({ ok: false, error: "Enter a balance" });
  });

  test("a missing account reports rather than writing", async () => {
    const result = await addAnchorResultAction(form({ anchoredOn: "2026-01-16", balance: "10" }));
    expect(result.ok).toBe(false);
  });
});

describe("addAnchorAction (the <form action> adapter)", () => {
  test("a bad balance redirects back to the account with ?error= instead of a 500", async () => {
    redirects.length = 0;
    await expect(
      addAnchorAction(form({ accountId, anchoredOn: "2026-01-17", balance: "not a number" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirects).toHaveLength(1);
    const url = new URL(redirects[0]!, "http://localhost");
    expect(url.pathname).toBe(`/accounts/${accountId}`);
    expect(url.searchParams.get("error")).toMatch(/^Balance: /);
  });

  test("a valid balance does not redirect at all", async () => {
    redirects.length = 0;
    await expect(
      addAnchorAction(form({ accountId, anchoredOn: "2026-01-18", balance: "50" })),
    ).resolves.toBeUndefined();
    expect(redirects).toEqual([]);
  });
});

describe("createAccountResultAction", () => {
  test("a bad initial balance fails BEFORE the insert, leaving no orphan account", async () => {
    const { db } = getDbBundle();
    const before = db.select().from(accounts).all().length;
    const result = await createAccountResultAction(
      form({ institutionId, name: "Orphan", type: "checking", initialBalance: "twelve" }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^Initial balance: /);
    expect(db.select().from(accounts).all().length).toBe(before);
  });

  test("an unknown type is reported with the field name, not thrown", async () => {
    const result = await createAccountResultAction(
      form({ institutionId, name: "Weird", type: "piggybank" }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^Account type: /);
  });

  test("a blank name reports the schema's own message", async () => {
    const result = await createAccountResultAction(
      form({ institutionId, name: "  ", type: "checking" }),
    );
    expect(result).toEqual({ ok: false, error: "Name the account" });
  });

  test("creates the account and its opening anchor", async () => {
    const result = await createAccountResultAction(
      form({ institutionId, name: "Opened", type: "savings", initialBalance: "$2,000" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const anchors = getDbBundle()
      .db.select()
      .from(balanceAnchors)
      .where(eq(balanceAnchors.accountId, result.data.id))
      .all();
    expect(anchors.map((a) => a.balanceCents)).toContain(200_000);
  });
});

describe("createAccountAction (the <form action> adapter)", () => {
  test("a failure redirects to /accounts?error= rather than surfacing a digest", async () => {
    redirects.length = 0;
    await expect(
      createAccountAction(form({ institutionId, name: "", type: "checking" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    const url = new URL(redirects[0]!, "http://localhost");
    expect(url.pathname).toBe("/accounts");
    expect(url.searchParams.get("error")).toBe("Name the account");
  });

  test("success still redirects to the new account's page", async () => {
    redirects.length = 0;
    await expect(
      createAccountAction(form({ institutionId, name: "Redirected", type: "checking" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirects[0]).toMatch(/^\/accounts\/[^?]+$/);
  });
});

describe("the remaining account form actions report instead of no-oping", () => {
  test("deleteAnchorResultAction names the missing field", async () => {
    const result = await deleteAnchorResultAction(form({ accountId }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("Pick a balance entry");
  });

  test("setAccountActiveResultAction round-trips the archive toggle", async () => {
    const archived = await setAccountActiveResultAction(form({ accountId, isActive: "false" }));
    expect(archived).toEqual({ ok: true, data: { accountId, isActive: false } });
    const restored = await setAccountActiveResultAction(form({ accountId, isActive: "true" }));
    expect(restored).toEqual({ ok: true, data: { accountId, isActive: true } });
  });

  test("setAccountActiveResultAction rejects a value that is neither true nor false", async () => {
    const result = await setAccountActiveResultAction(form({ accountId, isActive: "maybe" }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^Status: /);
  });
});
