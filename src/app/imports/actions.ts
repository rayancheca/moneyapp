"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import {
  acceptGap,
  importStatementFilesWithReport,
  originalOfArchivedCopy,
  unimportFile,
  type ImportInput,
  type ImportReport,
} from "@/services/import/service";
import type { ImportFiling } from "@/services/recurring-links";
import { actionErrorMessage, type ActionResult } from "@/app/transactions/action-types";
import { landBack } from "@/app/refusal-landing";

const REVALIDATE = ["/", "/imports", "/accounts", "/transactions", "/spending", "/budgets", "/recurring"];

function revalidateAll(): void {
  for (const p of REVALIDATE) revalidatePath(p);
}

/**
 * ⛔ A statement picked from the archive — data/statements/<account>/, where each original is kept as `<sha>-<name>` —
 * is its copy, and the upload hands the import the name the browser gives: read as an original, it was recorded under
 * the archive's name and archived a second time, and an activity CSV of the archive's matched no profile by it — a
 * FAILED row on /imports. Refused, with the whole upload, by the rule the commands refuse it by
 * (`originalOfArchivedCopy`); the message names what to upload instead.
 */
function archivedCopyRefusal(inputs: readonly ImportInput[]): string | null {
  for (const input of inputs) {
    const original = originalOfArchivedCopy(input);
    if (original === undefined) continue;
    return (
      `${input.name} is the statement archive's copy of ${original} — read as a statement, it would be recorded ` +
      `under the archive's name and archived a second time. Nothing was imported: upload ${original} as it was ` +
      "downloaded instead."
    );
  }
  return null;
}

/**
 * Each `Promise<void>` export below stays byte-identical in signature — React
 * types `<form action>` as `(formData) => void | Promise<void>`, so a result
 * cannot be returned from one without breaking its call site. The validating
 * `*ResultAction` twin carries the real message, and the void adapter routes a
 * failure to `?error=` (the /budgets pattern) instead of throwing — and a success, on a page showing a refusal,
 * to /imports with none (`landBack`).
 *
 * Each twin also carries back what its import filed under a series he confirmed (`filed`, `fileImportedLinks`) — the
 * import's report, as the scripts print it; /imports names it under the read from the ledger (`importFilingsByRead`),
 * since a form action hands the page nothing. 🔴 Review of 304c59a4 (2026-10-30): all three dropped it.
 */
export async function uploadStatementsResultAction(formData: FormData): Promise<ActionResult<ImportReport>> {
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { ok: false, error: "Pick at least one statement file" };
  try {
    const inputs = await Promise.all(
      files.map(async (f) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) })),
    );
    const refused = archivedCopyRefusal(inputs);
    if (refused !== null) return { ok: false, error: refused };
    // per-file failures come back as outcomes; only an unexpected fault throws
    const report = await importStatementFilesWithReport(getDb(), inputs);
    revalidateAll();
    return { ok: true, data: report };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, {}, "Import failed") };
  }
}

/*
 * Where each form on /imports lands (`landBack`, the rule every form that stays on its page lands by): a refusal on
 * `?error=`; a press that lands stays where it is — but where the page shows a refusal, back on /imports with none.
 * 🔴 Measured on a dev server over a copy of his ledger (2026-11-05): an upload refused with nothing picked left
 * `?error=Pick at least one statement file`, and the next upload, which landed (Imported files 454 → 455), kept the
 * banner on screen — each adapter returned on a success, and the page re-rendered under the URL the refusal had left.
 */
export async function uploadStatementsAction(formData: FormData): Promise<void> {
  landBack("/imports", formData, await uploadStatementsResultAction(formData));
}

export async function unimportFileResultAction(
  formData: FormData,
): Promise<ActionResult<{ importFileId: string; filed: ImportFiling[] }>> {
  const id = formData.get("importFileId");
  if (typeof id !== "string" || id === "") return { ok: false, error: "Pick a file to un-import" };
  let filed: ImportFiling[];
  try {
    filed = unimportFile(getDb(), id);
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, {}, "Could not un-import the file") };
  }
  revalidateAll();
  return { ok: true, data: { importFileId: id, filed } };
}

export async function unimportFileAction(formData: FormData): Promise<void> {
  landBack("/imports", formData, await unimportFileResultAction(formData));
}

export async function acceptGapResultAction(
  formData: FormData,
): Promise<ActionResult<{ statementPeriodId: string; filed: ImportFiling[] }>> {
  const id = formData.get("statementPeriodId");
  if (typeof id !== "string" || id === "") return { ok: false, error: "Pick a statement period" };
  let filed: ImportFiling[];
  try {
    filed = acceptGap(getDb(), id);
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, {}, "Could not accept the gap") };
  }
  revalidateAll();
  return { ok: true, data: { statementPeriodId: id, filed } };
}

export async function acceptGapAction(formData: FormData): Promise<void> {
  landBack("/imports", formData, await acceptGapResultAction(formData));
}
