import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import type { AccountType } from "@/db/schema/accounts";
import { importFiles, statementPeriods } from "@/db/schema/imports";
import { institutions } from "@/db/schema/institutions";
import { seedDatabase } from "@/db/seed";
import { recordWithheldSections } from "@/lib/import-file-label";
import { createAccount, createInstitution } from "@/services/accounts";
import { statementGaps } from "@/services/statement-gaps";
import { statementPulls } from "@/services/statement-pulls";
import { StatementsTeaser } from "@/components/dashboard/StatementsTeaser";
import { StatementGapsPanel } from "./StatementGapsPanel";
import { StatementSchedule } from "./StatementSchedule";

/**
 * His request 2026-10-09: "make it so i can click on each and it leads me straight to the website so i can pull the
 * statement". Every surface that names an account's statement to fetch — /imports' Statement schedule and its
 * "Statements you do not have" panel, and the dashboard's Statements teaser — rendered as the pages render them, over
 * accounts built through the app's own path, so the link is read off the institution the ledger files each account
 * under.
 */

const TODAY = "2026-08-14";

const CHASE = "https://www.chase.com/personal/mobile-online-banking/statements";
const SOFI = "https://www.sofi.com/login/";
const WELLS_FARGO =
  "https://connect.secure.wellsfargo.com/auth/login/present?origin=cob&loginMode=jukePassword&serviceType=document&LOB=CONS";
const CAPITAL_ONE_CARDS = "https://verified.capitalone.com/auth/signin?Product=Card&Action=Documents";

let dir: string;
let bundle: DbBundle;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-statement-sites-"));
  bundle = createDatabase(path.join(dir, "t.db"));
  seedDatabase(bundle.db);
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function institutionId(name: string): string {
  const row = bundle.db.select().from(institutions).where(eq(institutions.name, name)).get();
  return row ? row.id : createInstitution(bundle.db, name);
}

/** One statement for the account, in a file of its own — `statement_periods` is unique per file and account. */
function addStatement(instId: string, accountId: string, start: string, end: string): void {
  seq += 1;
  const fileId = bundle.db
    .insert(importFiles)
    .values({
      fileName: `${seq}.pdf`,
      fileSha256: `sha-${seq}`,
      format: "pdf",
      institutionId: instId,
      status: "parsed",
      storagePath: `/tmp/${seq}.pdf`,
      importedAt: TODAY,
    })
    .returning({ id: importFiles.id })
    .get().id;
  bundle.db
    .insert(statementPeriods)
    .values({ importFileId: fileId, accountId, periodStart: start, periodEnd: end, reconciliation: "reconciled" })
    .run();
}

/** An account whose three month-end closes leave July's behind it on TODAY — "Ready to pull" on both surfaces. */
function pullableAccount(institution: string, name: string, type: AccountType): void {
  const instId = institutionId(institution);
  const accountId = createAccount(bundle.db, { institutionId: instId, name, type });
  for (const end of ["2026-04-30", "2026-05-31", "2026-06-30"]) addStatement(instId, accountId, end, end);
}

function seedHisInstitutions(): void {
  pullableAccount("Chase", "Chase Checking", "checking");
  pullableAccount("Discover", "Discover", "credit");
  pullableAccount("SoFi", "SoFi Savings", "savings");
  pullableAccount("Wells Fargo", "Wells Fargo Everyday Checking", "checking");
  pullableAccount("Ally", "Ally Savings", "savings"); // a bank nobody researched
}

const decode = (s: string): string =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The `<li>` whose text starts with the account's name, as markup. */
function rowOf(markup: string, accountName: string): string {
  const rows = markup.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? [];
  const row = rows.find((r) => decode(r.replace(/<[^>]+>/g, " ")).trim().startsWith(accountName));
  if (!row) throw new Error(`no row for ${accountName}`);
  return row;
}

interface Link {
  href: string;
  target: string | null;
  rel: string | null;
  label: string | null;
  text: string;
}

/** Every `<a>` in a row, attributes entity-decoded and text flattened. */
function linksIn(row: string): Link[] {
  return [...row.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, inner]) => {
    const attr = (name: string): string | null => {
      const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs!);
      return m ? decode(m[1]!) : null;
    };
    return {
      href: attr("href")!,
      target: attr("target"),
      rel: attr("rel"),
      label: attr("aria-label"),
      // each tag a word break, as the flex row lays its pieces out
      text: decode(inner!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
    };
  });
}

function renderSchedule(): string {
  return renderToStaticMarkup(createElement(StatementSchedule, { pulls: statementPulls(bundle.db, TODAY) }));
}

function renderTeaser(): string {
  return renderToStaticMarkup(createElement(StatementsTeaser, { pulls: statementPulls(bundle.db, TODAY) }));
}

