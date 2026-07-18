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
  // drops anything not in the current spec at read time anyway. Values allow a
  // generous length: the dashboard's `accts` selection is comma-joined account
  // UUIDs (37 chars each) and must survive persistence even with dozens of
  // accounts (2026-07-18 review: a 512 cap silently dropped it past 13).
  state: z.record(z.string().min(1).max(64), z.string().max(4096)),
});

/**
 * Persist a surface's chosen view (NS#2 Pillar 2) so it's sticky on a fresh visit.
 * MERGES at the surface level: a caller that writes only spec dimensions ({chart})
 * must not clobber a sibling key another caller persisted ({accts}) — the two
 * cooperate for the dashboard's mode + account-selection (2026-07-18 review: a
 * replace-whole-record wiped `accts` on the first mode switch). Stale spec dims
 * are dropped by resolveViewState at read; stale `accts` is revalidated against
 * live accounts, so an over-broad merge is always safe. Deliberately does NOT
 * revalidate — the URL (which outranks this) drives the current render; this
 * only seeds the next cold load.
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
    const merged = { ...(current[parsed.data.surface] ?? {}), ...parsed.data.state };
    writeSetting(db, "viewPreferences", { ...current, [parsed.data.surface]: merged });
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save the view" };
  }
}
