import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchantAliases, merchants } from "@/db/schema/merchants";
import { transactions } from "@/db/schema/transactions";
import { transferAmbiguities } from "@/db/schema/transfer-ambiguities";
import { normalizeDescription } from "@/lib/normalize";
import { createAccount } from "@/services/accounts";
import { applyCorrection } from "@/services/categorize";
import { PROFILES } from "@/services/import/profiles";
import { importStatementFiles, type ImportInput } from "@/services/import/service";
import type { AccountHint, ParsedStatement, ParserProfile } from "@/services/import/types";
import { setSplits } from "@/services/transaction-splits";
import { DbTargetRefusal } from "./db-target";
import {
  PinRefusal,
  REAL_AID,
  applyPin,
  capturePinState,
  classifyPin,
  comparePin,
  loadPinFacts,
  parsePinCli,
  rehearsePin,
  type AidIds,
  type PinState,
} from "./fordham-aid-pin";

/**
 * A ledger shaped like Chase Checking's three Fordham aid deposits on the live ledger: read from a statement, filed
 * under Income › Financial Aid by a write that left `merchant_map` as their source, while the merchant map itself files
 * Fordham under Education. The rows reach the ledger through the app's own import, so a version bump re-reads them the
 * way re-dropping data/statements/chase-checking-3522 would. The ids are the import's — only the SHAPE is the live
 * ledger's.
 */

let dir: string;
let bundle: DbBundle;
let ids: AidIds;

const PREFIX = "fordham-aid-pin-";
const CHECKING: AccountHint = { institution: "Chase", type: "checking", last4: "3522" };
const AID = REAL_AID.rawDescription;
const MARSHALLS = "Card Purchase With Pin 10/08 Marshalls 2401 US High Union NJ Card 7782";

const STATEMENT: ParsedStatement[] = [
  {
    accountHint: CHECKING,
    txns: [
      { postedOn: "2022-09-15", amountCents: 323_800, rawDescription: AID },
      { postedOn: "2023-09-28", amountCents: 568_100, rawDescription: AID },
      { postedOn: "2023-10-10", amountCents: 250_000, rawDescription: AID },
      // the charge printed beside the third deposit: the pin must leave it to the merchant map
      { postedOn: "2023-10-10", amountCents: -2_450, rawDescription: MARSHALLS },
    ],
    period: { start: "2022-09-01", end: "2023-10-31", beginCents: 100_000, endCents: 100_000 + 323_800 + 568_100 + 250_000 - 2_450 },
  },
];

const profile: ParserProfile = {
  id: "test-fordham-aid-pin",
  version: 1,
  matches: (f) => f.name.startsWith(PREFIX),
  parse: () => STATEMENT,
};
const FILE: ImportInput = { name: `${PREFIX}20231012-statements-3522-.csv`, buffer: Buffer.from("statement") };

/** Re-drops the statement at a newer parser version — the run the pin exists for. */
async function reread(): Promise<void> {
  profile.version += 1;
  const [outcome] = await importStatementFiles(bundle.db, [FILE]);
  expect(outcome).toMatchObject({ status: "parsed", inserted: 4 });
}

const categoryId = (name: string, parentName: string | null): string => {
  const parent = parentName === null ? null : bundle.db.select().from(categories).where(and(eq(categories.name, parentName), isNull(categories.parentId))).get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), parent === null ? isNull(categories.parentId) : eq(categories.parentId, parent.id)))
    .get()!.id;
};
const education = () => categoryId("Education", null);

/** The live rows on the account, as the owner's ledger lists them. */
const live = () =>
  bundle.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, ids.checkingAccountId), ne(transactions.status, "superseded")))
    .orderBy(transactions.postedOn, transactions.amountCents)
    .all();
const row = (id: string) => bundle.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
const patch = (id: string, set: Partial<typeof transactions.$inferInsert>) =>
  bundle.db.update(transactions).set(set).where(eq(transactions.id, id)).run();
