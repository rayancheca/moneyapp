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
import { rebuildAccount } from "@/services/derivation";
import { trustCard } from "@/services/trust-card";
import { TrustCard } from "./TrustCard";

/**
 * "Can you trust this?", rendered as the dashboard renders it, over accounts built through the app's
 * own path — anchors, rows, `rebuildAccount` — so a count's tone is read off the ledger it describes.
 */

const REBUILT = "2026-09-15";
const TODAY = "2026-10-01";

let dir: string;
let bundle: DbBundle;
let institutionId: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-trust-card-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
  institutionId = bundle.db.select().from(institutions).all()[0]!.id;
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

function account(id: string, name: string): void {
  seq += 1;
  bundle.db
    .insert(accounts)
    .values({
      id,
      institutionId,
      name,
      type: "checking",
      currency: "USD",
      isActive: true,
      displayOrder: seq,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function anchor(accountId: string, day: string, cents: number, source: "statement" | "manual"): void {
  bundle.db
    .insert(balanceAnchors)
    .values({ accountId, anchoredOn: day, balanceCents: cents, source, createdAt: now(), updatedAt: now() })
    .run();
}

function row(accountId: string, day: string, cents = -1_234): void {
  seq += 1;
  bundle.db
    .insert(transactions)
    .values({
      id: `txn-${seq}`,
      accountId,
      postedOn: day,
      amountCents: cents,
      rawDescription: "COFFEE",
      normalizedDescription: "coffee",
      status: "active",
      needsReview: false,
      occurrenceIndex: 0,
      dedupeHash: `hash-${seq}`,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/** Three statements that agree, the row that funded it before the first, and maybe a later row. */
function statementAccount(id: string, name: string, laterRow: string | null): void {
  account(id, name);
  for (const day of ["2026-06-30", "2026-07-31", "2026-08-31"]) anchor(id, day, 500_000, "statement");
  row(id, "2026-06-05");
  if (laterRow !== null) row(id, laterRow);
  rebuildAccount(bundle.db, id, REBUILT);
}

/** The class of the one `<span>` whose text, once React's text-node markers are gone, is `text`. */
function classOfSpan(markup: string, text: string): string | null {
  const spans = [...markup.matchAll(/<span class="([^"]*)">((?:[^<]|<!-- -->)*)<\/span>/g)];
  const hits = spans.filter((m) => m[2]!.replaceAll("<!-- -->", "") === text);
  expect(hits, `one span reading "${text}"`).toHaveLength(1);
  return hits[0]![1]!;
}

/*
 * ⚖️ His answer, 2026-10-06: the "N days unchecked" beside a VERIFIED account is quiet — the faint
 * tone "what you owe"'s note has — not amber. Every count was painted `text-warning`, so Robinhood
 * Agentic, under "adds up" with "adds up through Aug 31, 2026, and unchecked days before that",
 * carried "26 days unchecked" in the colour of Robinhood Cash's run still open. Amber stays for an
 * account something is wrong with: a run still open, his count, a chain that stopped adding up.
 */
test("a verified account's unchecked count is quiet; one with nothing checking it, or broken, warns", () => {
  // Agentic: 26 days before its first balance, nothing open past Aug 31
  statementAccount("agentic", "Robinhood Agentic", null);
  // Robinhood Cash: a run open past its newest statement, from Sep 1
  statementAccount("rh-cash", "Robinhood Cash", "2026-09-05");
  // Cash on Hand: his count, and a row he entered after it
  account("coh", "Cash on Hand");
  anchor("coh", "2026-08-03", 500_000, "manual");
  row("coh", "2026-08-11");
  rebuildAccount(bundle.db, "coh", REBUILT);
  // SoFi: two statements a row between them does not reconcile
  account("sofi", "SoFi Checking");
  anchor("sofi", "2026-07-31", 500_000, "statement");
  anchor("sofi", "2026-08-31", 500_000, "statement");
  row("sofi", "2026-08-10");
  rebuildAccount(bundle.db, "sofi", REBUILT);

  const card = trustCard(bundle.db, TODAY)!;
  const gradeOf = (name: string) => card.groups.find((g) => g.accounts.some((a) => a.name === name))!.grade;
  expect(["Robinhood Agentic", "Robinhood Cash", "Cash on Hand", "SoFi Checking"].map(gradeOf)).toEqual([
    "verified",
    "unverified",
    "unverified",
    "broken",
  ]);
  const markup = renderToStaticMarkup(createElement(TrustCard, { data: card }));

  // Agentic's 26, all before its Jun 30 statement
  const quiet = classOfSpan(markup, "26 days unchecked");
  expect(quiet).toContain("text-ink-faint");
  expect(quiet).not.toContain("text-warning");

  // Robinhood Cash's run open from Sep 1 (of 37 in all), Cash on Hand's since Aug 11, SoFi's Aug
  for (const count of ["11 days unchecked, of 37 in all", "36 days unchecked", "30 days unchecked"]) {
    const warning = classOfSpan(markup, count);
    expect(warning).toContain("text-warning");
    expect(warning).not.toContain("text-ink-faint");
  }
});

/** Every `<p>` in the markup: its class (null when it has none) and its text, tags and markers gone. */
function paragraphs(markup: string): { cls: string | null; text: string }[] {
  return [...markup.matchAll(/<p(?: class="([^"]*)")?>([\s\S]*?)<\/p>/g)].map((m) => ({
    cls: m[1] ?? null,
    text: m[2]!.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'"),
  }));
}

/*
 * 🔴 The footer read the same count the old way (review of 2deb764). Its sentence counted every
 * account's unchecked days as days that "rest on nothing" and painted it amber whenever there were
 * any, so with two accounts that both add up — each with 26 days before its first statement — the
 * rows' "26 days unchecked" were faint and the footer under them warned: "52 of 208 days of balances
 * (25.0% of them) rest on nothing — 26 in Robinhood Agentic, 26 in SoFi Savings." ⚖️ His answer,
 * 2026-10-05: those days alone do not mean nothing is checking an account; a verified card's caveat
 * about them is a quiet note.
 */
test("a card where every account adds up does not warn about the days before their first balance", () => {
  statementAccount("agentic", "Robinhood Agentic", null);
  statementAccount("sofi", "SoFi Savings", null);
  const markup = renderToStaticMarkup(createElement(TrustCard, { data: trustCard(bundle.db, TODAY)! }));

  expect(markup).not.toContain("text-warning");
  expect(markup).not.toContain("rest on nothing");
  const note = paragraphs(markup).filter((p) => p.text.includes("before an account's first balance"));
  expect(note).toEqual([{ cls: null, text: expect.stringContaining("26 in Robinhood Agentic, 26 in SoFi Savings") }]);
});

test("beside accounts nothing checks, the amber sentence names only them; the verified one's days are quiet", () => {
  statementAccount("agentic", "Robinhood Agentic", null);
  statementAccount("rh-cash", "Robinhood Cash", "2026-09-05");
  account("coh", "Cash on Hand");
  anchor("coh", "2026-08-03", 500_000, "manual");
  row("coh", "2026-08-11");
  rebuildAccount(bundle.db, "coh", REBUILT);
  const markup = renderToStaticMarkup(createElement(TrustCard, { data: trustCard(bundle.db, TODAY)! }));

  const ps = paragraphs(markup);
  const warning = ps.filter((p) => p.text.includes("rest on nothing"));
  expect(warning).toEqual([
    { cls: "text-warning", text: expect.stringContaining("37 in Robinhood Cash, 36 in Cash on Hand.") },
  ]);
  expect(warning[0]!.text).not.toContain("Robinhood Agentic");
  const note = ps.filter((p) => p.text.includes("Robinhood Agentic"));
  expect(note).toEqual([{ cls: null, text: expect.stringContaining("26 days before its first balance are unchecked") }]);
});
