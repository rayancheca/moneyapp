# 🕊️ In-flight money — the net-worth dip rule (user-explained, 2026-07-18)

The user, looking at the Mar 22 – Apr 5 2026 dashboard window (drop from ~$72.3k to ~$57.5k, recovered Apr 1):

> "It dips because I transferred from one account to the other and the money is in the air whilst it
> transfers. Don't dip it — it's not a loss. It technically is, because the money left and was gone during
> the transfer period, but I don't want to see that. Do the math and correct the graph for dips like this
> across the years, and give them to me to review before acting on them."

**THE RULE:** money in transit **between the user's own accounts** is still the user's money. The net-worth
chart must bridge those windows instead of dipping. But a dip must NEVER be bridged when the money truly
left (a wire to family, a real purchase) or when the market moved — those are honest declines.

## The two flavors of "money in the air"

1. **Cross-account transfer gaps** — leg A posts (money leaves) days before leg B posts (money arrives).
   Evidence: a `transfer_group_id` pair whose legs post on different days. 16 windows found (1–3 day gaps,
   $1k–$14.9k, mostly Chase→Robinhood / Chase→SoFi).
2. **Robinhood sell-to-rebuy windows (the long-open P0.1 gap)** — the user sells stock, proceeds sit as
   *brokerage cash* (which the app does not model), then get re-invested days later. The chart shows the value
   vanishing at the sale and reappearing at the re-buy. **This is the user's Mar 26–31 example**: Mar 27 sold
   $15,326 SPY + $3,017 GOOG; Mar 31 re-bought $7,655 SPY; brokerage balance dipped $57.8k→$38.9k→$53.0k.
   The honest fix is modeling RH brokerage cash from the activity ledger (P0.1) — not a cosmetic bridge.

## Dip scan (all years, ≥$3k drop, recovery ≤14 days) — FOR USER REVIEW

| dip starts | drop | recovered by | my classification |
|---|---|---|---|
| 2024-01-03 | $4,891 | 01-16 | likely RH sell-window — verify |
| 2025-08-12 | $14,657 | 08-21 | ✅ in-flight: Chase→RH paired transfers 08-11 + 08-20 |
| 2025-10-27 | $6,970 | 10-28 | 1-day gap — likely paired transfer / verify |
| 2026-02-26 | $3,441 | 03-02 | verify (transfer or sell-window) |
| **2026-03-27** | **$12,962** | **03-31** | ✅ **the user's example: RH sell→rebuy (P0.1)** |
| 2026-06-05 | $3,076 | 06-15 | verify |
| 2026-06-16 | $3,442 | 06-22 | verify |
| 2026-07-08 | $3,360 | 07-10 | verify |
| 2026-07-11 | $6,909 | 07-15 | verify |

**Never-recovered drops the scan also surfaced — these are NOT dips and must NOT be bridged:**
- 2026-03-04 −$22,446 and 2026-05-07 −$26,419 and 2025-12-12 −$18,670 → the **dad pass-through wires OUT**
  (real money leaving; the matching inflow arrived earlier — see Transfers › Family pass-through).
- 2025-06-23 → 07-12 staircase (~$46k over 3 weeks) → the crypto/market decline + spending era; honest losses.
- 1-day paired-transfer dips whose receiving account has sparse statement coverage may show as unrecovered
  (e.g. 2025-01-29 Chase→SoFi $10k) — the money arrived but the receiving account's daily coverage lags; these
  ARE bridgeable with the pair as evidence.

## Proposed fix (after user sign-off)

1. **Family 1 (transfer gaps):** an *in-flight adjustment layer* in `netWorthSeries` (pure-lib TDD): for each
   active transfer pair whose legs post on different days, add back the in-flight amount on days
   `[outDay, inDay)`. Display-honesty: mark bridged days like carried days (the tooltip can say "in transit").
   Never touches stored balances or transactions.
2. **Family 2 (RH cash, P0.1):** model Robinhood brokerage cash from the activity ledger (deposits,
   withdrawals, buys, sells, dividends) so sale proceeds are an asset the day they exist —
   `data/rebuild-robinhood-cash-2026-07-10.ts` is the pass-10 starting point. This closes every sell-window
   dip honestly and permanently.
3. **Explicitly out of scope:** bridging anything without pair/ledger evidence; the wires-out; market moves.

Verification per window before shipping: for each bridged day, assert the bridge amount equals the evidenced
in-flight sum and that month-end totals still reconcile to statement anchors.

