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
import { createAccount, createInstitution } from "@/services/accounts";
import { statementPulls } from "@/services/statement-pulls";
import { StatementsTeaser } from "@/components/dashboard/StatementsTeaser";
import { StatementSchedule } from "./StatementSchedule";

/**
 * His request 2026-10-09: "make it so i can click on each and it leads me straight to the website so i can pull the
 * statement". Both surfaces that name an account to pull — /imports' Statement schedule and the dashboard's
 * Statements teaser — rendered as the pages render them, over accounts built through the app's own path, so the link
 * is read off the institution the ledger files each account under.
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

/** An account whose three month-end closes leave July's behind it on TODAY — "Ready to pull" on both surfaces. */
function pullableAccount(institution: string, name: string, type: AccountType): void {
  const instId = institutionId(institution);
  const accountId = createAccount(bundle.db, { institutionId: instId, name, type });
  for (const end of ["2026-04-30", "2026-05-31", "2026-06-30"]) {
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
      .values({ importFileId: fileId, accountId, periodStart: end, periodEnd: end, reconciliation: "reconciled" })
      .run();
  }
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
