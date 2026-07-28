# Findings I verified by hand (not agent-reported)

Everything here was confirmed by reading the cited code **and** measuring against a
database, on 2026-07-27. Where a number differs from what an agent claimed, the number
here is the measured one.

---

## V1 — CONFIRMED DEFECT: dead recurring series leak into the dashboard and the forecast

Three functions decide "is this series still alive?" and **they do not agree.**

| Function | File | Filter used | Excludes dead series? |
|---|---|---|---|
| `recurringCalendar` | `src/services/recurring-calendar.ts:155` | `isSeriesActive(s, today)` | ✅ yes |
| `upcomingOccurrences` | `src/services/recurring.ts:719-723` | `status IN ('detected','confirmed')` | ❌ **no** |
| `fixedComponents` | `src/services/forecast.ts:127-131` | `status IN ('detected','confirmed')` | ❌ **no** |

`isSeriesActive` (`src/services/recurring.ts:669-679`) is strictly stronger than a status
check — it *also* requires `lastMatchedOn` to be non-null and recent:

```ts
if (s.status === "dismissed" || s.status === "ended") return false;
if (!s.lastMatchedOn) return false;
return diffDays(s.lastMatchedOn, today) <= step * INACTIVE_MISS_LIMIT + grace;
```

The calendar's code even carries a comment explaining exactly why this matters — *"a long-dead
series must not litter the month with 'upcoming' charges it will never make"* — and the other
two call sites never got the same treatment.

**User-visible consequence.** The dashboard's *"Upcoming · next 14 days"* widget and the
`/spending` forecast both project charges from subscriptions that stopped billing months ago,
while `/recurring` correctly hides those same series. Two surfaces disagree about the same
series, and the forecast overstates fixed costs.

**Measured impact — real database:** 7 series are `detected|confirmed`; **2 are stale.**

| Series | Cadence | Last matched | Amount |
|---|---|---|---|
| `UBER *ONE` | monthly | **2025-05-25** (14 months ago) | $4.99 |
| `Rocket Money` | monthly | 2026-05-19 | $6.00 |

**$10.99/cycle of phantom charges.** Small in dollars, but `UBER *ONE` has been dead for over a
year and is still being forecast — that is a correctness bug regardless of size.

> ⚠️ **Do not quote the demo-database version of this finding.** On `data/moneyapp.db` the same
> query returns 7 stale series worth **$5,233.18**, because the demo fixtures include a stopped
> payroll series. Several agents reported figures in that range as if they were the owner's real
> finances. They are not.

> ### ⛔ CORRECTION (verified with the real constants) — do NOT apply `isSeriesActive` here
>
> My original fix ("replace the status check with `isSeriesActive` in both call sites") is **wrong
> and would make the forecast worse.** I approximated `INACTIVE_MISS_LIMIT` as 2 with a 7-day grace.
> The actual values in `src/services/recurring.ts:661,48` are **`INACTIVE_MISS_LIMIT = 1.5`** and a
> **2-day** weekly grace, so a weekly series goes inactive after **7 × 1.5 + 2 = 12.5 days**, not 21.
>
> Recomputed with the exact rule against the real database:
>
> | Series | kind | stale | threshold | suppressed? |
> |---|---|---|---|---|
> | **Cash job (weekly pay) — $1,046/wk** | **income** | **21d** | **12.5d** | **YES** ← |
> | UBER *ONE — $4.99 | expense | 428d | 48.8d | yes |
> | Rocket Money — $6.00 | expense | 69d | 49.0d | yes |
> | Amazon Prime, Breezeline, FPL, Flamingo rent | expense | 17–22d | 48.0d | no |
>
> The "fix" would remove **$1,046/week of income he is genuinely still earning** (~$4,500/month) in
> order to suppress **$10.99/cycle** of dead subscriptions. Net-negative by roughly 400×.
>
> **Root cause of my error:** `lastMatchedOn` measures **import recency, not liveness.** The newest
> transaction anywhere in his database is `2026-07-14`, and his SoFi accounts only run to
> `2026-05-31`. `isSeriesActive` conflates "no recent *statement*" with "this series *died*" — which
> is safe for the calendar (drawing nothing is harmless) but destructive in a forecast.
>
> **The correct fix:** judge staleness against **the account's own coverage end date**, not `today`.
> A series last matched 2026-07-06 on an account with no statements after 2026-07-14 is not stale at
> all. Failing that, surface the uncertainty rather than silently dropping the row. The genuine
> defect — three functions disagreeing — stands; only the remedy changes.
>
> *(Credit: the headline-factcheck fleet caught this. The audit backlog carries the same wrong
> remedy and must be re-worded — see `11-headline-factcheck.md`.)*

