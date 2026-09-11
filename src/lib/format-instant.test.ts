import { describe, expect, test } from "vitest";
import { formatInstantLong, formatIsoInstantLong } from "./format-instant";

/**
 * ⛔ The suite pins TZ=Pacific/Kiritimati (UTC+14, no DST) precisely so a
 * host-local rendering cannot accidentally agree with UTC. Every expectation
 * here is therefore the Kiritimati reading of the instant, and that IS the
 * assertion: a formatter that ignored the zone would print the UTC one.
 */
describe("formatInstantLong", () => {
  test("renders a stored UTC instant on the host's clock, not in UTC", () => {
    const at = Date.parse("2026-08-18T16:06:31.777Z");
    // UTC+14 → 2026-08-19 06:06 local. The old code sliced the string and
    // printed "2026-08-18 16:06" — the UTC reading, with no zone said.
    expect(formatInstantLong(at)).toBe("Wed, Aug 19, 2026 at 06:06");
    expect(formatInstantLong(at)).not.toContain("16:06");
  });

  test("crossing midnight moves the DAY, not just the time", () => {
    // the trap intraday-axis documents: an instant's day is zone-dependent
    expect(formatInstantLong(Date.parse("2026-07-31T00:00:00Z"))).toBe("Fri, Jul 31, 2026 at 14:00");
    expect(formatInstantLong(Date.parse("2026-07-30T11:00:00Z"))).toBe("Fri, Jul 31, 2026 at 01:00");
  });

  test("pads both halves of the clock", () => {
    expect(formatInstantLong(Date.parse("2026-01-01T09:05:00Z"))).toBe("Thu, Jan 1, 2026 at 23:05");
  });

  test("no instant is not a time", () => {
    expect(formatInstantLong(null)).toBe("time unknown");
    expect(formatInstantLong(Number.NaN)).toBe("time unknown");
    expect(formatInstantLong(null, "never run")).toBe("never run");
  });
});

describe("formatIsoInstantLong", () => {
  test("parses the stored ISO string", () => {
    expect(formatIsoInstantLong("2026-08-18T16:06:31.777Z")).toBe("Wed, Aug 19, 2026 at 06:06");
  });

  test("a missing or malformed instant never renders 'Invalid Date'", () => {
    expect(formatIsoInstantLong(null)).toBe("time unknown");
    expect(formatIsoInstantLong(undefined)).toBe("time unknown");
    expect(formatIsoInstantLong("not a time")).toBe("time unknown");
    expect(formatIsoInstantLong("", "never run")).toBe("never run");
  });
});
