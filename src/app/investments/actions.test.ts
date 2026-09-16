import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/**
 * The add-holding action against a real (temporary) database.
 *
 * ⚖️ Owner decisions: what Claude's agent buys sits in a brokerage book paired with Robinhood Agentic (2026-09-15),
 * its positions from statements only, and the book is kept out of his own returns (2026-09-14).
 *
 * 🔴 The Add-holding form offered the agent's book and the action wrote whatever it was given: a hand-entered share
 * in a book whose every position a statement proves, which the next statement then contradicts (measured 2026-09-16
 * on the branch).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// getDb() reads MONEYAPP_DB_PATH lazily on first call, so pointing it at a temp
// file before any action runs keeps the owner's real database untouched.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-investment-actions-"));
process.env.MONEYAPP_DB_PATH = path.join(dir, "t.db");
// the connection is cached on globalThis — drop any inherited handle so this file can never write another database
const dbCache = globalThis as { __moneyappDb?: unknown };
delete dbCache.__moneyappDb;

const { getDbBundle } = await import("@/db/client");
const { seedDatabase } = await import("@/db/seed");
const { accounts } = await import("@/db/schema/accounts");
const { holdings } = await import("@/db/schema/holdings");
const { institutions } = await import("@/db/schema/institutions");
const { createAccount } = await import("@/services/accounts");
const { addHoldingResultAction } = await import("./actions");

let brokerage: string;
let book: string;

beforeAll(() => {
  const { db } = getDbBundle();
  seedDatabase(db);
  const robinhood = db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  brokerage = createAccount(db, { institutionId: robinhood.id, name: "Robinhood Brokerage", type: "investment", subtype: "brokerage" });
  const agentic = createAccount(db, { institutionId: robinhood.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
  book = createAccount(db, { institutionId: robinhood.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
  db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
});

afterAll(() => {
  getDbBundle().sqlite.close();
  delete dbCache.__moneyappDb;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_DB_PATH;
});

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const heldIn = (accountId: string) =>
  getDbBundle()
    .db.select({ symbol: holdings.symbol, quantityE8: holdings.quantityE8 })
    .from(holdings)
    .where(eq(holdings.accountId, accountId))
    .all();

describe("addHoldingResultAction — hand-entered positions go to his own books only", () => {
  test("⛔ the agent's book is refused, and nothing is written", async () => {
    const result = await addHoldingResultAction(form({ accountId: book, symbol: "WMT", assetType: "stock", quantity: "0.25", occurredOn: "2026-08-20" }));

    expect(result).toEqual({
      ok: false,
      error: "Account: Robinhood Agentic Brokerage holds only what its statements prove — pick one of your own investment accounts",
    });
    expect(heldIn(book)).toEqual([]);
  });

  test("his own brokerage takes the position", async () => {
    const result = await addHoldingResultAction(form({ accountId: brokerage, symbol: "WMT", assetType: "stock", quantity: "0.25", occurredOn: "2026-08-20" }));

    expect(result).toEqual({ ok: true, data: { symbol: "WMT", quantityE8: 25_000_000 } });
    expect(heldIn(brokerage)).toEqual([{ symbol: "WMT", quantityE8: 25_000_000 }]);
  });

  test("an account that is not an investment account is still refused as before", async () => {
    const { db } = getDbBundle();
    const agentic = db.select().from(accounts).where(eq(accounts.name, "Robinhood Agentic")).get()!;

    const result = await addHoldingResultAction(form({ accountId: agentic.id, symbol: "WMT", assetType: "stock", quantity: "1" }));

    expect(result.ok).toBe(false);
    expect(heldIn(agentic.id)).toEqual([]);
  });
});
