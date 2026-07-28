import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { institutions } from "@/db/schema/institutions";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "./accounts";
import { setMerchantDefaultCategory } from "./merchants";
import { claudeRunState, classifyPendingMerchants, pendingMerchantQueue } from "./claude-categorize";

// NO network: the SDK is a stub class, so `new Anthropic()` never opens a
// socket and every batch response is whatever the test hands it.
const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMessage };
  },
}));

process.env.MONEYAPP_FAKE_PRICES = "1";

let dir: string;
let bundle: DbBundle;
let checkingId: string;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-credential";
  createMessage.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-claude-cat-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const COFFEE_RAW = "BLUE BOTTLE COFFEE 4471";

let seq = 0;
function insertTxn(rawDescription = COFFEE_RAW): string {
  seq += 1;
  return bundle.db
    .insert(transactions)
    .values({
      accountId: checkingId,
      postedOn: "2026-06-15",
      amountCents: -742,
      rawDescription,
      normalizedDescription: normalizeDescription(rawDescription),
      dedupeHash: dedupeHash({
        accountId: checkingId,
        postedOn: "2026-06-15",
        amountCents: -742,
        rawDescription: `${rawDescription}#${seq}`,
        occurrenceIndex: 0,
      }),
    })
    .returning({ id: transactions.id })
    .get().id;
}

function categoryIdFor(name: string): string {
  return bundle.db.select().from(categories).where(eq(categories.name, name)).all()[0]!.id;
}

function txnRow(id: string) {
  return bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
}

/** one batch answer from the model, in the SDK's response shape */
function mockBatch(
  merchantsOut: { description: string; canonicalName: string; category: string; confidence: number }[],
): void {
  createMessage.mockResolvedValue({
    content: [{ type: "tool_use", input: { merchants: merchantsOut } }],
    usage: { input_tokens: 100, output_tokens: 40 },
  });
}

