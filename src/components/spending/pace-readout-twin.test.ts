import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { categories } from "@/db/schema/categories";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { typicalPaceCents } from "@/lib/pace-readout";
import { resolvePeriod } from "@/lib/period";
import { createAccount } from "@/services/accounts";
import { dashboardData } from "@/services/dashboard";
import { cashFlowByPeriod, spendingProjection } from "@/services/spending";
import { SpendingPaceWidget } from "@/components/dashboard/SpendingPaceWidget";
import { CashFlowChart } from "./CashFlowChart";

// the readout never navigates; the chart's click handlers only need a router to exist
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

/**
 * 🔴 S12: two surfaces grading one window must not grade it two ways — the dashboard's pace tile and /spending's
 * cash-flow readout, which the tile links to (`pace-readout.ts`). ⚖️ Decision 64 (2026-10-12): no spending found and
 * not one elapsed day read by the day every account he spends from is imported through is no "$0.00 spent".
 *
 * 🔴 Review of 1042f71 (today 2026-07-08): the tile dashed "Free to spend — nothing found so far — spending imported
 * through Jun 20", and /spending's stat cards dashed Spent, Net and the savings rate, while the readout on the same page
 * printed "On pace for at least $0.00 … at least $0.00 so far" — the figure the tile's own comment calls "true of every
 * month there has ever been". Plausible on his ledger: a Wells Fargo import carrying a month's payroll before any card
 * shows that month's spending, Chase Checking still read through Aug 12.
 */

const TODAY = "2026-07-08";

let dir: string;
let bundle: DbBundle;
let seq = 0;

function account(institution: string, name: string, type: "checking" | "credit"): string {
  // the seed holds no Wells Fargo
  bundle.db.insert(institutions).values({ name: institution }).onConflictDoNothing().run();
  const instId = bundle.db.select().from(institutions).where(eq(institutions.name, institution)).get()!.id;
  return createAccount(bundle.db, { institutionId: instId, name, type });
}

function row(accountId: string, postedOn: string, amountCents: number, categoryId: string | null = null): void {
  seq += 1;
  const desc = `ROW ${seq}`;
  bundle.db
    .insert(transactions)
    .values({
      accountId,
      postedOn,
      amountCents,
      rawDescription: desc,
      normalizedDescription: desc,
      categoryId,
      dedupeHash: `twin-${seq}`,
    })
    .run();
}

function closeStatement(accountId: string, periodStart: string, periodEnd: string): void {
  const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
  const now = new Date().toISOString();
  const id = `${accountId}-${periodEnd}`;
  bundle.db
    .insert(importFiles)
    .values({
      id,
      fileName: `${periodEnd}-statement.pdf`,
      fileSha256: `sha-${id}`,
      format: "pdf",
      institutionId: instId,
      parserVersion: 1,
      status: "parsed",
      storagePath: `/tmp/${id}.pdf`,
      importedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  bundle.db
    .insert(statementPeriods)
    .values({
      id: `period-${id}`,
      importFileId: id,
      accountId,
      periodStart,
      periodEnd,
      reconciliation: "reconciled",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** the markup's text, which is what a screen reader reads: tags stripped, blocks spaced (the tile's test's helper) */
const textOf = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-pace-twin-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the pace tile and /spending's cash-flow readout — a running month with no spending found", () => {
  /** the reviewer's window: checking read through Jun 20, the card's statement through Jul 5, payroll on Jul 3 */
  function seedNothingFound(): void {
    const checking = account("Chase", "Chase Checking", "checking");
    row(checking, "2026-06-20", -900_00);
    const venture = account("Chase", "Venture X", "credit");
    row(venture, "2026-06-10", -25_00);
    closeStatement(venture, "2026-06-06", "2026-07-05");
    const salary = bundle.db.select().from(categories).where(eq(categories.name, "Salary")).get()!.id;
    const wells = account("Wells Fargo", "Wells Fargo Checking", "checking");
    row(wells, "2026-07-03", 1_141_92, salary);
  }

  function readout(): string {
    const period = resolvePeriod({}, TODAY);
    const cashFlow = cashFlowByPeriod(bundle.db, period, TODAY);
    const projection = spendingProjection(bundle.db, period, TODAY, cashFlow.pace, cashFlow.totals.spentCents);
    const html = renderToStaticMarkup(createElement(CashFlowChart, { data: cashFlow, projection }));
    // the readout is the paragraph above the chart
    return textOf(/<p\b[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "");
  }

  test("both say nothing was found past spending's day, in the same words, and neither prints $0.00", () => {
    seedNothingFound();
    const words = "nothing found so far — spending imported through Jun 20";

    const pace = dashboardData(bundle.db, TODAY).pace!;
    const tile = textOf(renderToStaticMarkup(createElement(SpendingPaceWidget, { pace })));
    expect(tile).toContain(`Free to spend — ${words}`);
    expect(tile).not.toContain("$0.00");

    const text = readout();
    // the same words, opening the readout's line with a capital (in the text — never `first-letter:uppercase`)
    expect(text).toContain(`N${words.slice(1)}`);
    expect(text).not.toContain("$0.00");
    expect(text).not.toContain("On pace for");
    // the tile prints no day count beside its dash; the fact names the day, and every elapsed day is past it
    expect(text).not.toContain("unaccounted");

    /*
     * …and the chart under the readout draws no dashed pace: 🔴 review of 4d799b6, on this very window it drew the amber
     * "typical pace" at $0 under "Nothing found so far" — $0 because nothing was found (`typicalPaceCents`).
     */
    const cashFlow = cashFlowByPeriod(bundle.db, resolvePeriod({}, TODAY), TODAY);
    expect(cashFlow.pace?.avgPerBucketCents).toBe(0);
    expect(typicalPaceCents(cashFlow)).toBeNull();
  });

  test("a month whose spending was found keeps the readout's figures, marked as the floors they are", () => {
    seedNothingFound();
    const card = account("Chase", "Sapphire", "credit");
    row(card, "2026-07-04", -40_00);

    const text = readout();
    expect(text).toContain("On pace for at least");
    expect(text).toContain("at least $40.00 so far");
    expect(text).toContain("spending imported through Jun 20 · 8 days of this period unaccounted");
    expect(text).not.toContain("nothing found");
  });
});
