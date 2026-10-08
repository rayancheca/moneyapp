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