const verdict = () => classifyPin(loadPinFacts(bundle, ids), ids);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-fordham-aid-pin-"));
  process.env.MONEYAPP_ORIGINALS_DIR = path.join(dir, "originals");
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  profile.version = 1;
  PROFILES.unshift(profile);

  const income = bundle.db.select().from(categories).where(and(eq(categories.name, "Income"), isNull(categories.parentId))).get()!;
  const aid = bundle.db.insert(categories).values({ name: "Financial Aid", parentId: income.id, kind: "income" }).returning().get();
  const fordham = bundle.db
    .insert(merchants)
    .values({ canonicalName: "Fordham University", defaultCategoryId: education(), mappingSource: "claude" })
    .returning()
    .get();
  bundle.db.insert(merchantAliases).values({ merchantId: fordham.id, pattern: normalizeDescription(AID), matchType: "exact", priority: 10 }).run();

  await importStatementFiles(bundle.db, [FILE]);
  const checking = bundle.db.select().from(accounts).where(eq(accounts.last4, "3522")).get()!;
  const deposits = bundle.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, checking.id), eq(transactions.rawDescription, AID)))
    .orderBy(transactions.postedOn)
    .all();
  // the live ledger's state: filed as aid by a write that kept the merchant map's source
  for (const d of deposits) patch(d.id, { categoryId: aid.id });
  ids = {
    ...REAL_AID,
    checkingAccountId: checking.id,
    financialAidId: aid.id,
    rows: deposits.map((d) => ({ id: d.id, postedOn: d.postedOn, amountCents: d.amountCents })),
  };
});

afterEach(() => {
  PROFILES.splice(PROFILES.indexOf(profile), 1);
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MONEYAPP_ORIGINALS_DIR;
});

describe("REAL_AID — the three deposits as measured on the live ledger, 2026-09-28", () => {
  test("three distinct rows on Chase Checking, on the days and for the sums the owner named", () => {
    expect(REAL_AID.rows.map((r) => [r.postedOn, r.amountCents])).toEqual([
      ["2022-09-15", 323_800],
      ["2023-09-28", 568_100],
      ["2023-10-10", 250_000],
    ]);
    expect(new Set(REAL_AID.rows.map((r) => r.id)).size).toBe(3);
    expect(REAL_AID.rawDescription).toBe("Fordham Universi Invoice PPD ID: 3131740451");
  });
});

describe("why the pin: a re-read hands the merchant map's rows back to the merchant map", () => {
  test("the seeded state is the live one: aid, filed by the merchant map, whose own default is Education", () => {
    for (const r of ids.rows) expect(row(r.id)).toMatchObject({ categoryId: ids.financialAidId, categorizationSource: "merchant_map", status: "active" });
  });

  test("unpinned, re-dropping the statement refiles all three to Education", async () => {
    await reread();
    const deposits = live().filter((r) => r.rawDescription === AID);
    expect(deposits.map((r) => [r.categoryId, r.categorizationSource])).toEqual(Array(3).fill([education(), "merchant_map"]));
  });

  test("pinned first, the same re-read keeps all three in Financial Aid — and the pin reads as done on the rows it left", async () => {
    applyPin(bundle, verdict().kind === "plan" ? ids.rows.map((r) => r.id) : [], ids);
    const neighbourBefore = live().find((r) => r.rawDescription === MARSHALLS)!;
    await reread();

    const after = live();
    const deposits = after.filter((r) => r.rawDescription === AID);
    expect(deposits.map((r) => [r.categoryId, r.categorizationSource])).toEqual(Array(3).fill([ids.financialAidId, "user"]));
    // a re-read writes new rows: the pin travelled with the money, not with the old ids
    expect(deposits.map((r) => r.id).filter((id) => ids.rows.some((r) => r.id === id))).toEqual([]);
    const neighbour = after.find((r) => r.rawDescription === MARSHALLS)!;
    expect([neighbour.categoryId, neighbour.categorizationSource]).toEqual([neighbourBefore.categoryId, neighbourBefore.categorizationSource]);

    // running the pin again after the re-drop is "nothing to do", and says where each row lives now
    expect(verdict()).toEqual({ kind: "applied", live: deposits.map((r) => r.id) });
  });
});

