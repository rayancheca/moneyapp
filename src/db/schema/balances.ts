import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./common";
import { accounts } from "./accounts";
import { importFiles, statementPeriods } from "./imports";

export const ANCHOR_SOURCES = ["statement", "ofx_ledger", "manual", "live", "unimported_statement"] as const;
export type AnchorSource = (typeof ANCHOR_SOURCES)[number];

/**
 * ⚖️ `unimported_statement` — the OPENING balance a statement printed, kept when the owner un-imported that statement
 * while another still-imported file keeps its rows and nothing else records the account's balance (owner decision 20,
 * 2026-09-17). Owned by the file that keeps the rows (`import_file_id`), so un-importing that file takes it too; a
 * document that records the same day again replaces it. It is never evidence: the replay stands on it only when the
 * account has no other recorded balance, and every day it carries is `derived_unverified`
 * (`services/import/kept-openings`, `deriveDailyRows`). Never a closing, never a number no statement printed.
 */
export const KEPT_OPENING_SOURCE = "unimported_statement" as const satisfies AnchorSource;

/**
 * Ground-truth balances at known dates (net-worth-signed). Same-date
 * precedence: statement > ofx_ledger > manual > live — enforced in the
 * derivation service; ofx_ledger/live are moments, excluded from exact
 * chain-closure checks.
 *
 * ⚠️ `live` means the number came from a live fetch, NOT that it is stamped
 * today. This note used to say "'live' is only ever written for today", and the
 * ledger disagrees: of 29 live anchors, one — Robinhood Cash on 2026-07-10 —
 * was written on the 11th, by a fetch that ran past midnight.
 *
 * ⛔ It was left as `live` rather than reclassified `manual`, because `manual`
 * means a PERSON typed the number and this one nobody did; relabelling it would
 * have made the row lie about where it came from in order to make a comment
 * true. Nothing depends on the claim either: `deriveBalances` lets a live
 * moment win the display only when `anchoredOn === today`, so a past-dated one
 * is inert by construction rather than by luck — asserted in
 * `derivation.test.ts` rather than promised here.
 */
export const balanceAnchors = sqliteTable(
  "balance_anchors",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    anchoredOn: text("anchored_on").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    source: text("source", { enum: ANCHOR_SOURCES }).notNull(),
    statementPeriodId: text("statement_period_id").references(() => statementPeriods.id),
    // provenance for the un-import lifecycle: anchors die with their file
    importFileId: text("import_file_id").references(() => importFiles.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("ux_balance_anchors_account_date_source").on(
      table.accountId,
      table.anchoredOn,
      table.source,
    ),
  ],
);

export const BALANCE_BASES = [
  "anchored",
  "derived",
  "derived_unverified",
  "carried",
  "gap",
] as const;
export type BalanceBasis = (typeof BALANCE_BASES)[number];

/**
 * Derived cache, rebuildable at any time — levels are never invented; days
 * without coverage are basis='gap' and the net-worth total marks them partial.
 */
export const dailyBalances = sqliteTable(
  "daily_balances",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    day: text("day").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    basis: text("basis", { enum: BALANCE_BASES }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.day] })],
);
