import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { institutions } from "@/db/schema/institutions";
import { recurringSeries, type SeriesKind } from "@/db/schema/recurring";
import { seedDatabase } from "@/db/seed";
import { createAccount } from "@/services/accounts";
import { addManualAnchor } from "@/services/anchors";
import { dashboardData } from "@/services/dashboard";
import { UpcomingBillsStrip } from "./UpcomingBillsStrip";

/**
 * The Upcoming strip's paycheck line, rendered as the dashboard renders it from `dashboardData` — so the
 * words are read against the sum they stand beside, not against a hand-made model.
 */

const TODAY = "2026-10-12";

let dir: string;
let bundle: DbBundle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-upcoming-strip-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const instId = bundle.db.select().from(institutions).where(eq(institutions.name, "Chase")).get()!.id;
  const checking = createAccount(bundle.db, { institutionId: instId, name: "Chase Checking", type: "checking" });
  addManualAnchor(bundle.db, { accountId: checking, anchoredOn: TODAY, enteredCents: 500_00 });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function series(name: string, kind: SeriesKind, nextExpectedOn: string, amountCents: number, days: number): void {
  bundle.db
    .insert(recurringSeries)
    .values({
      name,
      kind,
      cadence: days === 7 ? "weekly" : "monthly",
      intervalDaysAvg: days,
      nextExpectedOn,
      nextExpectedAmountCents: amountCents,
      amountCentsAvg: amountCents,
      lastMatchedOn: `2026-09-${nextExpectedOn.slice(8, 10)}`,
      status: "confirmed",
    })
    .run();
}

/** the strip's one sentence beside the heading, as text */
function paycheckLine(markup: string): string | null {
  const m = markup.match(/<p class="text-xs text-ink-muted">(.*?)<\/p>/);
  return m ? m[1]!.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, "") : null;
}

/*
 * 🔴 THE WORDS SAID "BEFORE"; THE SUM COUNTS "ON OR BEFORE". `upcomingBills` adds every bill due on or before the
 * payday (`<= 0` — kept on purpose: a bill and the pay share a day often, and leaving it out understated what he
 * must cover by a whole rent). The sentence beside it read "due before your next paycheck". Measured on his ledger
 * copy 2026-10-12: "$701.04 due before your next paycheck (Oct 15)" — the car lease $695.04 and Rocket Money $6.00,
 * BOTH due Oct 15, the payday itself. Nothing in that $701.04 is due before Oct 15. "By" says what is summed.
 */
test("the line says BY the payday, because the bills it sums fall due on the payday itself", () => {
  series("It America LLC (weekly pay)", "income", "2026-10-15", 1141_92, 7);
  series("Car lease", "bill", "2026-10-15", -695_04, 30);
  series("Rocket Money", "subscription", "2026-10-15", -6_00, 30);

  const { upcoming } = dashboardData(bundle.db, TODAY);
  expect(upcoming.beforePaycheck).toEqual({ date: "2026-10-15", cents: -701_04 });
  expect(paycheckLine(renderToStaticMarkup(createElement(UpcomingBillsStrip, { data: upcoming })))).toBe(
    "$701.04 due by your next paycheck (Oct 15)",
  );
});
