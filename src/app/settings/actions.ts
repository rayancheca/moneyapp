"use server";

import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defaultBackupsDir, getDb, getDbBundle, type DbBundle } from "@/db/client";
import { filesWithoutPrintedLines, recordImportedFiles } from "@/services/import/import-records";
import {
  manualSnapshot,
  resolveSnapshotPath,
  restoreFromSnapshot,
  type PreMutationSnapshotResult,
} from "@/db/backup";
import { DASHBOARD_SECTION_IDS, readSettings, writeSetting } from "@/services/settings";
import {
  clearInsightSelections,
  refreshInsightSelections,
  requestInsightSelectStop,
  type InsightSelectRunResult,
} from "@/services/insight-selection";
import { INSIGHT_SURFACES } from "@/lib/insight-surfaces";
import { normalizeOrder } from "@/lib/reorder";
import { matchesRestorePhrase } from "@/components/settings/restore-phrase";
import {
  actionErrorMessage,
  firstIssueMessage,
  type ActionResult,
} from "@/app/transactions/action-types";

const formSchema = z.object({
  aiMonthlyCapUsd: z.coerce.number().min(0).max(1_000),
  priceStalenessHours: z.coerce.number().int().min(1).max(168),
  reviewCreditThresholdCents: z.coerce.number().int().min(0),
  categorizationConfidenceMin: z.coerce.number().min(0).max(1),
});

const SETTINGS_LABELS = {
  aiMonthlyCapUsd: "Monthly AI cap",
  priceStalenessHours: "Price staleness window",
  reviewCreditThresholdCents: "Review credit threshold",
  categorizationConfidenceMin: "Minimum categorization confidence",
} as const;

export type SettingsFormValues = z.output<typeof formSchema>;

/**
 * Validating core of the settings form. `Number("abc")` is NaN, which the coerce
 * schema rejects — as a throw that used to take the whole Settings page down,
 * now as a named-field message.
 */
export async function updateSettingsResultAction(
  formData: FormData,
): Promise<ActionResult<SettingsFormValues>> {
  const rawThreshold = formData.get("reviewCreditThresholdUsd");
  const parsed = formSchema.safeParse({
    aiMonthlyCapUsd: formData.get("aiMonthlyCapUsd"),
    priceStalenessHours: formData.get("priceStalenessHours"),
    // Math.round(NaN) is NaN, so a non-numeric entry still fails the schema
    // rather than silently writing 0.
    reviewCreditThresholdCents: Math.round(Number(rawThreshold) * 100),
    categorizationConfidenceMin: formData.get("categorizationConfidenceMin"),
  });
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, SETTINGS_LABELS) };
  }
  try {
    const db = getDb();
    writeSetting(db, "aiMonthlyCapUsd", parsed.data.aiMonthlyCapUsd);
    writeSetting(db, "priceStalenessHours", parsed.data.priceStalenessHours);
    writeSetting(db, "reviewCreditThresholdCents", parsed.data.reviewCreditThresholdCents);
    writeSetting(db, "categorizationConfidenceMin", parsed.data.categorizationConfidenceMin);
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, SETTINGS_LABELS, "Could not save settings") };
  }
  revalidatePath("/settings");
  return { ok: true, data: parsed.data };
}

export async function updateSettingsAction(formData: FormData): Promise<void> {
  const result = await updateSettingsResultAction(formData);
  if (result.ok) return;
  // redirect() throws NEXT_REDIRECT by design — it must stay outside any catch
  redirect(`/settings?error=${encodeURIComponent(result.error)}`);
}

/* ── PASS 72d — insights: the kill switch, and the model that orders them ── */

/**
 * ⛔ Checkboxes are ABSENT from a form when unticked, so a schema that read them
 * as booleans would treat "unticked" and "not on this form" identically. The
 * form therefore posts the surface ids it rendered in a hidden field, and the
 * absent ones are the ones turned off — which is also why the stored map records
 * OFF rather than ON: a surface added later is on until somebody says otherwise.
 */