describe.each([
  ["the Statement schedule (/imports)", renderSchedule],
  ["the Statements teaser (dashboard)", renderTeaser],
])("%s", (_surface, render) => {
  beforeEach(seedHisInstitutions);

  test("an account's name opens its bank's statements in a new tab, and nothing follows it back", () => {
    const [link, ...more] = linksIn(rowOf(render(), "Chase Checking"));
    expect(more).toEqual([]);
    expect(link).toEqual({
      href: CHASE,
      target: "_blank",
      // noopener: the bank's page cannot reach back into this window; noreferrer: it is not told this app exists
      rel: "noopener noreferrer",
      label: "Chase Checking — opens Chase's statements site in a new tab",
      text: "Chase Checking Chase · statements ↗",
    });
  });

  test("the Discover card opens Capital One, where he pulls it (his answer 2026-10-09)", () => {
    const [link] = linksIn(rowOf(render(), "Discover"));
    expect(link!.href).toBe(CAPITAL_ONE_CARDS);
    expect(link!.text).toBe("Discover Capital One · statements ↗");
    expect(link!.label).toBe("Discover — opens Capital One's statements site in a new tab");
  });

  test("a sign-in-only bank says where to go once he is in", () => {
    const [link] = linksIn(rowOf(render(), "SoFi Savings"));
    expect(link!.href).toBe(SOFI);
    expect(link!.text).toBe("SoFi Savings SoFi sign-in · then Statements ↗");
    expect(link!.label).toBe("SoFi Savings — opens SoFi's sign-in in a new tab, then Statements");
  });

  test("a link whose query string carries & arrives intact", () => {
    const [link] = linksIn(rowOf(render(), "Wells Fargo Everyday Checking"));
    expect(link!.href).toBe(WELLS_FARGO);
  });

  test("an account with no researched site stays plain text — no link, no hint", () => {
    const row = rowOf(render(), "Ally Savings");
    expect(linksIn(row)).toEqual([]);
    expect(decode(row)).not.toContain("↗");
  });
});

/**
 * 🔴 The panel two cards below the schedule, "Statements you do not have", kept every name plain text — measured on a
 * copy of his ledger (review of 8f7c5ec): "Discover 5 statements · 152 days", four holes from Aug 2024 to Sep 2025,
 * and 0 links, while the same Discover row in the schedule above opened Capital One. Its intro says "These are files
 * to fetch", and it lists the most of them.
 */
describe("Statements you do not have (/imports)", () => {
  /** Monthly statements closing on the 18th, the one closing Sep 18, 2024 never imported. */
  function accountWithAHole(institution: string, name: string, type: AccountType): void {
    const instId = institutionId(institution);
    const accountId = createAccount(bundle.db, { institutionId: instId, name, type });
    addStatement(instId, accountId, "2024-06-19", "2024-07-18");
    addStatement(instId, accountId, "2024-07-19", "2024-08-18");
    addStatement(instId, accountId, "2024-09-19", "2024-10-18");
    addStatement(instId, accountId, "2024-10-19", "2024-11-18");
  }

  /** A file already imported WITHOUT the account's Nov 2024 section — listed, but "fetching it again adds nothing". */
  function withheldNovember(instId: string, accountId: string): void {
    seq += 1;
    bundle.db
      .insert(importFiles)
      .values({
        fileName: `w-${seq}.pdf`,
        fileSha256: `sha-${seq}`,
        format: "pdf",
        institutionId: instId,
        status: "parsed",
        error: recordWithheldSections([
          {
            accountId,
            accountName: "Robinhood Agentic",
            last4: "9651",
            periodStart: "2024-11-19",
            periodEnd: "2024-12-18",
            reason: "it shows $26.22 of securities, and this account is read as cash only",
          },
        ]),
        storagePath: `/tmp/w-${seq}.pdf`,
        importedAt: TODAY,
      })
      .run();
  }

  function renderGaps(): string {
    return renderToStaticMarkup(createElement(StatementGapsPanel, { gaps: statementGaps(bundle.db) }));
  }

  test("the Discover card's missing statements open Capital One, as the schedule's row does", () => {
    accountWithAHole("Discover", "Discover", "credit");

    const markup = renderGaps();

    expect(linksIn(rowOf(markup, "Discover"))).toEqual([
      {
        href: CAPITAL_ONE_CARDS,
        target: "_blank",
        rel: "noopener noreferrer",
        label: "Discover — opens Capital One's statements site in a new tab",
        text: "Discover Capital One · statements ↗",
      },
    ]);
    // and the row still says what is missing, beside the link
    expect(decode(rowOf(markup, "Discover").replace(/<[^>]+>/g, " "))).toMatch(/1 statement · 31 days/);
  });

  test("a bank nobody researched, and a Capital One BANK account, stay plain text", () => {
    accountWithAHole("Ally", "Ally Savings", "savings");
    accountWithAHole("Capital One", "Capital One 360 Checking", "checking");

    const markup = renderGaps();

    for (const name of ["Ally Savings", "Capital One 360 Checking"]) {
      expect(linksIn(rowOf(markup, name))).toEqual([]);
      expect(decode(rowOf(markup, name))).not.toContain("↗");
    }
  });

  test("⛔ a row whose only window is already imported stays plain text — fetching it again adds nothing", () => {
    // Robinhood Agentic's real shape, one cycle earlier: no window to fetch, one withheld
    const instId = institutionId("Robinhood");
    const accountId = createAccount(bundle.db, { institutionId: instId, name: "Robinhood Agentic", type: "checking" });
    addStatement(instId, accountId, "2024-09-19", "2024-10-18");
    addStatement(instId, accountId, "2024-10-19", "2024-11-18");
    withheldNovember(instId, accountId);

    const row = rowOf(renderGaps(), "Robinhood Agentic");

    expect(decode(row)).toContain("fetching it again adds nothing");
    expect(linksIn(row)).toEqual([]);
  });
});
