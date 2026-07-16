"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { DASHBOARD_SECTION_IDS, readSettings, writeSetting } from "@/services/settings";
import { normalizeOrder } from "@/lib/reorder";

const formSchema = z.object({
  aiMonthlyCapUsd: z.coerce.number().min(0).max(1_000),
  priceStalenessHours: z.coerce.number().int().min(1).max(168),
  reviewCreditThresholdCents: z.coerce.number().int().min(0),
  categorizationConfidenceMin: z.coerce.number().min(0).max(1),
});

export async function updateSettingsAction(formData: FormData): Promise<void> {
  const parsed = formSchema.parse({
    aiMonthlyCapUsd: formData.get("aiMonthlyCapUsd"),
    priceStalenessHours: formData.get("priceStalenessHours"),
    reviewCreditThresholdCents: Math.round(Number(formData.get("reviewCreditThresholdUsd")) * 100),
    categorizationConfidenceMin: formData.get("categorizationConfidenceMin"),
  });
  const db = getDb();
  writeSetting(db, "aiMonthlyCapUsd", parsed.aiMonthlyCapUsd);
  writeSetting(db, "priceStalenessHours", parsed.priceStalenessHours);
  writeSetting(db, "reviewCreditThresholdCents", parsed.reviewCreditThresholdCents);
  writeSetting(db, "categorizationConfidenceMin", parsed.categorizationConfidenceMin);
  revalidatePath("/settings");
}

const dashboardLayoutSchema = z
  .array(z.enum(DASHBOARD_SECTION_IDS))
  .min(1)
  .max(DASHBOARD_SECTION_IDS.length)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate sections");

/** Persist the dashboard section order (S7 "movable") — value-returning. */
export async function saveDashboardLayoutAction(
  order: readonly string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = dashboardLayoutSchema.safeParse(order);
  if (!parsed.success) return { ok: false, error: "Invalid section order" };
  try {
    writeSetting(getDb(), "dashboardLayout", normalizeOrder(parsed.data, DASHBOARD_SECTION_IDS) as typeof parsed.data);
    revalidatePath("/");
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save the layout" };
  }
}

const viewPreferenceSchema = z.object({
  surface: z.string().min(1).max(64),
  // bound the shape so a stray caller can't bloat app_settings; resolveViewState
  // drops anything not in the current spec at read time anyway.
  state: z.record(z.string().min(1).max(64), z.string().max(64)),
});

/**
 * Persist a surface's chosen view (NS#2 Pillar 2) so it's sticky on a fresh visit.
 * Value-returning; merges into the viewPreferences map. Deliberately does NOT
 * revalidate — the client already navigated via router.push, so the URL (which
 * outranks this) drives the current render; this only seeds the next cold load.
 */
export async function saveViewPreferenceAction(
  surface: string,
  state: Record<string, string>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = viewPreferenceSchema.safeParse({ surface, state });
  if (!parsed.success) return { ok: false, error: "Invalid view preference" };
  try {
    const db = getDb();
    const current = readSettings(db).viewPreferences;
    writeSetting(db, "viewPreferences", { ...current, [parsed.data.surface]: parsed.data.state });
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save the view" };
  }
}
