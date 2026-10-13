import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type SeriesKind } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { addDays, periodBounds } from "@/lib/dates";
import { resolveViewState } from "@/lib/view-state";
import { RECURRING_SERIES_VIEW_SPEC } from "@/components/recurring/recurring-view-spec";
import { createAccount } from "./accounts";
import { incomeExpectation } from "./budgets";
import { forecastCurrentMonth } from "./forecast";
import { printOnOneStatement } from "./printed-statement-fixture";
import { seriesDetail } from "./recurring-detail";

// rendering never navigates or submits; the page and its controls only need these to exist
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/recurring/s",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/recurring/actions", () => ({
  renameSeriesAction: vi.fn(),
  setSeriesStatusAction: vi.fn(),
  setSeriesOverridesAction: vi.fn(),
  attachToSeriesAction: vi.fn(),
  detachFromSeriesAction: vi.fn(),
  mergeIntoSeriesAction: vi.fn(),
  searchAttachCandidatesAction: vi.fn(),
}));
vi.mock("@/app/settings/actions", () => ({ saveViewPreferenceAction: vi.fn() }));

const { SeriesDetail } = await import("@/components/recurring/SeriesDetail");

/**
 * 🔴 His pay series' own page said nothing of the paydays that had passed this month. Read on a copy of his ledger
 * 2026-10-12, `/recurring/<It America LLC (weekly pay)>` showed "Awaiting statements" and "Next expected Oct 15" —
 * and no word of Oct 1 or Oct 8 — while the forecast on /recurring said "2 paydays worth $2,283.84 already passed
 * this month … the ledger has not looked for their deposits", /budgets said the same, and every BILL page carried an
 * "Already due — no import has covered it yet" block listing its days.
 *
 * ⛔ The fixture is that ledger's shape: a Thursday schedule, its one attributed deposit in June, and the account its
 * pay lands in read through a day before the month's paydays.
 */

let dir: string;
let bundle: DbBundle;
const TODAY = "2026-09-15";
const CHASE = "acct-chase";
const SERIES = "series-pay";
const now = (): string => new Date().toISOString();

function salaryId(): string {
  const named = (name: string, parentId: string | null) => {
    const parent = parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId);
    return bundle.db.select().from(categories).where(and(eq(categories.name, name), parent)).get()!;
  };
  return named("Salary", named("Income", null).id).id;
}