## ✅ USER DECISION (2026-07-18, interactive)
Approved BOTH parts: (1) bridge paired-transfer gaps, (2) model RH brokerage cash (P0.1). Style: **subtle
mark** — the line doesn't dip; scrubbing a bridged day says "includes $X in transit". Dad-wires-out and
market declines stay untouched. Build order: bridging layer (pure-lib TDD on netWorthSeries) → P0.1 RH-cash
rebuild from the activity ledger → regenerate dashboard baselines → per-window before/after verification
against statement anchors.

---

# 🛠️ PASS 19 — SHIPPED, and what the data actually said (2026-07-18)

Both parts landed (`src/lib/in-flight.ts` + `src/services/in-flight.ts` + the chart marks; the guarded
`data/rebuild-rh-cash-2026-07-17.ts` ledger move). The build taught us four things this doc's plan had wrong
or didn't know — each is now a RULE:

## 1. The float is usually the OTHER way round: "doubled", not "missing"
The plan assumed the out-leg posts first and money vanishes. Reality (111 evidenced windows):
**102 are the receiving side crediting FIRST** (Robinhood/SoFi credit instantly; Chase debits a day later)
— the raw chart showed phantom one-day SPIKES (money in two accounts), only 9 true dips. The layer handles
both signs: `+amount` where money is visible nowhere, `−amount` where it's visible twice.
**RULE — the per-day law:** the pair's money must appear in the total EXACTLY ONCE. `target(D)` = 1 while
any visible ledger claims it (or while in the air); `counted(D)` = how many visible ledgers actually show
it; correction = `amount × (target − counted)`. Days where an account is INVISIBLE (basis `gap`, or before
its first covered day) are coverage-honesty's job (the partial flag), never this layer's — adversarial
review proved bridging them would double-correct.

## 2. P0.1 was a MOVE, not an import — and never write daily_balances directly
The entire activity CSV had already been imported as **2,181 transactions sitting inert on the
investment-type Brokerage account** (investment curves are qty×close; replay never runs). The durable fix
was to move that ledger to Robinhood Cash (checking) + mirror the 64 asset-signed crypto rows as negated
cash legs + one labeled $3,579.67 reconciliation row, then let normal anchor+replay derive the curve.
The pass-10 script had written daily_balances directly — **a later rebuildAccount wiped it** and RH Cash
sat at $0-carried ever since. **RULE: daily_balances is a derived cache; durable balance truth lives only
in transactions + anchors.** (Import routing now prefers the "Robinhood Cash" account when it exists —
`AccountHint.preferName` — so future activity exports land on the moved ledger and dedupe correctly.)

## 3. The Jun–Jul 2025 "staircase" was NOT mostly honest losses — the doc was wrong
This doc classified 2025-06-23→07-12 (~$46k down) as "market decline + spending era; honest losses."
With cash modeled: **up to $43.5k of it was settlement cash sitting in Robinhood** (the SoFi→RH era).
Post-fix the same window reads ~$68k → ~$62k — a real but ~$6k decline. Aug-2025's rollercoaster
($47k→$32k→$47k) flattens to ~$78k once the two floats correct. The tail of the chart was right all along
(the pass-10 live anchor covered "today"); it was the HISTORY that lied.

## 4. Dip-table verdicts (re-scanned post-fix, all laws machine-checked)
- **CLOSED**: 2025-08-12 ($14.7k→−$137), 2026-03-27 (the user's example — raw drop now $339), 2025-10-27,
  2026-07-11.
- **STAND (honest)**: 2024-01-03 −$4,891 (recovered 01-16 — NOT a sell-window; cash modeling didn't close
  it, so it's real), 2026-02-26, 2026-06-05, 2026-06-16, 2026-07-08 (recovered market moves, no pair/ledger
  evidence — exactly what must not be bridged).
- **NEVER-BRIDGE verified**: dad wires 2025-12-12/2026-03-04/2026-05-07 keep their full drops (the 12-12
  "$2.5k difference" is a neighboring float's honest end, not the wire).
- Machine laws: every float's |Δ| equals its pair's evidenced amount; per-day bridged−raw == Σ covering
  floats == the point's `inTransitCents`; re-run via `data/report-dip-scan-2026-07-17.ts`.

## Known maintenance edges (tracked, not silent)
- **Crypto cash legs are one-shot**: future crypto statement imports won't auto-mirror cash legs onto
  Robinhood Cash — the cash curve drifts by the trade amount until re-mirrored (backlog: generate the cash
  leg in the crypto import profile).
- **Fresh installs** keep pre-P0.1 behavior (activity rows fall back to the brokerage account until a
  "Robinhood Cash" account exists); the fixture/e2e world models brokerage statements WITH cash included,
  so it must not gain a separate cash account until the fixture architecture is reworked.
- The brokerage **qty timeline** still comes from the holding-events backfill scripts, not the activity
  import (unchanged by this pass).
