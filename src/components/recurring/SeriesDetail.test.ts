import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { recurringSeries, SERIES_STATUSES } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { formatCents } from "@/lib/money";
import { resolveViewState } from "@/lib/view-state";
import { seedHisCarSeries, type OneChargeLedger } from "@/services/one-charge-fixture";
import { seedHisRent, type RentLedger } from "@/services/rent-fixture";
import { seriesDetail } from "@/services/recurring-detail";
import { seriesEndInput, seriesEndLines, seriesEndReassurance } from "./end-radius";
import { RECURRING_SERIES_VIEW_SPEC } from "./recurring-view-spec";

// rendering never navigates or submits; the page and its controls only need these to exist
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/recurring/s",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/recurring/actions", () => ({
  renameSeriesAction: vi.fn(),
  setSeriesStatusAction: vi.fn(),
  setSeriesOverridesAction: vi.fn(),
  attachToSeriesAction: vi.fn(),
  detachFromSeriesAction: vi.fn(),
  mergeIntoSeriesAction: vi.fn(),
  searchAttachCandidatesAction: vi.fn(),
}));
vi.mock("@/app/settings/actions", () => ({ saveViewPreferenceAction: vi.fn() }));

const { SeriesDetail } = await import("./SeriesDetail");

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 56): the one-time Nov 11 car-insurance balance's own page reads "charges once on
 * Nov 11" over a CADENCE stat of "Once"; Car insurance's, a monthly bill in its last months, keeps "Monthly". 🔴 The
 * balance's page read "Cadence Monthly" on a copy of his ledger that morning; and review of 3044ea6 put the stat back
 * on the stored cadence with every component test still green — `CadenceSentence`'s own tests hand it its `oneCharge`,
 * so nothing asked whether this page passes one. From his two series as stored, through `seriesDetail`, as the page
 * builds it.
 */
