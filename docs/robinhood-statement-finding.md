# Robinhood: why the 32 statements are not yet parseable

> ⛔ **SUPERSEDED 2026-08-06 (pass 40). The central claim in this document is WRONG.**
>
> §2 concluded that `Robinhood Cash` "is not Robinhood's cash" by comparing the app's balance
> against the statement's `Brokerage Cash Balance` line — while ignoring the `Deposit Sweep Balance`
> line printed directly beneath it, which is where the money actually sat. At 2025-07-31 this
> document reads `$35.00`; the sweep line that month read `$41,532.16`, and the app was within
> $100.04 of the true total.
>
> `Robinhood Cash` IS a settlement-cash account, it IS a legitimate reconciliation target, and it
> needed no modelling decision and no change to `reconcileAccounts` — only statements, because it is
> type `checking` and the cash branch already gates it arithmetically. All 32 statements are now
> imported. §3's two CODE claims about *investment* accounts remain true and still apply to
> Robinhood **Brokerage**; §5's stated discriminator was also false (`Robinhood Brokerage Statement`
> appears in 0 of 32 files).
>
> See `docs/HANDOFF-2026-08-06-pass40.md`. Kept for the record, not for guidance.


**Measured 2026-08-05.** The owner downloaded 32 consecutive monthly Robinhood brokerage
statements (2023-12 → 2026-07, zero gaps) so that Robinhood could finally have an arbiter. They
are real, complete, and rich. **They are still not importable, and the blocker is a modelling
decision rather than a missing parser.** Writing the parser first would produce something that
either does nothing or actively lies.

This document exists so the next pass does not re-derive any of it.

---

## 1. What the statement actually contains

From `07/01/2026 to 07/31/2026` (27 pages, ~40k chars of extracted text):

| Section | Content |
|---|---|
| Account Summary | `Brokerage Cash Balance $192.22 → $1,679.93`, `Deposit Sweep $0.07 → $0.45`, `Portfolio Value $59,522.17 → $69,539.64`, `Total Securities $59,329.88 → $67,859.26` |
| Portfolio Summary | every position: symbol, CUSIP, qty, price, market value, est. dividend, % of portfolio |
| Account Activity | itemised transactions — `Description / Symbol / Acct Type / Transaction Date / Qty / Price / Debit / Credit` |
| Brokerage-held Cash Activity | a **running-balance ledger**: `Opening $192.22`, per-day debit/credit/balance rows, `Closing $1,651.02`, `Total $8,584.63 / $10,043.43` |
| Executed Trades Pending Settlement | trades not yet settled at period end |

**The cash ledger closes exactly**: `192.22 − 8,584.63 + 10,043.43 = 1,651.02`. That is a genuine
arithmetic identity, and it is the arbiter Robinhood has never had in this app.

Note the two cash figures differ: Account Summary closing `$1,679.93` vs cash-ledger closing
`$1,651.02`, a `$28.91` difference which equals the period's `Dividends $28.91`. Whichever is
adopted, they are not interchangeable.

---

## 2. 🔴 The blocker: the app's "Robinhood Cash" is not Robinhood's cash

The obvious plan — reconcile the statement's cash balances against the app's `Robinhood Cash`
account — is wrong, and the numbers say so loudly. Statement `Brokerage Cash Balance` vs the app's
`Robinhood Cash` daily balance on the same dates:

| period start | stmt cash open | stmt cash close | app open | app close |
|---|---|---|---|---|
| 2025-06-01 | $0.00 | $0.00 | $3.19 | $14,146.14 |
| 2025-07-01 | $0.00 | $35.00 | $14,046.14 | $41,467.12 |
| 2025-08-01 | $35.00 | $0.00 | $41,367.12 | $29,895.19 |
| 2026-03-01 | $330.58 | $8,244.52 | $1,975.53 | $1,965.32 |
| 2026-06-01 | $0.38 | $192.22 | $2,020.71 | $1,612.36 |

Robinhood's cash balance sits near **$0** — it is uninvested settlement cash, swept nightly. The
app's `Robinhood Cash` runs to **$41,467**. They are not the same series and never were.

**Why:** the app's account was built from the activity CSV, and its composition is

| kind | rows | net |
|---|---|---|
| other (trade rows) | 2,068 | +$30,677.55 |
| dividend | 68 | +$180.13 |
| interest | 28 | +$433.42 |
| bank transfer | 17 | +$6,883.38 |

**2,068 of 2,181 rows are trades.** `Robinhood Cash` is an all-activity ledger, not a cash balance.
Forcing a reconciliation between it and the statement's cash figure would manufacture a gap of tens
of thousands of dollars per period that means nothing — the pass-38 lesson exactly: *a difference
that equals the gap is not proof of a mechanism.*

---

## 3. 🔴 The second blocker: an investment account cannot fail reconciliation, and ignores anchors

Two independent reasons a Portfolio-Value-anchor parser would not help `Robinhood Brokerage`:

1. **`reconcileAccounts` cannot fail for `type='investment'`** (`service.ts:1190-1196`). It stamps
   `value_anchor` unconditionally and absorbs any discrepancy into `market_change_cents`. Creating
   32 statement periods would create 32 periods that are *incapable* of reporting a problem — the
   account would look arbitrated while nothing checks it. That is worse than the honest
   `market_value` grade it carries today.
2. **The anchors would be ignored anyway.** `rebuildAccount` (`derivation.ts:252-271`) returns early
   into `rebuildInvestmentHistory` whenever the account has any `holding_events`. Robinhood
   Brokerage has **1,925**. The `balance_anchors` path below that branch is never reached, so
   month-end Portfolio Value anchors would be written and silently unused.

---

## 4. What the next pass has to decide first

These are design decisions, not parsing work. **Ask the owner — do not pick one silently.**

1. **What should `Robinhood Cash` represent?**
   - (a) Robinhood's actual settlement cash (near $0) — then the existing 2,181 rows are
     mis-modelled and the trade rows belong to the brokerage account, which is a migration touching
     ~$378k of movement.
   - (b) An all-activity ledger, as today — then it can never reconcile against a statement, and it
     should be graded honestly rather than given a fake arbiter.
2. **Should investment accounts get a real arithmetic gate?** The cash-side identity is available
   (§1) and would work. A quantity-side identity (opening qty + buys − sells = closing qty per
   symbol) is also available from the Portfolio Summary. Either is a change to `reconcileAccounts`,
   not to a parser.
3. **Only then** write `robinhood-brokerage-statement-pdf`. The extraction itself is
   straightforward — the sections are well-delimited and the cash ledger closes to the cent.

---

## 5. Gate for the parser when it is written

- `matchesContent` must select the brokerage statement WITHOUT catching the crypto one. The crypto
  profile already documents the discriminator at
  `robinhood-crypto-statement-profile.ts:88-92`: the brokerage statement says
  `Robinhood Brokerage Statement` / `Portfolio Summary` and carries neither `Crypto Statement` nor
  `PERIOD START`.
- Today all 32 files match **no** profile at all, so an import reports
  `"No parser profile matched this file"` per file and writes nothing. That is a safe failure and
  needs no interim guard.
