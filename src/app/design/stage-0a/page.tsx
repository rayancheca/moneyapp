import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, count, desc, eq, gte, sql, sum } from "drizzle-orm";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema/accounts";
import { categories } from "@/db/schema/categories";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { todayIso } from "@/lib/dates";
import { groupFirstPageByDay } from "@/lib/day-groups";
import { seriesDrawsAsRecurring } from "@/lib/series-evidence";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { monthKeysBack, monthlySpending } from "@/services/analytics";
import { netWorthSeries } from "@/services/derivation";
import { Badge, LetterBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CategoryChip } from "@/components/ui/CategoryChip";
import { Money } from "@/components/ui/Money";
import { NumberRoll } from "@/components/ui/NumberRoll";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { StageZeroAOverlays, type SheetTxn, type SiblingTxn } from "./preview-client";

export const metadata: Metadata = { title: "Stage 0a preview" };
export const dynamic = "force-dynamic";

/**
 * Stage-0a design checkpoint (ux-overhaul-plan §2.8): one high-fidelity sample
 * screen — date-grouped ledger + open transaction sheet + rule-prompt toast +
 * specimen strip — rendered from REAL data with the new primitives, for user
 * sign-off before the app-wide sweep. This route is replaced by the real
 * Stage-1 transactions rebuild.
 */

interface LedgerRow {
  id: string;
  postedOn: string;
  description: string;
  accountName: string;
  amountCents: number;
  categoryLabel: string;
  hue: string | null;
  icon: string | null;
  isTransfer: boolean;
  isRecurring: boolean;
  needsReview: boolean;
}

/** how many ledger rows the preview shows */
const PREVIEW_ROWS = 14;

