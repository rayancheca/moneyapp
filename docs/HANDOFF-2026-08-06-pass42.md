# Handoff — 2026-08-06, pass 42

> **The cash leg settles too — and "trade legs" was the wrong scope.** Pass 41 moved the share leg
> to the settle date; this pass moves the cash leg. But the handoff's scope (Buy+Sell) is
> *measurably worse* than the unconditional rule: trades-only closes 2 statement periods and
> **breaks 2025-04**, which reconciles today. Buy+Sell+ACH closes **5** and breaks nothing. Since
> only those three codes ever lag, the rule is simply **`posted_on` = Settle Date**.
>
> Robinhood Cash: **16 → 21 periods reconcile**, unreconciled total **$26,863.76 → $1,911.24
> (−92.9%)**, `gap` days **468 → 323**. Net worth **$92,958.76 → $91,392.26**.
>
> ⛔ **NEXT: the last $1,911.24 is concentrated and legible** — 74% of it is one period, and the
> rest is four adjacent cancelling pairs. §5.

## 1. Repo state

`main` = `33190c3`, pushed. Real DB written once, verified against a rehearsal copy first.

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | **151 files / 2,679 tests** (was 151 / 2,677 — +2 new) |
| `next build` | clean |
| `E2E_GATE=1 pnpm e2e:fresh` | **386 passed, 0 failed, 0 baseline churn** |

Restore point: `data/backups/pre-pass42-settle-redate.db` (plus the script's own
`pre-<ts>-robinhood-cash-settle-redate.db`).

---

## 2. 🔴 THE LESSON: a handoff's scope is a hypothesis, and scope is measurable

Pass 41 wrote: *"the Robinhood Cash trade legs"*. That reads like a settled fact. It is a
hypothesis, and it is wrong — not about direction, about **extent**. `ACH` lags identically to
`Buy`/`Sell` (all 98 rows, 1–4 days), and the handoff never mentions it.

The two scopes are not "one is more thorough". One is **actively worse**:

