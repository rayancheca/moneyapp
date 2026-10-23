import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";

/*
 * `cache` from React's SERVER build — the build Next renders a server component with, which memoises inside one
 * render (`agents-money-render.test.ts`'s harness). The build vitest resolves never memoises.
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
const { incomePaceMonths } = await import("./forecast");
const { ledgerOpenedOn } = await import("./imported-through-fixture");

/**
 * ⚡ Money in's months are read once per server render (`incomeCoverage`, `react`'s `cache`), as spending's are
 * (`spendingCoverageThrough`) — review of 0747432 (LOW). Measured on his ledger copy at 2026-10-23, one read outside a
 * render costs 4.86ms once warm, about what spending's day does (4.41ms).
 */
const TODAY = "2026-10-23";

let dir: string;
let bundle: DbBundle;
let seq = 0;
// the rows the income pace's day is read off (`hisIncomePaceRows` → `nonRecurringAllocations`)
let paceRowReads = 0;

function row(accountId: string, postedOn: string, amountCents: number, category: string): void {
  seq += 1;
  const rawDescription = `FIXTURE ${seq}`;
  const categoryId = bundle.db.select().from(categories).where(eq(categories.name, category)).get()!.id;
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription,
      normalizedDescription: rawDescription,
      categoryId,
      dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription, occurrenceIndex: seq }),
    })
    .run();
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-income-pace-render-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
  const checkingId = createAccount(bundle.db, { institutionId: chase.id, name: "Checking", type: "checking" });
  const cashId = createAccount(bundle.db, { institutionId: chase.id, name: "Brokerage Cash", type: "checking" });
  // his ledger's shape: Dividends to Sep 9, so Money in's months are Jun–Aug and the row names Brokerage Cash
  ledgerOpenedOn(bundle.db, "2026-01-01");
  for (const m of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]) {
    row(checkingId, `2026-${m}-05`, -10000, "Groceries");
  }
  for (const m of ["01", "02", "03", "04", "05", "06", "07", "08"]) row(cashId, `2026-${m}-15`, 3000, "Dividends");
  row(cashId, "2026-09-09", 7, "Dividends");

  paceRowReads = 0;
  const prepare = bundle.sqlite.prepare.bind(bundle.sqlite);
  bundle.sqlite.prepare = ((sql: string) => {
    const select = 'select "id", "posted_on", "amount_cents", "category_id", "account_id", "recurring_series_id"';
    if (sql.startsWith(`${select} from "transactions"`)) paceRowReads++;
    return prepare(sql);
  }) as typeof bundle.sqlite.prepare;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Money in's months are read once per render", () => {
  test("⚡ inside one render: a second reader shares the first one's read, and its answer", () => {
    const { first, second, reads } = inOneRender(() => {
      const before = paceRowReads;
      const first = incomePaceMonths(bundle.db, TODAY);
      const second = incomePaceMonths(bundle.db, TODAY);
      return { first, second, reads: paceRowReads - before };
    });
    expect(reads).toBe(1);
    expect(second).toEqual(first);
    expect(first.unread).toEqual({ months: ["2026-09"], through: "2026-09-09", accounts: ["Brokerage Cash"] });
  });

  test("⛔ outside a render nothing is memoised: tests and scripts read every call, as they always have", () => {
    const before = paceRowReads;
    incomePaceMonths(bundle.db, TODAY);
    incomePaceMonths(bundle.db, TODAY);
    expect(paceRowReads - before).toBe(2);
  });
});
