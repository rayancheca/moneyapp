"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { CADENCES } from "@/db/schema/recurring";
import { isValidIsoDate } from "@/lib/dates";
import { detectRecurringSeries, setSeriesStatus } from "@/services/recurring";
import {
  recurringCalendar,
  type RecurringCalendarMonth,
} from "@/services/recurring-calendar";
import {
  renameSeries,
  searchAttachCandidates,
  setSeriesOverrides,
  type AttachCandidate,
} from "@/services/recurring-detail";
import { attachTransactions, detachTransaction, mergeSeries } from "@/services/recurring-links";
import type { UndoPatch } from "@/services/bulk-edit";
import type { ActionResult } from "@/app/transactions/action-types";

const seriesFormSchema = z.object({ seriesId: z.string().min(1) });

/** Both the /recurring surfaces revalidate together after any mutation. */
function revalidateRecurring(seriesId?: string): void {
  revalidatePath("/recurring");
  if (seriesId) revalidatePath(`/recurring/${seriesId}`);
}

export async function detectNowAction(): Promise<void> {
  detectRecurringSeries(getDb());
  revalidatePath("/recurring");
}

export async function confirmSeriesAction(formData: FormData): Promise<void> {
  const parsed = seriesFormSchema.parse({ seriesId: formData.get("seriesId") });
  setSeriesStatus(getDb(), parsed.seriesId, "confirmed");
  revalidateRecurring(parsed.seriesId);
}

export async function dismissSeriesAction(formData: FormData): Promise<void> {
  const parsed = seriesFormSchema.parse({ seriesId: formData.get("seriesId") });
  setSeriesStatus(getDb(), parsed.seriesId, "dismissed");
  revalidateRecurring(parsed.seriesId);
}

// ─── Detail-page value-returning actions (§4.2) ────────────────────────────

const statusSchema = z.object({
  seriesId: z.string().min(1),
  status: z.enum(["confirmed", "dismissed", "ended"]),
});

export async function setSeriesStatusAction(
  input: z.input<typeof statusSchema>,
): Promise<ActionResult<{ status: string }>> {
  try {
    const { seriesId, status } = statusSchema.parse(input);
    setSeriesStatus(getDb(), seriesId, status);
    revalidateRecurring(seriesId);
    return { ok: true, data: { status } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to update status" };
  }
}

const renameSchema = z.object({ seriesId: z.string().min(1), name: z.string().min(1).max(120) });

export async function renameSeriesAction(
  input: z.input<typeof renameSchema>,
): Promise<ActionResult<{ name: string }>> {
  try {
    const { seriesId, name } = renameSchema.parse(input);
    const saved = renameSeries(getDb(), seriesId, name);
    revalidateRecurring(seriesId);
    return { ok: true, data: { name: saved } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to rename" };
  }
}

const overridesSchema = z.object({
  seriesId: z.string().min(1),
  userCadence: z.enum(CADENCES).nullable().optional(),
  userAmountCents: z.number().int().nullable().optional(),
  userNextExpectedOn: z
    .string()
    // a calendar-invalid date (e.g. 2026-02-31) would persist and then throw
    // DateParseError on every projection, 500-ing the whole recurring surface
    .refine(isValidIsoDate, "Expected a valid YYYY-MM-DD date")
    .nullable()
    .optional(),
});

export async function setSeriesOverridesAction(
  input: z.input<typeof overridesSchema>,
): Promise<ActionResult<Record<string, never>>> {
  try {
    const { seriesId, ...overrides } = overridesSchema.parse(input);
    setSeriesOverrides(getDb(), seriesId, overrides);
    revalidateRecurring(seriesId);
    return { ok: true, data: {} };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to save" };
  }
}

const attachSchema = z.object({
  seriesId: z.string().min(1),
  transactionIds: z.array(z.string().min(1)).min(1),
});

export async function attachToSeriesAction(
  input: z.input<typeof attachSchema>,
): Promise<ActionResult<{ attached: number; undo: UndoPatch }>> {
  try {
    const { seriesId, transactionIds } = attachSchema.parse(input);
    const result = attachTransactions(getDb(), seriesId, transactionIds);
    revalidateRecurring(seriesId);
    return { ok: true, data: { attached: result.attached, undo: result.undo } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to attach" };
  }
}

const detachSchema = z.object({ transactionId: z.string().min(1) });

export async function detachFromSeriesAction(
  input: z.input<typeof detachSchema>,
): Promise<ActionResult<{ formerSeriesId: string | null; undo: UndoPatch }>> {
  try {
    const { transactionId } = detachSchema.parse(input);
    const result = detachTransaction(getDb(), transactionId);
    revalidateRecurring(result.formerSeriesId ?? undefined);
    return { ok: true, data: { formerSeriesId: result.formerSeriesId, undo: result.undo } };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to detach" };
  }
}

const mergeSchema = z.object({ sourceId: z.string().min(1), targetId: z.string().min(1) });

export async function mergeIntoSeriesAction(
  input: z.input<typeof mergeSchema>,
): Promise<ActionResult<{ relinked: number; targetId: string }>> {
  try {
    const { sourceId, targetId } = mergeSchema.parse(input);
    const result = mergeSeries(getDb(), sourceId, targetId);
    revalidateRecurring(targetId);
    revalidatePath(`/recurring/${sourceId}`);
    return { ok: true, data: result };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to merge" };
  }
}

const searchSchema = z.object({ seriesId: z.string().min(1), query: z.string().max(120) });

export async function searchAttachCandidatesAction(
  input: z.input<typeof searchSchema>,
): Promise<ActionResult<AttachCandidate[]>> {
  try {
    const { seriesId, query } = searchSchema.parse(input);
    return { ok: true, data: searchAttachCandidates(getDb(), seriesId, query) };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Search failed" };
  }
}

const monthSchema = z.object({ monthKey: z.string().regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM") });

export async function loadRecurringMonthAction(
  input: z.input<typeof monthSchema>,
): Promise<ActionResult<RecurringCalendarMonth>> {
  try {
    const { monthKey } = monthSchema.parse(input);
    return { ok: true, data: recurringCalendar(getDb(), monthKey) };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to load month" };
  }
}
