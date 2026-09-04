"use client";

import Link from "next/link";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { useViewState } from "@/hooks/useViewState";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { ledgerHref } from "@/lib/ledger-href";
import { formatCents, formatCentsSigned } from "@/lib/money";
import { sideMagnitudeCents } from "@/lib/side-magnitude";
import { sparklineGeometry } from "@/lib/sparkline";
import type { ViewSpec, ViewState } from "@/lib/view-state";

/**
 * "Every account, ruled and totalled" — Direction B's dense accounts table, set
 * in Direction A's types (A+ §7). One line per account: the name with its
 * institution beneath, an inline sparkline of its real balance history, its
 * share of its own side, the balance, and the change across that history.
 * Grouped Held / Owed and totalled to a net figure that is the sum of the
 * printed column, never a second computation of it.
 *
 * SIGN CONVENTION — every figure here is in the ledger's own net-worth frame
 * (`daily_balances`: liabilities negative), because that is the only frame in
 * which the column can be totalled. A card paid down therefore reads as a
 * POSITIVE change: net worth went up. The cards view keeps the owed-frame
 * ("$1,414.69 owed", red); the two never render at once, and the caption states
 * which frame is in force.
 *
 * Nothing is derived from a clock or a random source: every number is a
 * `daily_balances` row the derivation service already produced, so the same
 * data draws the same pixels (243 visual snapshots depend on that).
 */

/* ═══════════════════════ pure model ═══════════════════════ */

/** one covered daily balance, net-worth convention (liabilities negative) */
export interface AccountsTablePoint {
  day: string;
  cents: number;
}

/** One account as the table needs it — exactly the card view's own figures. */
export interface AccountsTableAccount {
  id: string;
  name: string;
  institution: string;
  /** "Checking · ····1234 · 8 positions" — composed by the caller */
  meta: string | null;
  isLiability: boolean;
  /** latest covered balance, net-worth convention; null when never derived */
  balanceCents: number | null;
  asOf: string | null;
  /** covered daily balances oldest → newest (the card sparkline's own window) */
  spark: readonly AccountsTablePoint[];
  unreviewedCount: number;
}

export interface AccountsTableRow extends AccountsTableAccount {
  /** spark cents, oldest → newest */
  series: readonly number[];
  windowFrom: string | null;
  windowTo: string | null;
  /** covered days in the window (NOT calendar days — coverage can have holes) */
  windowDays: number;
  startCents: number | null;
  highCents: number | null;
  lowCents: number | null;
  /** last − first over the window; null when fewer than two covered days */
  deltaCents: number | null;
  /** delta as a percentage of |start|, 1dp; null when start is 0 or unknown */
  deltaPct: number | null;
  /** this account's share of its own side's total size, 1dp — the side sums to 100 */
  sharePct: number;
}

export interface AccountsTableModel {
  held: AccountsTableRow[];
  owed: AccountsTableRow[];
  /** sum of the held balances (nulls contribute nothing) */
  heldTotalCents: number;
  /** sum of the owed balances — NEGATIVE, in the net-worth frame */
  owedTotalCents: number;
  netCents: number;
  /** the Δ column totalled; null when no row has a change to report */
  netDeltaCents: number | null;
  /** the most recent day any listed account is covered to */
  asOf: string | null;
}

/** 1dp, and never a signed zero (−0 renders as "-0.0%"). */
function round1(n: number): number {
  const r = Math.round(n * 10) / 10;
  return r === 0 ? 0 : r;
}