describe("classifyPendingMerchants — user precedence over the model", () => {
  test("a user-set merchant default wins: rows get the USER's category, not Claude's", async () => {
    // Arrange: the user has already decided Blue Bottle is Food > Coffee
    const coffee = categoryIdFor("Coffee");
    const blueBottle = bundle.db
      .insert(merchants)
      .values({ canonicalName: "Blue Bottle Coffee" })
      .returning({ id: merchants.id })
      .get();
    setMerchantDefaultCategory(bundle.db, blueBottle.id, coffee); // stamps mappingSource='user'
    const rowId = insertTxn();
    // …and Claude disagrees, confidently
    mockBatch([
      {
        description: normalizeDescription(COFFEE_RAW),
        canonicalName: "Blue Bottle Coffee",
        category: "Shopping > General",
        confidence: 0.99,
      },
    ]);

    // Act
    const result = await classifyPendingMerchants(bundle.db);

    // Assert: the mapping the user owns decided the rows
    expect(result.classified).toBe(1);
    const row = txnRow(rowId);
    expect(row.categoryId).toBe(coffee);
    expect(row.categorizationSource).toBe("merchant_map");
    expect(row.categorizationConfidence).toBe(1);
    expect(row.merchantId).toBe(blueBottle.id);
    // the merchant's own default is untouched either way
    expect(
      bundle.db.select().from(merchants).where(eq(merchants.id, blueBottle.id)).get()!.defaultCategoryId,
    ).toBe(coffee);
  });

  test("a low-confidence answer under a user mapping is certain, not review-flagged", async () => {
    const coffee = categoryIdFor("Coffee");
    const blueBottle = bundle.db
      .insert(merchants)
      .values({ canonicalName: "Blue Bottle Coffee" })
      .returning({ id: merchants.id })
      .get();
    setMerchantDefaultCategory(bundle.db, blueBottle.id, coffee);
    const rowId = insertTxn();
    mockBatch([
      {
        description: normalizeDescription(COFFEE_RAW),
        canonicalName: "Blue Bottle Coffee",
        category: "Shopping > General",
        confidence: 0.2,
      },
    ]);

    const result = await classifyPendingMerchants(bundle.db);

    expect(result.needsReview).toBe(0);
    expect(txnRow(rowId).needsReview).toBe(false);
    expect(txnRow(rowId).categoryId).toBe(coffee);
  });

  test("a seed/unmapped merchant still takes Claude's category, flagged below the threshold", async () => {
    const rowId = insertTxn();
    mockBatch([
      {
        description: normalizeDescription(COFFEE_RAW),
        canonicalName: "Blue Bottle Coffee",
        category: "Food > Coffee",
        confidence: 0.5,
      },
    ]);

    const result = await classifyPendingMerchants(bundle.db);

    expect(result.classified).toBe(1);
    expect(result.needsReview).toBe(1);
    const row = txnRow(rowId);
    expect(row.categoryId).toBe(categoryIdFor("Coffee"));
    expect(row.categorizationSource).toBe("claude");
    expect(row.needsReview).toBe(true);
    // a brand-new merchant is recorded as Claude's, never as the user's
    expect(
      bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Blue Bottle Coffee")).get()!
        .mappingSource,
    ).toBe("claude");
  });

  test("a row the user deliberately left uncategorized is neither queued nor written", async () => {
    const userLeftBlank = insertTxn();
    const sibling = insertTxn();
    bundle.db
      .update(transactions)
      .set({ categorizationSource: "user" }) // category stays NULL — a decision, not a gap
      .where(eq(transactions.id, userLeftBlank))
      .run();

    // the queue counts descriptions, and this description still has one real row
    expect(pendingMerchantQueue(bundle.db)).toEqual([
      { description: normalizeDescription(COFFEE_RAW), count: 1 },
    ]);

    mockBatch([
      {
        description: normalizeDescription(COFFEE_RAW),
        canonicalName: "Blue Bottle Coffee",
        category: "Food > Coffee",
        confidence: 0.95,
      },
    ]);
    const result = await classifyPendingMerchants(bundle.db);

    expect(result.classified).toBe(1);
    expect(txnRow(sibling).categoryId).toBe(categoryIdFor("Coffee"));
    const untouched = txnRow(userLeftBlank);
    expect(untouched.categoryId).toBeNull();
    expect(untouched.categorizationSource).toBe("user");
    expect(untouched.merchantId).toBeNull();
  });
});

describe("classifyPendingMerchants — a failed run is recorded as failed", () => {
  test("a throwing batch records failed + message and clears the running flag", async () => {
    insertTxn();
    createMessage.mockRejectedValue(new Error("401 authentication_error: invalid x-api-key"));

    await expect(classifyPendingMerchants(bundle.db)).rejects.toThrow(/401/);

    const { isRunning, lastRun } = claudeRunState(bundle.db);
    expect(isRunning).toBe(false);
    expect(lastRun).not.toBeNull();
    expect(lastRun!.ran).toBe(true);
    expect(lastRun!.failed).toBe(true);
    expect(lastRun!.error).toMatch(/invalid x-api-key/);
    // nothing was classified, and the queue is intact for the retry
    expect(lastRun!.classified).toBe(0);
    expect(pendingMerchantQueue(bundle.db).length).toBe(1);
  });

  test("a successful run is never marked failed", async () => {
    insertTxn();
    mockBatch([
      {
        description: normalizeDescription(COFFEE_RAW),
        canonicalName: "Blue Bottle Coffee",
        category: "Food > Coffee",
        confidence: 0.95,
      },
    ]);

    const result = await classifyPendingMerchants(bundle.db);

    expect(result.failed).toBeUndefined();
    expect(result.error).toBeUndefined();
    const { lastRun } = claudeRunState(bundle.db);
    expect(lastRun!.failed).toBeUndefined();
    expect(lastRun!.classified).toBe(1);
  });
});
