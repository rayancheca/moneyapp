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
/** the history entry each of `redirects` asked Next for (`undefined`: Next's default — a push, in a server action) */
const entries = vi.hoisted(() => [] as (string | undefined)[]);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string, type?: string): never => {
    redirects.push(url);
    entries.push(type);
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
const { holdingEvents } = await import("@/db/schema/holding-events");
const { createAccount } = await import("@/services/accounts");
const { CASH_INSTITUTION_NAME } = await import("@/services/manual-transactions");
const {
  addAnchorAction,
  addAnchorResultAction,
  createAccountAction,
  createAccountResultAction,
  deleteAnchorAction,
  deleteAnchorResultAction,
  setAccountActiveAction,
  setAccountActiveResultAction,
} = await import("./actions");
const { refusalShownFields } = await import("@/components/ui/ErrorBanner");

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

/** a form on the page while it shows a refusal (`refusalShownFields`) */
function shown(entries: Record<string, string>): FormData {
  return form({ ...entries, ...refusalShownFields("Balance: that amount didn't parse") });
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

  /*
   * ⚖️ §6A 58 (owner, 2026-10-08): an account priced from its holdings takes no balance he counts. The page hides the
   * form there; a post that reaches the action anyway (a stale tab) is told why, and nothing is written.
   */
  test("a count on an account priced from its holdings is refused with the reason, writing nothing", async () => {
    const { db } = getDbBundle();
    const brokerage = createAccount(db, { institutionId, name: "Robinhood Brokerage", type: "investment" });
    db.insert(holdingEvents)
      .values({
        accountId: brokerage,
        symbol: "AAPL",
        assetType: "stock",
        occurredOn: "2026-01-02",
        quantityDeltaE8: 100_000_000,
      })
      .run();

    const result = await addAnchorResultAction(
      form({ accountId: brokerage, anchoredOn: "2026-01-15", balance: "17,000.00" }),
    );

    expect(result).toEqual({
      ok: false,
      error:
        "Robinhood Brokerage is priced from its holdings — a balance you counted there would play no part in its curve",
    });
    expect(db.select().from(balanceAnchors).where(eq(balanceAnchors.accountId, brokerage)).all()).toEqual([]);
  });

  test("an investment account with no holding events still takes a count — there it is its value", async () => {
    const { db } = getDbBundle();
    const bare = createAccount(db, { institutionId, name: "Bare holding", type: "investment" });

    const result = await addAnchorResultAction(
      form({ accountId: bare, anchoredOn: "2026-01-15", balance: "12,000.00" }),
    );

    expect(result).toEqual({ ok: true, data: { accountId: bare, enteredCents: 1_200_000 } });
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

  /*
   * 🔴 The review of 425ae02c (2026-11-05): a mistyped balance on /accounts/[id] refused to `?error=`, and the right one
   * after it landed under that URL — the refusal stayed beside the balance he had just added (`landBack`).
   */
  test("…and one that lands while a refusal shows goes back to the account with none — its banner gone", async () => {
    redirects.length = 0;
    await expect(addAnchorAction(shown({ accountId, anchoredOn: "2026-01-19", balance: "60" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(redirects).toEqual([`/accounts/${accountId}`]);
  });
});

/*
 * The account page's other two forms: a balance removed, the account archived or restored. Each is refused on /accounts
 * (`?error=`), and each, landing while the account page shows a refusal — a balance refused there — goes back to it
 * with none.
 */
describe("deleteAnchorAction and setAccountActiveAction (the account page's other adapters)", () => {
  test("a balance removed while a refusal shows goes back to the account with none", async () => {
    await addAnchorResultAction(form({ accountId, anchoredOn: "2026-01-20", balance: "70" }));
    const { db } = getDbBundle();
    const added = db.select().from(balanceAnchors).all().find((a) => a.accountId === accountId && a.anchoredOn === "2026-01-20")!;
    redirects.length = 0;

    await expect(deleteAnchorAction(shown({ anchorId: added.id, accountId }))).rejects.toThrow(/NEXT_REDIRECT/);

    expect(redirects).toEqual([`/accounts/${accountId}`]);
    expect(db.select().from(balanceAnchors).all().map((a) => a.id)).not.toContain(added.id);
  });

  test("…and the account restored while one shows", async () => {
    redirects.length = 0;
    await expect(setAccountActiveAction(shown({ accountId, isActive: "true" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirects).toEqual([`/accounts/${accountId}`]);
  });

  test("a refusal is still said on /accounts, and a press that lands with none showing stays where it is", async () => {
    redirects.length = 0;
    await expect(deleteAnchorAction(form({ accountId }))).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(setAccountActiveAction(form({ accountId, isActive: "true" }))).resolves.toBeUndefined();
    expect(redirects).toEqual([`/accounts?error=${encodeURIComponent("Pick a balance entry")}`]);
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

  test("a cash institution is refused here and pointed at the wallet form", async () => {
    // This form anchors on TODAY. A wallet needs an opening DATE, or its
    // balance freezes at the anchor for every entry dated today or earlier —
    // the owner would add spending and watch the number not move.
    const { db } = getDbBundle();
    const cashInstitutionId = db
      .insert(institutions)
      .values({ name: CASH_INSTITUTION_NAME })
      .returning({ id: institutions.id })
      .get().id;
    const before = db.select().from(accounts).all().length;

    const result = await createAccountResultAction(
      form({ institutionId: cashInstitutionId, name: "Pocket", type: "checking" }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/New cash wallet/);
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

  /*
   * 🔴 The review of cb2e89ac (2026-11-05): an adapter that leaves its page on every press kept Next's default, a push
   * — on /budgets one Back after the budget that landed brought the refusal back above it. A new account is the same
   * shape: created while /accounts shows a refusal, it takes the refusal's entry, so Back is /accounts with none.
   */
  test("one created while /accounts shows a refusal takes its place — Back is /accounts with none", async () => {
    redirects.length = 0;
    entries.length = 0;
    await expect(
      createAccountAction(shown({ institutionId, name: "After a refusal", type: "checking" })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(createAccountAction(shown({ institutionId, name: "", type: "checking" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    await expect(createAccountAction(form({ institutionId, name: "", type: "checking" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(redirects[0]).toMatch(/^\/accounts\/[^?]+$/);
    expect(redirects.slice(1)).toEqual([
      `/accounts?error=${encodeURIComponent("Name the account")}`,
      `/accounts?error=${encodeURIComponent("Name the account")}`,
    ]);
    // the landing and a refusal over a refusal take its place; a first refusal is pushed
    expect(entries).toEqual(["replace", "replace", "push"]);
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
