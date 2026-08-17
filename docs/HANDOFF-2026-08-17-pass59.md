# Handoff — 2026-08-17, pass 59

> **`main` = `3774588`** (this doc will follow), tree clean.
> tsc clean · **165 files / 3,042 unit** (was 163 / 3,016) · coverage gate exit 0 ·
> **`pnpm ledger-check` exit 0** (new).
> e2e NOT re-run this pass — no rendered surface changed; see §5.
>
> One real-DB write: one deleted transaction. Net worth and today's balance
> unchanged, asserted rather than assumed.
>
> The pass started on the handoff's top item — the "$231.85 shortfall in
> 2026-07" — and that number turned out to be **fiction produced by a
> fabricated row**. Chasing why led to the root cause of *every* remaining gap
> day in the ledger, which is a single dropped statement row type.

## 0. Read this first

**`excluded` hides a row from analytics but NOT from the balance chain — that is
where a plug lives.** A hand-entered +$3,579.67 row sat on Robinhood Cash at
2026-07-10, described *"Reconciliation — Robinhood settlement residual vs
verified live cash"*, its own note calling it an approximation. No import file,
no statement period: its amount was **chosen so the ledger would agree with a
live balance reading**. Because `excluded` is inside `REPLAY_STATUSES`, it moved
money in the chain while being invisible in every spend and income view. July
reported a **$231.85** gap against a real **$3,811.52** — a reconciliation
arbiter under-reporting a hole by 16×, which is the one thing it cannot do.

**Before calling two remedies equivalent, check which arbiter reads which status
list.** I offered the owner "quarantine it — same effect as deleting". That was
wrong. Replay reads `['active','excluded']`; reconciliation reads
`['active','quarantined','excluded']`. Quarantining would have fixed the balance
chain and left the false $231.85 verdict standing. He chose delete, so no harm
landed, but the recommendation was defective.

**A stored verdict is a snapshot, and nothing revisits it.**
`statement_periods.reconciliation` and `gap_cents` are written **only** at import
time. Not `rebuildAccount`, not a status flip, not a deletion. So a period can go
on asserting a number that was true once — which is half of why the plug
survived. `pnpm ledger-check` now recomputes every verdict and fails on drift.

**A probe that picks its own endpoints is measuring a different ledger.** Pass
58's anchor walk used *every* anchor; the derivation service uses only
chain-grade ones (`statement`, `manual`) and exempts `live`/`ofx_ledger` moments
from closure. So July's reported "two breaks around a `live` anchor" never
existed for the service — there was **one**. Real count **9 of 31 pairs, not 10
of 33**, and the two one-cent breaks hold **59** gap days, not 57. `selectEndpoints`
is now exported and used by both. (Also: a closure test applied to an
**investment** account manufactures breaks out of ordinary price moves —
Brokerage and Crypto "fail" every pair under a naive walk, because they replay no
transactions at all.)

**Read a docstring's REASON as a claim, not a fact.** §1.3.

## 1. Shipped

| # | commit | item |
|---|---|---|
| 1 | `ce7ee94` | the plug deleted; the pass-58 backlog entry corrected |
| 2 | `8af325f` | `pnpm ledger-check` — the arbiter for the arbiters |
| 3 | `3774588` | root cause of all 264 gap days; a false docstring corrected |

### 1.1 The plug (`ce7ee94`) — REAL-DB WRITE

Behind a restore point (`data/backups/pre-2026-08-17T151204-manual-backup.db`).
Deleted on the owner's explicit call.

The script re-proves the property the deletion was approved on rather than
asserting it: the last chain endpoint is the 2026-07-31 statement anchor
($1,680.38) and every day from 2026-08-01 derives from **that**, so a row on
2026-07-10 — inside a span whose 30 days are already `gap` — cannot move today's
number.

| | before | after |
|---|---|---|
| today's balance (2026-08-17) | $113.88 | **$113.88** (unchanged, asserted) |
| gap days | 264 | 264 |
| July 2026 stored gap | $231.85 | **$3,811.52** |
| every other account / period | — | byte-identical |

