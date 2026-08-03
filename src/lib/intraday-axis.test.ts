import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  InstantParseError,
  SESSION_TZ_LABEL,
  sessionDayOf,
  sessionSummarize,
  sessionTimeLabel,
  sessionView,
} from "./intraday-axis";

const JUL = "2026-07-31";

/** a 5-minute equity session, 13:30Z → 13:30Z + 5*n */
function equitySession(n: number, startCents = 100_000): { at: string; valueCents: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const minutes = 13 * 60 + 30 + i * 5;
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    return { at: `${JUL}T${hh}:${mm}:00.000Z`, valueCents: startCents + i * 10 };
  });
}

describe("sessionTimeLabel", () => {
  /**
   * THE LOAD-BEARING TEST. Both assertions are the SAME wall-clock time in New
   * York (09:30) at instants 60 minutes apart in UTC, because the US is on
   * daylight time in July and standard time in January. A fixed UTC offset
   * cannot satisfy both, so this refutes the offset shortcut outright.
   *
   * It is also the host-timezone guard for CI: on any non-Eastern machine these
   * exact strings only come out right if the zone is pinned in the module. On an
   * Eastern dev box they would pass even unpinned — which is what the source
   * guard below is for.
   */
  it("renders the market's clock, and survives DST", () => {
    expect(sessionTimeLabel("2026-07-31T13:30:00.000Z")).toBe("9:30 AM"); // EDT, UTC-4
    expect(sessionTimeLabel("2026-01-15T14:30:00.000Z")).toBe("9:30 AM"); // EST, UTC-5
    // the same instant in the other season is NOT 9:30 — proving the offset moved
    expect(sessionTimeLabel("2026-01-15T13:30:00.000Z")).toBe("8:30 AM");
  });

  it("renders the close and an after-hours instant", () => {
    expect(sessionTimeLabel("2026-07-31T20:00:00.000Z")).toBe("4:00 PM");
    expect(sessionTimeLabel("2026-07-31T00:00:00.000Z")).toBe("8:00 PM");
  });

  it("accepts an instant without milliseconds", () => {
    expect(sessionTimeLabel("2026-07-31T13:30:00Z")).toBe("9:30 AM");
  });

  it("refuses a bare day — a day has no time to render", () => {
    expect(() => sessionTimeLabel(JUL)).toThrow(InstantParseError);
    expect(() => sessionTimeLabel("nonsense")).toThrow(/Invalid ISO instant/);
  });
});

/**
 * The value assertions above cannot fail on this repo's own dev box, which
 * resolves to America/New_York — an unpinned implementation would agree with
 * them here and break only in UTC CI. This reads the source instead, so
 * deleting the pin fails the suite on the machine where it was deleted.
 */
describe("the timezone pin itself", () => {
  const source = readFileSync(new URL("./intraday-axis.ts", import.meta.url), "utf8");

  it("names an explicit IANA zone and an explicit locale", () => {
    expect(source).toContain('const SESSION_TZ = "America/New_York"');
    // every formatter in the file must pin BOTH, or it inherits the host's
    for (const call of source.match(/new Intl\.DateTimeFormat\([^)]*\{[^}]*\}/gs) ?? []) {
      expect(call).toContain('"en-US"');
      expect(call).toContain("timeZone: SESSION_TZ");
    }
  });

  it("never reaches for a host-dependent formatter", () => {
    expect(source).not.toMatch(/toLocaleTimeString|toLocaleDateString|toLocaleString/);
  });
});

describe("sessionDayOf", () => {
  it("is the day in the MARKET's zone, not the UTC prefix", () => {
    // midnight UTC is the previous evening in New York — the whole reason this
    // function exists rather than at.slice(0, 10)
    expect(sessionDayOf("2026-07-31T00:00:00.000Z")).toBe("2026-07-30");
    expect(sessionDayOf("2026-07-31T13:30:00.000Z")).toBe("2026-07-31");
  });

  it("zero-pads month and day", () => {
    expect(sessionDayOf("2026-01-05T15:00:00.000Z")).toBe("2026-01-05");
  });

  it("refuses a non-instant", () => {
    expect(() => sessionDayOf(JUL)).toThrow(InstantParseError);
  });
});

