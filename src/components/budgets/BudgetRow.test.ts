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
      createElement(BudgetRow, { status: s, guidanceCents: 0, spentProvenance: spentProof, planProvenance: null }),
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

  test("the control: one day read keeps today's lower-bound shape — $0.00 and a bar at 0", () => {
    const s = foodReadThrough("2026-08-01");
    const html = render(s);
    expect(figures(html)).toMatch(/^Spent \$0\.00 Budget \$300\.00 Left \$300\.00/);
    expect(html).toContain('aria-valuenow="0"');
    expect(spoken(html)).toMatch(/^Food: \$0\.00 of \$300\.00 \(0% of budget\)\. /);
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
      "Bills that came due are subtracted whether they are not posted or no statement has covered them yet, so a " +
        "missing statement cannot bank itself as savings.",
    );
  });
});
