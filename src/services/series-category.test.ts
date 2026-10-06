import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount, outsidePortfolioCashAccountIds } from "./accounts";
import { agentsSeriesBand, agentsSeriesBands, loadCategoryIndex } from "./analytics";
import { recurringCalendar } from "./recurring-calendar";
import { seriesDetail } from "./recurring-detail";

/**
 * 🔴 Three readers named a series' category three ways. A series page (`seriesDetail`) counted a row filed on the
 * system "Uncategorized" category as a vote and skipped a NULL one; the forecast (`agentsSeriesBands`) skipped both; the
 * calendar's hue (`seriesHues`) counted both kinds of filed row and broke a tie by the order its scan met them. Measured
 * at dbef9ae on a temp ledger: the agent's monthly +$5.00 schedule with rows filed [Uncategorized, Uncategorized,
 * Fees > Bank Fees] read "Uncategorized" on its page — unfiled, which goes by its sign, into the agent's income — while
 * the forecast netted the same $5.00 inside the agent's costs. The page and the card answered his question two ways.
 *
 * ⛔ One set, NULL or system-kind (owner decision 2026-09-03, `CategoryIndex.isUncategorized`): a row not filed yet
 * says nothing about the stream, and a filed row names it.
 */

const TODAY = "2026-10-05";
const AMOUNT = 500;
const FEES = "Fees > Bank Fees";
const INTEREST = "Income > Interest";
const UNCAT = "Uncategorized";

let dir: string;
let bundle: DbBundle;
let fakeToday: string | undefined;
let wellsFargo: string;
let agentic: string;

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

/** A monthly schedule on the 20th, its rows linked oldest first — the last on Sep 20 — each filed as `rows` says. */
function schedule(accountId: string, rows: readonly (string | null)[], userCategory: string | null): string {
  const amountCents = accountId === agentic ? AMOUNT : -AMOUNT;
  const id = bundle.db
    .insert(recurringSeries)
    .values({
      name: "Monthly on the 20th",
      kind: "other",
      accountId,
      cadence: "monthly",
      intervalDaysAvg: 30,
      toleranceDays: 3,
      nextExpectedOn: "2026-10-20",
      nextExpectedAmountCents: amountCents,
      amountCentsAvg: amountCents,
      lastMatchedOn: "2026-09-20",
      status: "detected",
      userCategoryId: userCategory === null ? null : catId(userCategory),
    })
    .returning({ id: recurringSeries.id })
    .get().id;
  rows.forEach((category, i) => {
    const postedOn = `2026-0${9 - (rows.length - 1 - i)}-20`;
    const raw = "MONTHLY ON THE 20TH";
    bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription: raw,
        normalizedDescription: raw,
        categoryId: category === null ? null : catId(category),
        recurringSeriesId: id,
        status: "active",
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: 0 }),
      })
      .run();
  });
  return id;
}

function drop(id: string): void {
  bundle.db.delete(transactions).where(eq(transactions.recurringSeriesId, id)).run();
  bundle.db.delete(recurringSeries).where(eq(recurringSeries.id, id)).run();
}

beforeEach(() => {
  fakeToday = process.env.MONEYAPP_FAKE_TODAY;
  process.env.MONEYAPP_FAKE_TODAY = TODAY;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-series-category-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const wf = bundle.db.insert(institutions).values({ name: "Wells Fargo" }).returning({ id: institutions.id }).get();
  const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
  wellsFargo = createAccount(bundle.db, { institutionId: wf.id, name: "Wells Fargo Everyday Checking", type: "checking" });
  agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking", last4: "9651" });
  const book = createAccount(bundle.db, {
    institutionId: rh.id,
    name: "Robinhood Agentic Brokerage",
    type: "investment",
    subtype: "brokerage",
  });
  bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (fakeToday === undefined) delete process.env.MONEYAPP_FAKE_TODAY;
  else process.env.MONEYAPP_FAKE_TODAY = fakeToday;
});

/** the smaller id of two categories — a tie reads one way on every surface */
const smaller = (a: string, b: string): string => (catId(a) < catId(b) ? a : b);

/** [rows' categories oldest first, the owner's category, the category the series is named by] */
const CASES = (): [readonly (string | null)[], string | null, string | null][] => [
  // 🔴 the reviewer's case: two unfiled on the system category never outvote the one filed row
  [[UNCAT, UNCAT, FEES], null, FEES],
  [[null, null, FEES], null, FEES],
  [[UNCAT, null, UNCAT, INTEREST], null, INTEREST],
  [[INTEREST, INTEREST, FEES], null, INTEREST],
  [[FEES, FEES, INTEREST, INTEREST], null, smaller(FEES, INTEREST)],
  [[INTEREST, INTEREST, FEES, FEES], null, smaller(FEES, INTEREST)],
  // nothing filed: the system category, where a row sits on it, as the page has always said; none where none does
  [[UNCAT, UNCAT, UNCAT], null, UNCAT],
  [[null, null, UNCAT], null, UNCAT],
  [[null, null, null], null, null],
  // the owner's first, whatever the rows say
  [[INTEREST, INTEREST, INTEREST], FEES, FEES],
  [[UNCAT, UNCAT, FEES], INTEREST, INTEREST],
];

describe("a series is named by one category on every surface that names it", () => {
  test("its page's chip", () => {
    for (const accountId of [wellsFargo, agentic]) {
      for (const [rows, userCategory, named] of CASES()) {
        const id = schedule(accountId, rows, userCategory);
        const shape = JSON.stringify({ rows, userCategory, agents: accountId === agentic });
        expect(seriesDetail(bundle.db, id, TODAY).category?.id ?? null, shape).toBe(named === null ? null : catId(named));
        drop(id);
      }
    }
  });

  test("the calendar's hue — the top-level colour of that category", () => {
    const idx = loadCategoryIndex(bundle.db);
    const colorOf = (name: string | null): string | null => {
      if (name === null) return null;
      const top = idx.topLevelOf(catId(name)).id;
      return bundle.db.select({ color: categories.color }).from(categories).where(eq(categories.id, top)).get()!.color;
    };
    for (const [rows, userCategory, named] of CASES()) {
      const id = schedule(wellsFargo, rows, userCategory);
      const shape = JSON.stringify({ rows, userCategory });
      const sept = recurringCalendar(bundle.db, "2026-09", TODAY);
      const entry = Object.values(sept.entriesByDay)
        .flat()
        .find((e) => e.seriesId === id);
      expect(entry, shape).toBeDefined();
      expect(entry!.hue, shape).toBe(colorOf(named));
      drop(id);
    }
  });

  test("⚖️ the band the forecast nets the agent's schedule in is the one its page's category names", () => {
    const idx = loadCategoryIndex(bundle.db);
    const agentsCash = outsidePortfolioCashAccountIds(bundle.db);
    for (const [rows, userCategory, named] of CASES()) {
      const id = schedule(agentic, rows, userCategory);
      const shape = JSON.stringify({ rows, userCategory });
      const series = { kind: "other" as const, accountId: agentic, userAmountCents: null, nextExpectedAmountCents: AMOUNT };
      const page = seriesDetail(bundle.db, id, TODAY).category?.id ?? null;
      expect(agentsSeriesBands(bundle.db, agentsCash).get(id), shape).toBe(agentsSeriesBand(idx, agentsCash, series, page));
      expect(page, shape).toBe(named === null ? null : catId(named));
      drop(id);
    }
  });
});
