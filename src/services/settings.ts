import { desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { aiCalls } from "@/db/schema/ai";
import { appSettings } from "@/db/schema/settings";
import { monthKey, todayIso } from "@/lib/dates";

/** Typed access to app_settings — every value Zod-validated on read AND write. */

export const settingsSchema = z.object({
  aiMonthlyCapUsd: z.number().min(0).max(1_000),
  priceStalenessHours: z.number().int().min(1).max(168),
  reviewCreditThresholdCents: z.number().int().min(0),
  categorizationConfidenceMin: z.number().min(0).max(1),
  weekStartsOn: z.literal("monday"),
  backupRetention: z.object({ keepDaily: z.number().int().min(1), keepMonthly: z.number().int().min(1) }),
});
export type AppSettingsShape = z.infer<typeof settingsSchema>;

export function readSettings(db: AppDatabase): AppSettingsShape {
  const rows = db.select().from(appSettings).all();
  const raw = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  return settingsSchema.parse(raw);
}

export function writeSetting<K extends keyof AppSettingsShape>(
  db: AppDatabase,
  key: K,
  value: AppSettingsShape[K],
): void {
  const current = readSettings(db);
  settingsSchema.parse({ ...current, [key]: value }); // validate the whole shape
  db.insert(appSettings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify(value) } })
    .run();
}

export interface AiSpend {
  monthUsd: number;
  totalUsd: number;
  monthCalls: number;
  capUsd: number;
  overCap: boolean;
  recent: { createdAt: string; purpose: string; model: string; batchSize: number; estCostUsd: number }[];
}

export function aiSpend(db: AppDatabase, today: string = todayIso()): AiSpend {
  const monthStart = `${monthKey(today)}-01`;
  const all = db.select().from(aiCalls).orderBy(desc(aiCalls.createdAt)).all();
  const month = db.select().from(aiCalls).where(gte(aiCalls.createdAt, monthStart)).all();
  const capUsd = readSettings(db).aiMonthlyCapUsd;
  const monthUsd = month.reduce((s, c) => s + c.estCostUsd, 0);
  return {
    monthUsd,
    totalUsd: all.reduce((s, c) => s + c.estCostUsd, 0),
    monthCalls: month.length,
    capUsd,
    overCap: monthUsd >= capUsd,
    recent: all.slice(0, 10).map((c) => ({
      createdAt: c.createdAt,
      purpose: c.purpose,
      model: c.model,
      batchSize: c.batchSize,
      estCostUsd: c.estCostUsd,
    })),
  };
}

export { eq };