const insightSettingsSchema = z.object({
  insightsEnabled: z.boolean(),
  insightModelEnabled: z.boolean(),
  offSurfaces: z.array(z.enum(INSIGHT_SURFACES.map((s) => s.id) as [string, ...string[]])),
});

export async function updateInsightSettingsResultAction(
  formData: FormData,
): Promise<ActionResult<{ off: string[] }>> {
  const rendered = String(formData.get("renderedSurfaces") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const parsed = insightSettingsSchema.safeParse({
    insightsEnabled: formData.get("insightsEnabled") !== null,
    insightModelEnabled: formData.get("insightModelEnabled") !== null,
    offSurfaces: rendered.filter((id) => formData.get(`surface:${id}`) === null),
  });
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error.issues, SETTINGS_LABELS) };
  }
  try {
    const db = getDb();
    writeSetting(db, "insightsEnabled", parsed.data.insightsEnabled);
    writeSetting(db, "insightModelEnabled", parsed.data.insightModelEnabled);
    writeSetting(
      db,
      "insightSurfaces",
      Object.fromEntries(parsed.data.offSurfaces.map((id) => [id, false])),
    );
    /*
     * ⛔ Turning the model off FORGETS its opinions. Leaving them stored would
     * mean "off" still changed the order of every page it had already touched —
     * a switch that does not switch anything off is worse than no switch.
     */
    if (!parsed.data.insightModelEnabled) clearInsightSelections(db);
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, SETTINGS_LABELS, "Could not save insight settings") };
  }
  revalidatePath("/", "layout");
  return { ok: true, data: { off: parsed.data.offSurfaces } };
}

export async function updateInsightSettingsAction(formData: FormData): Promise<void> {
  const result = await updateInsightSettingsResultAction(formData);
  if (result.ok) return;
  redirect(`/settings?error=${encodeURIComponent(result.error)}`);
}

/** Fill the selection cache. Value-returning so the button can report honestly. */
export async function runInsightSelectionAction(): Promise<
  { ok: true; data: InsightSelectRunResult } | { ok: false; error: string }
> {
  try {
    const data = await refreshInsightSelections(getDb());
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, SETTINGS_LABELS, "Could not order insights") };
  }
}

export async function stopInsightSelectionAction(): Promise<{ ok: true }> {
  requestInsightSelectStop(getDb());
  revalidatePath("/settings");
  return { ok: true };
}

/** Forget every stored order — the app returns to its own editorial sequence. */
export async function clearInsightSelectionsAction(): Promise<{ ok: true; data: { removed: number } }> {
  const removed = clearInsightSelections(getDb());
  revalidatePath("/", "layout");
  return { ok: true, data: { removed } };
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
    return { ok: false, error: actionErrorMessage(error, SETTINGS_LABELS, "Could not save the layout") };
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
    return { ok: false, error: actionErrorMessage(error, SETTINGS_LABELS, "Could not save the view") };
  }
}

/* ------------------------------------------------------------------ *
 * Backups
 *
 * Three actions over the archive the Settings page lists. Every one of them
 * takes a snapshot NAME, never a path: the name comes from the browser, and
 * resolveSnapshotPath is the single place that decides whether it points at
 * something inside the archive at all.
 * ------------------------------------------------------------------ */

/** Nothing here streams, so a download is capped at what fits comfortably in a response. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

const snapshotNameSchema = z.string().min(1).max(255);

export interface BackupNowData {
  /** the restore point written, or null when this database has backups turned off */
  name: string | null;
  /** why nothing was written — a skip is never silent */
  reason: PreMutationSnapshotResult["reason"] | null;
  /** older restore points rotation removed to make room */
  pruned: number;
}

