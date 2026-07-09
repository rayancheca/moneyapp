"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { detectRecurringSeries, setSeriesStatus } from "@/services/recurring";

const seriesFormSchema = z.object({ seriesId: z.string().min(1) });

export async function detectNowAction(): Promise<void> {
  detectRecurringSeries(getDb());
  revalidatePath("/recurring");
}

export async function confirmSeriesAction(formData: FormData): Promise<void> {
  const parsed = seriesFormSchema.parse({ seriesId: formData.get("seriesId") });
  setSeriesStatus(getDb(), parsed.seriesId, "confirmed");
  revalidatePath("/recurring");
}

export async function dismissSeriesAction(formData: FormData): Promise<void> {
  const parsed = seriesFormSchema.parse({ seriesId: formData.get("seriesId") });
  setSeriesStatus(getDb(), parsed.seriesId, "dismissed");
  revalidatePath("/recurring");
}