---

## V2 — VERIFIED STRENGTH: the money math genuinely reconciles

Four independent computation paths, June 2026 window, demo database:

```
periodTotals          earned $5,155.98   spent $4,930.22   net $225.76
categoryBreakdown     total  $4,930.22                     Δ vs periodTotals = $0.00  ✅
spendingSankey        hub in $5,155.98   hub out $5,155.98  Δ = $0.00                 ✅
documented invariant  in = earned + refunds + max(-net,0) == out = spent + max(net,0) ✅
```

`categoryBreakdown` and `periodTotals` are separate functions with separate queries and they
agree **to the cent**. The Sankey's money-conservation invariant holds exactly. This is the
thing a hostile reviewer attacks first in a finance app, and it survives.

Net worth reconciles across surfaces too: the five institution totals on `/` sum to
`10,493.73 + 50,701.47 − 86.89 + 21,280.98 + 28,228.53 = $110,617.82`, matching the hero
exactly, and `/investments` reports the same `$21,280.98 / −$242.09 / −1.12%` as the dashboard card.

---

## V3 — CORRECTED: `tabular-nums` is NOT a no-op (an agent got this wrong)

An agent reported that `font-variant-numeric: tabular-nums` in `globals.css` does nothing
because Geist Sans ships no `tnum` table, and recommended a font change. **Measured in the
running app, that is false:**

| Geist Sans | digit advance widths | spread |
|---|---|---|
| `font-variant-numeric: normal` | 66.3, 38.4, 61.9, 61.3, 61.5… | **72.6%** |
| `font-variant-numeric: tabular-nums` | 60, 60, 60, 60, 60… | **0%** |

**But the underlying complaint is real, with a much cheaper fix.** `.figures` applies *both*
`tabular-nums` and a switch to Geist Mono, so alignment inside it comes from the mono face.
Anything outside `.figures` gets proportional digits — and that is exactly the chart chrome:

```
$80k / $90k / $100k / $110k / $120k   → GeistSans, font-variant-numeric: normal
▲ $112k  (peak marker)                → GeistSans, normal
"Mon, Jul 27, 2026: $110,617.82"      → GeistSans, normal   ← the scrub tooltip
```

The scrub tooltip updates continuously while dragging; with a 72% width spread between `1` and
`0` the text reflows every frame and the number visibly shimmies. **Fix is one declaration on
the axis/tooltip text, not a font migration.**

---

## V4 — Responsive geometry

See [live-responsive-findings.md](../live-responsive-findings.md). Corrected summary: recharts
**is** properly responsive (293px at a 375px viewport on a clean load); an earlier 910px reading
was stale `ResizeObserver` state from resizing without reloading. The real overflow is a CSS Grid
track that will not shrink below its content (`min-width: auto` on a grid child) — **+30px at
440px** (iPhone 17 Pro Max), +95px at 375px. One `min-w-0`. Separately, `main` is capped at
`max-width: 1024px`, leaving ~653px unused on a 2545px display.

---

## V5 — No dead routes

All 51 distinct internal `href`s scraped from the nine top-level pages return HTTP 200.

---

## V6 — CONFIRMED: the transfer graph is missing an entire account (but the money math is safe)

The transfer-flow design agent flagged that only 516 of 650 transfer groups resolve to an edge.
I traced the other 134. **Every one is a single-leg group** — a transaction carrying a
`transfer_group_id` with no partner:

| Group shape | Count |
|---|---|
| `1neg/1pos` (properly paired) | 516 |
| `0neg/1pos` (inflow, no funding leg) | **127** |
| `1neg/0pos` (outflow, no landing leg) | 7 |

