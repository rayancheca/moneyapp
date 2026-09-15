import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { multipleFact } from "@/lib/insight-facts";
import { eatingOutCard } from "@/services/eating-out";
import { EatingOutCard } from "./EatingOutCard";

/**
 * 🔴 THE CARD PRINTED A MULTIPLE NO TWO MAGNITUDES CAN HAVE. `multipleFact`
 * refuses a multiple at or below zero — "a caller producing one has divided by
 * something that was not a magnitude" — and the eating-out card, the one other
 * surface that prints "N×", divided its two nets itself and printed whatever
 * came out. Refunds net inside each bucket (the card's own ⛔), so either net
 * can land at or below zero while the card is still on the dashboard (it needs
 * only one charge on each side):
 *
 *     eating out netted back, groceries spent   "-2.0× what you spend on groceries"
 *     eating out netted to zero                 "0.0× what you spend on groceries"
 *     groceries netted to or below zero         "No groceries in this window, so
 *                                                everything you ate was bought
 *                                                ready to eat." — over grocery trips
 *
 * The third is the `null` branch, which the dashboard could ONLY reach with a
 * grocery trip in the window (`isEmpty` hides a card with none), so the one
 * sentence it could print there was false every time.
 *
 * Measured on the owner's ledger 2026-09-15 at every month-end from 2022-10-31
 * to 2026-08-31 and at 2026-09-15 (the window depends only on today's month):
 * 48 of 48 cards print a positive multiple, 1.7× to 22.7×, and no net ever
 * reaches zero — the smallest are eating out $240.57 and groceries $106.33, both
 * over the one-month window at 2022-10-31. The defect is unreachable on his
 * ledger today and reachable on any ledger whose refunds outweigh a window.
 *
 * Every sign of both nets, through the real service and the real component.
 */

const TODAY = "2026-08-26";

let dir: string;
let bundle: DbBundle;
let seq = 0;

