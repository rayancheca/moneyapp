import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { dailyBalances } from "@/db/schema/balances";
import { categories } from "@/db/schema/categories";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { createAccount } from "@/services/accounts";
import { runwayCard } from "@/services/committed";
import { RunwayCard } from "./RunwayCard";

const TODAY = "2026-09-15";

let dir: string;
let bundle: DbBundle;

/** The href of the one `<a>` whose whole text is `text`, entity-decoded. */
function hrefOfLink(markup: string, text: string): string | null {
  const m = new RegExp(`<a [^>]*href="([^"]*)"[^>]*>${text}</a>`).exec(markup);
  return m ? m[1]!.replaceAll("&amp;", "&") : null;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-runway-card-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = (name: string) =>
    bundle.db.select().from(institutions).where(eq(institutions.name, name)).get()!.id;
  const robinhood = institutionId("Robinhood");
  const checking = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "Checking", type: "checking" });
  const brokerage = createAccount(bundle.db, {
    institutionId: robinhood,
    name: "Robinhood Brokerage",
    type: "investment",
    subtype: "brokerage",
  });
  const settlement = createAccount(bundle.db, { institutionId: robinhood, name: "Robinhood Cash", type: "checking" });
  const now = new Date().toISOString();
  bundle.db
    .insert(importFiles)
    .values({
      id: "rh-statement",
      fileName: "rh.pdf",
      fileSha256: "sha-rh",
      format: "pdf",
      institutionId: robinhood,
      status: "parsed",
      storagePath: "/tmp/rh.pdf",
      importedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  [settlement, brokerage].forEach((accountId, i) => {
    bundle.db
      .insert(statementPeriods)
      .values({
        id: `rh-period-${i}`,
        importFileId: "rh-statement",
        accountId,
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        reconciliation: "reconciled",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  for (const [accountId, cents] of [
    [checking, 300760],
    [brokerage, 7301320],
    [settlement, 90],
  ] as const) {
    bundle.db.insert(dailyBalances).values({ accountId, day: TODAY, balanceCents: cents, basis: "anchored" }).run();
  }
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * 🔴 "What selling investments would add" linked to `/investments`, whose value
 * is the investment accounts' holdings and nothing else. Since the owner's
 * decision of 2026-09-15 the row also carries the brokerage's own cash —
 * Robinhood Cash and Robinhood Agentic, printed on its statement — which
 * `/investments` never lists, so the link would open a page short of the row by
 * exactly that cash: measured on his ledger that day, $109,002.47 on the row
 * against $108,974.93 of holdings. `/accounts` lists every account the figure
 * sums, as it already does for "Cash you can spend today".
 */
test("the investments row links to the accounts it sums, brokerage cash included", () => {
  const card = runwayCard(bundle.db, TODAY);
  expect(card.runway.assumptions.find((a) => a.id === "investments")!.cents).toBe(7301320 + 90);

  const markup = renderToStaticMarkup(createElement(RunwayCard, { data: card }));
  expect(hrefOfLink(markup, "What selling investments would add")).toBe("/accounts");
  expect(hrefOfLink(markup, "Cash you can spend today")).toBe("/accounts");
});

/**
 * 🔴 Measured on his ledger copy 2026-10-12: "What you earn a month $4,948.32" — a rate levelled from his confirmed
 * weekly pay — linked to a bare `/spending`, which opened October and read "not imported yet". The service builds
 * `incomeHref` from the basis (its tests pin each one); this pins the half they cannot see, that the row renders it.
 */
test("the earn row opens the pay schedule its rate is levelled from", () => {
  const pay = bundle.db
    .insert(recurringSeries)
    .values({
      name: "It America LLC (weekly pay)",
      kind: "income",
      cadence: "weekly",
      status: "confirmed",
      intervalDaysAvg: 7,
      toleranceDays: 2,
      nextExpectedOn: "2026-09-17",
      nextExpectedAmountCents: 114192,
    })
    .returning({ id: recurringSeries.id })
    .get().id;

  const card = runwayCard(bundle.db, TODAY);
  expect(card.runway.assumptions.find((a) => a.id === "income")).toMatchObject({
    label: "What you earn a month",
    cents: Math.round((114192 * 52) / 12),
  });
  const markup = renderToStaticMarkup(createElement(RunwayCard, { data: card }));
  expect(hrefOfLink(markup, "What you earn a month")).toBe(`/recurring/${pay}`);
});

/**
 * ⚖️ His decision 61 (2026-10-12): the spend row keeps its link and gets its arithmetic captioned under it. The
 * service builds the sentence (`spendArithmetic`, its tests pin the sum); this pins that it renders as the spend row's
 * own description, under its figure, and that the row and its link are unchanged.
 */
test("the spend row carries its arithmetic under it", () => {
  const checking = bundle.db.select().from(accounts).where(eq(accounts.name, "Checking")).get()!.id;
  const groceries = bundle.db.select().from(categories).where(eq(categories.name, "Groceries")).get()!.id;
  // August is the one complete month: the ledger opens on its first day
  for (const [i, [postedOn, amountCents]] of ([
    ["2026-08-01", -120000],
    ["2026-08-20", 4550],
  ] as const).entries()) {
    bundle.db
      .insert(transactions)
      .values({
        accountId: checking,
        postedOn,
        amountCents,
        rawDescription: "SUPERMARKET",
        normalizedDescription: "SUPERMARKET",
        categoryId: groceries,
        dedupeHash: `runway-spend-${i}`,
      })
      .run();
  }
  // his weekly pay, so the earn row beside it reads as his did: "What you earn a month $4,948.32"
  bundle.db
    .insert(recurringSeries)
    .values({
      name: "It America LLC (weekly pay)",
      kind: "income",
      cadence: "weekly",
      status: "confirmed",
      intervalDaysAvg: 7,
      toleranceDays: 2,
      nextExpectedOn: "2026-09-17",
      nextExpectedAmountCents: 114192,
    })
    .run();

  const card = runwayCard(bundle.db, TODAY);
  expect(card.runway.assumptions.find((a) => a.id === "spend")!.cents).toBe(120000 - 4550);
  const markup = renderToStaticMarkup(createElement(RunwayCard, { data: card }));
  expect(hrefOfLink(markup, "What you spend a month")).toBe("/spending?from=2026-08-01&to=2026-08-31");
  expect(rowDescriptions(markup, "What you spend a month")).toEqual([
    "$1,154.50",
    "$1,200.00 spent − $45.50 back, over 1 month",
  ]);
  /*
   * …and the spend row's alone. 🔴 This guard read "Cash you can spend today", a cash row rendered with no caption prop
   * at all, so it could not fail: with the card passing `spendArithmetic` to BOTH flow rows, measured on bcfab98, the
   * dashboard's and the runway services' tests stayed green (12 files, 161 tests) while his card would have printed
   * "$56,444.55 spent − $888.62 back − $6,100.00 up front, over 6 months" under "What you earn a month $4,948.32". The
   * row that shares the caption prop is the earn row; the sentence is on the card once.
   */
  expect(rowDescriptions(markup, "What you earn a month")).toEqual(["$4,948.32"]);
  expect(markup.split("$1,200.00 spent − $45.50 back, over 1 month")).toHaveLength(2);
});

/** The text of every `<dd>` in the row whose link reads `label`, in order. */
function rowDescriptions(markup: string, label: string): string[] {
  const row = new RegExp(`<a [^>]*>${label}</a>.*?</dt>(.*?)</div>`).exec(markup);
  if (!row) return [];
  return [...row[1]!.matchAll(/<dd[^>]*>(.*?)<\/dd>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
}

/**
 * 🔴 Measured on the owner's ledger 2026-10-07: "A further $2,296.20 came due
 * earlier this month and never posted." while October is imported for none of
 * the accounts those bills post from. A bill no import has reached reads in
 * /budgets' words; "never posted" is kept for days the ledger has read.
 */
test("arrears no import has reached are not called never posted", () => {
  bundle.db
    .insert(recurringSeries)
    .values({
      name: "Rent",
      kind: "bill",
      cadence: "monthly",
      status: "confirmed",
      intervalDaysAvg: 30,
      toleranceDays: 4,
      nextExpectedOn: "2026-09-01",
      nextExpectedAmountCents: -210900,
    })
    .run();

  const card = runwayCard(bundle.db, TODAY);
  expect(card.committed.overdueCents).toBe(210900);
  const markup = renderToStaticMarkup(createElement(RunwayCard, { data: card }));
  expect(markup).toContain("A further $2,109.00 came due earlier this month and no import has covered it yet.");
  expect(markup).not.toContain("never posted");
  /*
   * 🔴 …and it said so in red. On a copy of his ledger 2026-10-08 the runway was the one surface still treating
   * staleness as an alarm: "A further $2,291.21 came due earlier this month and no import has covered it yet." in
   * `text-negative`, while the rent's page, the Next column and /categories said the same money quietly. ⚖️ Staleness
   * between uploads is normal, never a warning (his words 2026-08-05) — `arrearsAlarms`.
   */
  expect(arrearsLine(markup)).toEqual({
    text: "A further $2,109.00 came due earlier this month and no import has covered it yet.",
    alarm: false,
  });
});

test("arrears on days the ledger has read keep the negative tone", () => {
  const checking = bundle.db.select().from(accounts).where(eq(accounts.name, "Checking")).get()!.id;
  const now = new Date().toISOString();
  // Checking is read through yesterday, so the Sep 1 rent and every day a payment could have posted are read
  bundle.db
    .insert(statementPeriods)
    .values({
      id: "chk-period",
      importFileId: "rh-statement",
      accountId: checking,
      periodStart: "2026-08-15",
      periodEnd: "2026-09-14",
      reconciliation: "reconciled",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  bundle.db
    .insert(recurringSeries)
    .values({
      name: "Rent",
      kind: "bill",
      cadence: "monthly",
      status: "confirmed",
      intervalDaysAvg: 30,
      toleranceDays: 4,
      nextExpectedOn: "2026-09-01",
      nextExpectedAmountCents: -210900,
      accountId: checking,
    })
    .run();

  const card = runwayCard(bundle.db, TODAY);
  expect(card.committed.overdueUnreadCents).toBe(0);
  expect(arrearsLine(renderToStaticMarkup(createElement(RunwayCard, { data: card })))).toEqual({
    text: "A further $2,109.00 came due earlier this month and never posted.",
    alarm: true,
  });
});

/** The runway's arrears paragraph: its words, and whether it carries the negative tone. */
function arrearsLine(markup: string): { text: string; alarm: boolean } | null {
  const m = /<p class="([^"]*)">(A further [^<]*)<\/p>/.exec(markup);
  return m ? { text: m[2]!, alarm: m[1]!.split(/\s+/).includes("text-negative") } : null;
}
