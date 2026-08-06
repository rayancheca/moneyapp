# Handoff — 2026-08-06, pass 41

> **AAPL's 5.000000 shares were never missing.** The 2026-07-31 buy of 5 AAPL has **Settle Date
> 2026-08-03**, and page 14 of the July statement quarantines it under a heading that says so in as
> many words: *"Executed Trades Pending Settlement — These transactions may not be reflected in the
> other summaries."* It is an August position. Pass 40 walked the export on **Activity Date** and
> saw a gap that does not exist.
>
> The holdings book is **rebuilt from the trade record** and now matches the statement on **9 of 9
> symbols** (it matched 1). GOOG is back. Net worth **$87,180.71 → $92,097.71**.
>
> ⛔ **NEXT: the cash leg is still Activity-dated.** Fixing the share leg exposed a defect that two
> cancelling errors had been hiding. §5 — this is the one thing this pass deliberately did not fix.

## 1. Repo state

`main` = see `git rev-parse --short main`. Real DB written once, verified.

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | **151 files / 2,677 tests** (was 150 / 2,649) · `src/lib/**` **100%** stmts/branches/funcs/lines |
| `next build` | clean |
| `E2E_GATE=1 pnpm e2e:fresh` | **386 passed, 0 failed, 0 baseline churn** |

Restore points: `data/backups/pre-pass41-holdings-rebuild.db` (taken by hand before anything) and
the script's own `pre-<date>T<time>-robinhood-holdings-rebuild.db`.

---

## 2. 🔴 THE LESSON: a date column is a claim about *when*, and there is more than one

Pass 40 concluded AAPL was "5.000000 shares high" and wrote **"⚠️ Do not rebuild until AAPL is
explained… this is one specific unfound event, not a method error."** It was a method error. The
export has three date columns; the walk used `Activity Date`, and the statement counts settled
shares.

The tell was sitting in the same row the whole time. Nothing had to be inferred — only read:

```
"7/31/2026","7/31/2026","8/3/2026","AAPL","Apple…","Buy","5","$313.30","($1,566.50)"
 activity     process     SETTLE
```

Same failure shape as pass 40's own headline lesson (`Deposit Sweep Balance` sitting under
`Brokerage Cash Balance`), one field further along the same row.

**Two residuals were also blamed on missing events and are not.** Both are the export rounding a
quantity to four decimals, and both are recoverable *from the file itself*:

- **AAPL `REC` 2023-12-05** prints `0.0267`; the truth is `0.026737`. The 2024-02-12 dividend line
  states `0.086663 shares`, and the only other AAPL event before it is a `0.059926` buy.
  0.086663 − 0.059926 = 0.026737. The same −0.000037 then recurs on **all ten** AAPL dividend lines.
- **COKE `SPL` 2025-05-27** prints `9.0131`; the truth is `9.013095`. It is a **10-for-1**, and the
  held position was exactly `1.001455`, so the delta is `1.001455 × 9`. The ratio is provable
  without outside knowledge: the pre-split dividend pays *"at 2.5"*, every post-split one *"at
  0.25"*.

Neither number is fitted. `round(0.026737, 4) = 0.0267` and `round(9.013095, 4) = 9.0131`, both
exactly — and the code re-derives them at runtime rather than hardcoding them (§3).

---

## 3. What shipped

**`src/lib/robinhood-holdings.ts`** (+ 28 tests, 100% coverage) — the export → share-event
reconstruction. Three rules, each measured, none a constant:

1. **Settle date is the basis.** Positions accumulate on `Settle Date`.
2. **Splits are a ratio.** The integer multiplier is recovered from the rounded printed delta and
   re-applied exactly, so no precision is lost.
3. **Rounded rows are calibrated against the dividend lines.** Robinhood states the share count each
   dividend was paid on; the true quantity of a low-precision row is read back out of the next one.
   If the implied correction is bigger than a 4-decimal rounding could explain, it **throws** —
   because that is a missing event, not a rounded one.

`verifyAgainstDividends` re-checks all three against the 44 counts the export prints about itself.
That is the point: a wrong correction surfaces as a mismatch instead of as money.

**`scripts/rebuild-robinhood-holdings.ts`** — dry-run by default, `--confirm` to write, `--db=<path>`
to rehearse on a copy. It refuses to write unless **both** arbiters pass, scopes every write to the
brokerage account id, and fingerprints the crypto book before and after.

### Two arbiters, both exact

| | result |
|---|---|
| the 44 share counts printed inside the export's own dividend lines | **44/44** |
| the July 2026 statement's Portfolio Summary (p. 3) | **9/9**, zero ghost symbols |

| symbol | app before | rebuilt | statement |
|---|---|---|---|
| AAPL | 15.606784 | **16.150657** | 16.150657 |
| AMZN | 33.748471 | **34.884778** | 34.884778 |
| COKE | 32.989121 | **33.959422** | 33.959422 |
| GOOG | **absent** | **0.312739** | 0.312739 |
| META | 6.984804 | **7.283111** | 7.283111 |
| MSFT | 43.634230 | **45.890386** | 45.890386 |
| SPY | 16.546213 | **18.027139** | 18.027139 |
| UNH | 18.906582 | **19.329560** | 19.329560 |
| WMT | 0.412664 | 0.412664 | 0.412664 |

**What the old book actually was:** all 1,925 `holding_events` rows were written in the single minute
`2026-07-11T01:02`, from a shorter export, and nothing maintained them after. AAPL's stored quantity
`15.606784` is precisely the share count printed on the 2026-05-13 dividend — a number read off a
line, not accumulated.

