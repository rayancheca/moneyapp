# Handoff — 2026-08-17, pass 59

> **`main` = `2bc1448`** (this doc will follow), tree clean.
> tsc clean · **166 files / 3,050 unit** (was 163 / 3,016) · coverage gate exit 0 ·
> **`pnpm ledger-check` exit 0** (new) · e2e re-run, see §6.
>
> Two real-DB writes, both behind restore points, both asserting that today's
> balance and net worth could not move — and both proving it.
>
> **Gap days across the entire ledger: 264 → 0. No account is `broken`.**
>
> The pass started on the handoff's top item, the "$231.85 shortfall in
> 2026-07". That number was fiction produced by a fabricated row. Chasing why
> led to the root cause of *every* remaining gap day in the ledger — a single
> dropped statement row type — and the owner signed off on the migration that
> closed it.

## 0. Read this first

**`excluded` hides a row from analytics but NOT from the balance chain — that is
where a plug lives.** A hand-entered +$3,579.67 row sat on Robinhood Cash at
2026-07-10, described *"Reconciliation — Robinhood settlement residual vs
verified live cash"*, its own note calling it an approximation. No import file,
no statement period: its amount was **chosen so the ledger would agree with a
live balance reading**. Because `excluded` is inside `REPLAY_STATUSES` it moved
money in the chain while being invisible in every spend and income view. July
reported **$231.85** against a real **$3,811.52** — an arbiter under-reporting a
hole by 16×.

**"The CSV covers this day" is not "the CSV covers this row".** The migration's
first attempt inserted **nothing**, silently: `FORMAT_PRIORITY` makes a CSV
outrank a PDF, so the activity CSV's day-coverage suppressed all 109 crypto rows
as `skippedOwned` and the import reported `inserted 0`. The rule is right in
general and wrong for a row type the other source *documents that it excludes* —
the Robinhood CSV's own footer says it omits crypto activity, and it does (zero
`COIN` codes in any of three exports). Hence `CanonicalTxn.soleSource`.

**And `trial-import` never printed `skippedOwned`,** while the service comment
calls it *"visible, never silent"*. It was neither: 448 skipped rows reported as
`inserted 0`. Now printed, with `supersededTakeover`.

**Before calling two remedies equivalent, check which arbiter reads which status
list.** I offered the owner "quarantine it — same effect as deleting". Wrong:
replay reads `['active','excluded']`, reconciliation reads
`['active','quarantined','excluded']`. Quarantining would have fixed the chain
and left the false $231.85 verdict standing. He chose delete, so no harm landed.

**A stored verdict is a snapshot and nothing revisits it.**
`statement_periods.reconciliation`/`gap_cents` are written **only** at import
time — not by `rebuildAccount`, not by a status flip, not by a deletion. Half of
why the plug survived. `pnpm ledger-check` now recomputes every verdict.

**A probe that picks its own endpoints measures a different ledger.** Pass 58's
walk used *every* anchor; the derivation uses only chain-grade ones and exempts
`live`/`ofx_ledger` moments. July's "two breaks around a `live` anchor" never
existed — there was one. Real count **9 of 31 pairs, not 10 of 33**; the
one-cent breaks held **59** gap days, not 57. `selectEndpoints` is now exported
and used by both. (A closure test applied to an **investment** account also
manufactures breaks out of ordinary price moves.)

**Read a docstring's REASON as a claim, not a fact.** §1.3.

## 1. Shipped

| # | commit | item |
|---|---|---|
| 1 | `ce7ee94` | the plug deleted; the pass-58 backlog entry corrected |
| 2 | `8af325f` | `pnpm ledger-check` — the arbiter for the arbiters |
| 3 | `3774588` | root cause of all 264 gap days; a false docstring corrected |
| 4 | `2aa236f` | **the migration — gap days 264 → 0** |
| 5 | `2bc1448` | the brokerage arbiter, measured |

### 1.1 The plug (`ce7ee94`) — REAL-DB WRITE

Restore point `data/backups/pre-2026-08-17T151204-manual-backup.db`. Deleted on
the owner's explicit call. The script re-proves the safety property rather than
asserting it: the last chain endpoint is the 2026-07-31 statement anchor, so a
row on 2026-07-10 — inside 30 days already graded `gap` — cannot move today's
number. It did not ($113.88 → $113.88).

⚠️ It also **refutes trade date** as the mechanism behind the near-mirror pairs:
replaying on `transacted_on` breaks four periods that currently close to the
cent (2025-02, 2025-06, 2025-07, 2025-10). `posted_on = settle date` stands.

### 1.2 `pnpm ledger-check` (`8af325f`)

The plug walked past all three existing arbiters, each of which answers *"is this
period right?"*. It asks the two that would have caught it — does the **stored
verdict** still describe the ledger, and how much money in the chain has **no
source document** — plus the chain walk using the derivation's own
`selectEndpoints`. The grading rule moved to `src/lib/reconciliation.ts` and
`reconcileAccounts` now calls it, so a recompute uses the arithmetic that wrote
the value; proven byte-identical across all **219** statement periods.

Baseline is **exact, not a threshold**, and a **disappearing** break fails too —
good news still has to be written down. That paid off immediately: after the
migration it reported all nine breaks as `fixed-break` rather than passing
quietly. Refuted against a `.backup` copy: re-inserting the plug fails it three
ways; rewriting July's stored gap fails it once. It also caught a sign error in
the baseline I hand-wrote for it.

### 1.3 The root cause (`3774588`)

The Robinhood statement **prints `Crypto Money Movement` rows**; the ledger held
**zero**. `rh-mirror-crypto-cash` reconstructed the same legs from the *crypto*
ledger. Every break was exactly **(printed − mirrored)** — exact in all ten
months. July was never mirrored at all, which was the whole $3,811.52.

