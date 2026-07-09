"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { writeSetting } from "@/services/settings";

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
