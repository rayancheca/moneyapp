import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { noScheduleReason, type SeriesEvidence, type SeriesStatusForCopy } from "@/lib/series-evidence";

// the server action pulls in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({ setSeriesOverridesAction: vi.fn() }));

const { CadenceSentence } = await import("./CadenceSentence");

const EVERY_EVIDENCE: readonly SeriesEvidence[] = ["active", "never-billed", "awaiting-statements", "running-late", "lapsed", "schedule-ended"];
const EVERY_STATUS: readonly SeriesStatusForCopy[] = ["detected", "confirmed", "dismissed", "ended"];

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

type SentenceProps = Parameters<typeof CadenceSentence>[0];

/** Amazon Prime as his ledger stores it on 2026-10-08: last charge Jul 5, stored next 2026-08-05. */
function render(
  status: SeriesStatusForCopy,
  evidence: SeriesEvidence,
  overrides: Partial<SentenceProps> = {},
): { text: string; dialogTriggers: number; menuTriggers: number } {
  const html = renderToStaticMarkup(
    createElement(CadenceSentence, {
      seriesId: "s1",
      kind: "subscription",
      cadence: "monthly",
      nextExpectedOn: "2026-08-05",
      amountCents: -499,
      userCadence: null,
      userNextExpectedOn: null,
      userAmountCents: null,
      detectedCadence: "monthly",
      accountName: "Chase Sapphire",
      status,
      evidence,
      // Amazon Prime has charged — its last on Jul 5
      neverPosted: false,
      oneCharge: null,
      onChanged: () => undefined,
      ...overrides,
    }),
  );
  return {
    text: decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    // the date token and the amount token each open a dialog; the cadence token opens a menu
    dialogTriggers: [...html.matchAll(/aria-haspopup="dialog"/g)].length,
    menuTriggers: [...html.matchAll(/aria-haspopup="menu"/g)].length,
  };
}

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 56): the one-time Nov 11 car-insurance balance reads as ONE CHARGE. 🔴 Its page
 * read "charges monthly around the 11th, about $72.74" — a rhythm it does not have — over a CADENCE stat of "Monthly".
 */
describe("CadenceSentence — a schedule of one charge says once, and on which day", () => {
  const nov11 = {
    kind: "bill",
    nextExpectedOn: "2026-11-11",
    amountCents: -7274,
    userNextExpectedOn: "2026-11-11",
    userAmountCents: -7274,
    // the bank has never charged it
    neverPosted: true,
    oneCharge: { day: "2026-11-11", label: "Nov 11" },
  } as const satisfies Partial<SentenceProps>;

  test("the Nov 11 balance: once, its day, its amount — and no cadence menu, since one charge takes no step", () => {
    const { text, dialogTriggers, menuTriggers } = render("confirmed", "never-billed", nov11);
    expect(text).toBe("charges once on Nov 11, about $72.74 from Chase Sapphire.");
    expect(menuTriggers).toBe(0);
    // its day and its amount are still his to correct
    expect(dialogTriggers).toBe(2);
  });

  /*
   * ⛔ …and "was expected", never "charged": the bank never charged it. 🔴 Review of 49cc98f: from Nov 12 its page read
   * "charged once on Nov 11, about $72.74" over "Linked transactions · 0" (his ledger copy, 2026-10-12).
   */
  test("once it is over the day stays — a one-off's day is its schedule, not a rhythm read off a stale date", () => {
    for (const [status, evidence] of [
      ["ended", "never-billed"],
      ["confirmed", "schedule-ended"],
    ] as const) {
      const { text, dialogTriggers } = render(status, evidence, nov11);
      expect(text, `${status} · ${evidence}`).toBe("was expected once on Nov 11, about $72.74 from Chase Sapphire.");
      expect(dialogTriggers).toBe(1);
    }
    // paid, it was charged
    expect(render("confirmed", "schedule-ended", { ...nov11, neverPosted: false }).text).toBe(
      "charged once on Nov 11, about $72.74 from Chase Sapphire.",
    );
  });
});

