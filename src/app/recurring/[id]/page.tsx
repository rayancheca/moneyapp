import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { seriesDetail } from "@/services/recurring-detail";
import { SeriesDetail } from "@/components/recurring/SeriesDetail";

export const metadata: Metadata = { title: "Recurring series" };
export const dynamic = "force-dynamic";

/**
 * Series detail (ux-overhaul-plan §4.2). Every series-row name across the
 * Recurring tab links here; the client component hosts the editable cadence
 * sentence, the attach/merge/detach flows, and confirm/dismiss/end — all
 * value-returning server actions that refresh this page.
 */
export default async function RecurringSeriesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const data = (() => {
    try {
      return seriesDetail(db, id, todayIso());
    } catch {
      notFound();
    }
  })();

  return <SeriesDetail data={data} />;
}