function toRow(account: AccountsTableAccount, sideTotalCents: number): AccountsTableRow {
  const series = account.spark.map((p) => p.cents);
  const first = account.spark[0] ?? null;
  const last = account.spark[account.spark.length - 1] ?? null;
  const deltaCents = series.length >= 2 ? last!.cents - first!.cents : null;
  const startCents = first?.cents ?? null;
  const size = sideMagnitudeCents(account.balanceCents, account.isLiability);
  return {
    ...account,
    series,
    windowFrom: first?.day ?? null,
    windowTo: last?.day ?? null,
    windowDays: series.length,
    startCents,
    highCents: series.length > 0 ? Math.max(...series) : null,
    lowCents: series.length > 0 ? Math.min(...series) : null,
    deltaCents,
    deltaPct:
      deltaCents === null || startCents === null || startCents === 0
        ? null
        : round1((deltaCents / Math.abs(startCents)) * 100),
    sharePct: sideTotalCents === 0 ? 0 : round1((size / sideTotalCents) * 100),
  };
}

/**
 * Group the accounts into Held / Owed and total them. Every total is the sum of
 * a column the table actually prints, so the footer can never disagree with the
 * rows above it. Input order is preserved within each side (the service already
 * sorts by institution → displayOrder → name).
 *
 * 🔴 `share` is measured against what each account contributes to its own SIDE
 * (`lib/side-magnitude`), not against absolute balances. Absolute values handed
 * Chase Sapphire "8.2% of owed" while it sat $82.72 in CREDIT, and divided the
 * two cards that do owe by $1,008.33 instead of the $925.61 between them — the
 * defect `account-insights` fixed on 2026-09-03 and this table did not, so on
 * the same day one page read 60.2% of the same debt and this one read 55.3%.
 *
 * ⚠️ The column therefore sums to 100% of the side's own money and NOT of every
 * row: an account on the wrong side of its sign (a card in credit, an overdrawn
 * checking account) takes no share, which is the true reading.
 */
export function buildAccountsTable(accounts: readonly AccountsTableAccount[]): AccountsTableModel {
  const heldIn = accounts.filter((a) => !a.isLiability);
  const owedIn = accounts.filter((a) => a.isLiability);
  const sideTotal = (list: readonly AccountsTableAccount[]): number =>
    list.reduce((sum, a) => sum + sideMagnitudeCents(a.balanceCents, a.isLiability), 0);

  const held = heldIn.map((a) => toRow(a, sideTotal(heldIn)));
  const owed = owedIn.map((a) => toRow(a, sideTotal(owedIn)));
  const all = [...held, ...owed];

  const heldTotalCents = held.reduce((sum, r) => sum + (r.balanceCents ?? 0), 0);
  const owedTotalCents = owed.reduce((sum, r) => sum + (r.balanceCents ?? 0), 0);
  const withDelta = all.filter((r) => r.deltaCents !== null);

  return {
    held,
    owed,
    heldTotalCents,
    owedTotalCents,
    netCents: heldTotalCents + owedTotalCents,
    netDeltaCents:
      withDelta.length === 0 ? null : withDelta.reduce((sum, r) => sum + (r.deltaCents ?? 0), 0),
    asOf: all.reduce<string | null>(
      (latest, r) => (r.asOf !== null && (latest === null || r.asOf > latest) ? r.asOf : latest),
      null,
    ),
  };
}

export type Direction = "up" | "down" | "flat" | "unknown";

export function directionOf(cents: number | null): Direction {
  if (cents === null) return "unknown";
  if (cents > 0) return "up";
  if (cents < 0) return "down";
  return "flat";
}

/* ═══════════════════════ sparkline geometry ═══════════════════════ */

const SPARK_VB_W = 100;
const SPARK_VB_H = 28;
const SPARK_PAD = 3;

/**
 * Where a value lands on lib/sparkline's y axis. The lib returns the LAST
 * point's y only, and A+'s row also needs the FIRST point's y — the dashed
 * "where this account stood then" rule, which is the reading of direction that
 * survives greyscale. This mirrors `sparklineGeometry`'s mapping rather than
 * changing the lib (owned elsewhere); the co-located test pins the two together
 * by feeding a series whose first and last values are equal, so a drift in
 * either implementation fails loudly instead of quietly misdrawing a rule.
 */
