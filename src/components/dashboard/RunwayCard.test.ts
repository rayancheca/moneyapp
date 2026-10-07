import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { dailyBalances } from "@/db/schema/balances";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries } from "@/db/schema/recurring";
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
});
