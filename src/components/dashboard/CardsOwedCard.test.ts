import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { balanceAnchors } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { seedDatabase } from "@/db/seed";
import { cardsOwedCard } from "@/services/cards-owed";
import { rebuildAccount } from "@/services/derivation";
import { CardsOwedCard } from "./CardsOwedCard";

/**
 * "What you owe", rendered as the dashboard renders it, over cards built through the app's own
 * path — statements, rows, `rebuildAccount` — so a row's tone is read off the ledger it describes.
 */

const TODAY = "2026-08-10";

let dir: string;
let bundle: DbBundle;
let institutionId: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-cards-owed-card-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  institutionId = bundle.db.select().from(institutions).all()[0]!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

/**
 * Statements close at $180.00 on Jul 25 and $200.00 on Aug 5 — or on `lastClose`, no earlier than
 * Aug 1 — and the Aug 1 charge closes the gap.
 */
function statementCard(
  id: string,
  name: string,
  last4: string,
  rows: { day: string; cents: number }[],
  lastClose = "2026-08-05",
): void {
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type: "credit",
      last4,
      currency: "USD",
      isActive: true,
      displayOrder: 0,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  const statements = [
    { day: "2026-07-25", cents: -18_000 },
    { day: lastClose, cents: -20_000 },
  ];
  for (const s of statements) {
    bundle.db
      .insert(balanceAnchors)
      .values({
        accountId: id,
        anchoredOn: s.day,
        balanceCents: s.cents,
        source: "statement",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }
  for (const r of [{ day: "2026-08-01", cents: -2_000 }, ...rows]) {
    seq += 1;
    bundle.db
      .insert(transactions)
      .values({
        id: `txn-${seq}`,
        accountId: id,
        postedOn: r.day,
        amountCents: r.cents,
        rawDescription: "A CHARGE",
        normalizedDescription: "a charge",
        status: "active",
        needsReview: false,
        occurrenceIndex: 0,
        dedupeHash: `hash-${seq}`,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }
  rebuildAccount(bundle.db, id, TODAY);
}

/** The class of the one `<span>` whose whole text is `text`. */
function classOfSpan(markup: string, text: string): string | null {
  return new RegExp(`<span class="([^"]*)">${text}</span>`).exec(markup)?.[1] ?? null;
}

/*
 * ⚖️ His answer, 2026-10-05: a VERIFIED card's line about the days before its first statement is a
 * quiet note in the tone verified rows use, not the amber warning. Every row line below the name
 * was painted `text-warning`, so a card both statements check — graded `verified`, counted as
 * adding up — read in the colour of "nothing checks it since Aug 8" on the row beneath it.
 */
test("a verified card's days before its first statement are quiet; a card nothing checks warns", () => {
  // Alpha: a charge on Jul 20, replayed backwards from the Jul 25 statement — nothing open past Aug 5
  statementCard("acct-alpha", "Alpha", "1111", [{ day: "2026-07-20", cents: -1_000 }]);
  // Beta: a charge on Aug 8 that no statement has checked yet
  statementCard("acct-beta", "Beta", "2222", [{ day: "2026-08-08", cents: -4_000 }]);

  const card = cardsOwedCard(bundle.db, TODAY)!;
  const markup = renderToStaticMarkup(createElement(CardsOwedCard, { data: card }));

  // both close Aug 5, which "all as of Aug 5 — 5 days ago" says once: the note names only the days
  const note = "unchecked days before its first balance";
  expect(card.cards.find((c) => c.name === "Alpha")!.note).toBe(note);
  const quiet = classOfSpan(markup, note);
  expect(quiet).toContain("text-ink-faint");
  expect(quiet).not.toContain("text-warning");

  const warning = classOfSpan(markup, "nothing checks it since Aug 8 — 2 days ago");
  expect(warning).toContain("text-warning");
});

/*
 * 🔴 The card's rule, its other half: when the dates differ, each row carries its own — and the note
 * carried it again. Alpha's row read "Aug 5 — 5 days ago" and under it "adds up through Aug 5 — 5
 * days ago, and unchecked days before that": one date, twice, in one row. A verified card's date is
 * always on the card, the sentence's or its row's, so the note names only the days.
 */
test("a row with a date line of its own says that date once", () => {
  statementCard("acct-alpha", "Alpha", "1111", [{ day: "2026-07-20", cents: -1_000 }]);
  // Gamma's last statement closed Aug 1: the dates differ, so each row carries its own
  statementCard("acct-gamma", "Gamma", "3333", [], "2026-08-01");

  const card = cardsOwedCard(bundle.db, TODAY)!;
  expect(card.sharedCheckedThrough).toBeNull();
  const markup = renderToStaticMarkup(createElement(CardsOwedCard, { data: card }));

  const alphaRow = /<dt[^>]*>((?:(?!<\/dt>).)*Alpha(?:(?!<\/dt>).)*)<\/dt>/s.exec(markup)?.[1] ?? "";
  expect(classOfSpan(alphaRow, "Aug 5 — 5 days ago")).toContain("text-ink-faint");
  expect(alphaRow.split("Aug 5").length - 1).toBe(1);
  expect(classOfSpan(alphaRow, "unchecked days before its first balance")).toContain("text-ink-faint");
});
