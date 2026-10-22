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
import { ROLLOVER_BANKS, ROLLOVER_HOLDS } from "@/lib/rollover-held-back";
import { createAccount } from "@/services/accounts";
import { budgetPaceStatuses, createBudget, setBudgetRollover, type BudgetPaceStatus } from "@/services/budgets";
import { createCashWallet } from "@/services/cash-wallets";
import { checkedThrough } from "@/services/checked-days-fixture";
import { addManualTransaction } from "@/services/manual-transactions";
import { seedHisCarSeries } from "@/services/one-charge-fixture";
import { provenanceFor } from "@/services/provenance";
import { BudgetDetails } from "./BudgetDetails";
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
    createElement(BudgetRow, { status, guide: null, spentProvenance: null, planProvenance: null }),
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

  /**
   * 🔴 "Projected ≈ -$1,050.14" (review of c7a3510; Shopping, 2024-05-10 on his ledger copy with the budget started
   * early): a refund over the plan nets the month below zero, and the rate beside it, held apart from the refund, still
   * came to less than nothing. Neither the row nor its spoken sentence reads a projection below zero — and one of $0.00
   * beside a spend below it says nothing the spend does not.
   */
  test("a month a refund nets below zero prints no projection, and speaks none below zero", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const card = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
    for (const [postedOn, amountCents] of [
      ["2026-08-05", 5_000], // a July purchase, returned — more than the whole plan
      ["2026-08-11", -1_000],
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
    // a covered window and an on-track verdict — the row that prints a projection, had it one to print
    expect(s.uncoveredDays).toBe(0);
    expect(s.pace).toBe("under");
    expect(s.spentCents).toBe(-4_000);

    const html = render(s);
    expect(html).toContain("On track");
    expect(html).not.toContain("Projected");
    const spoken = /aria-valuetext="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(spoken).toMatch(/on track/);
    expect(spoken).not.toMatch(/projected -/);
  });

  /**
   * 🔴 The row and its spoken sentence chose the projection apart: a1cec5f made the row print one only where it says
   * more than the spend and more than zero, and the spoken sentence still read "on track — projected $0.00" over the
   * month a refund took below zero (review of a1cec5f, 2026-10-13) — and "projected $10.00" beside a spend of $10.00
   * the row prints alone. Where the row prints no "Projected ≈", the spoken row says none.
   */
  test("the spoken row says a projection only where the row prints one — not $0.00 below a refund", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const card = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
    for (const [postedOn, amountCents] of [
      ["2026-08-05", 5_000],
      ["2026-08-11", -1_000],
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
    expect(s.pace).toBe("under");
    expect(s.projectedCents).toBe(0); // the floor the row does not print
    const html = render(s);
    expect(html).not.toContain("Projected");
    const spoken = /aria-valuetext="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(spoken).not.toMatch(/projected/);
    expect(spoken).toMatch(/\. on track\.$/);
  });

  test("…nor one equal to the spend: a month of one bill, posted, with nothing more to come", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const card = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
    const bill = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Meal plan",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        amountCentsAvg: -1_000,
        nextExpectedOn: "2026-09-05",
        nextExpectedAmountCents: -1_000,
        status: "confirmed",
        lastMatchedOn: "2026-08-05",
        userCategoryId: catId("Food"),
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    for (const [postedOn, amountCents, category, seriesId] of [
      ["2026-08-05", -1_000, "Food", bill],
      ["2026-08-11", -500, "Shopping", null], // the card read through today
    ] as const) {
      const rawDescription = `SPEND ${postedOn} ${category}`;
      bundle.db
        .insert(transactions)
        .values({
          accountId: card,
          postedOn,
          amountCents,
          rawDescription,
          normalizedDescription: rawDescription,
          categoryId: catId(category),
          recurringSeriesId: seriesId,
          dedupeHash: dedupeHash({ accountId: card, postedOn, amountCents, rawDescription, occurrenceIndex: 0 }),
        })
        .run();
    }
    createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 3_000, startsOn: "2026-08-01" });

    const s = statusFor("Food");
    // a covered, graded row whose projection is its spend — the case the row prints no projection for
    expect(s.uncoveredDays).toBe(0);
    expect(s.pace).toBe("under");
    expect(s.spentCents).toBe(1_000);
    expect(s.projectedCents).toBe(1_000);
    const html = render(s);
    expect(html).toContain("On track");
    expect(html).not.toContain("Projected");
    const spoken = /aria-valuetext="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(spoken).not.toMatch(/projected/);
    expect(spoken).toMatch(/\. on track\.$/);
  });

  test("the control: a projection the row prints is spoken, the same figure", () => {
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
    expect(s.pace).toBe("at-risk");
    const html = render(s);
    const printed = /Projected ≈ <\/span><span[^>]*>([^<]*)</.exec(html.replace(/<!-- -->/g, ""))?.[1];
    expect(printed).toMatch(/^\$[\d,]+\.\d\d$/);
    const spoken = /aria-valuetext="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(spoken).toContain(`off pace — projected ${printed}, over budget.`);
  });
});