/**
 * 🔴 THE 2026-09-10 DEFECT, BACK FOR A LAPSED SERIES. On a copy of the owner's ledger 2026-10-08,
 * `/recurring/<Amazon Prime>` (detected, lapsed that morning) read "charges monthly around the 5th, about $4.99." above
 * "Nothing expected · This series has gone quiet past the point a bill stops, so it is no longer forecast and nothing
 * more is expected from it". The 5th was read off the stored 2026-08-05 — a date the forecast does not expect — and
 * its editor saved a `userNextExpectedOn` that toasted "Next expected …" while the lapse, which reads
 * `lastMatchedOn`, kept the page saying "Nothing expected". `noScheduleReason` had learned the lapse privately and
 * this sentence still asked `seriesIsOver` alone.
 */
describe("CadenceSentence — a series the forecast has let go is described in the past, with no day to edit", () => {
  test("Amazon Prime's sentence: past tense, the cadence and amount detection measured, no day clause", () => {
    for (const status of ["detected", "confirmed"] as const) {
      const { text, dialogTriggers } = render(status, "lapsed");
      expect(text, status).toBe("charged monthly, about $4.99 from Chase Sapphire.");
      // only the amount's editor — no "Next expected date" editor whose save the page would not honour
      expect(dialogTriggers, status).toBe(1);
    }
  });

  test("a late bill the forecast still carries keeps its present-tense schedule and its date editor", () => {
    const { text, dialogTriggers } = render("detected", "running-late");
    expect(text).toBe("charges monthly around the 5th, about $4.99 from Chase Sapphire.");
    expect(dialogTriggers).toBe(2);
  });

  test("the sentence's tense and the 'Nothing expected' card turn on one predicate, for every status and evidence", () => {
    // the linkage, not two lists that happen to agree today
    for (const status of EVERY_STATUS) {
      for (const evidence of EVERY_EVIDENCE) {
        const { text, dialogTriggers } = render(status, evidence);
        const nothingExpected = noScheduleReason(status, evidence, "subscription", true) !== null;
        expect(text.startsWith("charged "), `${status} · ${evidence}`).toBe(nothingExpected);
        expect(text.includes("around the"), `${status} · ${evidence}`).toBe(!nothingExpected);
        expect(dialogTriggers, `${status} · ${evidence}`).toBe(nothingExpected ? 1 : 2);
      }
    }
  });
});

/*
 * 🔴 His pay's page read "deposits weekly on Thursdays, about $1,141.92 from Wells Fargo Everyday Checking." — pay does
 * not come FROM the account it lands in (a copy of his ledger, 2026-10-13). The account clause says which way the money
 * moves through it: into it for pay, out of it for a bill — and a transfer series, which is one leg of a move between
 * his own accounts, by its own sign.
 */
describe("CadenceSentence — the account clause says which way the money moves through it", () => {
  const pay = {
    kind: "income",
    cadence: "weekly",
    nextExpectedOn: "2026-10-15",
    amountCents: 114_192,
    userAmountCents: 114_192,
    detectedCadence: "weekly",
    accountName: "Wells Fargo Everyday Checking",
  } as const satisfies Partial<SentenceProps>;

  test("his pay lands INTO Wells Fargo — present tense, as his ledger copy reads it on 2026-10-13", () => {
    expect(render("confirmed", "active", pay).text).toBe(
      "deposits weekly on Thursdays, about $1,141.92 into Wells Fargo Everyday Checking.",
    );
  });

  test("…and still into it once the pay is over, deposited or never", () => {
    expect(render("ended", "active", pay).text).toBe("deposited weekly, about $1,141.92 into Wells Fargo Everyday Checking.");
    expect(render("ended", "active", { ...pay, neverPosted: true }).text).toBe(
      "was expected weekly, about $1,141.92 into Wells Fargo Everyday Checking.",
    );
  });

  test("a bill still leaves FROM its account", () => {
    expect(render("detected", "running-late").text).toBe("charges monthly around the 5th, about $4.99 from Chase Sapphire.");
  });

  test("a transfer goes by its leg's sign: the autopay out of checking, the card's payment into the card", () => {
    const autopay = { kind: "transfer", nextExpectedOn: "2026-10-24", accountName: "Chase Checking" } as const;
    expect(render("detected", "active", { ...autopay, amountCents: -99_302 }).text).toBe(
      "moves monthly around the 24th, about $993.02 from Chase Checking.",
    );
    expect(render("detected", "active", { ...autopay, amountCents: 99_302, accountName: "Chase Sapphire" }).text).toBe(
      "moves monthly around the 24th, about $993.02 into Chase Sapphire.",
    );
  });
});
