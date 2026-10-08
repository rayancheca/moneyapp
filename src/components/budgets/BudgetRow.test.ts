import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { createAccount } from "@/services/accounts";
import { budgetPaceStatuses, createBudget, type BudgetPaceStatus } from "@/services/budgets";
import { createCashWallet } from "@/services/cash-wallets";
import { addManualTransaction } from "@/services/manual-transactions";
import { BudgetRow } from "./BudgetRow";

// rendering never navigates or submits; the row and its controls only need these to exist
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  redirect: () => undefined,
}));
vi.mock("@/app/budgets/actions", () => ({
  deactivateBudgetAction: async () => ({ ok: true }),
  updateBudgetAmountAction: async () => ({ ok: true }),
  setBudgetRolloverAction: async () => ({ ok: true }),
  updateBudgetPeriodAction: async () => ({ ok: true }),
}));

/**
 * The row, rendered from what `budgetPaceStatuses` returns — for the ONE part of
 * a budget row `budgetVerdict`'s own tests cannot see: whether the component
 * actually reads what the verdict decided. The headline and its definition are
 * tested there; this file only asks what the row draws beside them.
 */
const TODAY = "2026-08-11";

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-budget-row-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function catId(name: string): string {
  const row = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), isNull(categories.parentId)))
    .get();
  if (!row) throw new Error(`missing category ${name}`);
  return row.id;
}

function statusFor(name: string): BudgetPaceStatus {
  const s = budgetPaceStatuses(bundle.db, TODAY).find((x) => x.categoryName === name);
  if (!s) throw new Error(`no budget status for ${name}`);
  return s;
}

function render(status: BudgetPaceStatus): string {
  return renderToStaticMarkup(
    createElement(BudgetRow, { status, guidanceCents: 0, spentProvenance: null, planProvenance: null }),
  );
}

/** the class list of the dashed tail of recurring still expected, or null when none is drawn */
function tailClass(html: string): string | null {
  return /class="([^"]*border-dashed[^"]*)"/.exec(html)?.[1] ?? null;
}

describe("BudgetRow — what it draws beside the verdict", () => {
  test("⚖️ a cash-only row shows no projection, and its tail wears no pace colour", () => {
    /*
     * 🔴 Owner, 2026-09-15: a category spent only from cash wallets makes no pace
     * claim, and its definition says no reading of where it is heading is
     * offered. The row still printed "Projected ≈ $56.36" in the warning colour
     * beside that definition, because the figure was gated on `status.pace`
     * alone. A projection IS that reading; so is an amber tail.
     */
    const wallet = createCashWallet(bundle.db, { name: "Cash on Hand", openingOn: "2026-08-01", openingBalanceCents: 50_000 });
    addManualTransaction(bundle.db, {
      accountId: wallet,
      postedOn: "2026-08-05",
      amountCents: -2_000,
      description: "CASH LUNCH",
      categoryId: catId("Food"),
    });
    // a bill still to come this month, so the row has a tail to colour
    const lunch = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Lunch plan",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        amountCentsAvg: -500,
        nextExpectedOn: "2026-08-20",
        nextExpectedAmountCents: -500,
        status: "confirmed",
        lastMatchedOn: "2026-07-20",
        userCategoryId: catId("Food"),
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 3_000, startsOn: "2026-08-01" });

    const s = statusFor("Food");
    // the conditions under which the old row drew both — without them this test could not fail
    expect(s.spentFromAccounts).toBe(0);
    expect(s.spentFromWallets).toBe(1);
    expect(s.pace).toBe("at-risk");
    expect(s.projectedCents).not.toBe(s.spentCents);
    expect(s.tail.map((t) => t.id)).toContain(lunch);

    const html = render(s);
    expect(html).toContain("Cash only");
    expect(html).not.toContain("Projected");
    const tail = tailClass(html);
    expect(tail).not.toBeNull();
    expect(tail).not.toMatch(/text-(positive|warning|negative)\b/);
  });

  test("the control: a row read over a covered window still shows its projection in the pace colour", () => {
    // so the test above cannot pass by a row that never projects anything
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const card = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
    for (const [postedOn, amountCents] of [
      ["2026-08-05", -2_000],
      ["2026-08-11", -100],
    ] as const) {
      const rawDescription = `SPEND ${postedOn}`;
      bundle.db
        .insert(transactions)
        .values({
          accountId: card,
          postedOn,
          amountCents,
          rawDescription,
          normalizedDescription: rawDescription,
          categoryId: catId("Food"),
          dedupeHash: dedupeHash({ accountId: card, postedOn, amountCents, rawDescription, occurrenceIndex: 0 }),
        })
        .run();
    }
    createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 3_000, startsOn: "2026-08-01" });

    const s = statusFor("Food");
    expect(s.uncoveredDays).toBe(0);
    expect(s.pace).toBe("at-risk");

    const html = render(s);
    expect(html).toContain("Off pace");
    expect(html).toMatch(/Projected ≈ <\/span><span class="[^"]*text-warning/);
  });
});

