import { describe, expect, test } from "vitest";
import { addCalendarMonths, addDays } from "./dates";
import {
  CYCLE_AGREEMENT_DAYS,
  MAX_TRACKED_CLOSES,
  MIN_CLOSES,
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
    // the window, not the moved-cycle rule, is what forgot the 18th: a year on
    // the 2nd reads as a settled cycle with nothing before it
    expect(statementCadence([...old, ...now]).movedFrom).toBeUndefined();
    /*
     * ⚠️ A window still holding BOTH cycles used to average them into the 10th —
     * a day the card never closed on — and this line pinned that as the picture
     * of the bad answer. Since 2026-10-08 it is the case "a cycle that moved"
     * (below) exists for: six closes on the 2nd after six on the 18th is a move,
     * and the rhythm follows it instead of splitting the difference.
     */
    const mixed = statementCadence([...old, ...now].slice(6, 18));
    expect(mixed.rhythm).toEqual({ kind: "day-of-month", day: 2 });
    expect(mixed.movedFrom).toEqual({ day: 18, closes: 6 });
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
    expect(p.expectedHasPassed).toBe(false);
    expect(p.readyOn).toBe("2026-09-01");
    expect(pullSentence(p)).toBe("last one closed Jul 31, 14 days ago · next closes Aug 31");
    expect(pullSentence(p)).not.toContain("overdue");
  });

  /*
   * 🔴 THE REAL DISCOVER ROW ON 2026-09-03: eleven closes on the 2nd, then the
   * Capital One reissue closed Aug 9. The rhythm still says the 2nd and the
   * newest close widens the tolerance to eight days, so the panel honestly
   * waits until Sep 10 — but the sentence said "next closes Sep 2" beside "On
   * schedule", on Sep 3. A predicted date already gone is not the NEXT close.
   * Killed by mutation: dropping the `expectedHasPassed` branch prints the
   * stale sentence; deriving `readyOn` from anything but the loop's own sum
   * names a different day than the one the status flips on.
   */
  test("a predicted close that has passed is said as passed, with the day it counts as late", () => {
    const DISCOVER = [
      ...Array.from({ length: 11 }, (_, i) => {
        const month = ((8 + i) % 12) + 1; // 2025-09 … 2026-07
        const year = 8 + i >= 12 ? 2026 : 2025;
        return `${year}-${String(month).padStart(2, "0")}-02`;
      }),
      "2026-08-09",
    ];
    const p = statementPull(DISCOVER, "2026-09-03");
    expect(p.status).toBe("waiting");
    expect(p.expectedOn).toBe("2026-09-02");
    expect(p.expectedHasPassed).toBe(true);
    expect(p.readyOn).toBe("2026-09-10");
    expect(pullSentence(p)).toBe(
      "last one closed Aug 9, 25 days ago · closes around Sep 2 on this rhythm — counted as late from Sep 10",
    );
    // and on that very day the status flips, so the two agree about the date
    expect(statementPull(DISCOVER, "2026-09-10").status).toBe("due");
    expect(statementPull(DISCOVER, "2026-09-09").status).toBe("waiting");
  });

  test("on the predicted close day itself the close is behind us, not ahead", () => {
    // month-end, tolerance 1: on Aug 31 the PDF is not out yet and the status
    // waits, but "next closes Aug 31" would name today as the future
    const p = statementPull(MONTH_END, "2026-08-31");
    expect(p.status).toBe("waiting");
    expect(p.expectedHasPassed).toBe(true);
    expect(pullSentence(p)).toContain("closes around Aug 31 on this rhythm — counted as late from Sep 1");
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
    /*
     * ⚠️ The outlier is in the MIDDLE, not at the end. My first version of this
     * test put it last and asserted it was trimmed — encoding the very
     * behaviour the next commit had to change, because the newest close is
     * never the one trimmed. A fixture that puts the outlier where the rule
     * exempts it cannot test the rule.
     */
    // five closes → five days-of-month, so five deviations
    const wanderer = ["2026-03-02", "2026-04-10", "2026-05-02", "2026-06-02", "2026-07-02"];
    const trimmed = statementCadence(wanderer);
    expect(trimmed.rhythm).toEqual({ kind: "day-of-month", day: 2 });
    // the 8-day outlier is dropped, so the tolerance is the slack alone
    expect(trimmed.toleranceDays).toBeLessThan(8);

    // four closes → four deviations, below the trim: the outlier stands
    const untrimmed = statementCadence(["2026-04-10", "2026-05-02", "2026-06-02", "2026-07-02"]);
    expect(untrimmed.toleranceDays).toBeGreaterThanOrEqual(8);
  });

  /*
   * ⛔ A PERMANENT CHANGE OF CYCLE LOOKS EXACTLY LIKE A SINGLE OUTLIER in the
   * month it happens, so the newest close is never the one trimmed.
   *
   * 🔴 Measured on the real ledger: `Discover` is issued by Capital One now and
   * its August 2026 statement closed on the 9th after eleven closes on the 2nd.
   * The trim dropped that 7-day deviation and left `toleranceDays = 1` —
   * removing the newest close from the input entirely produced the IDENTICAL
   * rhythm AND tolerance, which is what "contributes nothing" means. /imports
   * then read "Ready to pull" from 2026-09-03, six days before the statement
   * exists, and would have done so every month until the median moved.
   */
  describe("the newest close is never trimmed", () => {
    const ELEVEN_ON_THE_SECOND = [
      "2025-10-02", "2025-11-02", "2025-12-02", "2026-01-02", "2026-02-02", "2026-03-02",
      "2026-04-02", "2026-05-02", "2026-06-02", "2026-07-02",
    ];

    test("a cycle that has just moved widens the tolerance instead of vanishing", () => {
      const moved = statementCadence([...ELEVEN_ON_THE_SECOND, "2026-08-09"]);
      // one close is not enough to move the median — the rhythm is still the 2nd
      expect(moved.rhythm).toEqual({ kind: "day-of-month", day: 2 });
      // …but the seven days it moved by are held, not thrown away
      expect(moved.toleranceDays).toBeGreaterThanOrEqual(7);
      // and the reminder waits until the day the statement actually closed
      expect(nextCloseAfter(moved.rhythm, "2026-08-09")).toBe("2026-09-02");
    });

    test("the same outlier in the PAST is still trimmed — the old rule survives for history", () => {
      const historical = statementCadence([
        "2025-10-09", ...ELEVEN_ON_THE_SECOND.slice(1), "2026-08-02",
      ]);
      expect(historical.rhythm).toEqual({ kind: "day-of-month", day: 2 });
      expect(historical.toleranceDays).toBeLessThan(7);
    });

    test("a settled cycle keeps a tight tolerance", () => {
      const settled = statementCadence([...ELEVEN_ON_THE_SECOND, "2026-08-02"]);
      expect(settled.toleranceDays).toBeLessThan(3);
    });
  });
});

