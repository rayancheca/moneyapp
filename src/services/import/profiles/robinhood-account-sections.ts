import { ParseError } from "../types";

/**
 * One account's run of lines inside a Robinhood statement that carries several.
 *
 * Both Robinhood statement PDFs do. From 2026-06 the brokerage statement prints
 * `Individual Account #:487513525` and `#655929651`; from 2026-07 the crypto
 * statement prints `ACCOUNT NUMBER 311070628474` and `311407134147`. Each
 * profile knows its own header line; which sections to read is ONE rule, and it
 * lives here so the two profiles cannot drift apart on it.
 */
export interface AccountSection {
  accountNumber: string;
  /** first line index — 0 for the first section, whose page header prints above its account line */
  start: number;
  /** exclusive */
  end: number;
}

/** A section the ledger tracks, with the last4 it was matched by — null only for a fresh install's lone section. */
export interface TrackedSection extends AccountSection {
  last4: string | null;
}

/**
 * Every account the document carries, in print order, split at each line the
 * `header` pattern matches (capture group 1 is the account number).
 *
 * A section runs until the next account's header, or to the end. A header that
 * repeats the SAME number as the one before continues its section rather than
 * opening another. Empty when the document prints no header at all — whether
 * that is acceptable is the caller's call.
 */
export function splitAtAccountHeaders(texts: readonly string[], header: RegExp): AccountSection[] {
  const headers = texts.flatMap((t, i) => {
    const m = header.exec(t);
    return m ? [{ at: i, accountNumber: m[1] as string }] : [];
  });
  const opens = headers.filter((h, k) => k === 0 || h.accountNumber !== headers[k - 1]?.accountNumber);
  return opens.map((h, k) => ({
    accountNumber: h.accountNumber,
    start: k === 0 ? 0 : h.at,
    end: opens[k + 1]?.at ?? texts.length,
  }));
}

/**
 * The sections of EVERY account this ledger tracks, in print order.
 *
 * 🔴 It used to be "the first section", then (3902f69) "the ONE tracked
 * section". The first broke when 2026-08 printed the untracked #655929651
 * FIRST: $26.64 → $26.64 was read as Robinhood Cash's month. The second was
 * right until the owner decided to track #655929651 as an account of its own
 * (2026-09-14) — at which point it refused every statement he has.
 *
 * ⛔ The choice is by NUMBER — a section is chosen when its account number ends
 * in the last four digits of an account the ledger tracks — and anything that
 * leaves a section's account in doubt is REFUSED rather than guessed:
 *  - no section is tracked: nothing in the file is an account this ledger has;
 *  - one section ends in two tracked last4s: two ledger accounts share a last4;
 *  - one last4 matches two sections: two printed accounts claim one ledger account.
 * An untracked section beside a tracked one is skipped — its balances are
 * another account's money. A ledger tracking nothing at this institution yet (a
 * fresh install) accepts a single-account statement, which is every file
 * before 2026-06.
 */
export function selectTrackedSections(
  profileId: string,
  sections: readonly AccountSection[],
  trackedLast4s: readonly string[],
): TrackedSection[] {
  if (trackedLast4s.length === 0 && sections.length === 1) {
    return [{ ...(sections[0] as AccountSection), last4: null }];
  }

  const tracked = sections.flatMap((section): TrackedSection[] => {
    const matches = trackedLast4s.filter((last4) => section.accountNumber.endsWith(last4));
    if (matches.length > 1) {
      throw new ParseError(
        profileId,
        `#${section.accountNumber} ends in the last4 of more than one account this ledger tracks ` +
          `(${matches.map((last4) => `····${last4}`).join(", ")}) — refusing to guess which account it is`,
      );
    }
    return matches.length === 1 ? [{ ...section, last4: matches[0] as string }] : [];
  });

  for (const last4 of new Set(tracked.map((t) => t.last4))) {
    const claimants = tracked.filter((t) => t.last4 === last4);
    if (claimants.length > 1) {
      throw new ParseError(
        profileId,
        `····${last4} matches more than one section (${claimants.map((t) => `#${t.accountNumber}`).join(", ")}) ` +
          `— refusing to guess which of them is the account`,
      );
    }
  }

  if (tracked.length === 0) {
    const printed = sections.map((s) => `#${s.accountNumber}`).join(", ");
    const known = trackedLast4s.length === 0 ? "none" : trackedLast4s.map((last4) => `····${last4}`).join(", ");
    throw new ParseError(
      profileId,
      `Statement carries ${printed}, and none is an account this ledger tracks (${known}) — refusing to guess which to import`,
    );
  }
  return tracked;
}