⚠️ It also **refutes trade date** as the mechanism behind the near-mirror pairs:
replaying on `transacted_on` instead of `posted_on` breaks four periods that
currently close to the cent (2025-02, 2025-06, 2025-07, 2025-10).
`posted_on = settle date` stands.

### 1.2 `pnpm ledger-check` (`8af325f`)

The plug walked past all three existing arbiters. Each answers *"is this period
right?"*; none answers the two that would have caught it:

1. does the **stored verdict** still describe the ledger underneath it?
2. how much of the money in the chain has **no source document**?

So the check asks those, plus the chain walk:

- **chain breaks**, using the derivation service's own `selectEndpoints`;
- **stale verdicts**, recomputed with the grading rule now extracted to
  `src/lib/reconciliation.ts` and called by `reconcileAccounts` itself — proven
  byte-identical across all **219** statement periods on the real database;
- **synthetic money**: net cents of replay-status rows with no import file, per
  account. Legitimately non-zero (crypto cash-leg mirrors, hand-entered Chase
  Sapphire activity, the car down payment), so the check is that it has not
  **moved**. This is the one that catches a plug.

The baseline is **exact, not a threshold** — a check tolerating "about nine
breaks" says nothing when a tenth arrives, and a break that changes size is a
different break. A break that **disappears** fails too: good news still has to be
written down, or the check calls it expected when it returns.

**Refuted, not assumed.** Against a `.backup` copy of the real DB: re-inserting
the plug fails it three ways (`changed-break`, `synthetic-drift`,
`stale-verdict`); rewriting July's stored gap alone fails it once; the unmutated
ledger exits 0. It also caught a sign error in the baseline I hand-wrote for it,
on its first run.

### 1.3 The root cause of all 264 gap days (`3774588`)

The Robinhood brokerage statement **prints `Crypto Money Movement` rows** in its
Account Activity table. **The ledger contains zero of them.** The parser drops
every one, and `pnpm rh-mirror-crypto-cash` reconstructs the same cash legs from
the *crypto* ledger instead.

Every break is exactly **(printed − mirrored)**. Measured against the source
PDFs, exact in all ten months:

| period | printed | mirrored | difference | stored gap | |
|---|---|---|---|---|---|
| 2025-10 | −$1,419.78 | −$1,419.78 | $0.00 | $0.00 | ✓ |
| 2025-11 | −$2,509.80 | −$2,529.59 | $19.79 | $19.79 | ✓ |
| 2025-12 | −$198.11 | −$178.20 | −$19.91 | −$19.91 | ✓ |
| 2026-01 | −$1,529.68 | −$1,539.55 | $9.87 | $9.87 | ✓ |
| 2026-02 | −$11,238.37 | −$11,228.36 | −$10.01 | −$10.01 | ✓ |
| 2026-03 | −$6,991.10 | −$6,991.09 | −$0.01 | −$0.01 | ✓ |
| 2026-04 | $1,188.92 | $1,188.93 | −$0.01 | −$0.01 | ✓ |
| 2026-05 | −$4,677.84 | −$4,577.81 | −$100.03 | −$100.03 | ✓ |
| 2026-06 | −$8,562.85 | −$8,662.83 | $99.98 | $99.98 | ✓ |
| 2026-07 | $3,811.52 | $0.00 | $3,811.52 | $3,811.52 | ✓ |

The "three different problems" of passes 57–58 are **one problem seen three
ways**: the near-mirror pairs are the mirror's approximation drifting over a
month end, the one-cent breaks are it off by a penny, and **July was never
mirrored at all**, which is the entire $3,811.52. It is not missing money. It is
money the statement prints and we throw away.