describe("sessionView", () => {
  it("returns null for a day that never ticked", () => {
    expect(sessionView(JUL, [], 100_000)).toBeNull();
  });

  it("prepends the previous close so the line starts where the day started", () => {
    const view = sessionView(JUL, equitySession(3, 21_000), 20_000)!;

    expect(view.opensAtPrevClose).toBe(true);
    expect(view.points).toHaveLength(4); // 3 ticks + the anchor
    expect(view.points[0]).toEqual({
      day: `${JUL}T00:00:00.000Z`,
      valueCents: 20_000,
      atLabel: "Previous close",
    });
    // the first REAL print is still the open, unchanged
    expect(view.points[1]!.valueCents).toBe(21_000);
    // ...and the anchor is what ScrubChart draws as its dotted baseline, so the
    // header delta now means "since yesterday's close"
    expect(view.points.at(-1)!.valueCents - view.points[0]!.valueCents).toBe(1_020);
  });

  it("omits the anchor rather than inventing one when there is no prior close", () => {
    const view = sessionView(JUL, equitySession(3), null)!;
    expect(view.opensAtPrevClose).toBe(false);
    expect(view.points).toHaveLength(3);
    expect(view.points[0]!.atLabel).toBe("Fri, Jul 31, 2026 · 9:30 AM");
  });

  it("omits the anchor when the session already begins at midnight UTC", () => {
    // a crypto book ticks all day, so there is no gap to anchor
    const view = sessionView(
      JUL,
      [
        { at: `${JUL}T00:00:00.000Z`, valueCents: 500 },
        { at: `${JUL}T12:00:00.000Z`, valueCents: 510 },
      ],
      499,
    )!;
    expect(view.opensAtPrevClose).toBe(false);
    expect(view.points).toHaveLength(2);
  });

  it("labels each point with the repo's own weekday and month names", () => {
    const view = sessionView(JUL, equitySession(2), null)!;
    expect(view.points[0]!.atLabel).toBe("Fri, Jul 31, 2026 · 9:30 AM");
    expect(view.points[1]!.atLabel).toBe("Fri, Jul 31, 2026 · 9:35 AM");
  });

  it("reports the session's own span for the caption", () => {
    const view = sessionView(JUL, equitySession(4), 1)!;
    expect(view.fromLabel).toBe("9:30 AM"); // the first PRINT, not the anchor
    expect(view.toLabel).toBe("9:45 AM");
    expect(SESSION_TZ_LABEL).toBe("ET");
  });
});

describe("sessionView ticks", () => {
  it("keeps every point when the session is shorter than the tick target", () => {
    const view = sessionView(JUL, equitySession(4), null)!;
    expect(view.ticks).toHaveLength(4);
    expect(view.ticks.map((t) => t.label)).toEqual(["9:30 AM", "9:35 AM", "9:40 AM", "9:45 AM"]);
  });

  it("samples a full 79-tick session down to a readable axis", () => {
    const view = sessionView(JUL, equitySession(79), null)!;
    expect(view.ticks).toHaveLength(6);
    expect(view.ticks.every((t) => /^\d{1,2}:\d{2} (AM|PM)$/.test(t.label))).toBe(true);
    // strictly increasing: a duplicated tick would stack two labels on one x
    const days = view.ticks.map((t) => t.day);
    expect([...new Set(days)]).toHaveLength(days.length);
    expect([...days].sort()).toEqual(days);
    // every tick names a real point, or recharts has nothing to place it against
    const domain = new Set(view.points.map((p) => p.day));
    expect(view.ticks.every((t) => domain.has(t.day))).toBe(true);
  });

  it("keeps the outermost ticks off the edges, where labels get clipped", () => {
    const view = sessionView(JUL, equitySession(79), null)!;
    // recharts centres a label on its category; a wide label on category 0 loses
    // its left half off the chart (this rendered "Prev close" as "v close")
    expect(view.ticks[0]!.day).not.toBe(view.points[0]!.day);
    expect(view.ticks.at(-1)!.day).not.toBe(view.points.at(-1)!.day);
    // …but still inside the session, not floating in the middle of it
    expect(view.ticks[0]!.day < view.points[8]!.day).toBe(true);
  });

  it("captions the anchor as the previous close when the axis reaches it", () => {
    // a short session labels every point, so index 0 IS a tick
    const view = sessionView(JUL, equitySession(3), 20_000)!;
    expect(view.ticks[0]!.label).toBe("Prev close");
    expect(view.ticks[1]!.label).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });

  it("thins the axis when labels carry a date prefix", () => {
    // 288 five-minute crypto ticks across a UTC day, which is two ET days
    const crypto = Array.from({ length: 288 }, (_, i) => {
      const hh = String(Math.floor((i * 5) / 60)).padStart(2, "0");
      const mm = String((i * 5) % 60).padStart(2, "0");
      return { at: `${JUL}T${hh}:${mm}:00.000Z`, valueCents: 1000 + i };
    });
    const view = sessionView(JUL, crypto, null)!;

    // four wide labels, not six — six of these collide into a smear at 440px
    expect(view.ticks).toHaveLength(4);
    for (const tick of view.ticks) {
      expect(tick.label).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2} (AM|PM)$/);
    }
  });

  it("prefixes the date when one session spans two ET days", () => {
    // a UTC-day crypto session starts at 8:00 PM the previous evening in ET
    const view = sessionView(
      JUL,
      [
        { at: `${JUL}T00:00:00.000Z`, valueCents: 500 },
        { at: `${JUL}T06:00:00.000Z`, valueCents: 505 },
        { at: `${JUL}T18:00:00.000Z`, valueCents: 510 },
      ],
      null,
    )!;
    expect(view.ticks.map((t) => t.label)).toEqual([
      "Jul 30 8:00 PM",
      "Jul 31 2:00 AM",
      "Jul 31 2:00 PM",
    ]);
  });

  it("does not prefix an ordinary equities session, anchor notwithstanding", () => {
    // the anchor sits at midnight UTC = the previous evening in ET, so a naive
    // span check over the ANCHORED points would wrongly prefix every session
    const view = sessionView(JUL, equitySession(8), 20_000)!;
    for (const tick of view.ticks.slice(1)) {
      expect(tick.label).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    }
  });
});

