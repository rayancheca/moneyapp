import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/**
 * /transactions' redirect-style form adapters against a real (temporary) database: each leaves the page on every
 * press, back to the filtered view it was pressed from (`returnTo`), and a press made while that view shows a refusal
 * takes the refusal's place in his history (`landBack`).
 *
 * 🔴 The review of cb2e89ac (2026-11-05) read the header strip's Categorize / Stop / Classify merchants adapters
 * redirecting after every press with Next's default — a push — the shape that brought /budgets' refusal back on one
 * Back above the budget he had just created (a dev server over his ledger copy 10-29b).
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-transaction-actions-"));
process.env.MONEYAPP_DB_PATH = path.join(dir, "t.db");
const dbCache = globalThis as { __moneyappDb?: unknown };
delete dbCache.__moneyappDb;

const { getDbBundle } = await import("@/db/client");
const { seedDatabase } = await import("@/db/seed");
const { correctCategoryAction, runCategorizationAction, stopClassifyAction } = await import("./actions");
const { refusalShownFields } = await import("@/components/ui/ErrorBanner");

beforeAll(() => {
  seedDatabase(getDbBundle().db);
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

const VIEW = "?view=review&page=2";

describe("/transactions — a press made while a refusal shows takes the refusal's place in his history", () => {
  test("Run categorization under a refusal lands on the view it was pressed from, in its place", async () => {
    expect(await press(runCategorizationAction, form({ returnTo: VIEW }, "Missing transaction"))).toEqual([
      { url: `/transactions${VIEW}`, type: "replace" },
    ]);
  });

  test("…and Stop Claude run, from the unfiltered view", async () => {
    expect(await press(stopClassifyAction, form({ returnTo: "" }, "Missing transaction"))).toEqual([
      { url: "/transactions", type: "replace" },
    ]);
  });

  test("with none shown, a press lands on its view as it always did", async () => {
    expect(await press(runCategorizationAction, form({ returnTo: VIEW }))).toEqual([
      { url: `/transactions${VIEW}`, type: "push" },
    ]);
  });

  test("a refusal follows the view's own query (`&error=`) — pushed, or in a shown refusal's place", async () => {
    expect(await press(correctCategoryAction, form({ returnTo: VIEW, categoryId: "c" }))).toEqual([
      { url: `/transactions${VIEW}&error=${encodeURIComponent("Missing transaction")}`, type: "push" },
    ]);
    expect(await press(correctCategoryAction, form({ returnTo: "", categoryId: "c" }, "Missing transaction"))).toEqual([
      { url: `/transactions?error=${encodeURIComponent("Missing transaction")}`, type: "replace" },
    ]);
  });
});
