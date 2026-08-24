import { desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { aiCalls } from "@/db/schema/ai";
import { appSettings } from "@/db/schema/settings";
import { DEFAULT_SETTINGS } from "@/db/seed";
import { monthKey, todayIso } from "@/lib/dates";

/** Typed access to app_settings — every value Zod-validated on read AND write. */

/**
 * Dashboard section ids in their canonical (default) order — S7 "movable".
 * S9 merged "upcoming" into the activity hub; normalizeOrder drops the stale
 * id from any previously saved layout.
 */
/**
 * Order here is the FRESH-INSTALL order only. `normalizeOrder` keeps a saved
 * layout's own sequence and appends canonical ids it has never seen to the END,
 * so `decisions` (pass 63) renders third on a new database and last on one that
 * saved a layout before the section existed. Moving it in this list changes the
 * former and never the latter.
 */
export const DASHBOARD_SECTION_IDS = ["hero", "activity", "decisions", "accounts", "recent"] as const;
export type DashboardSectionId = (typeof DASHBOARD_SECTION_IDS)[number];

export const settingsSchema = z.object({
  aiMonthlyCapUsd: z.number().min(0).max(1_000),
  priceStalenessHours: z.number().int().min(1).max(168),
  reviewCreditThresholdCents: z.number().int().min(0),
  categorizationConfidenceMin: z.number().min(0).max(1),
  weekStartsOn: z.literal("monday"),
  backupRetention: z.object({ keepDaily: z.number().int().min(1), keepMonthly: z.number().int().min(1) }),
  /**
   * persisted dashboard section order (S7). Read-tolerant on purpose: ids are
   * plain strings so a layout saved before a section was renamed/removed can
   * never crash readSettings — normalizeOrder drops unknown ids at use time.
   * The save action still enforces the strict enum on write.
   */
  dashboardLayout: z.array(z.string()).default([...DASHBOARD_SECTION_IDS]),
  /**
   * persisted per-surface view choices (NS#2 Pillar 2), keyed surface → (dimension
   * → value), e.g. { spending: { cash: "table" } }. Read-tolerant plain strings +
   * .default({}) so a preference saved before a surface/dimension existed can never
   * crash readSettings — resolveViewState drops values not in the current spec at
   * use time (URL > this > spec default). Absent from DEFAULT_SETTINGS on purpose.
   */
  viewPreferences: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /**
   * the Return views' comparison benchmark (Robinhood-parity item 4) — one
   * global choice across the investments + holding surfaces. Read-tolerant
   * plain string; the save action validates the ticker shape and that price
   * history actually exists before writing.
   */
  benchmarkSymbol: z.string().default("SPY"),
});
export type AppSettingsShape = z.infer<typeof settingsSchema>;

/**
 * A stored value that is not valid JSON is treated as absent rather than fatal:
 * the row is dropped here so the field can fall back to its default below.
 */
function parseStoredValue(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

export function readSettings(db: AppDatabase): AppSettingsShape {
  const rows = db.select().from(appSettings).all();
  const raw: Record<string, unknown> = {};
  for (const r of rows) {
    const parsed = parseStoredValue(r.value);
    if (parsed.ok) raw[r.key] = parsed.value;
  }

  const first = settingsSchema.safeParse(raw);
  if (first.success) return first.data;

  /**
   * Hygiene, not a live outage (dashboardLayout/viewPreferences/benchmarkSymbol
   * are already .default()-guarded): readSettings is called unguarded from every
   * page, so one hand-edited or drifted row should degrade that FIELD to its
   * default rather than take the whole page down. Only the keys zod actually
   * complained about are dropped — every other persisted value survives.
   */
  const bad = new Set(first.error.issues.map((i) => i.path[0]).filter((k) => typeof k === "string"));
  const kept = Object.fromEntries(Object.entries(raw).filter(([k]) => !bad.has(k)));
  // DEFAULT_SETTINGS underneath supplies the keys that have no schema-level
  // .default(); the repaired object failing would mean the defaults themselves
  // are broken, which is a bug we do want loud.
  return settingsSchema.parse({ ...DEFAULT_SETTINGS, ...kept });
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