export default function StageZeroAPreview() {
  // design scaffolding must not ship reachable in production builds
  if (process.env.NODE_ENV === "production" && process.env.MONEYAPP_PREVIEW !== "1") notFound();

  const db = getDb();
  const today = todayIso();

  const fetchedRows: LedgerRow[] = db
    .select({
      id: transactions.id,
      postedOn: transactions.postedOn,
      description: transactions.normalizedDescription,
      accountName: accounts.name,
      amountCents: transactions.amountCents,
      categoryLabel: sql<string>`coalesce(${categories.name}, 'Uncategorized')`,
      hue: categories.color,
      icon: categories.icon,
      transferGroupId: transactions.transferGroupId,
      seriesStatus: recurringSeries.status,
      needsReview: transactions.needsReview,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(recurringSeries, eq(transactions.recurringSeriesId, recurringSeries.id))
    .where(and(eq(transactions.status, "active"), eq(accounts.type, "checking")))
    .orderBy(
      desc(transactions.postedOn),
      desc(transactions.amountCents),
      desc(transactions.normalizedDescription),
      desc(transactions.id),
    )
    // one past what is shown: the only way to know whether the cut lands inside a day
    .limit(PREVIEW_ROWS + 1)
    .all()
    .map((r) => ({
      ...r,
      isTransfer: r.transferGroupId !== null,
      // the ledger's rule, not its own copy of "has a link" (see `toLedgerRow`)
      isRecurring: r.seriesStatus !== null && seriesDrawsAsRecurring(r.seriesStatus),
    }));

  // Busiest merchant → the sheet's same-merchant panel, from real history.
  const busy = db
    .select({
      merchantId: merchants.id,
      merchantName: merchants.canonicalName,
      n: count(transactions.id),
      totalCents: sum(transactions.amountCents),
    })
    .from(transactions)
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(and(eq(transactions.status, "active"), gte(transactions.postedOn, `${today.slice(0, 4)}-01-01`)))
    .groupBy(merchants.id)
    .orderBy(desc(count(transactions.id)))
    .limit(1)
    .get();

  const sheetRows = busy
    ? db
        .select({
          id: transactions.id,
          postedOn: transactions.postedOn,
          description: transactions.normalizedDescription,
          amountCents: transactions.amountCents,
          accountName: accounts.name,
          categoryLabel: sql<string>`coalesce(${categories.name}, 'Uncategorized')`,
          hue: categories.color,
          icon: categories.icon,
        })
        .from(transactions)
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(and(eq(transactions.merchantId, busy.merchantId), eq(transactions.status, "active")))
        .orderBy(desc(transactions.postedOn))
        .limit(6)
        .all()
    : [];

  const subject: SheetTxn | null =
    busy && sheetRows.length > 0
      ? {
          ...sheetRows[0]!,
          merchantName: busy.merchantName,
          siblingCount: busy.n,
          siblingTotalCents: Number(busy.totalCents ?? 0),
        }
      : null;
  const siblings: SiblingTxn[] = sheetRows.slice(1);

  const roots = db
    .select({ name: categories.name, hue: categories.color, icon: categories.icon })
    .from(categories)
    .where(and(eq(categories.isSystem, true), sql`${categories.parentId} IS NULL`))
    .orderBy(categories.sortOrder)
    .all();

  // §2.8 honesty: the stat row shows REAL aggregates (the header says
  // "rendered from REAL data"), via the same services the app pages use
  const monthKeys = monthKeysBack(today, 2);
  const spendCells = monthlySpending(db, { months: 2, refDate: today });
  const monthSpendCents = (month: string) =>
    spendCells.filter((c) => c.month === month).reduce((total, c) => total + c.spentCents, 0);
  const thisMonthSpendCents = monthSpendCents(monthKeys[1]!);
  const vsLastMonthCents = thisMonthSpendCents - monthSpendCents(monthKeys[0]!);
  const netWorthCents = netWorthSeries(db).at(-1)?.totalCents ?? 0;

  // ⛔ the ledger's boundary rule, not a copy — a day the row limit cuts is flagged
  // rather than printed as its total (see `groupFirstPageByDay`)
  const dayGroups = groupFirstPageByDay(fetchedRows, PREVIEW_ROWS);

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Stage-0a design preview — real ledger rows, new identity system. Sign-off gates the app-wide sweep."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="This month"
          value={<NumberRoll value={formatCents(thisMonthSpendCents)} />}
          href="/spending"
        />
        <StatCard
          label="vs last month"
          value={
            // spending delta: up is bad — semantic color, never decorative
            <span
              className={
                vsLastMonthCents > 0
                  ? "text-negative"
                  : vsLastMonthCents < 0
                    ? "text-positive"
                    : "text-ink-muted"
              }
            >
              {formatCentsSigned(vsLastMonthCents)}
            </span>
          }
          href="/spending"
        />
        <StatCard label="Net worth" value={<NumberRoll value={formatCents(netWorthCents)} />} href="/" />
      </div>

      <div className="overflow-hidden rounded-(--radius-card) border border-line bg-surface-raised">
        {dayGroups.map((group) => (
          <section key={group.day}>
            <div className="flex items-baseline justify-between border-b border-line bg-surface-sunken/60 px-4 py-1.5">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-faint">
                {group.label}
              </h2>
              <span className="flex items-baseline gap-1.5">
                <Money cents={group.netCents} flow className="figures text-[11px] text-ink-faint" />
                {group.partial ? (
                  <span
                    title={`This day continues past the ${PREVIEW_ROWS} rows shown — the subtotal counts only these.`}
                    className="text-[10px] uppercase tracking-[0.08em] text-ink-faint"
                  >
                    partial
                    <span className="sr-only">
                      {" "}
                      — subtotal counts only the rows shown; this day continues past the preview
                    </span>
                  </span>
                ) : null}
              </span>
            </div>
            {group.rows.map((r) => (
              <div
                key={r.id}
                className="group flex items-center gap-3 border-b border-line px-4 py-2.5 transition-colors duration-(--duration-fast) last:border-b-0 hover:bg-surface-sunken"
              >
                <CategoryChip label={r.categoryLabel} hue={r.hue} icon={r.icon} />
                <span className="min-w-0 flex-1 truncate text-sm">{r.description}</span>
                <span className="hidden items-center gap-1 sm:flex">
                  {r.isTransfer ? <LetterBadge letter="T" /> : null}
                  {r.isRecurring ? <LetterBadge letter="R" /> : null}
                </span>
                <span className="hidden whitespace-nowrap text-xs text-ink-muted md:inline">
                  {r.accountName}
                </span>
                {r.needsReview ? (
                  <span
                    role="img"
                    aria-label="Needs review"
                    className="inline-block size-1.5 shrink-0 rounded-full bg-info"
                  />
                ) : null}
                <Money cents={r.amountCents} flow className="whitespace-nowrap text-sm" />
              </div>
            ))}
          </section>
        ))}
      </div>

      <section aria-label="Design specimens" className="mt-10 space-y-5">
        <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
          Specimens — category identity, buttons, badges
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {roots.map((c) => (
            <CategoryChip key={c.name} label={c.name} hue={c.hue} icon={c.icon} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Save</Button>
          <Button variant="secondary" icon="filter">
            Filters
          </Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="destructive" icon="delete">
            Remove
          </Button>
          <Button variant="primary" pending>
            Classifying
          </Button>
          <Badge tone="positive">reconciled</Badge>
          <Badge tone="warning">drifted</Badge>
          <Badge tone="info">upcoming</Badge>
          <Badge tone="negative">missed</Badge>
          <LetterBadge letter="T" />
          <LetterBadge letter="R" />
          <LetterBadge letter="I" />
        </div>
      </section>

      <StageZeroAOverlays subject={subject} siblings={siblings} />
    </>
  );
}