/*
 * 🔴 THE ROW SAID "not imported", IN WARNING COLOUR, WHATEVER THE LEDGER HAD READ. On a copy of his ledger 2026-10-08
 * Housing read "$2,291.21 expected by now, not imported" in `text-warning` — rent and its utilities, both Oct 1, on
 * days no import had reached — while the runway said the same $2,291.21 quietly; and where an import HAD reached the
 * day (the e2e fixture's Meal Kit) "not imported" was false. ⚖️ Staleness between uploads is normal, never a warning
 * (his words 2026-08-05). ⛔ The runway's split and tone (`lib/arrears-reading`), for the line and the spoken sentence.
 */
describe("BudgetRow — the arrears line says the runway's split, in its tone", () => {
  const AUG_1 = "2026-08-01";

  /** a Housing bill on its own Card, the Card read through `readThrough`, under an August Housing budget */
  function housingWithBill(opts: { cents: number; readThrough: string; weekly?: boolean }): BudgetPaceStatus {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const card = createAccount(bundle.db, { institutionId: chase.id, name: "Rent card", type: "credit" });
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "Rent",
        kind: "bill",
        cadence: opts.weekly ? "weekly" : "monthly",
        intervalDaysAvg: opts.weekly ? 7 : 30,
        amountCentsAvg: -opts.cents,
        nextExpectedOn: AUG_1,
        nextExpectedAmountCents: -opts.cents,
        status: "confirmed",
        lastMatchedOn: AUG_1,
        userCategoryId: catId("Housing"),
        accountId: card,
      })
      .run();
    const rawDescription = `CAFE ${opts.readThrough}`;
    bundle.db
      .insert(transactions)
      .values({
        accountId: card,
        postedOn: opts.readThrough,
        amountCents: -800,
        rawDescription,
        normalizedDescription: rawDescription,
        categoryId: catId("Food"),
        dedupeHash: dedupeHash({ accountId: card, postedOn: opts.readThrough, amountCents: -800, rawDescription, occurrenceIndex: 0 }),
      })
      .run();
    createBudget(bundle.db, { categoryId: catId("Housing"), period: "monthly", amountCents: 300_000, startsOn: AUG_1 });
    return statusFor("Housing");
  }

  /** the arrears paragraph: its class list and its text, tags and React's text-node markers stripped */
  function arrearsLine(html: string): { className: string; text: string } {
    const p = /<p class="([^"]*)">((?:(?!<\/p>).)*expected by now(?:(?!<\/p>).)*)<\/p>/.exec(html);
    if (!p) throw new Error("no arrears line");
    return { className: p[1]!, text: p[2]!.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "") };
  }

  const spoken = (html: string): string => /aria-valuetext="([^"]*)"/.exec(html)![1]!;

  test("a due day no import has reached: the runway's words, quietly", () => {
    const html = render(housingWithBill({ cents: 228_570, readThrough: "2026-07-31" }));
    const line = arrearsLine(html);
    expect(line.text).toBe("$2,285.70 expected by now and no import has covered it yet · Rent Aug 1");
    expect(line.className).not.toMatch(/text-(warning|negative)\b/);
    expect(spoken(html)).toMatch(/ \$2,285\.70 was expected by now and no import has covered it yet\.$/);
    expect(html).not.toMatch(/not imported|has not been imported/);
  });

  test("a due day an import has reached, with nothing posted: \"not posted\", in warning", () => {
    const html = render(housingWithBill({ cents: 228_570, readThrough: "2026-08-05" }));
    const line = arrearsLine(html);
    expect(line.text).toBe("$2,285.70 expected by now and not posted · Rent Aug 1");
    expect(line.className).toMatch(/\btext-warning\b/);
    expect(spoken(html)).toMatch(/ \$2,285\.70 was expected by now and has not posted\.$/);
    expect(html).not.toMatch(/not imported|has not been imported/);
  });

  test("read part of the way: both halves by amount, and the warning for the read half", () => {
    // weekly from Aug 1: Aug 1 is read (the Card reaches Aug 5), Aug 8 is not
    const html = render(housingWithBill({ cents: 5_000, readThrough: "2026-08-05", weekly: true }));
    const line = arrearsLine(html);
    expect(line.text).toMatch(
      /^\$100\.00 expected by now: \$50\.00 not posted, and no import has covered the other \$50\.00 yet · /,
    );
    expect(line.className).toMatch(/\btext-warning\b/);
    expect(spoken(html)).toMatch(
      / \$100\.00 was expected by now: \$50\.00 has not posted, and no import has covered the other \$50\.00 yet\.$/,
    );
  });
});