/*
 * ⚖️ OWNER DECISION 2026-10-12 (§6A 64): where NO elapsed day of a budget's window is imported, Spent and Left print
 * "—" and Budget stays — the dashboard's pace tile and the category headline's rule (`lib/empty-period::emptyFigure`).
 * 🔴 Measured on his ledger copy 2026-10-12: all 12 rows read "Spent $0.00 · Left $X", a bar announcing "0% of
 * budget", over an October the accounts they are spent from were imported through Aug 12 or Sep 2.
 */
describe("BudgetRow — ⚖️ §6A 64, a window not one day of which has been read", () => {
  /** Food spent on a Card read through `readThrough` (a Shopping row that day), under an August Food budget */
  function foodReadThrough(readThrough: string): BudgetPaceStatus {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const card = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
    for (const [postedOn, category] of [
      ["2026-07-20", "Food"],
      [readThrough, "Shopping"],
    ] as const) {
      const rawDescription = `SPEND ${postedOn} ${category}`;
      bundle.db
        .insert(transactions)
        .values({
          accountId: card,
          postedOn,
          amountCents: -1_000,
          rawDescription,
          normalizedDescription: rawDescription,
          categoryId: catId(category),
          dedupeHash: dedupeHash({ accountId: card, postedOn, amountCents: -1_000, rawDescription, occurrenceIndex: 0 }),
        })
        .run();
    }
    createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 30_000, startsOn: "2026-08-01" });
    return statusFor("Food");
  }

  const spoken = (html: string): string => /aria-valuetext="([^"]*)"/.exec(html)![1]!;
  /** `html` less every element marked aria-hidden — a rolling figure's digit strips — nesting counted */
  function withoutHidden(html: string): string {
    let out = "";
    let at = 0;
    for (;;) {
      const start = html.indexOf('<span aria-hidden="true"', at);
      if (start === -1) return out + html.slice(at);
      out += html.slice(at, start);
      let depth = 0;
      const tag = /<(\/?)span\b[^>]*>/g;
      tag.lastIndex = start;
      for (let m = tag.exec(html); m; m = tag.exec(html)) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) {
          at = tag.lastIndex;
          break;
        }
      }
    }
  }

  /** the figures cluster's text — "Spent … Budget … Left …" — as a reader hears it, tags dropped */
  const CLUSTER = /<span class="text-ink-faint">Spent <\/span>[\s\S]*?(?=<div class="flex flex-wrap items-center gap-1">)/;
  const figures = (html: string): string =>
    withoutHidden(CLUSTER.exec(html)![0]!)
      .replace(/<!-- -->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  test("Spent and Left print a dash, the plan stands, and the bar announces no measured value", () => {
    const s = foodReadThrough("2026-07-31");
    const spentProof = provenanceFor(bundle.db, {
      kind: "categorySpend",
      categoryId: s.budget.categoryId,
      from: s.bounds.start,
      to: s.bounds.end,
      label: s.categoryPath,
    });
    const html = renderToStaticMarkup(
      createElement(BudgetRow, { status: s, guide: null, spentProvenance: spentProof, planProvenance: null }),
    );
    expect(figures(html)).toMatch(/^Spent — Budget \$300\.00 Left —/);
    expect(html).not.toContain("$0.00");
    // ⛔ no proof beside a dash: the popover proves a rendered figure (`CategoryHeadline`)
    expect(html).not.toMatch(/How Food spent is known/);
    // the no-verdict look: the withheld headline and its coverage sentence, and a bar with no measured value on it
    expect(html).toContain("Awaiting statements");
    expect(html).toContain("spending imported through Jul 31 · 11 days of this period unaccounted");
    expect(html).not.toMatch(/aria-valuenow=/);
    expect(spoken(html)).toBe(
      "Food: no day of this period imported yet, so neither spent nor left is shown against $300.00. " +
        "35% of this period has passed. spending imported through Jul 31 · 11 days of this period unaccounted.",
    );
  });

  /*
   * 🔴 Review of 6f217a7: the dashed row still printed "Projected ≈" — the tail and the arrears over the $0.00 it will
   * not print — in the pace colour, and drew its dashed tail in it: on his ledger copy 2026-10-12 Housing "Projected ≈
   * $2,291.21" and Transport "$368.86" in amber beside "Spent —" and "Left —", Transport's amber tail filling the bar.
   */
  test("…and no projection beside the dash, nor a pace colour on the tail of what is still expected", () => {
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "Meal plan",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        amountCentsAvg: -40_000,
        nextExpectedOn: "2026-08-20",
        nextExpectedAmountCents: -40_000,
        status: "confirmed",
        lastMatchedOn: "2026-07-20",
        userCategoryId: catId("Food"),
      })
      .run();
    const s = foodReadThrough("2026-07-31");
    // the conditions under which the row drew both — without them this test could not fail
    expect(s.noDayRead).toBe(true);
    expect(s.pace).toBe("at-risk");
    expect(s.projectedCents).toBe(40_000);
    const html = render(s);
    expect(figures(html)).toMatch(/^Spent — Budget \$300\.00 Left —/);
    expect(html).not.toContain("Projected");
    const tail = tailClass(html);
    expect(tail).not.toBeNull();
    expect(tail).not.toMatch(/text-(positive|warning|negative)\b/);
    // what is still expected keeps its own line: a schedule, not a reading of the dashed window
    expect(withoutHidden(html).replace(/<!-- -->/g, "")).toMatch(/\$400\.00<\/span> expected before Aug 31/);
  });

  test("the control: one day read keeps today's lower-bound shape — $0.00 and a bar at 0", () => {
    const s = foodReadThrough("2026-08-01");
    const html = render(s);
    expect(figures(html)).toMatch(/^Spent \$0\.00 Budget \$300\.00 Left \$300\.00/);
    expect(html).toContain('aria-valuenow="0"');
    expect(spoken(html)).toMatch(/^Food: \$0\.00 of \$300\.00 \(0% of budget\)\. /);
  });

  /*
   * ⚖️ OWNER DECISION 2026-10-13 (decision 69): a window read in PART prints no "Projected ≈" and draws its dashed
   * tail in no pace colour either, as the dashed row above does — its figures are floors, and a projection of floors
   * is a reading the row's own definition says it does not offer. The bills still to come keep their own line.
   */
  test("⚖️ decision 69: a window read in part shows its figures, but no projection and no pace colour", () => {
    bundle.db
      .insert(recurringSeries)
      .values({
        name: "Meal plan",
        kind: "bill",
        cadence: "monthly",
        intervalDaysAvg: 30,
        amountCentsAvg: -40_000,
        nextExpectedOn: "2026-08-20",
        nextExpectedAmountCents: -40_000,
        status: "confirmed",
        lastMatchedOn: "2026-07-20",
        userCategoryId: catId("Food"),
      })
      .run();
    const s = foodReadThrough("2026-08-05");
    // the conditions under which the row drew both — without them this test could not fail
    expect(s.noDayRead).toBe(false);
    expect(s.uncoveredDays).toBeGreaterThan(0);
    expect(s.pace).toBe("at-risk");
    expect(s.projectedCents).toBeGreaterThan(Math.max(0, s.spentCents));
    const html = render(s);
    expect(html).toContain("Awaiting statements");
    expect(figures(html)).toMatch(/^Spent \$0\.00 Budget \$300\.00 Left \$300\.00/);
    expect(html).not.toContain("Projected");
    const tail = tailClass(html);
    expect(tail).not.toBeNull();
    expect(tail).not.toMatch(/text-(positive|warning|negative)\b/);
    expect(withoutHidden(html).replace(/<!-- -->/g, "")).toMatch(/\$400\.00<\/span> expected before Aug 31/);
    // the spoken row says what is missing, not where spending is heading
    expect(spoken(html)).not.toMatch(/projected|on track|off pace/);
    expect(spoken(html)).toMatch(/spending imported through Aug 5 · 6 days of this period unaccounted\./);
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
  function housingWithBill(opts: {
    cents: number;
    readThrough: string;
    weekly?: boolean;
    dueOn?: string;
  }): BudgetPaceStatus {
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
        nextExpectedOn: opts.dueOn ?? AUG_1,
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
    // …and its balances checked through it: the day its chip measures to, which the ✕ reads (his decision 62)
    checkedThrough(bundle.db, card, opts.readThrough);
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

  test("a due day no checked statement has reached: the runway's words, quietly", () => {
    const html = render(housingWithBill({ cents: 228_570, readThrough: "2026-07-31" }));
    const line = arrearsLine(html);
    expect(line.text).toBe("$2,285.70 expected by now and no statement has covered it yet · Rent Aug 1");
    expect(line.className).not.toMatch(/text-(warning|negative)\b/);
    expect(spoken(html)).toMatch(/ \$2,285\.70 was expected by now and no statement has covered it yet\.$/);
    expect(html).not.toMatch(/not imported|has not been imported/);
  });

  test("a due day a checked statement has reached, with nothing posted: \"not posted\", in warning", () => {
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
      /^\$100\.00 expected by now: \$50\.00 not posted, and no statement has covered the other \$50\.00 yet · /,
    );
    expect(line.className).toMatch(/\btext-warning\b/);
    expect(spoken(html)).toMatch(
      / \$100\.00 was expected by now: \$50\.00 has not posted, and no statement has covered the other \$50\.00 yet\.$/,
    );
  });

  /*
   * 🔴 Its Card read through today, a bill due yesterday still inside its 3 days to post read "no import has covered it
   * yet" (review of the 2026-10-08 batch) — what is unread is days still to come, and on an archived card or a cash
   * wallet no import ever will. The row says what it waits for, quietly.
   */
  test("read through today, its days to post not over: says so, quietly — never 'no import'", () => {
    const html = render(housingWithBill({ cents: 228_570, readThrough: TODAY, dueOn: "2026-08-10" }));
    const line = arrearsLine(html);
    expect(line.text).toBe(
      "$2,285.70 expected by now and the days a payment has to post are not over yet · Rent Aug 10",
    );
    expect(line.className).not.toMatch(/text-(warning|negative)\b/);
    expect(spoken(html)).toMatch(
      / \$2,285\.70 was expected by now and the days a payment has to post are not over yet\.$/,
    );
  });
});