describe("SeriesDetail — a schedule of one charge reads once, on its own page", () => {
  const TODAY = "2026-10-08";
  let dir: string;
  let bundle: DbBundle;
  let his: OneChargeLedger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-series-detail-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    his = seedHisCarSeries(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function page(seriesId: string): string {
    const html = renderToStaticMarkup(
      createElement(SeriesDetail, {
        data: seriesDetail(bundle.db, seriesId, TODAY)!,
        today: TODAY,
        viewState: resolveViewState(RECURRING_SERIES_VIEW_SPEC, {}, undefined),
        basePath: `/recurring/${seriesId}`,
      }),
    );
    return decode(html);
  }

  const statOf = (html: string, label: string): string | undefined =>
    new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>([^<]*)</dd>`).exec(html)?.[1];
  const words = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

  test("the balance: a Cadence stat of Once, under 'charges once on Nov 11'", () => {
    const html = page(his.balanceId);
    expect(statOf(html, "Cadence")).toBe("Once");
    expect(words(html)).toContain("charges once on Nov 11, about $72.74");
    expect(words(html)).not.toContain("charges monthly");
  });

  test("Car insurance, two charges left: Monthly, and a monthly sentence", () => {
    const html = page(his.insuranceId);
    expect(statOf(html, "Cadence")).toBe("Monthly");
    expect(words(html)).toContain("charges monthly");
    expect(words(html)).not.toContain("once");
  });

  /*
   * 🔴 Review of 0af5689, on a copy of his ledger (2026-10-12) asked about 2026-12-12: "Confirmed · Bill · Never billed
   * · Ends Nov 11, 2026 … charges once on Nov 11, about $72.74. Annualized —" — a present-tense schedule a month past,
   * and no "Nothing expected" card, while the subscriptions card counted it ended.
   */
  const pageOn = (seriesId: string, today: string): string =>
    decode(
      renderToStaticMarkup(
        createElement(SeriesDetail, {
          data: seriesDetail(bundle.db, seriesId, today)!,
          today,
          viewState: resolveViewState(RECURRING_SERIES_VIEW_SPEC, {}, undefined),
          basePath: `/recurring/${seriesId}`,
        }),
      ),
    );

  /*
   * 🔴 Review of 49cc98f: a schedule its end had closed read in the past tense of a posting — "charged once on Nov 11,
   * about $72.74" over "Linked transactions · 0", of a balance the bank has never charged, and its "Never billed" badge
   * was gone (a copy of his ledger, 2026-10-12, asked about 2026-11-12). The tense says the schedule is over; what it
   * did is the evidence's to say — nothing, so it was expected, and it is never billed.
   */
  test.each(["2026-11-12", "2026-12-12"])(
    "%s, past its one day: 'was expected', never 'charged' — Never billed beside Ended, and no charges 'below'",
    (today) => {
      const html = pageOn(his.balanceId, today);
      const text = words(html);
      expect(text).toContain("was expected once on Nov 11, about $72.74");
      expect(text).not.toContain("charged once");
      expect(text).not.toContain("charges once");
      expect(text).toContain("Nothing expected");
      expect(text).toContain("Its schedule has ended");
      // nothing is linked, so nothing "below" stays anywhere
      expect(text).toContain("No linked transactions yet");
      expect(text).not.toContain("below stay in the ledger");
      // both facts: never billed, quiet as everywhere (`seriesEvidenceTone`), and its end in the past tense
      expect(html).toMatch(/text-ink-muted[^>]*>Never billed</);
      expect(text).toContain("Ended Nov 11, 2026");
      expect(text).not.toContain("Ends Nov 11, 2026");
      expect(html).not.toMatch(/text-warning[^>]*>Ended Nov 11/);
    },
  );

  /* …while a schedule that ended after it HAD charged says so: Car insurance, its last premium Jan 11, 2027 */
  test("Car insurance from Jan 12, 2027: 'charged monthly', no Never billed, and its charges below stay", () => {
    const text = words(pageOn(his.insuranceId, "2027-01-12"));
    expect(text).toContain("charged monthly, about $357.58");
    expect(text).not.toContain("was expected");
    expect(text).not.toContain("Never billed");
    expect(text).toContain("Ended Jan 11, 2027");
    expect(text).toContain("Its charges below stay in the ledger.");
  });
});

/*
 * The rent's Per charge names what each PAYMENT paid — Jun 16's two card rows one payment — and that its payments
 * carry the utilities (§6A 59). 🔴 His page read "posted avg -$1,849.76 ± $583.58" under "-$2,109.00", though every
 * month he paid more (a copy of his ledger, 2026-10-12). From his rent as stored (`seedHisRent`), through
 * `seriesDetail`.
 */
describe("SeriesDetail — the rent's posted avg is per payment, and names what its payments carry", () => {
  const TODAY = "2026-10-12";
  let dir: string;
  let bundle: DbBundle;
  let rent: RentLedger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-series-detail-rent-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    rent = seedHisRent(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** the Per charge stat, its words only */
  const perChargeOf = (seriesId: string): string => {
    const html = decode(
      renderToStaticMarkup(
        createElement(SeriesDetail, {
          data: seriesDetail(bundle.db, seriesId, TODAY)!,
          today: TODAY,
          viewState: resolveViewState(RECURRING_SERIES_VIEW_SPEC, {}, undefined),
          basePath: `/recurring/${seriesId}`,
        }),
      ),
    );
    const at = html.indexOf(">Per charge<");
    const stat = html.slice(at, html.indexOf("</dd>", at));
    return stat.replace(/<[^>]+>/g, "").replace(/^>Per charge/, "");
  };

  test("the rent: posted avg -$2,312.20 ± $85.27 · its payments carry Rent utilities & fees too", () => {
    expect(perChargeOf(rent.rentId)).toContain(
      "-$2,109.00posted avg -$2,312.20 ± $85.27 · its payments carry Rent utilities & fees too",
    );
  });

  test("the utilities print no average, and carry nothing", () => {
    const stat = perChargeOf(rent.utilitiesId);
    expect(stat).toContain("-$182.21");
    expect(stat).not.toContain("posted avg");
    expect(stat).not.toContain("carry");
  });

  /*
   * ⛔ The Amount history counts what the Per charge above it averages: a payment per bar, Jun 16's two card rows one.
   * 🔴 Row by row, his page (table lens) read "Charge amount for each of the 5 posted occurrences … Jun 16, 2026
   * -$1,100.00 -$1,009.00 · Jun 16, 2026 -$1,334.80 -$774.20" under "posted avg -$2,312.20 ± $85.27" — 5 occurrences
   * and 4 on one page, and a payment $325.80 OVER the $2,109.00 read as two under it (review of af5b0fa, 2026-10-12).
   */
  test("the Amount history: four payments, Jun 16's one bar of -$2,434.80, $325.80 over", () => {
    const html = decode(
      renderToStaticMarkup(
        createElement(SeriesDetail, {
          data: seriesDetail(bundle.db, rent.rentId, TODAY)!,
          today: TODAY,
          viewState: resolveViewState(RECURRING_SERIES_VIEW_SPEC, { lens: "table" }, undefined),
          basePath: `/recurring/${rent.rentId}`,
        }),
      ),
    );
    const at = html.indexOf("Charge amount for each of");
    const table = html.slice(at, html.indexOf("</table>", at)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(table).toContain("Charge amount for each of the 4 posted occurrences, newest first, against the expected");
    expect(table).toContain("Jun 16, 2026 -$2,434.80 one payment, posted as 2 +$325.80");
    expect(table).not.toContain("-$1,100.00");
    expect(table).not.toContain("-$1,334.80");
    expect(table).toContain("Sep 2, 2026 -$2,291.21 +$182.21");
  });
});

/*
 * The merge preview (§6A 54 — each candidate and what merging it would file) is read only for a page that renders the
 * merge control: a live series, the one predicate the page and `seriesDetail` both ask (`seriesCanBeReshaped`).
 * 🔴 Every series page computed it, the ended and dismissed pages included, where the control is hidden (review of
 * §6A 54, 2026-10-08) — a reading of every live series' unfiled rows that nothing on the page shows.
 */
describe("SeriesDetail — the merge preview is read only where the merge control renders", () => {
  const TODAY = "2026-10-08";
  let dir: string;
  let bundle: DbBundle;
  let his: OneChargeLedger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-series-merge-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    his = seedHisCarSeries(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each(SERIES_STATUSES)("Car insurance %s: candidates exactly where the control renders", (status) => {
    bundle.db.update(recurringSeries).set({ status }).where(eq(recurringSeries.id, his.insuranceId)).run();
    const data = seriesDetail(bundle.db, his.insuranceId, TODAY);
    const html = renderToStaticMarkup(
      createElement(SeriesDetail, {
        data,
        today: TODAY,
        viewState: resolveViewState(RECURRING_SERIES_VIEW_SPEC, {}, undefined),
        basePath: `/recurring/${his.insuranceId}`,
      }),
    );
    const live = status === "detected" || status === "confirmed";
    // live, its candidate is the Nov 11 balance; ended or dismissed, nothing is read and nothing renders
    expect(data.mergeCandidates.map((c) => c.id)).toEqual(live ? [his.balanceId] : []);
    expect(html.includes("Merge another series in")).toBe(live);
  });
});

/*
 * 🔴 "Nothing expected" said "Its charges below stay in the ledger" of every kind — of his ended pay's deposits too
 * (Knack Tutoring, Fordham Payroll; his ledger copy 2026-10-12). ⛔ The page hands the reason the series' own kind
 * (`noScheduleReason`), not a bill's by default.
 */
describe("SeriesDetail — the Nothing expected card names what the series posted", () => {
  const TODAY = "2026-10-08";
  let dir: string;
  let bundle: DbBundle;
  let his: OneChargeLedger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-series-kind-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    his = seedHisCarSeries(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    ["income", "Its deposits below stay in the ledger."],
    ["transfer", "Its transfers below stay in the ledger."],
    ["bill", "Its charges below stay in the ledger."],
  ] as const)("an ended %s series: %s", (kind, kept) => {
    const insurance = eq(recurringSeries.id, his.insuranceId);
    bundle.db.update(recurringSeries).set({ status: "ended", kind }).where(insurance).run();
    const html = decode(
      renderToStaticMarkup(
        createElement(SeriesDetail, {
          data: seriesDetail(bundle.db, his.insuranceId, TODAY),
          today: TODAY,
          viewState: resolveViewState(RECURRING_SERIES_VIEW_SPEC, {}, undefined),
          basePath: `/recurring/${his.insuranceId}`,
        }),
      ),
    );
    expect(html).toContain(`This series has ended, so nothing more is expected from it. ${kept}`);
  });
});

/*
 * 🔴 Review of 49cc98f — item (4)'s sweep stopped at the All tab. On a copy of his ledger (2026-10-12) asked about
 * 2026-11-12, `/recurring/<Fordham Payroll>` (income, ended) read "Nothing expected · This series has ended, so nothing
 * more is expected from it. Its charges below stay in the ledger." above 56 "DIRECT DEPOSIT FORDHAM UNIVERSI PAYROLL"
 * rows. A pay is deposited, not charged — on the page that lists its deposits, as on the All tab. Through
 * `seriesDetail`, as the page builds it, so the test asks whether the page hands the sentence its kind.
 */
describe("SeriesDetail — his ended payroll's page keeps its deposits, not its charges", () => {
  const TODAY = "2026-11-12";
  let dir: string;
  let bundle: DbBundle;
  let payId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-series-detail-pay-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    const his = seedHisCarSeries(bundle.db);
    payId = bundle.db
      .insert(recurringSeries)
      .values({
        name: "Fordham Payroll",
        kind: "income",
        cadence: "biweekly",
        intervalDaysAvg: 14,
        nextExpectedOn: "2025-06-06",
        nextExpectedAmountCents: 76_200,
        status: "ended",
        lastMatchedOn: "2025-05-23",
      })
      .returning({ id: recurringSeries.id })
      .get().id;
    ["2025-05-09", "2025-05-23"].forEach((postedOn, i) => {
      const raw = "DIRECT DEPOSIT FORDHAM UNIVERSI PAYROLL";
      bundle.db
        .insert(transactions)
        .values({
          accountId: his.checkingId,
          postedOn,
          amountCents: 76_200,
          rawDescription: raw,
          normalizedDescription: raw,
          recurringSeriesId: payId,
          dedupeHash: dedupeHash({ accountId: his.checkingId, postedOn, amountCents: 76_200, rawDescription: raw, occurrenceIndex: i }),
        })
        .run();
    });
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const pageWords = (): string =>
    decode(
      renderToStaticMarkup(
        createElement(SeriesDetail, {
          data: seriesDetail(bundle.db, payId, TODAY)!,
          today: TODAY,
          viewState: resolveViewState(RECURRING_SERIES_VIEW_SPEC, {}, undefined),
          basePath: `/recurring/${payId}`,
        }),
      ),
    )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");

  test("Nothing expected: its deposits below stay in the ledger", () => {
    const text = pageWords();
    expect(text).toContain("Nothing expected");
    expect(text).toContain("This series has ended, so nothing more is expected from it. Its deposits below stay in the ledger.");
    expect(text).not.toContain("Its charges");
  });

  /* 🔴 …and the same page's stat read "Per charge +$762.00" — his live pay's "Per charge +$1,141.92" (the copy, 11-12) */
  test("its amount is per deposit, and nothing on the page calls a deposit a charge", () => {
    const text = pageWords();
    expect(text).toContain("Per deposit");
    expect(text).not.toMatch(/charge/i);
  });

  // the End dialog renders only once opened, so its words are asked of the input the page builds them from
  test("its End dialog loses and keeps deposits — from the page's own data", () => {
    const input = seriesEndInput(seriesDetail(bundle.db, payId, TODAY));
    const said = [...seriesEndLines(input, formatCents).map((l) => `${l.label}: ${l.value}`), seriesEndReassurance(input.kind)];
    expect(said).toContain("Upcoming deposits off the calendar: none scheduled");
    expect(said).toContain(
      "Nothing is deleted — the deposits stay in your ledger, and Confirm brings the series back if it starts again.",
    );
    expect(said.join(" · ")).not.toMatch(/charge/i);
  });

  test("merged into his current pay, its deposits live there now", () => {
    const into = bundle.db
      .insert(recurringSeries)
      .values({ name: "It America LLC (weekly pay)", kind: "income", cadence: "weekly", status: "confirmed" })
      .returning({ id: recurringSeries.id })
      .get().id;
    bundle.db.update(recurringSeries).set({ mergedIntoId: into }).where(eq(recurringSeries.id, payId)).run();
    const text = pageWords();
    expect(text).toContain("This series was merged into It America LLC (weekly pay) . Its deposits live there now.");
    expect(text).not.toMatch(/charge/i);
  });
});