function childId(name: string): string {
  const food = bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, "Food"), isNull(categories.parentId)))
    .get()!;
  return bundle.db
    .select()
    .from(categories)
    .where(and(eq(categories.name, name), eq(categories.parentId, food.id)))
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-eating-multiple-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  const institutionId = bundle.db.select().from(institutions).all()[0]!.id;
  bundle.db
    .insert(accounts)
    .values({
      id: "acct-1",
      institutionId,
      name: "Chase Checking",
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
  // (Feb–Jul 2026); uncategorised, so it is in neither bucket
  addTxn("2025-01-01", -1, null);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** Each net, as the signed amounts that produce it — every one holds a charge, so the card is shown. */
const NETS = {
  positive: [-5000],
  zero: [-5000, 5000],
  negative: [-2000, 5000],
} as const;
const GROCERY_NETS = {
  positive: [-1500],
  zero: [-1500, 1500],
  negative: [-1000, 3000],
} as const;
type Sign = keyof typeof NETS;
const SIGNS: readonly Sign[] = ["positive", "zero", "negative"];

function renderCard(eatingOut: Sign, groceries: Sign): string {
  NETS[eatingOut].forEach((cents, i) => addTxn(`2026-07-${String(2 + i).padStart(2, "0")}`, cents, childId("Dining")));
  GROCERY_NETS[groceries].forEach((cents, i) =>
    addTxn(`2026-06-${String(2 + i).padStart(2, "0")}`, cents, childId("Groceries")),
  );
  const card = eatingOutCard(bundle.db, TODAY)!;
  // the dashboard shows exactly these cards — `page.tsx` hides an `isEmpty` one
  expect(card.isEmpty).toBe(false);
  return text(renderToStaticMarkup(createElement(EatingOutCard, { data: card })));
}

describe("the eating-out card's multiple of groceries", () => {
  const cases = SIGNS.flatMap((e) => SIGNS.map((g) => [e, g] as const));

  test.each(cases)("eating out %s, groceries %s: a multiple only of two magnitudes", (e, g) => {
    const t = renderCard(e, g);
    if (e === "positive" && g === "positive") {
      // the one sentence a multiple may be printed in, spelled by the rule's own home
      const display = multipleFact("f1", "Eating out", 5000 / 1500, "what you spend on groceries").display;
      expect(display).toBe("3.3×");
      expect(t).toContain(`${display} what you spend on groceries, which comes to $2.50 a month.`);
      return;
    }
    // no figure followed by a times sign anywhere on the card — not "-2.0×", not "0.0×"
    expect(t).not.toMatch(/\d×/);
    // there WERE grocery trips in the window, so this sentence is false here
    expect(t).not.toContain("No groceries in this window");
  });

  test("eating out that refunds cancelled says so, and still gives groceries' monthly figure", () => {
    for (const e of ["zero", "negative"] as const) {
      const t = renderCard(e, "positive");
      expect(t).toContain(
        "Refunds came to at least what you spent on eating out in this window, so there is no multiple to give. " +
          "Groceries come to $2.50 a month.",
      );
      bundle.db.delete(transactions).where(eq(transactions.categoryId, childId("Dining"))).run();
      bundle.db.delete(transactions).where(eq(transactions.categoryId, childId("Groceries"))).run();
    }
  });

  test("groceries that refunds cancelled say so", () => {
    const t = renderCard("positive", "negative");
    expect(t).toContain(
      "Refunds came to at least what you spent on groceries in this window, so there is no multiple to give.",
    );
    expect(t).not.toContain("Groceries come to");
  });

  test("both cancelled says so once, for both", () => {
    const t = renderCard("negative", "zero");
    expect(t).toContain(
      "Refunds came to at least what you spent on eating out and on groceries in this window, so there is no multiple to give.",
    );
    // groceries netted back too, so their monthly figure is no magnitude to give
    expect(t).not.toContain("Groceries come to");
  });

  /**
   * 🔴 A grocery net of a few cents over six months is a monthly figure that
   * rounds to nothing, and the card printed it anyway: "2500.0× what you spend
   * on groceries, which comes to $0.00 a month." and, under eating out that
   * refunds cancelled, "Groceries come to $0.00 a month." — a measured zero over
   * a positive net the groceries row prints as $0.02. The window's total is on
   * that row; the monthly clause is left out rather than rounded to nothing.
   */
  test("a groceries figure that rounds to $0.00 a month is not stated as one beside a multiple", () => {
    addTxn("2026-06-02", -1500, childId("Groceries"));
    addTxn("2026-06-03", 1498, childId("Groceries"));
    addTxn("2026-07-02", -5000, childId("Dining"));
    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.isEmpty).toBe(false);
    expect(card.groceries.spentCents).toBe(2);
    expect(card.groceriesMonthlyCents).toBe(0);
    const t = text(renderToStaticMarkup(createElement(EatingOutCard, { data: card })));
    expect(t).not.toContain("comes to $0.00");
    expect(t).toContain("2500.0× what you spend on groceries.");
  });

  test("…nor after eating out that refunds cancelled", () => {
    addTxn("2026-06-02", -1500, childId("Groceries"));
    addTxn("2026-06-03", 1498, childId("Groceries"));
    addTxn("2026-07-02", -5000, childId("Dining"));
    addTxn("2026-07-03", 5000, childId("Dining"));
    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.isEmpty).toBe(false);
    expect(card.groceriesMonthlyCents).toBe(0);
    const t = text(renderToStaticMarkup(createElement(EatingOutCard, { data: card })));
    expect(t).toContain(
      "Refunds came to at least what you spent on eating out in this window, so there is no multiple to give.",
    );
    expect(t).not.toContain("Groceries come to");
  });

  /** The control: a monthly figure of one cent is a cent, and keeps its clause. */
  test("a groceries figure that rounds to a cent a month still states it", () => {
    addTxn("2026-06-02", -1500, childId("Groceries"));
    addTxn("2026-06-03", 1496, childId("Groceries"));
    addTxn("2026-07-02", -5000, childId("Dining"));
    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.groceriesMonthlyCents).toBe(1);
    const t = text(renderToStaticMarkup(createElement(EatingOutCard, { data: card })));
    expect(t).toContain("1250.0× what you spend on groceries, which comes to $0.01 a month.");
  });

  /**
   * 🔴 Two magnitudes whose ratio is under 0.05 printed "0.0×" — the measured
   * zero the refusal exists to keep off the card, put back by `toFixed(1)`.
   * One $1.00 dinner against $3,000.00 of groceries is 0.0003×.
   */
  test("a multiple too small for a tenth reads <0.1×, not 0.0×", () => {
    addTxn("2026-07-02", -100, childId("Dining"));
    addTxn("2026-06-02", -300000, childId("Groceries"));
    const card = eatingOutCard(bundle.db, TODAY)!;
    expect(card.isEmpty).toBe(false);
    const t = text(renderToStaticMarkup(createElement(EatingOutCard, { data: card })));
    expect(t).not.toContain("0.0×");
    expect(t).toContain("<0.1× what you spend on groceries, which comes to $500.00 a month.");
  });

  /** The branch the dashboard never shows (`isEmpty`), kept honest for the component's other readers. */
  test("a window with no grocery charge at all keeps its own sentence", () => {
    addTxn("2026-07-02", -5000, childId("Dining"));
    const card = eatingOutCard(bundle.db, TODAY)!;
    const t = text(renderToStaticMarkup(createElement(EatingOutCard, { data: card })));
    expect(t).toContain("No groceries in this window, so everything you ate was bought ready to eat.");
    expect(t).not.toMatch(/\d×/);
  });
});
