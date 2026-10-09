import type { AccountType } from "@/db/schema/accounts";

/**
 * Where each account's statements are downloaded — the ONE place that knows.
 *
 * ⚖️ His request 2026-10-09, on /imports' Statement schedule: "make it so i can click on each and it leads me straight
 * to the website so i can pull the statement". The schedule, /imports' "Statements you do not have" panel and the
 * dashboard's Statements teaser all link an account's name through `statementSiteFor`, so no two of them can send him
 * to different places.
 *
 * ⛔ Every URL is one the bank's OWN pages link to (researched 2026-10-09) — never a guessed deep link. A deep link
 * that is guessed fails silently on the one evening he goes to pull a statement; a sign-in page plus the next step,
 * in the bank's own words, does not. Where no page was found the account gets no link at all.
 *
 * The app is local-first: a link here is his own navigation, opened only when he clicks it — no prefetch, and
 * `rel="noopener noreferrer"` so the bank's page is neither handed this window nor told where he came from.
 *
 * Pure: no React, no DOM, no `Date`.
 */

export type StatementSite =
  /** the link lands on the bank's statements (or its sign-in to them) */
  | { readonly bank: string; readonly url: string; readonly opens: "statements" }
  /** the link is a bare sign-in; `then` is the next step once he is in, in the bank's own words */
  | { readonly bank: string; readonly url: string; readonly opens: "sign-in"; readonly then: string };

interface SiteEntry {
  readonly site: StatementSite;
  /** the link lands on CARD documents — a bank account at the same institution is not served by it */
  readonly cardsOnly: boolean;
}

/**
 * Keyed by the institution's name as the ledger files it (`institutions.name`, exact). A Map, not an object lookup:
 * an institution named "constructor" must find nothing, not `Object.prototype`'s.
 */
const SITES: ReadonlyMap<string, SiteEntry> = new Map(Object.entries({
  // Chase's "Statements & documents" page, with its sign-in; inside: Main Menu → Statements & documents
  Chase: {
    site: {
      bank: "Chase",
      url: "https://www.chase.com/personal/mobile-online-banking/statements",
      opens: "statements",
    },
    cardsOnly: false,
  },
  // sign-in only — SoFi publishes no statements deep link; inside: Banking homepage → Statements
  SoFi: {
    site: { bank: "SoFi", url: "https://www.sofi.com/login/", opens: "sign-in", then: "Statements" },
    cardsOnly: false,
  },
  // sign-in only; inside: Account → Reports and statements → Monthly statements
  Robinhood: {
    site: {
      bank: "Robinhood",
      url: "https://robinhood.com/login",
      opens: "sign-in",
      then: "Account → Reports and statements",
    },
    cardsOnly: false,
  },
  // the sign-on wellsfargo.com/online-banking/statements/ links to, which lands on Statements & Documents
  "Wells Fargo": {
    site: {
      bank: "Wells Fargo",
      url: "https://connect.secure.wellsfargo.com/auth/login/present?origin=cob&loginMode=jukePassword&serviceType=document&LOB=CONS",
      opens: "statements",
    },
    cardsOnly: false,
  },
  /**
   * The card sign-in Capital One's help center ("View your statement") links to; it lands on card statements and
   * documents. `Product=Card`, so it serves cards only — no 360 bank-statements link was researched, and a 360
   * account gets none rather than this one.
   */
  "Capital One": {
    site: {
      bank: "Capital One",
      url: "https://verified.capitalone.com/auth/signin?Product=Card&Action=Documents",
      opens: "statements",
    },
    cardsOnly: true,
  },
} satisfies Record<string, SiteEntry>));

/**
 * An institution whose statements are pulled on another bank's site.
 *
 * ⚖️ His answer 2026-10-09: he pulls the Discover card's (····4741) statements at capitalone.com. Capital One bought
 * Discover, and its FAQ says Discover cards are managed on Capital One's site — the ledger still files the card
 * under "Discover" (the statements print a Capital One template since Aug 2026), so the link follows the issuer.
 */
const PULLED_AT: ReadonlyMap<string, string> = new Map([["Discover", "Capital One"]]);

/** The site an account's statements are pulled at; null for a wallet, or a bank nobody researched. */
export function statementSiteFor(account: {
  readonly institutionName: string;
  readonly type: AccountType;
}): StatementSite | null {
  const entry = SITES.get(PULLED_AT.get(account.institutionName) ?? account.institutionName);
  if (!entry || (entry.cardsOnly && account.type !== "credit")) return null;
  return entry.site;
}

/** The quiet line beside the account's name: whose site, and the next step when it is only a sign-in. */
export function statementSiteHint(site: StatementSite): string {
  return site.opens === "statements" ? `${site.bank} · statements` : `${site.bank} sign-in · then ${site.then}`;
}

/** The link's accessible name — it starts with the visible account name, so voice control still finds it. */
export function statementSiteLabel(accountName: string, site: StatementSite): string {
  return site.opens === "statements"
    ? `${accountName} — opens ${site.bank}'s statements site in a new tab`
    : `${accountName} — opens ${site.bank}'s sign-in in a new tab, then ${site.then}`;
}
