import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { resolveViewState } from "@/lib/view-state";
import { seedHisCarSeries, type OneChargeLedger } from "@/services/one-charge-fixture";
import { seedHisRent, type RentLedger } from "@/services/rent-fixture";
import { seriesDetail } from "@/services/recurring-detail";
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