/** A restore point on demand — the same mechanism every irreversible action uses. */
export async function backUpNowAction(): Promise<ActionResult<BackupNowData>> {
  try {
    const result = manualSnapshot(getDbBundle().sqlite);
    revalidatePath("/settings");
    return {
      ok: true,
      data: {
        name: result.path === null ? null : path.basename(result.path),
        reason: result.reason ?? null,
        pruned: result.pruned.length,
      },
    };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, {}, "Could not write a backup") };
  }
}

export interface RestoreSnapshotData {
  restoredFrom: string;
  /** the state from just before, so the restore itself can be walked back */
  preRestoreName: string | null;
  transactionsBefore: number | null;
  transactionsAfter: number | null;
  /**
   * Imported files the restored ledger still has no record of what they print, after the restore recorded what it
   * could (`recordImportedFiles`) — 0 when the snapshot's records were whole or are now.
   */
  filesUnrecorded: number;
}

/**
 * A snapshot older than the import records brings back the files without the records (`import-records`); they are
 * read from the originals again here, as the three backfills read them. A failure to record leaves the restore in
 * place and is counted, never thrown: the ledger is already the snapshot's.
 */
async function recordRestoredImports(bundle: DbBundle): Promise<number> {
  if (filesWithoutPrintedLines(bundle.db).length === 0) return 0;
  try {
    await recordImportedFiles(bundle);
  } catch (error: unknown) {
    console.error("[restore] recording what the restored files print failed", error);
  }
  return filesWithoutPrintedLines(bundle.db).length;
}

/**
 * Replaces the ledger with a snapshot. The typed phrase is re-checked HERE:
 * the dialog's gate is a courtesy, this one is the rule.
 *
 * Deliberately value-returning rather than a <form action> — the client needs
 * to report which restore point was saved on the way past, and a redirect
 * would throw that away.
 */
export async function restoreSnapshotAction(input: {
  name: string;
  confirmation: string;
}): Promise<ActionResult<RestoreSnapshotData>> {
  const parsed = snapshotNameSchema.safeParse(input.name);
  if (!parsed.success) return { ok: false, error: "That is not a snapshot in the backups folder" };
  if (!matchesRestorePhrase(input.confirmation)) {
    return { ok: false, error: "Nothing was restored — the confirmation word did not match" };
  }
  try {
    const full = resolveSnapshotPath(defaultBackupsDir(), parsed.data);
    const result = restoreFromSnapshot(getDbBundle(), full);
    const filesUnrecorded = await recordRestoredImports(result.reopened);
    // every screen in the app is now looking at a different ledger
    revalidatePath("/", "layout");
    return {
      ok: true,
      data: {
        restoredFrom: result.restoredFrom,
        preRestoreName:
          result.preRestorePath === null ? null : path.basename(result.preRestorePath),
        transactionsBefore: result.transactionsBefore,
        transactionsAfter: result.transactionsAfter,
        filesUnrecorded,
      },
    };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, {}, "Could not restore that snapshot") };
  }
}

export interface DownloadSnapshotData {
  filename: string;
  sizeBytes: number;
  /**
   * The file itself, base64. A local-first app has the snapshot on disk
   * already; what "download" buys is a copy somewhere this machine's disk
   * failing cannot reach, so the bytes have to travel through the response.
   */
  base64: string;
}

export async function downloadSnapshotAction(
  name: string,
): Promise<ActionResult<DownloadSnapshotData>> {
  const parsed = snapshotNameSchema.safeParse(name);
  if (!parsed.success) return { ok: false, error: "That is not a snapshot in the backups folder" };
  try {
    const full = resolveSnapshotPath(defaultBackupsDir(), parsed.data);
    const { size } = fs.statSync(full);
    if (size > MAX_DOWNLOAD_BYTES) {
      return {
        ok: false,
        error: `That snapshot is too large to download from here — copy it from ${full}`,
      };
    }
    return {
      ok: true,
      data: { filename: parsed.data, sizeBytes: size, base64: fs.readFileSync(full).toString("base64") },
    };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, {}, "Could not read that snapshot") };
  }
}