describe("the plan", () => {
  test("the measured state pins all three, and the pinned state is ALREADY APPLIED", () => {
    expect(verdict()).toEqual({ kind: "plan", pin: ids.rows.map((r) => r.id) });
    applyPin(bundle, ids.rows.map((r) => r.id), ids);
    expect(verdict()).toEqual({ kind: "applied", live: ids.rows.map((r) => r.id) });
  });

  test("a row he already filed as aid by hand stays as it is; the plan pins the other two", () => {
    const [first, ...rest] = ids.rows;
    applyCorrection(bundle.db, { transactionId: first!.id, categoryId: ids.financialAidId });
    expect(verdict()).toEqual({ kind: "plan", pin: rest.map((r) => r.id) });
  });

  const otherAccount = () => {
    const checking = bundle.db.select().from(accounts).where(eq(accounts.id, ids.checkingAccountId)).get()!;
    return createAccount(bundle.db, { institutionId: checking.institutionId, name: "Chase Savings", type: "savings" });
  };
  const splitInTwo = (id: string) => {
    const r = row(id);
    setSplits(bundle.db, id, [
      { categoryId: ids.financialAidId, amountCents: r.amountCents - 100 },
      { categoryId: education(), amountCents: 100 },
    ]);
  };

  test.each<[string, (id: string) => void, RegExp]>([
    ["its amount", (id) => patch(id, { amountCents: 323_700 }), /not as measured/],
    ["its day", (id) => patch(id, { postedOn: "2022-09-16" }), /not as measured/],
    ["its account", (id) => patch(id, { accountId: otherAccount() }), /not as measured/],
    ["its words", (id) => patch(id, { rawDescription: "FORDHAM UNIVERSI INVOICE" }), /not as measured/],
    ["its status", (id) => patch(id, { status: "excluded" }), /not as measured/],
    ["its category — already Education", (id) => patch(id, { categoryId: education() }), /not as measured/],
    ["its source — Claude's, not the merchant map's", (id) => patch(id, { categorizationSource: "claude" }), /categorized by claude/],
    ["its transfer group", (id) => patch(id, { transferGroupId: "grouped" }), /not as measured/],
    ["its parts — split, so the parts carry the category", splitInTwo, /not as measured/],
  ])("refuses when %s is not as measured, and names the row", (_name, change, message) => {
    const target = ids.rows[0]!.id;
    change(target);
    const v = verdict();
    expect(v.kind).toBe("refuse");
    expect(JSON.stringify(v)).toMatch(message);
    expect(JSON.stringify(v)).toContain(target);
  });

  test("refuses a row that is not in the ledger at all", () => {
    const missing: AidIds = { ...ids, rows: [...ids.rows.slice(1), { id: "gone", postedOn: "2022-09-15", amountCents: 323_800 }] };
    expect(classifyPin(loadPinFacts(bundle, missing), missing)).toEqual({ kind: "refuse", reasons: [expect.stringContaining("gone")] });
  });

  test("refuses when the re-read ran BEFORE the pin — the Education it wrote is not his to keep", async () => {
    await reread();
    const v = verdict();
    expect(v.kind).toBe("refuse");
    expect(JSON.stringify(v)).toMatch(/replaced by a re-read/);
  });

  test("…and when the re-read happened to land them on aid by the MAP's hand: filed right, still not pinned", async () => {
    // a merchant taught aid as its default files them as aid on a re-read — until the map changes again
    const merchantId = row(ids.rows[0]!.id).merchantId!;
    bundle.db.update(merchants).set({ defaultCategoryId: ids.financialAidId }).where(eq(merchants.id, merchantId)).run();
    await reread();
    expect(live().filter((r) => r.rawDescription === AID).map((r) => [r.categoryId, r.categorizationSource])).toEqual(
      Array(3).fill([ids.financialAidId, "merchant_map"]),
    );
    const v = verdict();
    expect(v.kind).toBe("refuse");
    expect(JSON.stringify(v)).toMatch(/filed by merchant_map, not by his hand/);
  });

  test("refuses a row an open transfer question is anchored on — pinning it would answer that question too", () => {
    bundle.db
      .insert(transferAmbiguities)
      .values({ accountId: ids.checkingAccountId, ambiguityKey: "k", anchorTransactionId: ids.rows[1]!.id, legCount: 2, reasonDetail: "two equal legs" })
      .run();
    const v = verdict();
    expect(v.kind).toBe("refuse");
    expect(JSON.stringify(v)).toMatch(/open transfer question/);
  });
});

