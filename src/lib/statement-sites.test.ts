import { describe, expect, test } from "vitest";
import type { AccountType } from "@/db/schema/accounts";
import { statementSiteFor, statementSiteHint, statementSiteLabel, type StatementSite } from "./statement-sites";

/**
 * Where each account's statements are downloaded — his request 2026-10-09: "make it so i can click on each and it
 * leads me straight to the website so i can pull the statement".
 *
 * Every URL below is the one the bank's own pages link to (researched 2026-10-09); this file pins them so a typo is a
 * red test, not a link that 404s the one evening he goes to pull a statement.
 */

const CHASE = "https://www.chase.com/personal/mobile-online-banking/statements";
const SOFI = "https://www.sofi.com/login/";
const ROBINHOOD = "https://robinhood.com/login";
const WELLS_FARGO =
  "https://connect.secure.wellsfargo.com/auth/login/present?origin=cob&loginMode=jukePassword&serviceType=document&LOB=CONS";
const CAPITAL_ONE_CARDS = "https://verified.capitalone.com/auth/signin?Product=Card&Action=Documents";

describe("statementSiteFor", () => {
  test.each([
    ["Chase", "checking", { bank: "Chase", url: CHASE, opens: "statements" }],
    ["Chase", "credit", { bank: "Chase", url: CHASE, opens: "statements" }],
    ["SoFi", "checking", { bank: "SoFi", url: SOFI, opens: "sign-in", then: "Statements" }],
    ["SoFi", "savings", { bank: "SoFi", url: SOFI, opens: "sign-in", then: "Statements" }],
    [
      "Robinhood",
      "investment",
      { bank: "Robinhood", url: ROBINHOOD, opens: "sign-in", then: "Account → Reports and statements" },
    ],
    [
      "Robinhood",
      "checking",
      { bank: "Robinhood", url: ROBINHOOD, opens: "sign-in", then: "Account → Reports and statements" },
    ],
    ["Wells Fargo", "checking", { bank: "Wells Fargo", url: WELLS_FARGO, opens: "statements" }],
    ["Capital One", "credit", { bank: "Capital One", url: CAPITAL_ONE_CARDS, opens: "statements" }],
  ] as const)("%s (%s) opens its own site", (institutionName, type, site) => {
    expect(statementSiteFor({ institutionName, type })).toEqual(site);
  });

  /**
   * ⚖️ His answer 2026-10-09: he pulls the Discover card's statements at capitalone.com — Capital One bought Discover
   * and manages its cards on its own site. The ledger still files the card under "Discover", so the link follows the
   * issuer, not the name on the institution row.
   */
  test("the Discover card opens Capital One's card documents, where he pulls it", () => {
    expect(statementSiteFor({ institutionName: "Discover", type: "credit" })).toEqual({
      bank: "Capital One",
      url: CAPITAL_ONE_CARDS,
      opens: "statements",
    });
  });

  /**
   * Capital One's link is `Product=Card` — it lands on CARD documents. A 360 bank account at the same institution is
   * not served by it, and no 360 statements link was researched, so it gets none rather than an invented one.
   */
  test("a Capital One bank account gets no link — the one researched is for cards", () => {
    expect(statementSiteFor({ institutionName: "Capital One", type: "checking" })).toBeNull();
    expect(statementSiteFor({ institutionName: "Capital One", type: "savings" })).toBeNull();
  });

  test("a wallet has no bank to go to", () => {
    expect(statementSiteFor({ institutionName: "Cash", type: "checking" })).toBeNull();
  });

  test("an institution nobody researched gets no link, never a guessed one", () => {
    expect(statementSiteFor({ institutionName: "Ally", type: "savings" })).toBeNull();
    // exact names only — a near miss is a different institution row, not this bank
    expect(statementSiteFor({ institutionName: "Chase Bank", type: "checking" })).toBeNull();
    expect(statementSiteFor({ institutionName: "chase", type: "checking" })).toBeNull();
    // a name an object lookup would resolve to Object.prototype's own members
    expect(statementSiteFor({ institutionName: "constructor", type: "checking" })).toBeNull();
    expect(statementSiteFor({ institutionName: "toString", type: "credit" })).toBeNull();
  });
});

/** The site an institution resolves to, for the wording tests below — every one of them has one. */
const siteOf = (institutionName: string, type: AccountType): StatementSite => statementSiteFor({ institutionName, type })!;

describe("statementSiteHint", () => {
  test("a link that lands on statements says whose", () => {
    expect(statementSiteHint(siteOf("Chase", "credit"))).toBe("Chase · statements");
    expect(statementSiteHint(siteOf("Discover", "credit"))).toBe("Capital One · statements");
  });

  test("a bare sign-in says where to go next", () => {
    expect(statementSiteHint(siteOf("SoFi", "savings"))).toBe("SoFi sign-in · then Statements");
    expect(statementSiteHint(siteOf("Robinhood", "investment"))).toBe(
      "Robinhood sign-in · then Account → Reports and statements",
    );
  });
});

describe("statementSiteLabel", () => {
  // the accessible name starts with the visible one, so "click Chase Checking" still finds it by voice
  test("names the account, the bank and the new tab", () => {
    expect(statementSiteLabel("Chase Checking", siteOf("Chase", "checking"))).toBe(
      "Chase Checking — opens Chase's statements site in a new tab",
    );
    expect(statementSiteLabel("Discover", siteOf("Discover", "credit"))).toBe(
      "Discover — opens Capital One's statements site in a new tab",
    );
  });

  test("a sign-in label carries the next step", () => {
    expect(statementSiteLabel("SoFi Checking", siteOf("SoFi", "checking"))).toBe(
      "SoFi Checking — opens SoFi's sign-in in a new tab, then Statements",
    );
  });
});