/*
 * ⛔ A CYCLE THAT MOVED. The window takes a year to forget an old cycle and the
 * median needs six or seven new closes before it moves, so for half a year a
 * reissued card was described by a cycle it no longer has.
 *
 * 🔴 Measured on the owner's /imports on 2026-10-08: `Discover` (Capital One since
 * Aug 2026) read "closes around the 2nd, from 12 statements" and "closes around
 * Oct 2 on this rhythm — counted as late from Oct 9" — while its last two
 * statements closed Aug 9 and Sep 8, and its next is due about Oct 9.
 */
describe("a cycle that moved", () => {
  /** Every Discover period end on the real ledger (statement_periods, 2026-10-08 copy), oldest first. */
  const DISCOVER_REAL = [
    "2023-11-18", "2023-12-18", "2024-01-18", "2024-02-18", "2024-03-18", "2024-04-18", "2024-05-18",
    "2024-06-18", "2024-07-18", "2024-08-18", "2024-10-18", "2024-12-18", "2025-01-18", "2025-02-18",
    "2025-05-02", "2025-06-02", "2025-07-02", "2025-10-02", "2025-11-02", "2025-12-02", "2026-01-02",
    "2026-02-02", "2026-03-02", "2026-04-02", "2026-05-02", "2026-06-02", "2026-07-02",
    "2026-08-09", "2026-09-08",
  ];
  /** The ten closes on the 2nd inside Discover's window, before Capital One moved it. */
  const TEN_ON_THE_SECOND = DISCOVER_REAL.slice(17, 27);

  test("Discover's real closes: the rhythm follows the Capital One cycle from its second close", () => {
    expect(TEN_ON_THE_SECOND).toEqual(Array.from({ length: 10 }, (_, i) => addCalendarMonths("2025-10-02", i)));
    const c = statementCadence(DISCOVER_REAL);
    // Aug 9 and Sep 8 → the median day 8.5 rounds to the 9th; one day of spread plus the slack
    expect(c.rhythm).toEqual({ kind: "day-of-month", day: 9 });
    expect(c.toleranceDays).toBe(2);
    expect(c.closes).toBe(2);
    expect(c.movedFrom).toEqual({ day: 2, closes: 10 });
    // two closes is below the MIN_CLOSES bar, and the phrase says so
    expect(MIN_CLOSES).toBe(3);
    expect(rhythmPhrase(c)).toBe(
      "closes around the 9th, from only its last 2 statements — the 10 before closed around the 2nd",
    );
  });

  test("Discover's row on 2026-10-08 names the close that is coming, and late follows it", () => {
    const p = statementPull(DISCOVER_REAL, "2026-10-08");
    expect(p.status).toBe("waiting");
    expect(p.expectedOn).toBe("2026-10-09");
    expect(p.readyOn).toBe("2026-10-11");
    expect(pullSentence(p)).toBe("last one closed Sep 8, 30 days ago · next closes Oct 9");
    // on the day itself the close is behind us, and the late day is the one the status flips on
    expect(pullSentence(statementPull(DISCOVER_REAL, "2026-10-09"))).toBe(
      "last one closed Sep 8, 31 days ago · closes around Oct 9 on this rhythm — counted as late from Oct 11",
    );
    expect(statementPull(DISCOVER_REAL, "2026-10-10").status).toBe("waiting");
    expect(statementPull(DISCOVER_REAL, "2026-10-11").status).toBe("due");
  });

  /*
   * 🔴 A rule that looked only at the TWO newest closes would hold for one month:
   * when the third close on the new cycle lands, Aug 9 becomes the newest of the
   * OLDER closes, is never trimmed there, widens their tolerance to eight days,
   * and the 8th and 9th sit inside it — the panel would go back to "the 2nd".
   */
  test("the third close on the new cycle keeps it — every close since the move counts", () => {
    const c = statementCadence([...DISCOVER_REAL, "2026-10-09"]);
    expect(c.rhythm).toEqual({ kind: "day-of-month", day: 9 });
    expect(c.closes).toBe(3);
    expect(c.toleranceDays).toBe(2);
    expect(c.movedFrom).toEqual({ day: 2, closes: 9 });
    expect(rhythmPhrase(c)).toBe(
      "closes around the 9th, from its last 3 statements — the 9 before closed around the 2nd",
    );
  });

  /*
   * ⛔ THE END OF THE MOVE: the older closes must still be a rhythm on their own — MIN_CLOSES of them — or
   * there is nothing to have moved FROM. Pinned at the two months it decides, with the months to come
   * closing on the 9th as Capital One's do so far. A second reader found both bounds unpinned on
   * 2026-10-08: starting the run one shorter, or measuring the old cycle from two closes, passed every test.
   */
  test("the move holds while three closes before it remain; the plain measurement takes the window after", () => {
    /** Discover's real closes, then `months` more on the 9th from Oct 2026. */
    const capitalOneThrough = (months: number) =>
      statementCadence([
        ...DISCOVER_REAL,
        ...Array.from({ length: months }, (_, i) => addCalendarMonths("2026-10-09", i)),
      ]);
    // Apr 2027: nine closes on the new cycle, three on the 2nd before them — still a move
    const april = capitalOneThrough(7);
    expect(april.rhythm).toEqual({ kind: "day-of-month", day: 9 });
    expect(april.closes).toBe(9);
    expect(april.toleranceDays).toBe(1);
    expect(april.movedFrom).toEqual({ day: 2, closes: MIN_CLOSES });
    expect(rhythmPhrase(april)).toBe(
      "closes around the 9th, from its last 9 statements — the 3 before closed around the 2nd",
    );
    // May 2027: two closes on the 2nd are below the bar, so the window is measured whole. Its median has
    // moved to the 9th; for this one cycle the trim keeps one of the two old closes as wander (seven days)
    const may = capitalOneThrough(8);
    expect(may.rhythm).toEqual({ kind: "day-of-month", day: 9 });
    expect(may.closes).toBe(RECENT_CLOSES);
    expect(may.toleranceDays).toBe(8);
    expect(may.movedFrom).toBeUndefined();
    expect(rhythmPhrase(may)).toBe("closes around the 9th, from 12 statements");
  });

  test("a single late close is not a move — the one-off case keeps the old day", () => {
    const c = statementCadence([...TEN_ON_THE_SECOND, "2026-08-09"]);
    expect(c.rhythm).toEqual({ kind: "day-of-month", day: 2 });
    expect(c.movedFrom).toBeUndefined();
    expect(rhythmPhrase(c)).toBe("closes around the 2nd, from 11 statements");
  });

  test("the newest closes must agree with each other — at most CYCLE_AGREEMENT_DAYS apart", () => {
    expect(CYCLE_AGREEMENT_DAYS).toBe(3);
    // the 9th and the 12th: three apart, one cycle → the median 10.5 rounds to the 11th
    const agree = statementCadence([...TEN_ON_THE_SECOND, "2026-08-09", "2026-09-12"]);
    expect(agree.rhythm).toEqual({ kind: "day-of-month", day: 11 });
    expect(agree.movedFrom).toEqual({ day: 2, closes: 10 });
    // the 9th and the 13th: four apart, two late closes rather than a cycle
    const apart = statementCadence([...TEN_ON_THE_SECOND, "2026-08-09", "2026-09-13"]);
    expect(apart.rhythm).toEqual({ kind: "day-of-month", day: 2 });
    expect(apart.movedFrom).toBeUndefined();
  });

  test("closes inside the old cycle's own tolerance are wander, not a move", () => {
    // ten on the 2nd → tolerance 1: two closes on the 3rd sit inside it…
    const wander = statementCadence([...TEN_ON_THE_SECOND, "2026-08-03", "2026-09-03"]);
    expect(wander.rhythm).toEqual({ kind: "day-of-month", day: 2 });
    expect(wander.movedFrom).toBeUndefined();
    // …two on the 4th do not
    const moved = statementCadence([...TEN_ON_THE_SECOND, "2026-08-04", "2026-09-04"]);
    expect(moved.rhythm).toEqual({ kind: "day-of-month", day: 4 });
    expect(moved.movedFrom).toEqual({ day: 2, closes: 10 });
  });

  test("EVERY close since the move must be off the old cycle, not just the newest", () => {
    // the 3rd is inside the old tolerance, the 5th is not: one late close, not a cycle
    const c = statementCadence([...TEN_ON_THE_SECOND, "2026-08-03", "2026-09-05"]);
    expect(c.rhythm).toEqual({ kind: "day-of-month", day: 2 });
    expect(c.movedFrom).toBeUndefined();
  });

  test("a transitional first close counts with the new cycle — the run is as long as it agrees", () => {
    // eight on the 2nd, then the 6th, 8th, 8th, 9th: all four within three days of
    // each other and off the 2nd, so the new cycle is measured from all four
    const c = statementCadence([
      ...TEN_ON_THE_SECOND.slice(0, 8), "2026-06-06", "2026-07-08", "2026-08-08", "2026-09-09",
    ]);
    expect(c.rhythm).toEqual({ kind: "day-of-month", day: 8 });
    expect(c.closes).toBe(4);
    expect(c.movedFrom).toEqual({ day: 2, closes: 8 });
    // the 6th is two off the 8th: wander of the new cycle, held rather than trimmed
    expect(c.toleranceDays).toBe(3);
  });

  test("a month-end account is never re-measured from its newest closes", () => {
    const c = statementCadence([
      "2025-10-31", "2025-11-30", "2025-12-31", "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30",
      "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-09", "2026-09-08",
    ]);
    expect(c.movedFrom).toBeUndefined();
  });

  test("a window that is not monthly as a whole stays in days, whatever its newest closes do", () => {
    // three closes on the 2nd, then four a day apart on the 20th–23rd: the last
    // four agree and sit off the 2nd, but the median gap is 9.5 days, and an
    // every-n-days rhythm is never re-read as a day of the month
    const c = statementCadence([
      "2026-01-02", "2026-02-02", "2026-03-02", "2026-03-20", "2026-03-21", "2026-03-22", "2026-03-23",
    ]);
    expect(c.rhythm).toEqual({ kind: "every-n-days", days: 10 });
    expect(c.movedFrom).toBeUndefined();
  });

  /*
   * The accounts the rule must leave alone, as the real ledger has them. Chase
   * Sapphire is read the way the Missing-statements panel read it until
   * 2026-10-08 — two Chase spending reports included, which is where its 9-day
   * tolerance comes from. Both panels now read statements only
   * (`statementsByAccount`, tolerance 1); the noisier reading stays as the
   * harder case: two strays off the 2nd are not a moved cycle.
   */
  test("the real ledger's settled cycles are untouched", () => {
    const sapphire = statementCadence([
      "2025-12-02", "2025-12-31", "2026-01-02", "2026-02-02", "2026-03-02", "2026-04-02", "2026-05-02",
      "2026-06-02", "2026-07-02", "2026-07-10", "2026-08-02", "2026-09-02",
    ]);
    expect(sapphire.rhythm).toEqual({ kind: "day-of-month", day: 2 });
    expect(sapphire.toleranceDays).toBe(9);
    expect(sapphire.movedFrom).toBeUndefined();

    const chaseChecking = statementCadence([
      "2025-09-11", "2025-10-10", "2025-11-13", "2025-12-10", "2026-01-13", "2026-02-11", "2026-03-11",
      "2026-04-10", "2026-05-12", "2026-06-10", "2026-07-10", "2026-08-12",
    ]);
    expect(chaseChecking.rhythm).toEqual({ kind: "day-of-month", day: 11 });
    expect(chaseChecking.toleranceDays).toBe(3);
    expect(chaseChecking.movedFrom).toBeUndefined();

    const ventureX = statementCadence([
      "2026-02-11", "2026-03-14", "2026-04-13", "2026-05-14", "2026-06-13", "2026-07-14", "2026-08-14",
      "2026-09-13",
    ]);
    expect(ventureX.rhythm).toEqual({ kind: "day-of-month", day: 14 });
    expect(ventureX.toleranceDays).toBe(2);
    expect(ventureX.movedFrom).toBeUndefined();
  });
});
