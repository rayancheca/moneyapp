"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { CADENCES } from "@/db/schema/recurring";
import { isValidIsoDate } from "@/lib/dates";
import {
  detectRecurringSeries,
  setSeriesStatus,
  type DetectionSummary,
} from "@/services/recurring";
import {
  recurringCalendar,
  type RecurringCalendarMonth,
} from "@/services/recurring-calendar";
import { forecastForMonth, type MonthForecast } from "@/services/forecast";
import {
  renameSeries,
  searchAttachCandidates,
  setSeriesOverrides,
  type AttachCandidate,
} from "@/services/recurring-detail";
import {
  attachTransactions,
  createSeriesFromTransaction,
  detachTransaction,
  mergeSeries,
  undoSeriesCreation,
  type CreateSeriesResult,
  type MergeResult,
} from "@/services/recurring-links";
import type { UndoPatch } from "@/services/bulk-edit";
import {
  actionErrorMessage,
  firstIssueMessage,
  type ActionResult,
} from "@/app/transactions/action-types";

// the single-argument form reports the SAME message when the hidden input is
// missing entirely, instead of zod's "expected string, received undefined"
const seriesFormSchema = z.object({
  seriesId: z.string("Pick a series").min(1, "Pick a series"),
});

/** Both the /recurring surfaces revalidate together after any mutation. */
function revalidateRecurring(seriesId?: string): void {
  revalidatePath("/recurring");
  if (seriesId) revalidatePath(`/recurring/${seriesId}`);
}

const SERIES_LABELS = {
  seriesId: "Series",
  sourceId: "Series",
  targetId: "Series",
  transactionId: "Transaction",
  transactionIds: "Transactions",
  name: "Name",
  status: "Status",
  userCadence: "Cadence",
  userAmountCents: "Amount",
  userNextExpectedOn: "Next expected",
  monthKey: "Month",
  query: "Search",
} as const;

/**
 * Every catch below can receive a ZodError from the schemas in this file, whose
 * own `.message` is a JSON dump of the issue array — actionErrorMessage unwraps
 * it to the single field message the schema declared.
 */
function failure(error: unknown, fallback: string): { ok: false; error: string } {
  return { ok: false, error: actionErrorMessage(error, SERIES_LABELS, fallback) };
}

/**
 * The three `<form action>` bindings on /recurring keep their `Promise<void>`
 * signature byte-identical — React types the prop as
 * `(formData) => void | Promise<void>`, so a result cannot be returned from one
 * without breaking its call site. Each delegates to a validating
 * `*ResultAction` twin and routes a failure to `?error=` (the /budgets pattern)
 * instead of letting a throwing `.parse()` become an error digest.
 */
export async function detectNowResultAction(): Promise<ActionResult<DetectionSummary>> {
  try {
    const summary = detectRecurringSeries(getDb());
    revalidatePath("/recurring");
    return { ok: true, data: summary };
  } catch (error: unknown) {
    return failure(error, "Detection failed");
  }
}

export async function detectNowAction(): Promise<void> {
  const result = await detectNowResultAction();
  if (result.ok) return;
  // redirect() throws NEXT_REDIRECT by design — it must stay outside any catch
  redirect(`/recurring?error=${encodeURIComponent(result.error)}`);
}

/** Shared core of confirm/dismiss — the only difference is the target status. */
async function setStatusFromForm(
  formData: FormData,
  status: "confirmed" | "dismissed",
): Promise<ActionResult<{ seriesId: string; status: string }>> {
  const parsed = seriesFormSchema.safeParse({ seriesId: formData.get("seriesId") });
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, SERIES_LABELS) };
  }
  try {
    setSeriesStatus(getDb(), parsed.data.seriesId, status);
  } catch (error: unknown) {
    return failure(error, "Failed to update status");
  }
  revalidateRecurring(parsed.data.seriesId);
  return { ok: true, data: { seriesId: parsed.data.seriesId, status } };
}

export async function confirmSeriesResultAction(
  formData: FormData,
): Promise<ActionResult<{ seriesId: string; status: string }>> {
  return setStatusFromForm(formData, "confirmed");
}

