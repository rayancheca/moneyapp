import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/**
 * /budgets' two form adapters against a real (temporary) database: where each press lands, and the history entry it
 * asks Next for (`undefined` would be Next's default — a push, inside a server action).
 *
 * 🔴 The review of cb2e89ac (2026-11-05, a dev server over his ledger copy 10-29b): /accounts, then /budgets (history
 * 3); "Create budget" with Housing, Annual, 0 → `/budgets?error=Budget amount must be positive` (4); 12.34, Annual →
 * /budgets with no alert (5); one Back → `/budgets?error=Budget amount must be positive`, the alert above the budget
 * he had just created. A press made while the page shows a refusal takes the refusal's entry (`landBack`).
 */

const navigations = vi.hoisted(() => [] as { url: string; type: string | undefined }[]);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string, type?: string): never => {
    navigations.push({ url, type });
    // mirrors Next's real control flow: redirect() never returns
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// getDb() reads MONEYAPP_DB_PATH lazily on first call, so pointing it at a temp file before any action runs keeps the
// owner's real database untouched; the connection is cached on globalThis, so drop any inherited handle first
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-budget-actions-"));
process.env.MONEYAPP_DB_PATH = path.join(dir, "t.db");
const dbCache = globalThis as { __moneyappDb?: unknown };
delete dbCache.__moneyappDb;

const { getDbBundle } = await import("@/db/client");
const { seedDatabase } = await import("@/db/seed");
const { categories } = await import("@/db/schema/categories");
const { budgets } = await import("@/db/schema/budgets");
const { createBudget } = await import("@/services/budgets");
const { createBudgetAction, deactivateBudgetAction } = await import("./actions");
const { refusalShownFields } = await import("@/components/ui/ErrorBanner");

let housingId: string;

beforeAll(() => {
  const { db } = getDbBundle();
  seedDatabase(db);
  housingId = db.select().from(categories).where(eq(categories.name, "Housing")).get()!.id;
});

afterAll(() => {
  getDbBundle().sqlite.close();
  delete dbCache.__moneyappDb;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_DB_PATH;
});

function form(entries: Record<string, string>, refusal: string | null = null): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...entries, ...refusalShownFields(refusal) })) fd.set(k, v);
  return fd;
}

/** where the press landed, and how — `redirect()` throws by design, so the press rejects with it */
async function press(action: (formData: FormData) => Promise<void>, formData: FormData): Promise<typeof navigations> {
  navigations.length = 0;
  await expect(action(formData)).rejects.toThrow(/NEXT_REDIRECT/);
  return [...navigations];
}

const REFUSED = "Budget amount must be positive";

describe("/budgets — a press made while a refusal shows takes the refusal's place in his history", () => {
  test("the measured steps: Housing, Annual, 0 is pushed; 12.34 takes its place — Back is /budgets", async () => {
    expect(await press(createBudgetAction, form({ categoryId: housingId, period: "annual", amount: "0" }))).toEqual([
      { url: `/budgets?error=${encodeURIComponent(REFUSED)}`, type: "push" },
    ]);
    expect(
      await press(createBudgetAction, form({ categoryId: housingId, period: "annual", amount: "12.34" }, REFUSED)),
    ).toEqual([{ url: "/budgets", type: "replace" }]);
    const { db } = getDbBundle();
    const created = db
      .select()
      .from(budgets)
      .where(and(eq(budgets.categoryId, housingId), eq(budgets.period, "annual"), eq(budgets.isActive, true)))
      .get();
    expect(created?.amountCents).toBe(1234);
  });

  test("a refusal over a refusal takes its place too — Back is never the refusal before it", async () => {
    const noCategory = form({ categoryId: "", period: "monthly", amount: "600" }, REFUSED);
    expect(await press(createBudgetAction, noCategory)).toEqual([
      { url: `/budgets?error=${encodeURIComponent("Pick a category")}`, type: "replace" },
    ]);
  });

  test("a budget deactivated while a refusal shows takes its place, and one refused there is said in it", async () => {
    const { db } = getDbBundle();
    // its own budget, so this reads the Deactivate form alone — not what the create form above left
    const weekly = createBudget(db, { categoryId: housingId, period: "weekly", amountCents: 5_000 });
    expect(await press(deactivateBudgetAction, form({ budgetId: weekly }, REFUSED))).toEqual([
      { url: "/budgets", type: "replace" },
    ]);
    expect(db.select().from(budgets).where(eq(budgets.id, weekly)).get()?.isActive).toBe(false);
    expect(await press(deactivateBudgetAction, form({ budgetId: "" }, REFUSED))).toEqual([
      { url: `/budgets?error=${encodeURIComponent("Pick a budget")}`, type: "replace" },
    ]);
  });

  test("with none shown, a press lands on /budgets as it always did", async () => {
    expect(await press(createBudgetAction, form({ categoryId: housingId, period: "monthly", amount: "600" }))).toEqual([
      { url: "/budgets", type: "push" },
    ]);
  });
});
