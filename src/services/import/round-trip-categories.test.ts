import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { importFiles } from "@/db/schema/imports";
import { transactions } from "@/db/schema/transactions";
import { PROFILES } from "./profiles";
import { importStatementFiles, type ImportInput } from "./service";
import type { AccountHint, ParsedStatement, ParserProfile } from "./types";
import { unimportCountsByFile } from "./unimport-counts";

/**
 * What a round trip does to categories no engine of the import derives from the surviving record.
 *
 * 🔴 A line another record already holds is absorbed, and its bank category went with it: the statement row that
 * records the charge has none. Measured on a copy of the real ledger, 2026-09-16: un-importing
 * 20260602-statements-9805-.pdf and Spending Report PDF (1).pdf, then importing the statement and the report again,
 * took uncategorized 32 -> 86 (of the 80 May rows the round trip rewrote, 55 had held the report's bank category and 7
 * a hand one) while no row's money moved.
 */

let dir: string;
let bundle: DbBundle;

const PREFIX = "round-trip-categories-";
const CARD: AccountHint = { institution: "Chase", type: "checking", last4: "4301" };

const SECTIONS: Record<string, ParsedStatement[]> = {
  statement: [
    {
      accountHint: CARD,
      txns: [
        { postedOn: "2026-05-05", transactedOn: "2026-05-05", amountCents: -2500, rawDescription: "ZQX HOLLOW 12 MIAMI FL" },
        { postedOn: "2026-05-06", transactedOn: "2026-05-06", amountCents: -900, rawDescription: "ZQX LANTERN MIAMI FL" },
      ],
      period: { start: "2026-05-01", end: "2026-05-31", beginCents: 10_000, endCents: 6_600 },
    },
  ],
  // the bank's report posts the same charges two days later, with its own words and its own buckets
  report: [
    {
      accountHint: CARD,
      txns: [
        { postedOn: "2026-05-07", transactedOn: "2026-05-05", amountCents: -2500, rawDescription: "ZQX HOLLOW 12", bankCategory: "GROCERIES" },
        { postedOn: "2026-05-08", transactedOn: "2026-05-06", amountCents: -900, rawDescription: "ZQX LANTERN", bankCategory: "NOT_A_BUCKET" },
      ],
    },
  ],
};

const profile: ParserProfile = {
  id: "test-round-trip-categories",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: (f) => SECTIONS[f.text.trim()]!,
};

const file = (name: string): ImportInput => ({ name: `${PREFIX}${name}.csv`, buffer: Buffer.from(name) });
const STATEMENT = file("statement");
const REPORT = file("report");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-round-trip-categories-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  PROFILES.unshift(profile);
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

const accountId = () => bundle.db.select().from(accounts).where(eq(accounts.last4, CARD.last4!)).get()!.id;
const live = () =>
  bundle.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId()), ne(transactions.status, "superseded")))
    .orderBy(transactions.postedOn)
    .all();
const fileId = (input: ImportInput) => bundle.db.select().from(importFiles).where(eq(importFiles.fileName, input.name)).get()!.id;
const groceries = () => {
  const food = bundle.db.select().from(categories).where(eq(categories.name, "Food")).get()!;
  return bundle.db.select().from(categories).where(and(eq(categories.name, "Groceries"), eq(categories.parentId, food.id))).get()!.id;
};

describe("a line absorbed by another record gives it the bank category it prints", () => {
  test("the statement's row takes the report's bank bucket, and is categorized by it", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    expect(live().map((r) => r.categoryId)).toEqual([null, null]);

    const [outcome] = await importStatementFiles(bundle.db, [REPORT]);
    expect(outcome).toMatchObject({ status: "parsed", inserted: 0, dedupedCrossFormat: 2 });

    const [hollow, lantern] = live();
    expect(hollow).toMatchObject({ bankCategory: "GROCERIES", categoryId: groceries(), categorizationSource: "bank_category", importFileId: fileId(STATEMENT) });
    // a bucket the app does not map is kept, and categorizes nothing
    expect(lantern).toMatchObject({ bankCategory: "NOT_A_BUCKET", categoryId: null });
  });

  test("a record that already has a bank category keeps its own", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    const [hollow] = live();
    bundle.db.update(transactions).set({ bankCategory: "SHOPPING" }).where(eq(transactions.id, hollow!.id)).run();

    await importStatementFiles(bundle.db, [REPORT]);
    expect(live()[0]).toMatchObject({ id: hollow!.id, bankCategory: "SHOPPING" });
  });
});

describe("the un-import confirmation counts the categories no import derives again", () => {
  test("Claude's categories and categories with no recorded source are counted apart from the hand-set ones", async () => {
    await importStatementFiles(bundle.db, [STATEMENT]);
    const [hollow, lantern] = live();
    const cat = groceries();
    bundle.db.update(transactions).set({ categoryId: cat, categorizationSource: "claude" }).where(eq(transactions.id, hollow!.id)).run();
    bundle.db.update(transactions).set({ categoryId: cat, categorizationSource: null }).where(eq(transactions.id, lantern!.id)).run();

    expect(unimportCountsByFile(bundle.db).get(fileId(STATEMENT))).toMatchObject({
      deleted: 2,
      userCategorizedDeleted: 0,
      notRederivedDeleted: 2,
    });

    bundle.db.update(transactions).set({ categorizationSource: "user" }).where(eq(transactions.id, lantern!.id)).run();
    expect(unimportCountsByFile(bundle.db).get(fileId(STATEMENT))).toMatchObject({ userCategorizedDeleted: 1, notRederivedDeleted: 1 });
  });
});
