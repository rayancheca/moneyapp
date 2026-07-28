"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { acceptGap, importStatementFiles, unimportFile, type FileOutcome } from "@/services/import/service";
import { actionErrorMessage, type ActionResult } from "@/app/transactions/action-types";

const REVALIDATE = ["/", "/imports", "/accounts", "/transactions", "/spending", "/budgets", "/recurring"];

function revalidateAll(): void {
  for (const p of REVALIDATE) revalidatePath(p);
}

/**
 * Each `Promise<void>` export below stays byte-identical in signature — React
 * types `<form action>` as `(formData) => void | Promise<void>`, so a result
 * cannot be returned from one without breaking its call site. The validating
 * `*ResultAction` twin carries the real message, and the void adapter routes a
 * failure to `?error=` (the /budgets pattern) instead of throwing.
 */
export async function uploadStatementsResultAction(
  formData: FormData,
): Promise<ActionResult<{ outcomes: FileOutcome[] }>> {
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { ok: false, error: "Pick at least one statement file" };
  try {
    const inputs = await Promise.all(
      files.map(async (f) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) })),
    );
    // per-file failures come back as outcomes; only an unexpected fault throws
    const outcomes = await importStatementFiles(getDb(), inputs);
    revalidateAll();
    return { ok: true, data: { outcomes } };
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, {}, "Import failed") };
  }
}

export async function uploadStatementsAction(formData: FormData): Promise<void> {
  const result = await uploadStatementsResultAction(formData);
  if (result.ok) return;
  // redirect() throws NEXT_REDIRECT by design — it must stay outside any catch
  redirect(`/imports?error=${encodeURIComponent(result.error)}`);
}

export async function unimportFileResultAction(
  formData: FormData,
): Promise<ActionResult<{ importFileId: string }>> {
  const id = formData.get("importFileId");
  if (typeof id !== "string" || id === "") return { ok: false, error: "Pick a file to un-import" };
  try {
    unimportFile(getDb(), id);
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, {}, "Could not un-import the file") };
  }
  revalidateAll();
  return { ok: true, data: { importFileId: id } };
}

export async function unimportFileAction(formData: FormData): Promise<void> {
  const result = await unimportFileResultAction(formData);
  if (result.ok) return;
  redirect(`/imports?error=${encodeURIComponent(result.error)}`);
}

export async function acceptGapResultAction(
  formData: FormData,
): Promise<ActionResult<{ statementPeriodId: string }>> {
  const id = formData.get("statementPeriodId");
  if (typeof id !== "string" || id === "") return { ok: false, error: "Pick a statement period" };
  try {
    acceptGap(getDb(), id);
  } catch (error: unknown) {
    return { ok: false, error: actionErrorMessage(error, {}, "Could not accept the gap") };
  }
  revalidateAll();
  return { ok: true, data: { statementPeriodId: id } };
}

export async function acceptGapAction(formData: FormData): Promise<void> {
  const result = await acceptGapResultAction(formData);
  if (result.ok) return;
  redirect(`/imports?error=${encodeURIComponent(result.error)}`);
}