export function sparkValueY(
  values: readonly number[],
  value: number,
  height: number = SPARK_VB_H,
  pad: number = SPARK_PAD,
): number {
  if (values.length === 0) return Math.round((height / 2) * 100) / 100;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const y = span === 0 ? height / 2 : pad + (1 - (value - min) / span) * (height - pad * 2);
  return Math.round(y * 100) / 100;
}

/* ═══════════════════════ presentation ═══════════════════════ */

const TONE: Record<Direction, string> = {
  up: "text-positive",
  down: "text-negative",
  flat: "text-ink-muted",
  unknown: "text-ink-faint",
};

const GLYPH: Record<Direction, string> = { up: "▲", down: "▼", flat: "•", unknown: "·" };

/** the six identity hues, as literal classes so Tailwind's scanner sees them */
const BAR_TONE = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
  "bg-chart-6",
] as const;

const HEAD =
  "border-b-2 border-ink px-2.5 pb-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint shadow-[0_3px_0_-2px_var(--line)] sm:px-3.5 lg:px-4";

const CELL =
  "border-b border-line px-2.5 py-2.5 align-baseline transition-colors duration-(--duration-fast) group-hover:bg-surface-sunken group-focus-within:bg-surface-sunken sm:px-3.5 lg:px-4";

/** the ink rule that slides up the row's left edge on hover/focus */
const CELL_FIRST =
  "relative before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:origin-top before:scale-y-0 before:rounded-full before:bg-accent before:transition-transform before:duration-(--duration-normal) group-hover:before:scale-y-100 group-focus-within:before:scale-y-100";

const FOOT = "border-t-2 border-ink px-2.5 pt-3 sm:px-3.5 lg:px-4";

const EYEBROW = "text-[11px] font-semibold uppercase tracking-[0.12em]";

/** columns the table declares — hidden ones still occupy a DOM cell */
const COLUMN_COUNT = 5;