/**
 * 🔴 THE ONE DEFINITION STILL SAYING "never posted". Opened, a rolling budget explains what it banks: "Bills that
 * came due and never posted are subtracted, so a missing statement cannot bank itself as savings." His words for a
 * bill a checked statement shows nothing for are "not posted" (decisions 60 and 65), and "never posted" is a negative
 * claim the arrears may make only of read days (`lib/arrears-reading`) — while the rollover subtracts all of
 * `budgetOverdue`, read or not, which is the sentence's own point. ⛔ Both halves, in the split's two phrases.
 */
describe("BudgetDetails — what rollover subtracts, in his words", () => {
  test("a rolling budget's panel says not posted, and names the half no statement has covered", () => {
    createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 3_000, startsOn: "2026-06-01" });
    const panel = createElement(BudgetDetails, { status: statusFor("Food"), rolloverEnabled: true });
    const html = renderToStaticMarkup(panel).replace(/<!-- -->/g, "").replace(/\s+/g, " ");
    expect(html).not.toContain("never posted");
    expect(html).toContain(
      "Bills that came due are subtracted whether they are not posted or no statement has covered them yet.",
    );
  });

  /*
   * 🔴 Review of 8f9f408: the sentence ended "…, so a missing statement cannot bank itself as savings" — and `carryInto`
   * banked the whole plan of a closed period nobody had read, its $0.00 taken as "spent nothing". On his ledger copy
   * 2026-10-12 (every rolling budget carries from Sep 1) September banked $761.52 no statement confirmed: Cash & ATM
   * $130.00 and Fees $15.00 with no row and no day read, Travel $70.00 from one read through Sep 2.
   * ⚖️ Decision 67 (2026-10-13): such a period banks nothing until its statements land — so the panel says so, names
   * the period it is waiting on, and the carry arrives on its own once the statement is in.
   */
  test("a closed period no statement has covered banks nothing — the panel names it, and the carry arrives with it", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const card = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
    const foodRow = (postedOn: string, amountCents: number): void => {
      const row = { accountId: card, postedOn, amountCents, rawDescription: `SPEND ${postedOn}` };
      bundle.db
        .insert(transactions)
        .values({
          ...row,
          normalizedDescription: row.rawDescription,
          categoryId: catId("Food"),
          dedupeHash: dedupeHash({ ...row, occurrenceIndex: 0 }),
        })
        .run();
    };
    foodRow("2026-06-30", -1_000); // the Card's import stops at Jun 30, and so does what the ledger has read of Food
    const id = createBudget(bundle.db, {
      categoryId: catId("Food"),
      period: "monthly",
      amountCents: 3_000,
      startsOn: "2026-06-01",
    });
    setBudgetRollover(bundle.db, id, { enabled: true, startsOn: "2026-07-01" });
    const panelText = (): string =>
      renderToStaticMarkup(createElement(BudgetDetails, { status: statusFor("Food"), rolloverEnabled: true }))
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ");
    // the conditions under which the sentence was false: July, closed, not one day of it read
    const july = budgetPaceStatuses(bundle.db, "2026-07-31").find((x) => x.categoryName === "Food")!;
    expect(july.noDayRead).toBe(true);

    // …so it banks nothing, and the panel names the period it is waiting on
    expect(statusFor("Food").rolloverCents).toBe(0);
    expect(panelText()).toContain(
      "Banked $0.00 from closed periods. July 2026 is not fully imported, so nothing rolls over from it yet.",
    );
    expect(panelText()).toContain("so a missing statement on one of them cannot bank itself as savings.");
    /*
     * 🔴 …and the plan's proof on the same row said its own words, from before decision 67: "this plan plus
     * whatever you underspent in closed periods" — over July's $30.00 plan, nothing read of it, $0.00 carried
     * (review of 9249ae7). ⛔ One rule, two readers: the proof says what the panel says.
     */
    const plan = provenanceFor(bundle.db, { kind: "budgetPlan", id, label: "Food" })!;
    expect(plan.headline).not.toContain("whatever you underspent");
    expect(plan.headline).toContain(`${ROLLOVER_BANKS} ${ROLLOVER_HOLDS}`);
    expect(panelText()).toContain(ROLLOVER_BANKS);

    foodRow("2026-08-01", -500); // July's statement lands: the Card is read past Jul 31
    expect(statusFor("Food").rolloverCents).toBe(3_000);
    expect(panelText()).toContain("Banked $30.00 from closed periods. A period that came in under plan");
    expect(panelText()).not.toContain("so nothing rolls over");
    expect(panelText()).toContain("so a missing statement on one of them cannot bank itself as savings.");
  });

  /*
   * 🔴 Review of 46b6e4b: the panel said "the accounts this category has lately been spent from" under EVERY rolling
   * budget, while the carry asks its category page's day (`categoryReachFor`) — a category with no account of its own
   * waits on its nearest ancestor's accounts. The panel names whose day the carry asked, as it asked it.
   */
  test("a subcategory with no account of its own names the parent whose accounts its carry waits on", () => {
    const chase = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!;
    const card = createAccount(bundle.db, { institutionId: chase.id, name: "Card", type: "credit" });
    const row = { accountId: card, postedOn: "2026-07-20", amountCents: -1_000, rawDescription: "GROCER" };
    bundle.db
      .insert(transactions)
      .values({
        ...row,
        normalizedDescription: row.rawDescription,
        categoryId: catId("Food"),
        dedupeHash: dedupeHash({ ...row, occurrenceIndex: 0 }),
      })
      .run();
    const coffee = bundle.db
      .select()
      .from(categories)
      .where(and(eq(categories.name, "Coffee"), eq(categories.parentId, catId("Food"))))
      .get()!;
    const id = createBudget(bundle.db, { categoryId: coffee.id, period: "monthly", amountCents: 3_000, startsOn: "2026-07-01" });
    setBudgetRollover(bundle.db, id, { enabled: true });

    const text = renderToStaticMarkup(createElement(BudgetDetails, { status: statusFor("Coffee"), rolloverEnabled: true }))
      .replace(/<[^>]+>/g, "")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
    // …through THAT PERIOD's last day: 🔴 "through its last day" after "the accounts Food …" read as Food's (review of
    // 9249ae7)
    expect(text).toContain(
      "With no account of its own to wait on, a period of this category adds nothing until the accounts Food has " +
        "lately been spent from are imported through that period's last day, so a missing statement on one of them " +
        "cannot bank itself as savings.",
    );
    expect(text).not.toContain("the accounts this category has lately been spent from");
  });
});