describe("the write and its guards", () => {
  test("rehearsed: the source moves on exactly the three, to his hand, and nothing else moves", () => {
    const { failures, pinned } = rehearsePin(bundle, ids);
    expect(failures).toEqual([]);
    expect(pinned).toEqual(ids.rows.map((r) => r.id));
    for (const r of ids.rows) {
      expect(row(r.id)).toMatchObject({ categoryId: ids.financialAidId, categorizationSource: "user", categorizationConfidence: 1, needsReview: false });
    }
    const merchant = bundle.db.select().from(merchants).where(eq(merchants.canonicalName, "Fordham University")).get()!;
    expect(merchant.defaultCategoryId).toBe(education());
  });

  test("rolls back whole when one row is no longer as planned", () => {
    patch(ids.rows[2]!.id, { categoryId: education() });
    expect(() => applyPin(bundle, ids.rows.map((r) => r.id), ids)).toThrow(PinRefusal);
    for (const r of ids.rows) expect(row(r.id).categorizationSource).toBe("merchant_map");
  });

  describe("each guard can fail", () => {
    let before: PinState;
    let after: PinState;
    const pin = () => ids.rows.map((r) => r.id);
    beforeEach(() => {
      before = capturePinState(bundle);
      applyPin(bundle, pin(), ids);
      after = capturePinState(bundle);
    });

    test("the honest write passes", () => {
      expect(comparePin(before, after, pin())).toEqual([]);
    });

    test("a column other than the source changed", () => {
      const tampered = { ...after, besideSource: new Map([...after.besideSource, [pin()[0]!, "re-filed"]]) };
      expect(comparePin(before, tampered, pin()).join("\n")).toMatch(/a column other than the source changed on 1 row/);
    });

    test("the source moved on a row the plan did not name, or missed one it did", () => {
      expect(comparePin(before, after, pin().slice(0, 2)).join("\n")).toMatch(/the source moved on/);
      const fourth = live().find((r) => r.rawDescription === MARSHALLS)!.id;
      const tampered = { ...after, sources: new Map([...after.sources, [fourth, "user"]]) };
      expect(comparePin(before, tampered, pin()).join("\n")).toMatch(/the source moved on/);
    });

    test("a row went somewhere other than his hand", () => {
      const tampered = { ...after, sources: new Map([...after.sources, [pin()[0]!, "rule"]]) };
      expect(comparePin(before, tampered, pin()).join("\n")).toMatch(/not his hand/);
    });

    test("another row was touched", () => {
      const fourth = live().find((r) => r.rawDescription === MARSHALLS)!.id;
      const tampered = { ...after, stamps: new Map([...after.stamps, [fourth, "2099-01-01T00:00:00.000Z"]]) };
      expect(comparePin(before, tampered, pin()).join("\n")).toMatch(/touched a row it did not pin/);
    });

    test("net worth moved", () => {
      expect(comparePin(before, { ...after, netWorth: "moved" }, pin()).join("\n")).toMatch(/net worth on every day moved/);
    });

    test("the owner's 'apply to the merchant' box would have taught Fordham a new default — another table moved", () => {
      const merchantId = row(pin()[0]!).merchantId!;
      applyCorrection(bundle.db, { transactionId: pin()[0]!, categoryId: ids.financialAidId, applyToMerchant: true });
      expect(bundle.db.select().from(merchants).where(eq(merchants.id, merchantId)).get()!.defaultCategoryId).toBe(ids.financialAidId);
      expect(comparePin(before, capturePinState(bundle), pin()).join("\n")).toMatch(/merchants changed/);
    });
  });
});

describe("the command line", () => {
  const env = {
    cwd: "/repo",
    exists: (p: string) => p === "/repo/copy.db" || p === "/scratch" || p === os.tmpdir(),
  };

  test("requires --db and never guesses a database", () => {
    expect(() => parsePinCli([], env)).toThrow(DbTargetRefusal);
    expect(() => parsePinCli(["--db=missing.db"], env)).toThrow(DbTargetRefusal);
  });

  test("refuses a flag it does not know, a bare argument, and --confirm with a value", () => {
    expect(() => parsePinCli(["--db=copy.db", "--dry-run"], env)).toThrow(PinRefusal);
    expect(() => parsePinCli(["--db=copy.db", "copy.db"], env)).toThrow(PinRefusal);
    // it reads like a write; the flag it spells is not the one this write reads
    expect(() => parsePinCli(["--db=copy.db", "--confirm=yes"], env)).toThrow(PinRefusal);
  });

  test("reads --db, --confirm and --scratch; a dry run is the default", () => {
    expect(parsePinCli(["--db=copy.db", "--confirm", "--scratch=/scratch"], env)).toEqual({ dbPath: "/repo/copy.db", confirm: true, scratch: "/scratch" });
    expect(parsePinCli(["--db=copy.db"], env)).toEqual({ dbPath: "/repo/copy.db", confirm: false, scratch: os.tmpdir() });
  });

  test("refuses a scratch directory that is not there, and a --scratch with no value", () => {
    expect(() => parsePinCli(["--db=copy.db", "--scratch=/nope"], env)).toThrow(/no scratch directory/);
    expect(() => parsePinCli(["--db=copy.db", "--scratch"], env)).toThrow(PinRefusal);
  });
});