They are overwhelmingly **credit-card payments landing on `Chase Sapphire`**. The consequence:
`Chase Sapphire` touches **107 transfer groups but appears in none of the 13 edges** — the account
is entirely absent from the flow graph.

### Is the funding side missing, or just unpaired?

It exists. For each of the 127 unpaired inflows I searched for an unlinked outflow of the exact
opposite amount in a different account:

| Tier | Count | Reading |
|---|---|---|
| same-day, unique match, description says "Payment to Chase card…" | **101** | two-sided + mutual-nearest — safe to auto-pair under existing doctrine |
| same-day, unique match, other wording | 2 | review |
| same-day, **ambiguous** (2+ candidates) | 4 | detector correctly declined — doctrine working |
| counterpart 1–5 days away | 19 | needs the wider window, or manual linking |
| no counterpart anywhere in the data | 1 | genuine statement-coverage gap |

So **101 pairings are recoverable with high confidence.** These are not the "single-sided hint"
cases the pass-12 doctrine deliberately refuses — both legs exist, same day, same amount, and the
outflow's description names the card. This is a detector gap, not a doctrine boundary.

> ⚠️ A naive ±5-day exact-amount matcher reports **126/127** recoverable. That number is wrong —
> it matches things like a $100 Zelle payment to a person against a $100 card payment. Use 101.

### Does this corrupt any money number? **No — verified.**

I checked how the unlinked outflows are categorised:

| Category | kind | n | total |
|---|---|---|---|
| `Transfers > Credit Card Payment` | `transfer` | 104 | $33,478.97 |
| `Transfers > Internal Transfer` | `transfer` | 1 | $100.00 |

All of them carry a **`kind='transfer'` category**, so the spending classifiers exclude them by
kind regardless of `transfer_group_id`. **There is no double-counting and spending is not
inflated.** The categorisation layer is independently protecting the money math — a genuinely
good piece of defensive design.

### What this means for the new transfer-flow view

The service must **not** key solely off `transfer_group_id`, or it will silently omit
$33,578.97 of card payments and the whole `Chase Sapphire` account. Two options:

1. **Fix the detector** — pair the 101 high-confidence cases, then key off `transfer_group_id`.
   Cleaner, benefits every surface, but it is a real-DB write and needs the usual
   backup + dry-run + delta-guard treatment.
2. **Make the service tolerant** — build edges from `transfer_group_id` where present, and fall
   back to `kind='transfer'` + account-side inference for single-leg groups. No DB write.

Recommend (2) first so the view is honest immediately, then (1) as a separate guarded pass.
Either way the view should surface the unattributed count rather than hiding it.

---

## V7 — FALSIFIED: "40 rows marked Transfer keep counting as spending everywhere"

The review's section-04 register states that because
`grep -c transferGroupId src/services/analytics.ts` returns 0, transfer-paired rows leak into
spending. The grep is correct — analytics.ts genuinely never reads `transfer_group_id`. **The
conclusion drawn from it is wrong.**

`spendingBucket` (`src/services/analytics.ts:201-209`) gates on the **top-level category kind**:

```ts
if (txn.categoryId === null) return txn.amountCents < 0 ? { …"Uncategorized" } : null;
const top = idx.topLevelOf(txn.categoryId);
if (top.kind !== "expense") return null;      // ← transfers excluded here
```

So a transfer-paired outflow leaks into spending **only if** it is uncategorised, or categorised
under an `expense` top-level. I measured exactly that set:

| Database | active transfer outflows | leaking into spending |
|---|---|---|
| DEMO | 122 | **0** |
| REAL | 523 | **0** |

**Zero on both.** Every transfer-paired outflow carries a non-expense kind, so the kind gate
catches all of them. Spending is not inflated.

**What is still fair to say:** the exclusion is *incidental* rather than *enforced*. Nothing stops
a future mis-categorisation from putting a transfer row under an expense parent, and no test pins
this invariant. That is a legitimate **low-severity robustness gap** — "add a regression test
asserting no `transfer_group_id` row reaches `spendingBucket`" — not the critical money bug it was
filed as.