**Also fixed, and it was a chain:** GOOG's price feed had been dead since 2026-04-27 **because**
GOOG had no active `holdings` row — `refreshPrices` only quotes `isActive` symbols. Writing
`holdings` first, then refreshing, backfilled **70 GOOG closes**. Its 2026-07-31 close came back
`356.649993`; the statement prints **$356.65**.

**Cost basis is now recorded, not estimated** — every buy carries an `Amount`, so average cost is
computed from cash actually paid. Only 2 of 1,992 share events have no price, and both are events
that cost nothing (a referral share and a split).

**History extended:** the brokerage curve now runs **2024-07-10 → 2026-08-06**, 758 rows over a
758-day span — zero holes, and 227 days earlier than before. It stops at 2024-07-10, not the first
trade (2023-12-05), because AAPL's price cache starts there; those 218 days hold ~$17 and are
**omitted rather than invented**.

⚠️ This moved the TWR anchor — `/investments` now reads "since Jul 2024" instead of Feb 2025.

---

## 4. ⚠️ Watch for: a rebuild verified against `basis='gap'` proves nothing here

`rebuildInvestmentHistory` does **not** write a `gap` row when a held symbol has no close — it
**skips the day entirely** (`crypto-history.ts:110-117`). Absence, not a marked hole, so every
"gap days" audit reads clean. Verify **row count against day span** instead.

And a missing close is **carried**, not zeroed — a real position silently valued at a months-old
price, which `coverage.ts:174` grades as neither broken nor unverified. That is exactly how GOOG
went 101 days unnoticed. The script now names any live symbol whose newest close predates the
statement day.

---

## 5. ⛔ NEXT: the cash leg is on the wrong date basis

**This is the one thing this pass knowingly left.** Robinhood Cash posts trades on **Activity
Date** (`csv-profiles.ts:421`); the shares now land on **Settle Date**. Between the two, the app
thinks the money is gone *and* the shares have not arrived.

The statement says both legs move on settle date: July's closing Brokerage Cash Balance is
**$1,679.93 and still contains the $1,566.50** for a trade that had not settled.

**Measured, not estimated** — net-worth series before vs after the rebuild, dips >$500 that recover
within 3 days:

| | count |
|---|---|
| new dips introduced | **14** (largest **$5,334.95**, 2025-07-08, recovers next day) |
| dips removed | 6 |

The old book hid this by being Activity-dated on *both* legs — two errors cancelling into a right
total over wrong parts. Fixing one exposed the other, which is the honest outcome, but it runs
against a rule the owner stated himself in `docs/inflight-dips.md`:

> *"It dips because I transferred from one account to the other and the money is in the air…
> Don't dip it — it's not a loss."*

**The fix is to move the Robinhood Cash trade legs to Settle Date too.** ⚠️ Not a one-liner: it
re-dates ~1,992 rows, and Robinhood Cash's statement reconciliation (703 unverified days → 0, won in
pass 40) reconciles against the *current* dating. Trial it with `--db=` first and re-check every
period. `docs/inflight-dips.md` §"Proposed fix" is the alternative if re-dating proves too invasive.

---

## 6. Also measured this pass

**The remaining $197.63 on 2026-07-31 is price source, not quantities.** Brokerage value
$67,661.63 vs the statement's $67,859.26, with all nine quantities exact. It is entirely the
difference between the app's cached closes and the marks Robinhood printed:

| | statement | app | per-share |
|---|---|---|---|
| AAPL | $308.91 | $301.28 | −$7.63 |
| UNH | $414.40 | $420.49 | +$6.09 |
| META | $556.71 | $548.91 | −$7.80 |
| GOOG | $356.65 | $356.65 | **exact** |

Worth a look on its own terms (0.29%), but it is not a holdings defect.

**A latent bug the tests caught before the data did.** `calibrateRounded` summed peer events from
*every* symbol, not just the one being calibrated. It produced correct output only because it runs
once, on the 2023-12-05 receipt, before any second symbol exists. A fixture with an unrelated MSFT
dividend broke it immediately.

**`sameDayRank` earned itself.** The reconstruction threw `AAPL goes negative on 2025-06-24` on
first run against real data: a 0.099319 buy and an 18.184176 sell settle together against 18.084857
held. Only non-negative if the buy lands first. The intra-day order changes no position, but it
changes the average cost a sale releases.

---

## 7. The queue, as it now stands

1. ⛔ **Move the Robinhood Cash trade legs to Settle Date** (§5) — the last known-wrong thing about
   Robinhood, now precisely located and measured.
2. **Fix the all-time stats under the windowed chart** — `ReturnViewParts.tsx:89` computes best day
   / worst day / max drawdown over the FULL series while the chart shows a slice.
   ⚠️ `dailyReturns()` starts at `i=1`, so the slice must include one day BEFORE the window start.
3. **Wire `/investments` panels to `?range=`** — holdings, allocation, top movers, P&L heatmap.
   ⚠️ **Now unblocked:** `holding_events` is a real timeline again, and the 24 exited symbols are
   present as 0-quantity rows, so a historical view finally has something to read.
4. **`/flow` range** — `flow/page.tsx:44` hardcodes `2000-01-01` while `transfer-flow.ts:145`
   already honours a range. Cheapest win left.
5. **The transaction drawer + `/transactions` breadcrumb + name the filter chips.**
6. **Robinhood CRYPTO activity export** — would close July's `+$1,798.35`; the securities export
   carries no crypto. ⛔ Do NOT delete the `+$3,579.67` plug first.
7. **The 33 review rows** — several already settled by pass 40 §12.
8. ⛔ **Hosting LAST.**

**Closed this pass:** pass 40's items 1 (holdings rebuild) and 6's premise — the securities CSV was
already imported and complete through 2026-07-31; no fresh export is needed for the share book.