| variant | periods reconciling (of 31) | closed | broke |
|---|---|---|---|
| baseline | 16 | — | — |
| A — Buy+Sell (the handoff's words) | 17 | 2 | **1 — 2025-04** |
| B — Buy+Sell+ACH ≡ "Settle Date always" | **21** | **5** | **0** |

Variant A breaks a month that reconciles today, because two ACH deposits straddle it (+$85.00
3/31→4/1, +$100.00 4/30→5/1). Moving the trades without the transfers desynchronises the very
boundary the fix exists to repair. **The legs must move together.**

The generalisable form: *when a handoff names a subset, ask what the predicate actually is.* The
predicate here was never "is it a trade" — it was "does this row lag", and that is a column you can
`GROUP BY`, not a category you reason about.

## 3. The evidence — the statements say it in their own words

Neither pass 40 nor pass 41 opened these PDFs for this question. They answer it directly (the repo's
own `unpdf` reads them; there is no `pdftotext` on this box).

**July 2026, p13.** The 7/31 AAPL buy is not in Account Activity at all. It sits alone under a
heading that explains itself:

> *Executed Trades Pending Settlement — **These transactions may not be reflected in the other
> summaries*** · `Apple … Buy  Trade Date 07/31/2026  Settle Date 08/03/2026  5  $313.30  $1,566.50`

Its $1,566.50 is still inside the closing Brokerage Cash Balance. The cash had not moved.

**February 2025 — and this is the one that settles ACH.** The 2/28 ACH deposit settling 3/3 is
absent the same way: **`"$200.00"` occurs 0 times in the entire file.** February's close —
Brokerage Cash `$0.00` + Deposit Sweep `$100.02` = **$100.02** — matches the stored anchor
(`10002`) exactly. An unsettled *transfer* is excluded from the period identically to an unsettled
*trade*.

**A prediction, then the measurement.** From the July document alone: July's walk should improve by
exactly the quarantined amount. Measured: **537,802 → 381,152 = 156,650 cents**, the $1,566.50 to
the cent.

## 4. What shipped

**Parser** (`csv-profiles.ts`, v3 → **v4**): `postedOn` = Settle Date, `transactedOn` = Activity
Date. Unconditional — 168 of 2,256 rows do not move because their settle date already equals their
activity date. A missing Settle Date falls back to the activity date (fixtures need it; real
exports: 0 of 2,256). Two new tests, including the real 7/31→8/3 AAPL shape.

**Migration** (`scripts/redate-robinhood-cash-to-settle.ts`): dry-run by default, `--confirm` to
write, `--db=` to rehearse on a copy. Three traps it exists to avoid:

1. ⛔ **Never re-import.** Bumping the version and re-feeding the CSV *looks* right and reports a
   healthy `inserted 2229` — and silently destroys ~27 real rows, deposits included.
   `importOneFile` supersedes one file's contribution at a time while the other files'
   activity-dated rows are still live in the `IdentityPool`, and `consumeIdentity` matches on
   `(day, amount)` with **no description check**. This script rewrites in place and never touches a
   row id, so categories, notes, transfer links and exclusions survive by construction.
2. **`occurrence_index` must be recomputed, not carried.** Settle-dating collapses **14 pairs** onto
   a shared day (two recurring AMZN buys from 11/10 and 11/11 both settle 11/12), and both members
   carry index 0 today. Preserving it makes their new hashes identical. The script re-runs
   `assignOccurrenceIndexes` keyed on the *new* date, which renumbers them 0/1.
3. **Park the hashes first.** `ux_transactions_account_dedupe` is enforced per statement, so
   rewriting row A onto a hash row B still holds aborts the transaction even though B is about to
   vacate it. Phase 1 sets every affected hash to `migrating:<id>`; phase 2 writes the real values.

Identity is reconstructed **by calling the parser**, not by re-deriving `rawDescription` by hand —
that string is part of the dedupe hash, and a hand-rolled copy of the rule is a chance to
manufacture a hash that never existed. v4 returns both dates, so one parse yields both the old
identity (keyed on `transactedOn`) and the new one. It matched **2,256 / 2,256** stored hashes,
0 unmapped — which is itself the proof the reconstruction is exact.

### Measured on the real ledger

| | before | after |
|---|---|---|
| periods reconciled / gap | 16 / 15 | **21 / 10** |
| unreconciled total | $26,863.76 | **$1,911.24** (−92.9%) |
| `daily_balances` basis | gap 468, derived 176 | **gap 323, derived 321** |
| net worth (2026-08-06) | $92,958.76 | **$91,392.26** |
| transient dips >$500 (raw / bridged) | 46 / 37 | **40 / 32** |

**The −$1,566.50 is a correction, not a cost.** Since pass 41 the ledger counted *both* the 5 AAPL
shares *and* the cash that bought them. `holding_events` had the shares on 2026-08-03 while the cash
sat on 2026-07-31; they now agree.

**Safety, verified on a copy and again on the real DB:** row multiset **identical** (no money row
lost or gained), **0 of 2,321** rows drifted a user attribute, **no period that reconciled before
became a gap**, `duplicate_candidates` 71→71, `needs_review` 16→16, quarantined 0.

**Idempotency, proven both ways** — this is why parser and DB ship in one commit:

| target (byte-different re-download, so the sha guard can't help) | result |
|---|---|
| migrated DB + v4 parser | `inserted 0, deduped 2256` |
| **un**migrated DB + v4 parser | **`inserted 349`** |

## 5. ⛔ NEXT: the last $1,911.24 is concentrated and legible

Ten periods still miss, but they are no longer a fog — they are two distinct shapes:

| period | gap | reading |
|---|---|---|
| **2025-10** | **−$1,419.78** | **74% of everything left.** It *degraded* (−$669.78 → −$1,419.78): the −$750.00 ACH Withdrawal (activity 10/31, settle 11/03) correctly left October, and October was already broken. Its neighbour 2025-11 went −$680.21 → **+$19.79**. |
| 2025-11 / 2025-12 | +$19.79 / −$19.91 | cancel to **12¢** |
| 2026-01 / 2026-02 | +$9.87 / −$10.01 | cancel to **14¢** |
| 2026-05 / 2026-06 | −$100.03 / +$99.98 | cancel to **5¢** |
| 2026-03 / 2026-04 | −1¢ / −1¢ | effectively closed |
| 2026-07 | +$231.85 | was $1,798.35 before this pass |

**Four adjacent cancelling pairs is a signature, not noise** — it is one more row-class still on the
wrong side of a month boundary. The prime suspect is the **65 hand-entered rows** (64 crypto
cash-settlement mirrors + the $3,579.67 plug), which this pass deliberately left activity-dated
because they are not parser output. Start there: they are few enough to read individually.

⚠️ Do **not** assume the fresh Robinhood **crypto** export closes these. It will help 2026-07, but
the ±$10 and ±$100 pairs are too small and too regular to be crypto.

## 6. Corrections to the record — three claims that do not survive measurement

1. ⛔ **"14 new transient dips, largest $5,334.95 on 2025-07-08"** (pass 41 §5) is
   **unreproducible**. `$5,334.95` appears nowhere in the DB or the CSV, under any threshold ×
   window × series combination tried. The real effect of this fix is a *partial* improvement —
   dips 46 → 40 raw, 37 → 32 bridged — not an elimination. Do not carry the old number forward.
2. ⛔ **"zero `gap` days left anywhere in the ledger"** (pass 40 line 10, and MEMORY.md) is false,
   and **pass 40 contradicts itself** — its own line 263 says *"gap days 526 → 468"* and line 140
   grades Robinhood Cash **`broken`**. There were 468, all Robinhood Cash, byte-identical in the
   pre-pass-41 backup. Now 323.
3. ⛔ **Pass 40's "settlement lag" note** (line 138: *"07/06 +$5,043.62 … dated 07/02 (settlement
   lag)"*) is wrong. The July statement dates both RTP rows **07/02/2026**, the same day the app
   does. $5,043.62 = $1,137.27 + $3,906.35, two RTP rows with Activity == Settle. Nothing to fix.

Also worth recording, because it cost time: **`gap_cents` is not stale** — I suspected it was
(July stores 179,835 while `end − beg − Σtxns` gives 537,802) but re-running `reconcileAccounts` on
an untouched copy reproduces the stored values exactly. It is simply a *different* metric from the
naive walk. Compare like with like: re-reconcile a copy before calling a number a regression.

## 7. Deliberate non-changes

- **e2e fixtures keep Activity == Settle.** `scripts/fixtures/render.ts:156` emits the same date
  three times, so the fixture world never exercises a lag. Teaching it one would churn
  **4 snapshot dirs / 146 PNGs** to prove what the two new unit tests already prove precisely. A
  parser dating rule belongs in unit coverage. Revisit only if the fixture world grows a
  settlement-sensitive assertion.
- **The 65 hand-entered rows stay activity-dated** — see §5; they are not parser output, and moving
  them is a separate, evidence-led decision.

## 8. The queue

1. ⛔ **The last $1,911.24** (§5) — start with the 65 hand-entered rows, not the crypto export.
2. **Fix the all-time stats under the windowed chart** — `ReturnViewParts.tsx:89` computes best/worst
   day and max drawdown over the FULL series while the chart shows a slice.
   ⚠️ `dailyReturns()` starts at `i=1`, so the slice must include one day BEFORE the window start.
3. **Wire `/investments` panels to `?range=`** — holdings, allocation, top movers, P&L heatmap.
4. **`/flow` range** — `flow/page.tsx:44` hardcodes `2000-01-01` while `transfer-flow.ts:145` already
   honours a range. Cheapest win left.
5. **The transaction drawer + `/transactions` breadcrumb + name the filter chips.**
6. **Robinhood CRYPTO activity export.** ⛔ Do NOT delete the $3,579.67 plug first.
7. **The 33 review rows.**
8. ⛔ **Hosting LAST** — the owner's standing instruction is the whole queue first.
