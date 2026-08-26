import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { seriesDetail } from "@/services/recurring-detail";
import { readSettings } from "@/services/settings";
import { resolveViewState } from "@/lib/view-state";
import {
  RECURRING_SERIES_SURFACE,
  RECURRING_SERIES_VIEW_SPEC,
} from "@/components/recurring/recurring-view-spec";
import { provenanceFor } from "@/services/provenance";
import { SeriesDetail } from "@/components/recurring/SeriesDetail";

export const metadata: Metadata = { title: "Recurring series" };
export const dynamic = "force-dynamic";

/**
 * Series detail (ux-overhaul-plan §4.2). Every series-row name across the
 * Recurring tab links here; the client component hosts the editable cadence
 * sentence, the attach/merge/detach flows, and confirm/dismiss/end — all
 * value-returning server actions that refresh this page.
 */
export default async function RecurringSeriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const db = getDb();
  const data = (() => {
    try {
      return seriesDetail(db, id, todayIso());
    } catch {
      notFound();
    }
  })();

  // switchable-view state (NS#2 Pillar 2): URL > persisted preference > default
  const viewState = resolveViewState(
    RECURRING_SERIES_VIEW_SPEC,
    { lens: Array.isArray(raw.lens) ? raw.lens[0] : raw.lens },
    readSettings(db).viewPreferences[RECURRING_SERIES_SURFACE],
  );

  // a forecast is graded by its EVIDENCE — how many postings, and whether they
  // agreed — which is a different question from every other figure on the page
  const provenance = provenanceFor(getDb(), { kind: "recurringSeries", id });

  return (
    <SeriesDetail data={data} provenance={provenance} viewState={viewState} basePath={`/recurring/${id}`} />
  );
}