export async function confirmSeriesAction(formData: FormData): Promise<void> {
  const result = await confirmSeriesResultAction(formData);
  if (result.ok) return;
  redirect(`/recurring?error=${encodeURIComponent(result.error)}`);
}

export async function dismissSeriesResultAction(
  formData: FormData,
): Promise<ActionResult<{ seriesId: string; status: string }>> {
  return setStatusFromForm(formData, "dismissed");
}

export async function dismissSeriesAction(formData: FormData): Promise<void> {
  const result = await dismissSeriesResultAction(formData);
  if (result.ok) return;
  redirect(`/recurring?error=${encodeURIComponent(result.error)}`);
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
    return failure(error, "Failed to update status");
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
    return failure(error, "Failed to rename");
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
    return failure(error, "Failed to save");
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
    // attaching may file an unfiled row under the series' category (§6A 47)
    revalidatePath("/transactions");
    return { ok: true, data: { attached: result.attached, undo: result.undo } };
  } catch (error: unknown) {
    return failure(error, "Failed to attach");
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
    return failure(error, "Failed to detach");
  }
}

const createFromTxnSchema = z.object({ transactionId: z.string().min(1) });

/** The "Make recurring" button: promote a transaction into a confirmed series. */
export async function createSeriesFromTxnAction(
  input: z.input<typeof createFromTxnSchema>,
): Promise<ActionResult<CreateSeriesResult>> {
  try {
    const { transactionId } = createFromTxnSchema.parse(input);
    const result = createSeriesFromTransaction(getDb(), transactionId);
    revalidateRecurring(result.seriesId);
    revalidatePath("/transactions");
    return { ok: true, data: result };
  } catch (error: unknown) {
    return failure(error, "Failed to make recurring");
  }
}

const undoCreateSchema = z.object({ seriesId: z.string().min(1), undo: z.unknown() });

/** Inverse of createSeriesFromTxnAction's "created" mode: restore links + delete. */
export async function undoCreateSeriesAction(
  input: z.input<typeof undoCreateSchema>,
): Promise<ActionResult<{ unlinked: number }>> {
  try {
    const { seriesId, undo } = undoCreateSchema.parse(input);
    // the patch itself is schema-validated inside applyUndoPatch
    const result = undoSeriesCreation(getDb(), seriesId, undo as UndoPatch);
    revalidateRecurring();
    revalidatePath("/transactions");
    return { ok: true, data: { unlinked: result.unlinked } };
  } catch (error: unknown) {
    return failure(error, "Failed to undo");
  }
}

const mergeSchema = z.object({ sourceId: z.string().min(1), targetId: z.string().min(1) });

export async function mergeIntoSeriesAction(
  input: z.input<typeof mergeSchema>,
): Promise<ActionResult<MergeResult>> {
  try {
    const { sourceId, targetId } = mergeSchema.parse(input);
    const result = mergeSeries(getDb(), sourceId, targetId);
    revalidateRecurring(targetId);
    revalidatePath(`/recurring/${sourceId}`);
    return { ok: true, data: result };
  } catch (error: unknown) {
    return failure(error, "Failed to merge");
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
    return failure(error, "Search failed");
  }
}

const monthSchema = z.object({ monthKey: z.string().regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM") });

/**
 * The projection for one month, so the forecast card can follow the calendar.
 *
 * Returns `null` DATA — not a failure — for a month that has already ended.
 * That is a real answer ("there is nothing to project"), and modelling it as an
 * error would make the card show a toast every time the owner paged into the
 * past to look at what actually happened.
 */
export async function loadMonthForecastAction(
  input: z.input<typeof monthSchema>,
): Promise<ActionResult<MonthForecast | null>> {
  try {
    const { monthKey } = monthSchema.parse(input);
    return { ok: true, data: forecastForMonth(getDb(), monthKey) };
  } catch (error: unknown) {
    return failure(error, "Failed to load that month's forecast");
  }
}

export async function loadRecurringMonthAction(
  input: z.input<typeof monthSchema>,
): Promise<ActionResult<RecurringCalendarMonth>> {
  try {
    const { monthKey } = monthSchema.parse(input);
    return { ok: true, data: recurringCalendar(getDb(), monthKey) };
  } catch (error: unknown) {
    return failure(error, "Failed to load month");
  }
}
