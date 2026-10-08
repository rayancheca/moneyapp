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
import { seedHisCarSeries } from "@/services/one-charge-fixture";
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
/*
 * A popover renders its contents only while open, and nothing opens one in a static render — so the list of what is
 * still expected (the tail's popover) is invisible to this file unless a test opens it. Closed unless one does.
 */
const popovers = vi.hoisted(() => ({ forceOpen: false }));
vi.mock("@/components/ui/Popover", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ui/Popover")>();
  const { createElement: h } = await import("react");
  return {
    ...real,
    Popover: (props: Parameters<typeof real.Popover>[0]) =>
      h(real.Popover, { ...props, open: props.open || popovers.forceOpen }),
  };
});

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
 * ⚖️ Owner decision 2026-10-08 (§6A 56): the one-time Nov 11 car-insurance balance reads "once" wherever a cadence is
 * printed — here, the list behind "… expected before Nov 30", where every line names its day and its cadence. 🔴 Review
 * of 3044ea6 put this line back on the stored cadence ("Nov 11 · monthly") with every component test still green.
 */
describe("BudgetRow — the expected list prints a schedule of one charge as once", () => {
  const NOVEMBER = "2026-11-02";

  afterEach(() => {
    popovers.forceOpen = false;
  });

  test("Nov 11 · once for the balance, beside a monthly bill that stays monthly", () => {
    const his = seedHisCarSeries(bundle.db);
    // his lease, monthly on the 15th to 2028 — a line in the same month with a cadence to print
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "Car lease",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        nextExpectedOn: "2026-11-15",
        nextExpectedAmountCents: -69504,
        userEndsOn: "2028-08-15",
        status: "confirmed",
        lastMatchedOn: "2026-10-15",
        userCategoryId: his.carId,
      })
      .run();
    createBudget(bundle.db, { categoryId: his.carId, period: "monthly", amountCents: 150_000, startsOn: "2026-11-01" });
    const s = budgetPaceStatuses(bundle.db, NOVEMBER).find((x) => x.categoryName === "Transport")!;
    expect(s.tail.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Car lease", "Car insurance — Nov 11 balance after the $1,000 early payment"]),
    );

    popovers.forceOpen = true;
    const html = render(s);
    const lines = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    );
    const lineOf = (name: string): string | undefined => lines.find((l) => l.startsWith(`${name} `));
    expect(lineOf("Car insurance — Nov 11 balance after the $1,000 early payment")).toContain("Nov 11 · once");
    expect(lineOf("Car lease")).toContain("Nov 15 · monthly");
  });
});
