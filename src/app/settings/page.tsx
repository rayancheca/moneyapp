import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { defaultBackupsDir, getDb } from "@/db/client";
import { aiSpend, readSettings } from "@/services/settings";
import { Field, Input } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { updateSettingsAction } from "./actions";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

function listBackups(): { name: string; sizeKb: number }[] {
  const dir = defaultBackupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .sort()
    .reverse()
    .slice(0, 8)
    .map((name) => ({ name, sizeKb: Math.round(fs.statSync(path.join(dir, name)).size / 1024) }));
}

export default function SettingsPage() {
  const db = getDb();
  const settings = readSettings(db);
  const spend = aiSpend(db);
  const backups = listBackups();
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Thresholds, AI spend, and backups. Everything else is derived from your data."
      />
      <div className="space-y-6">
        <SurfaceCard>
          <h2 className="mb-4 text-sm font-medium">Thresholds</h2>
          <form action={updateSettingsAction} className="grid gap-4 sm:grid-cols-2">
            <Field label="AI monthly cap (USD)">
              <Input name="aiMonthlyCapUsd" type="number" step="0.5" min="0" defaultValue={settings.aiMonthlyCapUsd} className="figures" />
            </Field>
            <Field label="Price staleness (hours)">
              <Input name="priceStalenessHours" type="number" min="1" max="168" defaultValue={settings.priceStalenessHours} className="figures" />
            </Field>
            <Field label="Review deposits above (USD)">
              <Input name="reviewCreditThresholdUsd" type="number" min="0" step="10" defaultValue={settings.reviewCreditThresholdCents / 100} className="figures" />
            </Field>
            <Field label="Claude confidence minimum (0–1)">
              <Input name="categorizationConfidenceMin" type="number" min="0" max="1" step="0.05" defaultValue={settings.categorizationConfidenceMin} className="figures" />
            </Field>
            <div className="sm:col-span-2">
              <button
                type="submit"
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90"
              >
                Save settings
              </button>
            </div>
          </form>
          <p className="mt-3 text-xs text-ink-faint">
            Weeks start Monday (ISO). Backups keep {settings.backupRetention.keepDaily} daily +{" "}
            {settings.backupRetention.keepMonthly} monthly snapshots.
          </p>
        </SurfaceCard>

        <div className="grid gap-6 md:grid-cols-2">
          <SurfaceCard>
            <h2 className="mb-3 text-sm font-medium">AI spend</h2>
            <p className="figures text-3xl font-semibold">
              ${spend.monthUsd.toFixed(2)}
              <span className="ml-2 text-sm font-normal text-ink-faint">
                / ${spend.capUsd.toFixed(2)} cap this month
              </span>
            </p>
            {spend.overCap && (
              <p className="mt-1 text-xs font-medium text-negative" role="alert">
                Monthly cap reached — Claude classification pauses until next month or a higher cap.
              </p>
            )}
            <p className="mt-2 text-xs text-ink-muted">
              {spend.monthCalls} calls this month · ${spend.totalUsd.toFixed(2)} all-time. Every call
              is logged with tokens and batch size.
            </p>
            <p className="mt-2 text-xs">
              {hasApiKey ? (
                <span className="text-positive">ANTHROPIC_API_KEY configured</span>
              ) : (
                <span className="text-warning">
                  No ANTHROPIC_API_KEY — the app fully works; unknown merchants queue for later.
                </span>
              )}
            </p>
          </SurfaceCard>

          <SurfaceCard>
            <h2 className="mb-3 text-sm font-medium">Backups</h2>
            {backups.length === 0 ? (
              <p className="text-sm text-ink-muted">
                First snapshot lands on next app start — crash-safe copies via SQLite&apos;s online
                backup API, never raw file copies.
              </p>
            ) : (
              <ul className="space-y-1">
                {backups.map((b) => (
                  <li key={b.name} className="flex justify-between text-xs">
                    <span className="figures">{b.name}</span>
                    <span className="text-ink-faint">{b.sizeKb} KB</span>
                  </li>
                ))}
              </ul>
            )}
          </SurfaceCard>
        </div>
      </div>
    </>
  );
}
