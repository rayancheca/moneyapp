import { describe, expect, test } from "vitest";
import { addDays } from "./dates";
import {
  MAX_TRACKED_CLOSES,
  MONTHLY_GAP_MAX,
  MONTHLY_GAP_MIN,
  nextCloseAfter,
  pullDemand,
  pullSentence,
  RECENT_CLOSES,
  rhythmPhrase,
  statementCadence,
  statementPull,
} from "./statement-cadence";

/**
 * Fixtures are the REAL shapes on this ledger, measured from statement_periods:
 * SoFi/Robinhood close on the last day of the month, Discover and Chase Sapphire
 * on the 2nd, Venture X on the 13th–14th, and Chase Checking wanders 10–13.
 */
const MONTH_END = ["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31"];
const SECOND = ["2026-03-02", "2026-04-02", "2026-05-02", "2026-06-02", "2026-07-02", "2026-08-02"];
const CHASE = ["2026-01-13", "2026-02-11", "2026-03-11", "2026-04-10", "2026-05-12", "2026-06-10", "2026-07-10", "2026-08-12"];

describe("statementCadence", () => {
  test("an all-last-day history is month-end, not 'the 31st'", () => {
    // the discriminator that matters: 2026-04-30 is a close on the last day, and
    // reading it as "the 30th" would put May's close three days early
    const c = statementCadence(MONTH_END);
    expect(c.rhythm).toEqual({ kind: "month-end" });
    expect(c.closes).toBe(5);
  });

  test("a fixed-day history reports that day", () => {
    expect(statementCadence(SECOND).rhythm).toEqual({ kind: "day-of-month", day: 2 });
  });

  test("a business-day wander widens the tolerance, it does not move the day", () => {
    const c = statementCadence(CHASE);
    expect(c.rhythm).toEqual({ kind: "day-of-month", day: 11 });
    // days 10–13 around a median of 11 → deviations [2,0,0,1,1,1,1,1], the lone
    // 2 trimmed off, so 1 of wander plus a day of publishing slack. Without any
    // tolerance this nags on the 12th every month the cycle lands on the 13th.
    expect(c.toleranceDays).toBe(2);
  });

  test("one outlier close does not set the tolerance forever", () => {
    // Chase Sapphire's real shape: seven closes on the 2nd and a stray on the
    // 10th. An untrimmed maximum would hold the reminder back 8 days each month.
    const c = statementCadence([...SECOND, "2026-09-10", "2026-10-02", "2026-11-02"]);
    expect(c.rhythm).toEqual({ kind: "day-of-month", day: 2 });
    expect(c.toleranceDays).toBe(1);
  });

  test("only the most recent year decides — a CHANGED cycle takes over", () => {
    /*
     * Discover's real history: it billed on the 18th for a year, then the 2nd.
     * Across all of it the median day is the 14th — a day it has never closed
     * on — with a tolerance wide enough to swallow both. The window is what
     * stops the app predicting a date that never happens.
     */
    const old = Array.from({ length: 12 }, (_, i) => `2024-${String(i + 1).padStart(2, "0")}-18`);
    const now = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}-02`);
    expect(statementCadence([...old, ...now]).rhythm).toEqual({ kind: "day-of-month", day: 2 });
    expect(statementCadence([...old, ...now]).closes).toBe(RECENT_CLOSES);
    // and the un-windowed answer is the bad one this guards against
    expect(statementCadence([...old, ...now].slice(6, 18)).rhythm).toEqual({
      kind: "day-of-month",
      day: 10,
    });
  });

  test("fewer than three closes is not a rhythm", () => {
    expect(statementCadence(["2026-07-31", "2026-08-31"]).rhythm).toEqual({ kind: "unknown" });
    expect(statementCadence([]).closes).toBe(0);
  });

  test("duplicate close dates count once", () => {
    expect(statementCadence(["2026-07-31", "2026-07-31", "2026-08-31"]).rhythm).toEqual({
      kind: "unknown",
    });
  });

  test("a quarterly cycle is reported in days rather than forced into a month", () => {
    const c = statementCadence(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
    expect(c.rhythm).toEqual({ kind: "every-n-days", days: 91 });
    expect(c.toleranceDays).toBe(2); // gaps 90/91/92 → spread 1 (too few to trim), +1
  });

  test("a weekly cycle is under the monthly band and stays in days", () => {
    expect(statementCadence(["2026-07-03", "2026-07-10", "2026-07-17"]).rhythm).toEqual({
      kind: "every-n-days",
      days: 7,
    });
  });

  test("the step can never be zero, so the next-close walk always advances", () => {
    // The one input that could hang a caller is a step of 0 days. Deduping makes
    // it unreachable: distinct ascending dates are at least a day apart, so even
    // this degenerate run reports 1 rather than 0.
    const c = statementCadence(["2026-07-01", "2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(c.rhythm).toEqual({ kind: "every-n-days", days: 1 });
    expect(nextCloseAfter(c.rhythm, "2026-07-03")).toBe("2026-07-04");
  });
});

describe("nextCloseAfter", () => {
  test("month-end lands on each month's own last day, whatever its length", () => {
    const r = { kind: "month-end" } as const;
    expect(nextCloseAfter(r, "2026-01-31")).toBe("2026-02-28");
    expect(nextCloseAfter(r, "2026-02-28")).toBe("2026-03-31"); // the 31st comes back
    expect(nextCloseAfter(r, "2024-01-31")).toBe("2024-02-29"); // leap
    expect(nextCloseAfter(r, "2026-12-31")).toBe("2027-01-31");
  });

  test("a fixed day clamps into a month that does not have it", () => {
    expect(nextCloseAfter({ kind: "day-of-month", day: 31 }, "2026-01-31")).toBe("2026-02-28");
    expect(nextCloseAfter({ kind: "day-of-month", day: 2 }, "2026-08-09")).toBe("2026-09-02");
  });

  test("an n-day rhythm steps in days", () => {
    expect(nextCloseAfter({ kind: "every-n-days", days: 91 }, "2026-01-15")).toBe("2026-04-16");
  });

  test("an unknown rhythm predicts nothing", () => {
    expect(nextCloseAfter({ kind: "unknown" }, "2026-01-15")).toBeNull();
  });
});

describe("statementPull", () => {
  test("inside the cycle it is waiting, and says when the next one closes", () => {
    const p = statementPull(MONTH_END, "2026-08-14");
    expect(p.status).toBe("waiting");
    expect(p.expectedOn).toBe("2026-08-31");
    expect(p.closesDue).toBe(0);
    expect(p.daysLate).toBe(0);
    expect(p.daysSinceLastClose).toBe(14);
  });

  test("a close that has passed is ready to pull — the real Robinhood Crypto row", () => {
    // measured on the ledger: last close 2026-06-30, read on 2026-08-14
    const p = statementPull(
      ["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"],
      "2026-08-14",
    );
    expect(p.status).toBe("due");
    expect(p.expectedOn).toBe("2026-07-31");
    expect(p.closesDue).toBe(1);
    expect(p.daysLate).toBe(14);
  });

  test("the tolerance holds the reminder back until the close is certain", () => {
    // Chase-shaped: median day 11, tolerance 2. On the 12th the cycle may not
    // have closed yet — it has landed on the 13th twice — so the panel stays
    // quiet, and speaks on the 13th once every observed close has passed.
    expect(statementPull(CHASE, "2026-09-12").status).toBe("waiting");
    expect(statementPull(CHASE, "2026-09-13").status).toBe("due");
  });

  test("two missed cycles read as behind, oldest first", () => {
    const p = statementPull(MONTH_END, "2026-10-05");
    expect(p.status).toBe("behind");
    expect(p.closesDue).toBe(2); // 2026-08-31 and 2026-09-30
    expect(p.daysLate).toBe(35); // since the OLDEST unpulled close
    expect(p.capped).toBe(false);
  });

  test("a dormant account stops counting rather than walking the calendar", () => {
    const p = statementPull(["2019-01-31", "2019-02-28", "2019-03-31"], "2026-08-14");
    expect(p.closesDue).toBe(MAX_TRACKED_CLOSES);
    expect(p.capped).toBe(true);
    expect(p.status).toBe("behind");
  });

  test("no rhythm predicts no date, and never claims a statement is late", () => {
    const p = statementPull(["2026-07-31"], "2026-12-31");
    expect(p.status).toBe("unknown");
    expect(p.expectedOn).toBeNull();
    expect(p.closesDue).toBe(0);
    expect(p.lastCloseOn).toBe("2026-07-31");
    expect(p.daysSinceLastClose).toBe(153);
  });

  test("an account with no statements at all is silent, not overdue", () => {
    const p = statementPull([], "2026-08-14");
    expect(p.status).toBe("unknown");
    expect(p.lastCloseOn).toBeNull();
    expect(p.daysSinceLastClose).toBeNull();
    expect(p.daysLate).toBe(0);
  });
});

describe("the words", () => {
  test("every rhythm states the evidence it was measured from", () => {
    expect(rhythmPhrase(statementCadence(MONTH_END))).toBe(
      "closes on the last day of the month, from 5 statements",
    );
    expect(rhythmPhrase(statementCadence(SECOND))).toBe("closes around the 2nd, from 6 statements");
    expect(rhythmPhrase(statementCadence(CHASE))).toBe("closes around the 11th, from 8 statements");
    expect(rhythmPhrase(statementCadence(["2026-01-15", "2026-04-15", "2026-07-15"]))).toBe(
      "closes about every 91 days, from 3 statements",
    );
  });

  test("ordinals survive the teens and the 1st/2nd/3rd", () => {
    const at = (day: number) =>
      rhythmPhrase(statementCadence([`2026-05-${String(day).padStart(2, "0")}`, `2026-06-${String(day).padStart(2, "0")}`, `2026-07-${String(day).padStart(2, "0")}`]));
    expect(at(1)).toContain("the 1st,");
    expect(at(2)).toContain("the 2nd,");
    expect(at(3)).toContain("the 3rd,");
    expect(at(11)).toContain("the 11th,"); // not "11st"
    expect(at(12)).toContain("the 12th,");
    expect(at(13)).toContain("the 13th,");
    expect(at(21)).toContain("the 21st,");
    expect(at(24)).toContain("the 24th,");
  });

  test("too little evidence says so instead of naming a day", () => {
    expect(rhythmPhrase(statementCadence([]))).toBe("no statements imported yet");
    expect(rhythmPhrase(statementCadence(["2026-07-31"]))).toBe(
      "only 1 statement — not enough to call a cycle",
    );
    expect(rhythmPhrase(statementCadence(["2026-06-30", "2026-07-31"]))).toBe(
      "only 2 statements — not enough to call a cycle",
    );
  });

  /**
   * The two states the whole feature exists for, neither of which any Playwright
   * run on this repo's fixture can render — all seven of its accounts sit inside
   * their cycle. This is the only place they are exercised.
   */
  test("a due account is told which close to go and get", () => {
    const p = statementPull(MONTH_END, "2026-09-02");
    expect(p.status).toBe("due");
    expect(pullSentence(p)).toBe(
      "last one closed Jul 31, 33 days ago · one closed 2 days ago, not imported",
    );
  });

  test("a behind account counts them, oldest first", () => {
    const p = statementPull(MONTH_END, "2026-10-05");
    expect(pullSentence(p)).toBe(
      "last one closed Jul 31, 66 days ago · 2 closed since, the oldest 35 days ago",
    );
  });

  test("a dormant account reports a floor, never a fabricated count", () => {
    const p = statementPull(["2019-01-31", "2019-02-28", "2019-03-31"], "2026-08-14");
    expect(pullSentence(p)).toContain(`${MAX_TRACKED_CLOSES}+ closed since`);
  });

  test("a waiting account names the next close, and nothing is called overdue", () => {
    const p = statementPull(MONTH_END, "2026-08-14");
    expect(pullSentence(p)).toBe("last one closed Jul 31, 14 days ago · next closes Aug 31");
    expect(pullSentence(p)).not.toContain("overdue");
  });

  test("the teaser and the panel cannot word the same fact differently", () => {
    // pullSentence is built FROM pullDemand, so the dashboard's short line and
    // the /imports row can never disagree about what is outstanding
    const due = statementPull(MONTH_END, "2026-09-02");
    expect(pullDemand(due)).toBe("one closed 2 days ago, not imported");
    expect(pullSentence(due)).toContain(pullDemand(due)!);

    const behind = statementPull(MONTH_END, "2026-10-05");
    expect(pullDemand(behind)).toBe("2 closed since, the oldest 35 days ago");
    expect(pullSentence(behind)).toContain(pullDemand(behind)!);
  });

  test("a quiet account makes NO demand — the dashboard shows it nothing", () => {
    expect(pullDemand(statementPull(MONTH_END, "2026-08-14"))).toBeNull(); // waiting
    expect(pullDemand(statementPull(["2026-07-31"], "2026-12-31"))).toBeNull(); // unknown
    expect(pullDemand(statementPull([], "2026-08-14"))).toBeNull(); // never had one
  });

  test("an account with no statements at all makes no claim about a cycle", () => {
    expect(pullSentence(statementPull([], "2026-08-14"))).toBe("nothing imported yet");
  });

  test("one statement is described without predicting from it", () => {
    expect(pullSentence(statementPull(["2026-07-31"], "2026-08-14"))).toBe(
      "last one closed Jul 31, 14 days ago",
    );
  });
});

/*
 * ⛔ THE MONTHLY BAND'S OWN EDGES, and the trim's threshold. All three were
 * found by mutation: each comparison could be relaxed or tightened with nothing
 * red, because every fixture sits comfortably inside its band and comfortably
 * past the trim's five.
 *
 * The rhythm decides `nextCloseAfter`, so a card whose closes average exactly
 * 26 or 35 days apart gets a different predicted statement date and a different
 * `status` on the /imports pull panel. A 26-day gap is a February close pair
 * and a 35-day gap is a close that slipped a long month — both are real shapes,
 * not invented ones.
 */
describe("the monthly band, at its edges", () => {
  /** N closes exactly `gap` days apart, ending 2026-08-01. */
  const everyNDays = (gap: number, n = 6): string[] => {
    const out: string[] = [];
    let d = "2026-08-01";
    for (let i = 0; i < n; i++) {
      out.unshift(d);
      d = addDays(d, -gap);
    }
    return out;
  };

  test("exactly MONTHLY_GAP_MIN days apart is still monthly", () => {
    expect(MONTHLY_GAP_MIN).toBe(26);
    expect(statementCadence(everyNDays(26)).rhythm.kind).toBe("day-of-month");
    // …and one day tighter is not
    expect(statementCadence(everyNDays(25)).rhythm).toEqual({ kind: "every-n-days", days: 25 });
  });

  test("exactly MONTHLY_GAP_MAX days apart is still monthly", () => {
    expect(MONTHLY_GAP_MAX).toBe(35);
    expect(statementCadence(everyNDays(35)).rhythm.kind).toBe("day-of-month");
    // …and one day wider is not
    expect(statementCadence(everyNDays(36)).rhythm).toEqual({ kind: "every-n-days", days: 36 });
  });

  /*
   * The outlier trim turns on at exactly five deviations. Below it the raw
   * maximum stands, which is what the trim exists to prevent: one late close
   * would hold the reminder back by its own lateness every month after.
   */
  test("the trim turns on at exactly five observations", () => {
    // five closes → four gaps and five days-of-month, so five deviations
    const wanderer = ["2026-03-02", "2026-04-02", "2026-05-02", "2026-06-02", "2026-07-10"];
    const trimmed = statementCadence(wanderer);
    expect(trimmed.rhythm).toEqual({ kind: "day-of-month", day: 2 });
    // the 8-day outlier is dropped, so the tolerance is the slack alone
    expect(trimmed.toleranceDays).toBeLessThan(8);

    // four closes → four deviations, below the trim: the outlier stands
    const untrimmed = statementCadence(["2026-04-02", "2026-05-02", "2026-06-02", "2026-07-10"]);
    expect(untrimmed.toleranceDays).toBeGreaterThanOrEqual(8);
  });
});
