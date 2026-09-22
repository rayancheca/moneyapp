import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { runwayCard } from "@/services/committed";
import { eatingOutCard } from "@/services/eating-out";
import { feesCard } from "@/services/fees-card";
import { EatingOutCard } from "./EatingOutCard";
import { FeesCard } from "./FeesCard";
import { RunwayCard } from "./RunwayCard";

/**
 * 🔴 THREE CARDS LINKED "Spending →" TO A MONTH THEY NEVER READ. The eating-out,
 * fees and runway cards each measure complete months that exclude the running
 * one, and each header link was a bare `/spending` — which `resolvePeriod`
 * resolves to the running month. Measured on the owner's ledger 2026-09-15: all
 * three measured Mar 2026 to Aug 2026 and all three links opened September
 * 2026, where the page refuses any comparison. The runway card's "What you
 * spend a month" row did the same.
 *
 * The services now build `spendingHref` from the window they read, and their
 * own tests pin it. This file pins the other half, which those cannot see: that
 * the card RENDERS the field rather than a literal `/spending`.
 */

const TODAY = "2026-08-26";
/** the six complete months before TODAY's month, as `baselineWindow` bounds them */
const WINDOW_HREF = "/spending?from=2026-02-01&to=2026-07-31";

let dir: string;
let bundle: DbBundle;
let seq = 0;

function childId(parent: string, name: string): string {
  const top = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, parent), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.parentId, top.id)))
    .get()!.id;
}

function addTxn(day: string, cents: number, categoryId: string | null): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `t-${seq}`,
      accountId: "acct-1",
      importFileId: null,
      postedOn: day,
      amountCents: cents,
      rawDescription: `ROW ${seq}`,
      normalizedDescription: `ROW ${seq}`,
      categoryId,
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `h-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

/** The href of the one `<a>` whose whole text is `text`, entity-decoded. */
function hrefOfLink(markup: string, text: string): string | null {
  const m = new RegExp(`<a [^>]*href="([^"]*)"[^>]*>${text}</a>`).exec(markup);
  return m ? m[1]!.replaceAll("&amp;", "&") : null;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-spending-links-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(accounts)
    .values({
      id: "acct-1",
      institutionId,
      name: "Checking",
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  seq = 0;
  // the ledger opens on a month's first day, so the window is six whole months
  addTxn("2025-01-01", -1, null);
  addTxn("2026-07-02", -2000, childId("Food", "Dining"));
  addTxn("2026-07-03", -1500, childId("Food", "Groceries"));
  addTxn("2026-07-04", -500, childId("Fees", "Bank Fees"));
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a dashboard card's Spending link opens the months the card read", () => {
  test("Eating out", () => {
    const markup = renderToStaticMarkup(createElement(EatingOutCard, { data: eatingOutCard(bundle.db, TODAY)! }));
    expect(hrefOfLink(markup, "Spending →")).toBe(WINDOW_HREF);
  });

  test("What the banks charge you", () => {
    const markup = renderToStaticMarkup(createElement(FeesCard, { data: feesCard(bundle.db, TODAY)! }));
    expect(hrefOfLink(markup, "Spending →")).toBe(WINDOW_HREF);
  });

  test("Runway — the header and the spend row", () => {
    const markup = renderToStaticMarkup(createElement(RunwayCard, { data: runwayCard(bundle.db, TODAY) }));
    expect(hrefOfLink(markup, "Spending →")).toBe(WINDOW_HREF);
    expect(hrefOfLink(markup, "What you spend a month")).toBe(WINDOW_HREF);
    /*
     * The income term is this month's, so its link still opens this month. The
     * ROW LABEL is now the one `incomeBasis` earned: this fixture has no income
     * series at all, so the basis is "calendar" — money already in plus pay
     * still due — and calling that "what you earn a month" was the same
     * mis-naming a five-week lump exposed on the "banked" basis.
     */
    expect(hrefOfLink(markup, "Income expected this window")).toBe("/spending");
  });
});
