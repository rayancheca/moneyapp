"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { acceptGap, importStatementFiles, unimportFile } from "@/services/import/service";

const REVALIDATE = ["/", "/imports", "/accounts", "/transactions", "/spending", "/budgets", "/recurring"];

function revalidateAll(): void {
  for (const p of REVALIDATE) revalidatePath(p);
}

export async function uploadStatementsAction(formData: FormData): Promise<void> {
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return;
  const inputs = await Promise.all(
    files.map(async (f) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) })),
  );
  await importStatementFiles(getDb(), inputs);
  revalidateAll();
}

export async function unimportFileAction(formData: FormData): Promise<void> {
  const id = formData.get("importFileId");
  if (typeof id !== "string" || id === "") return;
  unimportFile(getDb(), id);
  revalidateAll();
}

export async function acceptGapAction(formData: FormData): Promise<void> {
  const id = formData.get("statementPeriodId");
  if (typeof id !== "string" || id === "") return;
  acceptGap(getDb(), id);
  revalidateAll();
}