function addAccount(id: string): void {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId: bundle.db.select().from(institutions).all()[0]!.id,
      name: id,
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function addSeries(
  id: string,
  name: string,
  opts: { kind?: SeriesKind; cents?: number; status?: "confirmed" | "ended"; accountId?: string } = {},
): void {
  const cents = opts.cents ?? 100_000;
  bundle.db
    .insert(recurringSeries)
    .values({
      id,
      name,
      kind: opts.kind ?? "income",
      cadence: "weekly",
      userCadence: "weekly",
      intervalDaysAvg: 7,
      amountCentsAvg: cents,
      userAmountCents: cents,
      nextExpectedOn: "2026-06-04",
      nextExpectedAmountCents: cents,
      lastMatchedOn: "2026-06-04",
      accountId: opts.accountId ?? null,
      status: opts.status ?? "confirmed",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

let seq = 0;
function deposit(accountId: string, seriesId: string, postedOn: string, cents = 100_000): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId,
      postedOn,
      amountCents: cents,
      rawDescription: "PAYROLL",
      normalizedDescription: "PAYROLL",
      categoryId: salaryId(),
      recurringSeriesId: seriesId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/** Days the balance walk has read — the second arbiter `accountCoverage` grades. */
function readThrough(accountId: string, from: string, to: string): void {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    bundle.db.insert(dailyBalances).values({ accountId, day, balanceCents: 100_000, basis: "derived" }).run();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-pay-page-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  addAccount(CHASE);
  addSeries(SERIES, "It America LLC (weekly pay)");
  // the one attributed deposit: a Thursday, so the schedule's paydays are Thursdays
  deposit(CHASE, SERIES, "2026-06-04");
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const page = (id: string) => seriesDetail(bundle.db, id, TODAY);

/** What the forecast and /budgets read of the same paydays — the reading the page must not disagree with. */
function othersRead() {
  const f = forecastCurrentMonth(bundle.db, TODAY).unbankedIncome;
  const month = periodBounds(TODAY, "monthly");
  const b = incomeExpectation(bundle.db, month.start, month.end, TODAY);
  return {
    forecast: {
      totalCents: f.totalCents,
      occurrenceCount: f.occurrenceCount,
      checkedOccurrenceCount: f.checkedOccurrenceCount,
      frontier: f.frontier,
    },
    budgets: {
      totalCents: b.passedUnpaidCents,
      occurrenceCount: b.passedUnpaidOccurrences,
      checkedOccurrenceCount: b.passedUnpaidCheckedOccurrences,
      frontier: b.passedUnpaidFrontier,
    },
  };
}

describe("a pay series' own page lists the paydays that passed this month with no deposit", () => {
  test("his October's shape: both paydays after the frontier, each listed, as the forecast and /budgets say", () => {
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    const passed = page(SERIES).unbankedPaydays;
    expect(passed).toEqual({
      totalCents: 200_000,
      occurrenceCount: 2,
      checkedOccurrenceCount: 0,
      frontier: { kind: "day", through: "2026-08-12" },
      paydays: [
        { date: "2026-09-03", amountCents: 100_000 },
        { date: "2026-09-10", amountCents: 100_000 },
      ],
    });
    const { paydays: _paydays, ...reading } = passed!;
    const others = othersRead();
    expect(reading).toEqual(others.forecast);
    expect(reading).toEqual(others.budgets);
  });

  /* ⛔ A date window has two ends, and so does "checked": a payday ON the frontier day was looked for. */
  test("a month straddling the frontier carries its own checked split, the same one the forecast reads", () => {
    readThrough(CHASE, "2026-06-01", "2026-09-03");
    const passed = page(SERIES).unbankedPaydays!;
    expect(passed).toMatchObject({
      occurrenceCount: 2,
      checkedOccurrenceCount: 1,
      frontier: { kind: "day", through: "2026-09-03" },
    });
    const { paydays: _paydays, ...reading } = passed;
    expect(reading).toEqual(othersRead().forecast);
  });

  test("a payday a deposit met is not listed — settlement's answer, not a date match of the page's own", () => {
    readThrough(CHASE, "2026-06-01", "2026-09-14");
    deposit(CHASE, SERIES, "2026-09-10");
    const passed = page(SERIES).unbankedPaydays!;
    expect(passed.paydays).toEqual([{ date: "2026-09-03", amountCents: 100_000 }]);
    expect(passed.totalCents).toBe(othersRead().forecast.totalCents);
  });

  test("each payday at its own day's rate, summing to the total (§6A 55)", () => {
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    const passed = page(SERIES).unbankedPaydays!;
    expect(passed.paydays.reduce((sum, p) => sum + p.amountCents, 0)).toBe(passed.totalCents);
  });

  test("nothing passed — the 1st of the month, or every payday met — is no block at all", () => {
    readThrough(CHASE, "2026-06-01", "2026-09-14");
    expect(seriesDetail(bundle.db, SERIES, "2026-09-01").unbankedPaydays).toBeNull();
    deposit(CHASE, SERIES, "2026-09-03");
    deposit(CHASE, SERIES, "2026-09-10");
    expect(page(SERIES).unbankedPaydays).toBeNull();
  });

  test("an ended pay series owes no paydays, as the forecast counts none of its", () => {
    addSeries("series-old", "Fordham Payroll", { status: "ended" });
    deposit(CHASE, "series-old", "2026-06-04");
    expect(page("series-old").unbankedPaydays).toBeNull();
  });

  /*
   * ⚖️ What the agent's account is paid is not HIS income (owner decision 2026-09-28, `isAgentsIncomeSeries`): the
   * forecast and /budgets leave its schedule out of the passed paydays, so its page names none either.
   */
  test("the agent's income series stays out, as the forecast leaves it out", () => {
    const rh = bundle.db.select().from(institutions).where(eq(institutions.name, "Robinhood")).get()!;
    const agentic = createAccount(bundle.db, { institutionId: rh.id, name: "Robinhood Agentic", type: "checking" });
    const book = createAccount(bundle.db, {
      institutionId: rh.id,
      name: "Robinhood Agentic Brokerage",
      type: "investment",
      subtype: "brokerage",
    });
    bundle.db.update(accounts).set({ cashAccountId: agentic }).where(eq(accounts.id, book)).run();
    printOnOneStatement(bundle.db, rh.id, [agentic, book]);
    addSeries("series-agent", "Agent interest", { cents: 4, accountId: agentic });
    deposit(agentic, "series-agent", "2026-06-04", 4);
    readThrough(CHASE, "2026-06-01", "2026-08-12");

    expect(forecastCurrentMonth(bundle.db, TODAY).unbankedIncome.names).toEqual(["It America LLC (weekly pay)"]);
    expect(page("series-agent").unbankedPaydays).toBeNull();
    expect(page(SERIES).unbankedPaydays).not.toBeNull();
  });

  test("a bill's page lists no paydays — its arrears are `overdue`'s, untouched", () => {
    addSeries("series-bill", "Gym", { kind: "bill", cents: -5_000 });
    deposit(CHASE, "series-bill", "2026-06-04", -5_000);
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    expect(page("series-bill").unbankedPaydays).toBeNull();
  });
});

describe("the page renders the block from that reading", () => {
  const decode = (s: string): string =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const words = (id: string): string =>
    decode(
      renderToStaticMarkup(
        createElement(SeriesDetail, {
          data: page(id),
          today: TODAY,
          viewState: resolveViewState(RECURRING_SERIES_VIEW_SPEC, {}, undefined),
          basePath: `/recurring/${id}`,
        }),
      ),
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");

  test("his pay page names both paydays, in the forecast's words", () => {
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    const w = words(SERIES);
    expect(w).toContain("2 paydays worth $2,000.00 already passed this month");
    expect(w).toContain(
      "They all fall after Wed, Aug 12, 2026, the last day every account that pay lands in has been checked " +
        "through — so the ledger has not looked for their deposits.",
    );
    expect(w).toMatch(/Sep 3, 2026 \+\$1,000\.00 .*Sep 10, 2026 \+\$1,000\.00/);
  });

  test("a bill's page carries no such block", () => {
    addSeries("series-bill", "Gym", { kind: "bill", cents: -5_000 });
    deposit(CHASE, "series-bill", "2026-06-04", -5_000);
    readThrough(CHASE, "2026-06-01", "2026-08-12");
    expect(words("series-bill")).not.toMatch(/already passed this month|payday/);
  });
});