describe("sessionSummarize", () => {
  const slice = [
    { day: "2026-07-31T00:00:00.000Z", valueCents: 20_000 },
    { day: "2026-07-31T13:30:00.000Z", valueCents: 21_000 },
    { day: "2026-07-31T20:00:00.000Z", valueCents: 22_000 },
  ];

  it("measures the move from the window's first point", () => {
    expect(sessionSummarize(0, 2, slice)).toEqual({
      day: "2026-07-31T20:00:00.000Z",
      valueCents: 22_000,
      deltaCents: 2_000,
      deltaPct: 10,
    });
  });

  it("reports the scrubbed point, not the last one", () => {
    expect(sessionSummarize(0, 1, slice).deltaCents).toBe(1_000);
  });

  it("goes negative on a down session rather than clamping", () => {
    expect(sessionSummarize(0, 1, [slice[2]!, slice[0]!]).deltaCents).toBe(-2_000);
  });

  /**
   * The regression this function exists for. The portfolio's flow-adjusted
   * summarize selects days with `d.day >= from`; once `from` is an instant that
   * comparison is false for every daily row, so it returned $0.00 (+0.00%) over
   * a line that had visibly moved — a wrong number with no exception anywhere.
   */
  it("does not silently report zero on a session that moved", () => {
    const summary = sessionSummarize(0, 2, slice);
    expect(summary.deltaCents).not.toBe(0);
    expect(summary.deltaPct).not.toBe(0);
    // and the string comparison that broke the daily path really is false
    expect("2026-07-31" >= "2026-07-31T00:00:00.000Z").toBe(false);
  });

  it("has no percentage to report when the baseline is zero", () => {
    expect(sessionSummarize(0, 1, [{ day: "a", valueCents: 0 }, { day: "b", valueCents: 5 }]).deltaPct).toBeNull();
  });

  it("treats a missing value as zero rather than throwing", () => {
    expect(sessionSummarize(0, 1, [{ day: "a", valueCents: null }, { day: "b", valueCents: null }])).toEqual({
      day: "b",
      valueCents: 0,
      deltaCents: 0,
      deltaPct: null,
    });
  });

  it("survives an out-of-range index", () => {
    expect(sessionSummarize(0, 9, slice)).toEqual({
      day: "",
      valueCents: 0,
      deltaCents: -20_000,
      deltaPct: -100,
    });
  });
});

describe("the caption's own span", () => {
  it("carries the date when the session crosses midnight ET", () => {
    // "8:00 PM – 7:55 PM" describes a span that appears to run backwards
    const view = sessionView(
      JUL,
      [
        { at: `${JUL}T00:00:00.000Z`, valueCents: 500 },
        { at: `${JUL}T23:55:00.000Z`, valueCents: 510 },
      ],
      null,
    )!;
    expect(view.fromLabel).toBe("Jul 30 8:00 PM");
    expect(view.toLabel).toBe("Jul 31 7:55 PM");
  });

  it("stays bare on an ordinary equities session", () => {
    const view = sessionView(JUL, equitySession(4), null)!;
    expect(view.fromLabel).toBe("9:30 AM");
    expect(view.toLabel).toBe("9:45 AM");
  });
});
