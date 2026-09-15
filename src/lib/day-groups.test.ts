import { describe, expect, test } from "vitest";
import { groupFirstPageByDay } from "./day-groups";

const row = (postedOn: string, amountCents: number) => ({ postedOn, amountCents });

/**
 * 🔴 `/design/stage-0a` fetched `.limit(14)` rows and grouped them with its own
 * copy of `groupByDay`, which had no boundary argument. Measured on the owner's
 * ledger 2026-09-15: rows 13–14 are the only 2026-08-25 rows on the page and
 * sum +99,938¢, so the header read "+$999.38". Row 15 is also 2026-08-25, and
 * the whole day — 5 active checking rows — nets −51,952¢. The subtotal had the
 * wrong sign as well as the wrong amount, with no "partial" beside it.
 *
 * A preview that shows the first N rows is page 1 of a ledger paged by N, so it
 * takes the ledger's own rule — `pageBoundary` — by fetching one row past the
 * limit, which is the only way to know whether the cut lands inside a day.
 */
describe("groupFirstPageByDay", () => {
  const twelveEarlier = Array.from({ length: 12 }, (_, i) => row("2026-08-27", -(i + 1) * 100));

  test("a day the limit cuts is flagged partial, and only the shown rows are summed", () => {
    const fetched = [...twelveEarlier, row("2026-08-25", 99_000), row("2026-08-25", 938), row("2026-08-25", -151_890)];
    const groups = groupFirstPageByDay(fetched, 14);

    expect(groups.flatMap((g) => g.rows)).toHaveLength(14);
    expect(groups.at(-1)).toMatchObject({ day: "2026-08-25", netCents: 99_938, partial: true });
    expect(groups[0]!.partial).toBe(false);
  });

  test("a limit that lands on a day change cuts nothing", () => {
    const fetched = [...twelveEarlier, row("2026-08-25", 99_000), row("2026-08-25", 938), row("2026-08-24", -151_890)];
    const groups = groupFirstPageByDay(fetched, 14);

    expect(groups.at(-1)).toMatchObject({ day: "2026-08-25", netCents: 99_938, partial: false });
  });

  test("when nothing follows the rows, nothing is cut", () => {
    const groups = groupFirstPageByDay([row("2026-08-25", 500), row("2026-08-25", -200)], 14);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ netCents: 300, partial: false });
  });

  test("nothing before the first page is ever hidden", () => {
    const fetched = [row("2026-08-25", 1), row("2026-08-25", 2), row("2026-08-25", 3)];

    expect(groupFirstPageByDay(fetched, 2)[0]).toMatchObject({ netCents: 3, partial: true });
    expect(groupFirstPageByDay([], 14)).toEqual([]);
  });
});
