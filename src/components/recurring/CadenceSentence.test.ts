import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { noScheduleReason, type SeriesEvidence, type SeriesStatusForCopy } from "@/lib/series-evidence";

// the server action pulls in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({ setSeriesOverridesAction: vi.fn() }));

const { CadenceSentence } = await import("./CadenceSentence");

const EVERY_EVIDENCE: readonly SeriesEvidence[] = ["active", "never-billed", "running-late", "lapsed"];
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
    oneCharge: { day: "2026-11-11", label: "Nov 11" },
  } as const satisfies Partial<SentenceProps>;

  test("the Nov 11 balance: once, its day, its amount — and no cadence menu, since one charge takes no step", () => {
    const { text, dialogTriggers, menuTriggers } = render("confirmed", "never-billed", nov11);
    expect(text).toBe("charges once on Nov 11, about $72.74 from Chase Sapphire.");
    expect(menuTriggers).toBe(0);
    // its day and its amount are still his to correct
    expect(dialogTriggers).toBe(2);
  });

  test("once it is over the day stays — a one-off's day is its schedule, not a rhythm read off a stale date", () => {
    const { text, dialogTriggers } = render("ended", "never-billed", nov11);
    expect(text).toBe("charged once on Nov 11, about $72.74 from Chase Sapphire.");
    expect(dialogTriggers).toBe(1);
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
        const nothingExpected = noScheduleReason(status, evidence) !== null;
        expect(text.startsWith("charged "), `${status} · ${evidence}`).toBe(nothingExpected);
        expect(text.includes("around the"), `${status} · ${evidence}`).toBe(!nothingExpected);
        expect(dialogTriggers, `${status} · ${evidence}`).toBe(nothingExpected ? 1 : 2);
      }
    }
  });
});
