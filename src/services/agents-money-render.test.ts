import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";

/*
 * `cache` from React's SERVER build — the build Next renders a server component with, which memoises inside one
 * render. The build vitest resolves never memoises, so a render is stood up here with the one hook that `cache` asks
 * of it: a dispatcher holding this render's caches (`inOneRender`).
 */
const server = vi.hoisted(() => ({ internals: null as null | { A: unknown } }));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  const { createRequire } = await import("node:module");
  const build = createRequire(import.meta.url)(
    path.join(process.cwd(), "node_modules/react/cjs/react.react-server.development.js"),
  );
  server.internals = build.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  return { ...real, cache: build.cache };
});

const { createAccount } = await import("./accounts");
const { spendingTransactions } = await import("./analytics");
const { ledgerOpens, ledgerReaches } = await import("./observation-frontier");
const { printOnOneStatement } = await import("./printed-statement-fixture");
const { agentsMoneyRowCount, categoryEmptyCopy, spendingEmptyCopy } = await import("./spending");

/**
 * ⚡ `agentsMoneyRowCount` asks whose accounts are the agent's through the read the page's row list already made
 * (`agentsCashOfRender`). Measured 2026-10-08 on a copy of his ledger, before: every empty `/spending` and
 * `/categories/<id>` request read the accounts twice for it (`ownPortfolioAccountIds`, then the pairing) on top of
 * the one cached read every row list in the same render shares.
 */

const TODAY = "2026-10-05";
const DAY = { from: "2026-09-05", to: "2026-09-05" };

let dir: string;
let bundle: DbBundle;
let fakeToday: string | undefined;
let agentic: string;
let accountReads = 0;

function catId(pathStr: string): string {
  const [parentName, subName] = pathStr.split(" > ");
  const parent = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parentName!), isNull(categories.parentId)))
    .get()!;
  if (!subName) return parent.id;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, subName), eq(categories.parentId, parent.id)))
    .get()!.id;
}

/** One React server render: `cache` memoises inside `fn` and nowhere else. */
function inOneRender<T>(fn: () => T): T {
  const caches = new Map<() => unknown, unknown>();
  server.internals!.A = {
    getCacheForType<C>(create: () => C): C {
      if (!caches.has(create)) caches.set(create, create());
      return caches.get(create) as C;
    },
  };
  try {
    return fn();
  } finally {
    server.internals!.A = null;
  }
}

beforeEach(() => {
  fakeToday = process.env.MONEYAPP_FAKE_TODAY;
  process.env.MONEYAPP_FAKE_TODAY = TODAY;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-agents-render-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);

  const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
  const book = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic Brokerage", type: "investment", subtype: "brokerage" });
  bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
  printOnOneStatement(bundle.db, rh.id, [agentic, book]);
  // the agent's Gold fee, the only money of the day: /spending and /categories/<Fees> read their empty states
  const raw = "Gold Monthly Fee";
  bundle.db
    .insert(transactions)
    .values({
      accountId: agentic,
      postedOn: DAY.from,
      amountCents: -500,
      rawDescription: raw,
      normalizedDescription: raw,
      categoryId: catId("Fees > Bank Fees"),
      status: "active",
      dedupeHash: dedupeHash({ accountId: agentic, postedOn: DAY.from, amountCents: -500, rawDescription: raw, occurrenceIndex: 0 }),
    })
    .run();

  // every read of whose accounts are whose — `outsidePortfolioCashAccountIds` makes two
  accountReads = 0;
  const prepare = bundle.sqlite.prepare.bind(bundle.sqlite);
  bundle.sqlite.prepare = ((sql: string) => {
    if (sql.startsWith('select "id", "type", "name", "institution_id", "cash_account_id" from "accounts"')) accountReads++;
    return prepare(sql);
  }) as typeof bundle.sqlite.prepare;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (fakeToday === undefined) delete process.env.MONEYAPP_FAKE_TODAY;
  else process.env.MONEYAPP_FAKE_TODAY = fakeToday;
});

describe("the empty state's agent clause reads whose accounts are whose once per render", () => {
  /** what each page renders once the day reads empty: the row list, then its empty state */
  function emptyPages() {
    const fees = catId("Fees");
    const opts = { today: TODAY, label: "the day", ledgerOpens: ledgerOpens(bundle.db), formatDay: (iso: string) => iso };
    expect(spendingTransactions(bundle.db, { categoryId: fees, ...DAY })).toEqual([]);
    const afterRows = accountReads;
    const category = categoryEmptyCopy(bundle.db, fees, DAY, opts);
    const spending = spendingEmptyCopy(bundle.db, DAY, { ...opts, ledgerReaches: ledgerReaches(bundle.db) });
    return { reads: accountReads - afterRows, said: [category.description, spending.description], count: agentsMoneyRowCount(bundle.db, DAY) };
  }

  test("⚡ inside one render: none beyond the row list's — and both empty states still say the agent's money is left out", () => {
    const page = inOneRender(emptyPages);
    expect(page.reads).toBe(0);
    for (const said of page.said) expect(said).toContain("none of it is counted here");
    expect(page.count).toBe(1);
  });

  test("⛔ outside a render nothing is memoised: tests and scripts read every call, as they always have", () => {
    const before = accountReads;
    expect([agentsMoneyRowCount(bundle.db, DAY), agentsMoneyRowCount(bundle.db, DAY)]).toEqual([1, 1]);
    expect(accountReads - before).toBe(4);
  });
});