**The docstring that said this was impossible.** `parseSweepActivity` justified
reading direction from the running balance by asserting that column position
*"does not survive text extraction"*. **False.** `Line` carries
`tokens: { str, x }[]`, and `pdf-profile.ts` already filters on `t.x >= 350`. The
decision it defended is still right for the *sweep* table (it supports three
independent cross-checks), but the stated reason was load-bearing and wrong:
**Account Activity has no balance column at all**, so x-against-the-header is the
only way to sign those rows. A probe doing exactly that reads all 14 July rows
and nets $3,811.52 to the cent. Docstring corrected.

## 2. ⛔ NEXT — the migration, and why it needs sign-off

Recorded in `docs/future-ideas.md`. It is **not** just a parser change:

1. parse `Crypto Money Movement` by column x, with tests;
2. **bump the parser version** — a parser fix never reaches already-imported files;
3. **`pnpm trial-import` FIRST** — a bank changing how it prints makes rows
   disappear silently rather than fail (pass 52);
4. re-import the Robinhood statements, and **delete the hand-entered mirror rows
   in the same operation, or every crypto leg double-counts**. There is currently
   −$35,938.28 of synthetic money in the chain; `ledger-check` tracks that total;
5. `pnpm ledger-check` should then report zero breaks; empty the baseline.
   Expect **gap days 264 → 0**.

Step 4 moves real money across ten months. **Get the owner's sign-off before it.**

## 3. Still open (unchanged from pass 58 unless noted)

- **Robinhood Brokerage still has no arbiter** (P0.1). Every one of the 32
  statements prints `Portfolio Value`; the parser reads it only in the detection
  gate and discards it. ⚠️ `Total Market Value` is the stock-LENDING subtotal.
- **The ForecastCard** was not touched, again. Five equal-weight numbers, no
  hierarchy. The owner has not asked for it; the ledger work outranked it twice.
- **`paid_different` has no rendered coverage anywhere** — no seeded posting lands
  outside its tolerance band.
- **The recurring calendar has no week-level total**; adding one needs a decision
  about `role="grid"` semantics (an 8th column breaks the 7-day arrow-key math).
- ~~Tolerate an explained settlement difference, or keep the hard line?~~
  **This question is withdrawn.** §1.3 shows the residuals are not settlement
  timing at all — they are approximation error in a script that will be deleted by
  the migration. Do not ask the owner to set a tolerance for a mechanism that is
  about to stop existing.

## 4. The `live` anchor at 2026-07-10 — left in place, deliberately

$7,235.65, `source='live'`, no import file. Pass 58 flagged it. It is **inert**:
moments are never chain endpoints, and the `liveToday` display override only
fires when `anchoredOn === today`. It is also a real observation someone read off
the app, so it has evidentiary value. ⚠️ It does violate the schema note that
`'live'` is *"only ever written for today"* — worth a look, but it is not
currently costing anything.

## 5. Notes for the next session

- **e2e was not re-run.** Nothing rendered changed this pass — the diff is one
  deleted DB row, two new pure libs, one script, and docstrings. `pnpm e2e` is
  ~428 tests and the pass-58 run is still representative. Re-run it before any
  UI work.
- **`data/` probes from this pass** (gitignored): `probe-chain.ts` (the corrected
  chain walk), `probe-window.ts`, `probe-boundary.ts`, `probe-datebasis.ts` (the
  trade-date refutation), `probe-statement-crypto.ts` and `probe-crypto-vs-gap.ts`
  (the two that found the root cause), `drop-reconciliation-plug.ts`.
- ⚠️ `reconcileAccounts` has a **side effect**: a non-closing period flips its own
  file's rows to `quarantined`, pulling them out of replay. On Robinhood Cash it
  matches **zero** rows (statement periods and transactions come from different
  import files), so the policy is silently dead there. Assert statuses are
  unchanged around any call to it — `drop-reconciliation-plug.ts` shows the shape.
- **`transactions` has no `description` column** — it is `raw_description` /
  `normalized_description`. `statement_periods` has no `opening_balance_cents` —
  it is `beginning_balance_cents` / `ending_balance_cents`.
- The **git-push auth gotcha from pass 58 recurred and the workaround still
  works**, used for all three pushes this pass:

      git -c credential.helper='!gh auth git-credential' push origin main