**The docstring that said the fix was impossible.** `parseSweepActivity`
justified reading direction from the running balance by asserting column position
*"does not survive text extraction"*. **False** — `Line` carries
`tokens: { str, x }[]` and `pdf-profile.ts` already filters on `t.x >= 350`. The
decision it defended is still right for the *sweep* table, but the reason was
load-bearing and wrong: **Account Activity has no balance column**, so
x-against-the-header is the only way to sign those rows.

### 1.4 THE MIGRATION (`2aa236f`) — REAL-DB WRITE

Restore point `data/backups/pre-2026-08-17T160014-manual-backup.db`.
Parser **v2** reads the rows by column x (`robinhood-crypto-movement.ts`,
8 unit tests). Then: delete the 74 approximated legs, re-import the 32
statements. **Both halves in one operation** — importing alone double-counts
(measured: 264 → 234 gap days and 69 rows quarantined).

| | before | after |
|---|---|---|
| gap days (whole ledger) | 264 | **0** |
| Robinhood Cash grade | `broken` | **`unverified`** (ordinary staleness) |
| periods 2025-10 → 2026-07 | 9 `gap` | **all `reconciled`, $0.00** |
| synthetic money on the account | −$35,938.28 | **$0.00** |
| net worth | $101,594.99 | **$101,594.99** (asserted) |
| today's balance | $113.88 | **$113.88** (asserted) |

109 inserted · 0 deduped · 0 skippedOwned · 0 quarantined. **No account is
`broken`.** The 109 rows land `active`, category `Transfers`, 0 needing review —
note they are *active* where the old mirrors were *excluded*, so they are now
visible in transaction views (correctly: they are real printed movements).

## 2. ⛔ NEXT — Robinhood Brokerage, the last account without an arbiter

Measured this pass; the numbers are in `docs/future-ideas.md`.

It has **6 anchors, all `source='live'` hand readings, and 0 statement periods**.
Its daily values come from the holdings valuation, not those anchors.

**The right anchor is `Total Securities`, NOT `Portfolio Value`.** Verified:
Portfolio Value = Total Securities + Brokerage Cash + Deposit Sweep
($67,859.26 + $1,679.93 + $0.45 = $69,539.64). `Robinhood Cash` already carries
the cash, so anchoring on Portfolio Value **double-counts it** — by $41,567.16 in
2025-07, where cash dwarfed securities. ⚠️ `Total Market Value` is the
stock-LENDING subtotal; and a second account section (#655929651, $26.64)
repeats both labels, so take the FIRST occurrence only.

Across the 24 statements printing it: **16 exact, 2 within a cent, 6 that
genuinely disagree** (worst −$667.86 on 2025-04-30; −$197.62 on the most recent).
So the holdings model is broadly right and wrong in six places — the case for an
arbiter rather than trust. `data/probe-brokerage-value.ts` does the measurement.

## 3. Still open

- **The ForecastCard** — five equal-weight numbers, no hierarchy. Untouched for a
  third pass; the owner has not asked, and ledger integrity outranked it.
- **`paid_different` has no rendered coverage anywhere** — no seeded posting lands
  outside its tolerance band.
- **The recurring calendar has no week-level total**; an 8th column would break
  the 7-day arrow-key math under `role="grid"`.
- **Consider calling `reconcileAccounts` from `rebuildAccount`** so a stored
  verdict cannot go stale at all. ⚠️ It has a side effect — a non-closing period
  flips its own file's rows to `quarantined`, pulling them from replay. On
  Robinhood Cash that matched zero rows *before* this pass (periods and
  transactions came from different files); **after the migration the crypto rows
  DO belong to the statement's file**, so the policy is live there now. Every
  period closes, so nothing is quarantined today — but the safety margin is gone.
  Assert statuses around any call.

## 4. The `live` anchor at 2026-07-10 — left in place, deliberately

$7,235.65, `source='live'`, no import file. Inert: moments are never chain
endpoints and the `liveToday` override only fires when `anchoredOn === today`.
It is a real observation with evidentiary value. ⚠️ It does violate the schema
note that `'live'` is *"only ever written for today"*.

## 5. `data/` probes from this pass (gitignored)

`probe-chain.ts` (corrected chain walk) · `probe-window.ts` · `probe-boundary.ts`
· `probe-datebasis.ts` (trade-date refutation) · `probe-statement-crypto.ts` and
`probe-crypto-vs-gap.ts` (found the root cause) · `probe-brokerage-value.ts` ·
`drop-reconciliation-plug.ts` · `migrate-crypto-movements.ts` · `copy-db.ts`.

`migrate-crypto-movements.ts` is the template for a two-halves-must-agree
migration: Δ-guards on the exact row count and net, dry-run against a `.backup`
copy via `--db`, and a post-condition that throws rather than leaving a bad
database.

## 6. Notes for the next session

- **e2e**: full suite re-run this pass after the import-service change — see the
  final line of §7 below for the count. The seed is generated by the seeder, not
  by imports, so the blast radius was small, but the service change warranted it.
- **`transactions` has no `description` column** — `raw_description` /
  `normalized_description`. `statement_periods` has no `opening_balance_cents` —
  `beginning_balance_cents` / `ending_balance_cents`.
- **`importStatementFiles` is `async` and returns `FileOutcome[]`** directly, not
  an object with `.files`.
- **`better-sqlite3`'s `.backup()` is async** and top-level `await` fails under
  tsx's cjs transform — wrap it in a `main()`. Use it, never `cp` (pass 44).
- The **git-push auth gotcha** recurred; this workaround worked for all pushes:

      git -c credential.helper='!gh auth git-credential' push origin main