function formatPct(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

function DeltaFigure({
  cents,
  pct,
  size = "sm",
}: {
  cents: number | null;
  pct?: number | null;
  size?: "sm" | "lg";
}) {
  const dir = directionOf(cents);
  if (cents === null) {
    return <span className="text-[11px] text-ink-faint">not yet</span>;
  }
  return (
    <span
      className={`figures whitespace-nowrap font-semibold ${size === "lg" ? "text-sm" : "text-xs sm:text-sm"} ${TONE[dir]}`}
    >
      <span aria-hidden="true" className="mr-0.5 text-[0.8em]">
        {GLYPH[dir]}
      </span>
      {formatCentsSigned(cents)}
      {pct !== null && pct !== undefined && (
        <span className="figures mt-0.5 block text-[10px] font-normal text-ink-faint">
          {formatPct(pct)}
        </span>
      )}
    </span>
  );
}

/**
 * The row's inline balance history. Decorative on purpose — aria-hidden, with
 * every figure it is drawn from restated in "The balance series, printed"
 * below the table. Direction is carried by the cap's SHAPE (filled disc when it
 * rose, hollow ring when it fell) as well as its colour.
 */
function RowSparkline({ row }: { row: AccountsTableRow }) {
  const geo = sparklineGeometry(row.series, SPARK_VB_W, SPARK_VB_H, SPARK_PAD);
  const dir = directionOf(row.deltaCents);
  if (!geo || row.startCents === null) {
    return (
      <span aria-hidden="true" className="text-[11px] text-ink-faint">
        —
      </span>
    );
  }
  const baseY = sparkValueY(row.series, row.startCents);
  return (
    <svg
      viewBox={`0 0 ${SPARK_VB_W} ${SPARK_VB_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className={`block h-5 w-12 overflow-visible sm:h-6 sm:w-20 lg:w-32 2xl:w-56 ${TONE[dir]}`}
    >
      <line
        x1={0}
        x2={SPARK_VB_W}
        y1={baseY}
        y2={baseY}
        className="text-ink-faint"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="2 3"
        opacity={0.5}
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={geo.linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={geo.lastX}
        cy={geo.lastY}
        r={2.2}
        fill={dir === "up" ? "currentColor" : "var(--surface-raised)"}
        stroke="currentColor"
        strokeWidth={1.4}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function GroupHeading({
  label,
  note,
  totalCents,
}: {
  label: string;
  note: string;
  totalCents: number;
}) {
  return (
    <tr>
      <th
        scope="rowgroup"
        colSpan={COLUMN_COUNT}
        className="border-b border-line px-2.5 pt-6 pb-1.5 text-left font-normal sm:px-3.5 lg:px-4"
      >
        <span className="flex items-baseline justify-between gap-4">
          <span className={`${EYEBROW} text-ink-faint`}>
            {label}
            <span className="font-normal normal-case tracking-normal"> — {note}</span>
          </span>
          <span className="figures text-xs font-semibold text-ink-muted">
            {formatCents(totalCents)}
          </span>
        </span>
      </th>
    </tr>
  );
}

function AccountRow({ row, rank }: { row: AccountsTableRow; rank: number }) {
  const meta = [row.institution, row.meta, row.unreviewedCount > 0 ? `${row.unreviewedCount} to review` : null]
    .filter(Boolean)
    .join(" · ");
  const balance = row.balanceCents;
  return (
    <tr className="group">
      <td className={`${CELL} ${CELL_FIRST}`}>
        <span className="flex items-baseline gap-2.5">
          <span
            aria-hidden="true"
            className="hidden shrink-0 tabular-nums text-sm text-ink-faint transition-colors duration-(--duration-fast) group-hover:text-accent sm:block"
          >
            {String(rank).padStart(2, "0")}
          </span>
          <Link
            href={ledgerHref({ account: row.id })}
            aria-label={`${row.name} — its transactions`}
            className="block min-w-0 flex-1 rounded-sm"
          >
            <span className="block truncate text-sm font-medium text-ink transition-colors duration-(--duration-fast) group-hover:text-accent sm:whitespace-normal">
              {row.name}
            </span>
            <span className="mt-0.5 block truncate text-[11px] tracking-[0.01em] text-ink-faint sm:whitespace-normal">
              {meta}
            </span>
          </Link>
        </span>
      </td>

      <td className={`${CELL} hidden sm:table-cell`}>
        <RowSparkline row={row} />
      </td>

      <td className={`${CELL} hidden lg:table-cell`}>
        <span className="grid min-w-[5.5rem] gap-1 2xl:min-w-[8.5rem]">
          <span className="block h-1.5 overflow-hidden rounded-full bg-surface-sunken shadow-[inset_0_1px_0_var(--line)]">
            <span
              className={`block h-full rounded-full ${BAR_TONE[(rank - 1) % BAR_TONE.length]}`}
              style={{ width: `${row.sharePct}%` }}
            />
          </span>
          {/* A row on the WRONG SIDE of its own sign takes no share, and saying
              "0.0% of owed" of a card the bank owes YOU money on describes it as
              a rounded-down debt. Name the reason instead — the balance beside it
              is the proof. */}
          <span className="figures text-[10px] text-ink-faint">
            {row.balanceCents !== null &&
            row.balanceCents !== 0 &&
            sideMagnitudeCents(row.balanceCents, row.isLiability) === 0
              ? row.isLiability
                ? "in credit — no share of the debt"
                : "overdrawn — no share of what is held"
              : `${row.sharePct.toFixed(1)}% of ${row.isLiability ? "owed" : "held"}`}
          </span>
        </span>
      </td>

      <td className={`${CELL} text-right`}>
        {balance === null ? (
          <span className="text-[11px] text-ink-faint">no balance</span>
        ) : (
          <Link
            href={`/accounts/${row.id}`}
            aria-label={`${formatCents(balance)} — ${row.name} balance history`}
            className={`figures whitespace-nowrap text-sm font-semibold underline-offset-4 hover:underline ${
              balance < 0 ? "text-negative" : "text-ink"
            }`}
          >
            {formatCents(balance)}
          </Link>
        )}
        {row.asOf && (
          <span className="mt-0.5 block text-[10px] text-ink-faint">as of {formatDayShort(row.asOf)}</span>
        )}
      </td>

      <td className={`${CELL} text-right`}>
        <DeltaFigure cents={row.deltaCents} pct={row.deltaPct} />
      </td>
    </tr>
  );
}

function SeriesLine({ row }: { row: AccountsTableRow }) {
  if (row.startCents === null || row.windowFrom === null || row.windowTo === null) {
    return (
      <li className="border-t border-line py-1.5 text-xs text-ink-muted first:border-t-0">
        <b className="font-semibold text-ink">{row.name}</b> · no balance history yet
      </li>
    );
  }
  return (
    <li className="border-t border-line py-1.5 text-xs text-ink-muted first:border-t-0">
      <b className="font-semibold text-ink">{row.name}</b>{" "}
      <span className="figures">{formatCents(row.startCents)}</span> on {formatDayShort(row.windowFrom)}{" "}
      → <span className="figures">{formatCents(row.balanceCents ?? 0)}</span> on{" "}
      {formatDayShort(row.windowTo)} · {row.windowDays} covered days · high{" "}
      <span className="figures">{formatCents(row.highCents ?? 0)}</span> · low{" "}
      <span className="figures">{formatCents(row.lowCents ?? 0)}</span> · change{" "}
      <span className="figures">
        {row.deltaCents === null ? "not yet" : formatCentsSigned(row.deltaCents)}
      </span>
    </li>
  );
}

export interface AccountsTableProps {
  accounts: readonly AccountsTableAccount[];
  /** stated in the note — cash wallets keep their own card on this page */
  cashWalletNote?: string;
}

export function AccountsTable({ accounts, cashWalletNote }: AccountsTableProps) {
  const model = buildAccountsTable(accounts);
  const all = [...model.held, ...model.owed];

  if (all.length === 0) {
    return <p className="text-sm text-ink-muted">No accounts yet — add one below.</p>;
  }

  return (
    <div>
      <div className="overflow-x-auto overscroll-x-contain">
        <table className="w-full min-w-[19rem] border-separate border-spacing-0 text-xs sm:text-sm">
          <caption className={`${EYEBROW} pb-2 text-left text-ink-faint`}>
            Every account, ruled and totalled
            {model.asOf && (
              <span className="block font-normal normal-case tracking-normal">
                Balances as of {formatDayLong(model.asOf)}. Balance and change are both signed
                against net worth, so a debt reads negative and a card paid down reads positive —
                which is what lets both columns be added across the two sides below. Elsewhere a
                card reads as what you owe.
              </span>
            )}
          </caption>
          <thead>
            <tr>
              <th scope="col" className={HEAD}>
                Account
              </th>
              <th scope="col" className={`${HEAD} hidden sm:table-cell`}>
                History
              </th>
              <th scope="col" className={`${HEAD} hidden lg:table-cell`}>
                Share of side
              </th>
              <th scope="col" className={`${HEAD} text-right`}>
                Balance
              </th>
              <th scope="col" className={`${HEAD} text-right`}>
                Change
              </th>
            </tr>
          </thead>

          {model.held.length > 0 && (
            <tbody>
              <GroupHeading
                label="Held"
                note={`${model.held.length} ${model.held.length === 1 ? "account" : "accounts"}`}
                totalCents={model.heldTotalCents}
              />
              {model.held.map((row, i) => (
                <AccountRow key={row.id} row={row} rank={i + 1} />
              ))}
            </tbody>
          )}

          {model.owed.length > 0 && (
            <tbody>
              <GroupHeading
                label="Owed"
                note={`${model.owed.length} ${model.owed.length === 1 ? "account" : "accounts"}`}
                totalCents={model.owedTotalCents}
              />
              {model.owed.map((row, i) => (
                <AccountRow key={row.id} row={row} rank={model.held.length + i + 1} />
              ))}
            </tbody>
          )}

          <tfoot>
            <tr>
              <th scope="row" className={`${FOOT} text-left font-normal`}>
                <span className={`${EYEBROW} block text-ink-muted`}>These accounts</span>
                <span className="mt-1 block text-[11px] font-normal text-ink-faint">
                  Held less owed{model.asOf ? `, ${formatDayLong(model.asOf)}` : ""}
                </span>
              </th>
              <td className={`${FOOT} hidden sm:table-cell`} />
              <td className={`${FOOT} hidden lg:table-cell`} />
              <td className={`${FOOT} text-right`}>
                <span className="figures text-lg font-medium text-ink">
                  {formatCents(model.netCents)}
                </span>
              </td>
              <td className={`${FOOT} text-right`}>
                <DeltaFigure cents={model.netDeltaCents} size="lg" />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <details className="mt-4 border-t border-line">
        <summary
          className={`${EYEBROW} cursor-pointer list-none py-2.5 text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink [&::-webkit-details-marker]:hidden`}
        >
          The balance series, printed
        </summary>
        <ul className="mb-2">
          {all.map((row) => (
            <SeriesLine key={row.id} row={row} />
          ))}
        </ul>
      </details>

      {/* 🔴 This abs'd the owed total, and the Owed heading three rows above
          printed the same number signed: -$842.89 up there, $842.89 down here,
          on one screen. `Math.abs` also had the latent fault §7c named — if card
          credits ever exceeded card debts it would print a DEBT where there is a
          credit. Negating says what you owe, and the sentence changes when the
          sign does rather than hiding it. */}
      <p className="mt-3 max-w-[68ch] text-[11px] text-ink-faint">
        Balances are the ledger&apos;s own derived figures — held{" "}
        <b className="figures font-semibold text-ink-muted">{formatCents(model.heldTotalCents)}</b>{" "}
        and{" "}
        {model.owedTotalCents > 0 ? (
          <>
            <b className="figures font-semibold text-ink-muted">
              {formatCents(model.owedTotalCents)}
            </b>{" "}
            in credit
          </>
        ) : (
          <>
            owed{" "}
            <b className="figures font-semibold text-ink-muted">
              {formatCents(-model.owedTotalCents)}
            </b>
          </>
        )}
        , which the Owed row above prints signed against net worth. Change spans each
        account&apos;s own covered days, and the total change is that column
        added up; the exact dates are in the printed series above. A row&apos;s name opens its
        transactions, its balance opens its history.
        {cashWalletNote ? ` ${cashWalletNote}` : ""} Archived accounts are left out.
      </p>
    </div>
  );
}

/* ═══════════════════════ the view switcher ═══════════════════════ */

/** stable identity so useViewState's setView doesn't churn every render */
const EMPTY_PARAMS: Record<string, string> = {};

export interface AccountsListSwitcherProps {
  /** app_settings key for the persisted preference */
  surface: string;
  spec: ViewSpec;
  /** the RSC-resolved active view (URL > persisted > default) */
  state: ViewState;
  labels?: Record<string, string>;
  basePath?: string;
}

/**
 * Cards ⇄ Table on /accounts, wired to the same view-state model every other
 * switchable surface uses (NS#2 Pillar 2): the URL wins, the persisted
 * preference makes it sticky, the spec default ("cards") is the floor. The spec
 * is passed in rather than imported so the server page — which must resolve the
 * view before rendering — owns the single definition of it (a "use client"
 * module's constants cannot be read on the server).
 */
export function AccountsListSwitcher({
  surface,
  spec,
  state,
  labels,
  basePath = "/accounts",
}: AccountsListSwitcherProps) {
  const { state: active, setView, isPending } = useViewState({
    surface,
    spec,
    state,
    basePath,
    baseParams: EMPTY_PARAMS,
  });
  const dimension = spec[0];
  if (!dimension) return null;
  return (
    <ViewSwitcher
      dimension={dimension}
      value={active[dimension.key] ?? ""}
      onSelect={(value) => setView(dimension.key, value)}
      labels={labels}
      ariaLabel="Accounts view"
      disabled={isPending}
    />
  );
}
