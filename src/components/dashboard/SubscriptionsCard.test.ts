import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type {
  OneOffLine,
  SubscriptionLine,
  SubscriptionsCard as SubscriptionsCardData,
} from "@/services/subscriptions-card";
import { SubscriptionsCard } from "./SubscriptionsCard";

/**
 * ⚖️ His decision 59 (2026-10-08): `Rent utilities & fees` ($182.21) is paid inside the rent. 🔴 Its line read "never
 * billed" on the dashboard; it reads "billed with the rent, last seen Sep 2", and a line the bank really has never
 * billed still says so.
 */
const line = (over: Partial<SubscriptionLine> & Pick<SubscriptionLine, "seriesId" | "name">): SubscriptionLine => ({
  cadence: "monthly",
  perOccurrenceCents: 10000,
  monthlyCents: 10000,
  lastMatchedOn: "2026-09-08",
  lastMatchedLabel: "Sep 8",
  daysSinceLastMatch: 30,
  daysPastTolerance: null,
  pastToleranceThroughLabel: null,
  postedCents: 10000,
  postedCount: 1,
  neverBilled: false,
  billedWithLabel: null,
  ...over,
});

const data = (
  live: SubscriptionLine[],
  lapsed: SubscriptionLine[] = [],
  oneOffs: OneOffLine[] = [],
): SubscriptionsCardData => ({
  liveMonthlyCents: live.reduce((s, l) => s + l.monthlyCents, 0),
  lapsedMonthlyCents: lapsed.reduce((s, l) => s + l.monthlyCents, 0),
  live,
  lapsed,
  oneOffs,
  lapsedSharePct: 0,
  neverBilledMonthlyCents: 10000,
  neverBilledSharePct: 10,
  largestLapsed: lapsed[0] ?? null,
  postedCents: 0,
  postedCount: 0,
  unforecastableCount: 0,
  endedCount: 0,
  months: 6,
  fromMonth: "2026-04",
  toMonth: "2026-09",
  unread: null,
  today: "2026-10-08",
});

const text = (d: SubscriptionsCardData): string =>
  renderToStaticMarkup(createElement(SubscriptionsCard, { data: d }))
    .replace(/<[^>]+>/g, "|")
    .replace(/&amp;/g, "&");

describe("SubscriptionsCard — each line's evidence, in its own voice", () => {
  test("a line paid inside the rent reads billed with the rent, last seen Sep 2 — never 'never billed'", () => {
    const t = text(
      data([
        line({
          seriesId: "u",
          name: "Rent utilities & fees",
          lastMatchedOn: "2026-09-02",
          lastMatchedLabel: "Sep 2",
          billedWithLabel: "billed with the rent, last seen Sep 2",
        }),
        line({ seriesId: "g", name: "Gym", lastMatchedOn: null, lastMatchedLabel: null, daysSinceLastMatch: null, neverBilled: true }),
        line({ seriesId: "b", name: "Breezeline" }),
      ]),
    );
    expect(t).toContain("|Rent utilities & fees||billed with the rent, last seen Sep 2|");
    expect(t).toContain("|Gym||never billed|");
    expect(t).toContain("|Breezeline||last seen Sep 8|");
    expect(t.match(/never billed/g)).toHaveLength(1);
  });

  test("a carried line whose carrier went quiet keeps the count of days past tolerance", () => {
    const t = text(
      data(
        [line({ seriesId: "b", name: "Breezeline" })],
        [
          line({
            seriesId: "u",
            name: "Rent utilities & fees",
            billedWithLabel: "billed with the rent, last seen Jun 2",
            daysPastTolerance: 33,
          }),
        ],
      ),
    );
    expect(t).toContain("billed with the rent, last seen Jun 2 · 33 days past tolerance");
  });

  /*
   * 🔴 Review of §6A 57: "last seen Apr 25 · 94 days past tolerance" — a calendar date beside a count of READ days; from
   * Apr 25 to Oct 8 a reader counts 118. The count names the day it ran to when that is short of today, and nothing
   * when it runs to today, where it agrees with the date beside it.
   */
  test("a lapsed line's days past tolerance say which days they counted when that stops short of today", () => {
    const t = text(
      data(
        [line({ seriesId: "b", name: "Breezeline" })],
        [
          // Apr 25 → Sep 13 is 141 days, less the 48-day tolerance (`pastToleranceOf`, services/subscriptions-card)
          line({ seriesId: "d", name: "Dead streaming", lastMatchedLabel: "Apr 25", daysPastTolerance: 93, pastToleranceThroughLabel: "Sep 13" }),
          line({ seriesId: "o", name: "Old landlord", lastMatchedLabel: "Jan 8", daysPastTolerance: 225 }),
        ],
      ),
    );
    expect(t).toContain("|Dead streaming||last seen Apr 25 · 93 days past tolerance, checked through Sep 13|");
    expect(t).toContain("|Old landlord||last seen Jan 8 · 225 days past tolerance|");
  });

  /*
   * 🔴 Review of f117d68: the line learned to name its checked day and the card's lead sentence, over the same count,
   * did not — "The largest is Dead streaming, last seen Apr 25, 93 days past its own tolerance." reads as 118 to
   * anyone counting from Apr 25 to Oct 8. One count, one clause, both places.
   */
  test("the lead sentence's largest lapsed line names the day its count ran to, as its row does", () => {
    const dead = line({ seriesId: "d", name: "Dead streaming", lastMatchedLabel: "Apr 25", daysPastTolerance: 93, pastToleranceThroughLabel: "Sep 13" });
    const t = text(data([line({ seriesId: "b", name: "Breezeline" })], [dead])).replace(/\|/g, "");
    expect(t).toContain("The largest is Dead streaming, last seen Apr 25, 93 days past its own tolerance, checked through Sep 13.");
    const toToday = text(data([line({ seriesId: "b", name: "Breezeline" })], [{ ...dead, pastToleranceThroughLabel: null }]));
    expect(toToday.replace(/\|/g, "")).toContain("last seen Apr 25, 93 days past its own tolerance.");
  });

  /*
   * §6A 56 composed with §6A 59: a one-charge row billed inside another's payment reads its one day AND its carrier —
   * "once · Nov 11 · billed with the rent, last seen Sep 2" — never a bare "last seen" (the carrier's day, unexplained)
   * nor "never billed"; a one-off billed on its own still reads "never billed".
   */
  test("a one-off paid inside the rent says once and billed with the rent; one billed on its own, never billed", () => {
    const oneOff = (over: Partial<OneOffLine> & Pick<OneOffLine, "seriesId" | "name">): OneOffLine => ({
      on: "2026-11-11",
      cadenceLabel: "once · Nov 11",
      cents: 7274,
      neverBilled: true,
      lastMatchedLabel: null,
      billedWithLabel: null,
      ...over,
    });
    const t = text(
      data(
        [line({ seriesId: "b", name: "Breezeline" })],
        [],
        [
          oneOff({
            seriesId: "u",
            name: "Move-out fee",
            neverBilled: false,
            lastMatchedLabel: "Sep 2",
            billedWithLabel: "billed with the rent, last seen Sep 2",
          }),
          oneOff({ seriesId: "c", name: "Car insurance balance" }),
        ],
      ),
    );
    expect(t).toContain("|Move-out fee||once · Nov 11 · billed with the rent, last seen Sep 2|");
    expect(t).toContain("|Car insurance balance||once · Nov 11 · never billed|");
    expect(t).not.toContain("once · Nov 11 · last seen Sep 2");
  });
});