/*
 * ⚖️ His decision 71 (2026-10-13): the editor's guide averages the dashboard's window, and a window the frontier slid
 * back names its months and says why (`budgetGuides`). This pins that the editor prints what it is handed: the lead
 * beside the figure, and the note under it only when there is one.
 */
describe("BudgetRow — the inline editor's guide", () => {
  afterEach(() => {
    popovers.forceOpen = false;
  });

  function editorText(guide: Parameters<typeof BudgetRow>[0]["guide"]): string {
    createBudget(bundle.db, { categoryId: catId("Food"), period: "monthly", amountCents: 60_000, startsOn: "2026-08-01" });
    popovers.forceOpen = true;
    return renderToStaticMarkup(
      createElement(BudgetRow, { status: statusFor("Food"), guide, spentProvenance: null, planProvenance: null }),
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  }

  test("a guide the frontier slid back prints its lead, its figure, and why", () => {
    const note =
      "Averaged over 6 complete months, Feb 2026 to Jul 2026. Aug 2026 and Sep 2026 are left out: Aug 12 is the last " +
      "day every account you spend from has been imported through.";
    const text = editorText({ cents: 221_650, lead: "6-mo avg", note });
    expect(text).toContain("6-mo avg ≈ $2,216.50");
    expect(text).toContain(note);
  });

  test("an uncut guide prints no note", () => {
    const text = editorText({ cents: 74_169, lead: "6-mo avg", note: null });
    expect(text).toContain("6-mo avg ≈ $741.69");
    expect(text).not.toContain("left out");
  });

  test("no guide prints nothing", () => {
    const text = editorText(null);
    expect(text).not.toContain("avg ≈");
    expect(text).not.toContain("left out");
  });
});
