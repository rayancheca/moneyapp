# Handoff — 2026-08-17, pass 57

> **`main` = `902af37`** (plus this doc), tree clean. tsc clean · **2,984 unit** ·
> coverage gate exit 0 · **`E2E_GATE=1` 415 passed** (414 before; the account-detail price-age test is new) · **zero baseline churn**.
>
> Real-DB writes this pass: the Venture X August statement (50 rows), and the
> ten Robinhood crypto cash legs. Net worth **$90,942.53 → $101,594.99**, and
> every cent of that move is the Venture X card payment.

## 0. Read this first

**The backlog's own P0 was mostly false, and I only found that by re-measuring
it.** `docs/future-ideas.md` P0.1 said Robinhood brokerage cash "is missing from
the balance model", that `daily_balances` start 2025-02-20, that the pre-anchor
era is uncounted, and that ~$48k is invisible. **Four of those are false today** —
pass 42 moved the cash ledger onto `Robinhood Cash` and it has been modelled ever
since. Had I implemented the entry as written I would have built a second cash
model on top of a working one. The entry is now rewritten with what is actually
true and what is actually left.

**A green check can be green because it never ran the row.** `parseSweepActivity`
was written with the row pattern pinned to `FDIC Sweep`, which is what every row
in the sample looked like. It parsed 13 of 18 statements and I nearly wrote a
docstring claiming it was verified across the archive. Probing first is what
found `Interest Payment` rows inside the same table — and once those were read, a
SECOND check (last row vs printed closing balance) that had been failing on 12 of
those 13 statements also passed. **Three independent checks now guard it, and each
one caught something the other two could not.**

**A mutation harness lied again — the fifth time in this repo.** `perl -0pi -e
"s/\Q$from\E/\Q$to\E/"` escapes metacharacters on the REPLACEMENT side too, so it
wrote literal backslashes into the source. Every "mutation" produced a file that
did not compile, vitest printed no tally, and the harness happily reported
success. **The fix is in `data/tmp-mutate.sh` and is worth copying: it asserts the
file changed, asserts the mutant still `tsc --noEmit`s, prints the real tally, and
asserts the restore is byte-identical.** A mutant that does not compile proves
nothing.

**And one of my own tests was decoration.** Deleting the mutual-nearest guard from
`dropSettlementLag` left all ten of its tests green: my test asserted a COUNT and
a NET, and both implementations leave exactly one row worth $10.00. Only the
surviving row's *day* tells them apart.

## 1. Shipped

| # | commit | item |
|---|---|---|
| — | (no diff) | Venture X August 2026 statement imported |
| 1 | `b3979f2` | price age moves to the column header |
| 2 | `9c2a0ae` | the Deposit Sweep Activity table is read |
| 3 | `902af37` | ten Robinhood crypto cash legs recovered |

### 1.1 Venture X, August 2026 — 50 rows, reconciled to the cent

`statements/venture-x/Statement_082026_4208.pdf`. The existing Capital One
profile parsed it unmodified; **verified, not assumed** — every printed subtotal
was reconciled against the DB by hand before and after:

| printed | ledger |
|---|---|
| Previous Balance $11,020.45 | period begin −$11,020.45 ✓ (and = the prior period's close) |
| Payments − $12,913.45 | +1,291,345¢ ✓ |
| Other Credits − $110.21 | +11,021¢ ✓ (an IKEA return) |
| Total Transactions $2,371.20 | −237,120¢ ✓ |
| per-card $2,357.20 / $10.88 / $3.12 | −235,720 / −1,088 / −312 ✓ |
| New Balance = $367.99 | period end −$36,799 ✓, `reconciled`, gap null |

⚠️ **The brief said Venture X had never had a statement imported. It had** —
`Statement_072026_4208.pdf`, 2026-07-15, and six reconciled periods behind it.
What was missing was the `statements/venture-x/` **drop folder**; the earlier
files live only in the originals archive (`data/statements/capital-one-venturex-*`).
Coverage went `verified 2026-07-14 → verified 2026-08-14`; the statement schedule
now reads `waiting, next closes Sep 14`.

Two things worth knowing about that file:
- it carries **three card sections** (#4208, #9082, #4147) on one account, and all
  three subtotals land correctly;
- it prints `Upcoming statement closing date: September 12, 2026` — **a fact that
  beats our median**, which predicts the 14th. Capturing it is a small, real
  improvement to the schedule panel and is not yet in the backlog.

Also: `PROGRESSIVE INS $357.58` on 2025-08-12 does not match the $361.49 × 6 car
insurance series in memory. Not investigated — flagging it, not asserting it.

### 1.2 Price age moves to the column (`b3979f2`)

You asked for something better than "always on" or "only when they disagree", and
both were wrong for the same reason: they argued about *whether* to print a fact
instead of *where it lives*. A fact about every row belongs to the **column**.

```
every priced row shares one close → the Price column header carries the date
the rows disagree                 → each stale row carries its own
```

`priceColumnAge` returns both from one call, so they cannot double up or both
fall silent — which is exactly what pass 56 shipped: the per-row gate suppressed
itself precisely when every row agreed, and your ten holdings have agreed on an
Aug 6 close for eleven days. The date sits inside the `<th>`, so a screen reader
announcing a price cell says "Price as of Aug 6".

This also fixes `AccountHoldingsTable`, where `quotedOn` was computed per row and
dropped. **That page has no page-level price note at all**, so nothing on it
disclosed that Price, Day, Value, P/L and Alloc all came from a stored close.

### 1.3 The Deposit Sweep Activity table (`9c2a0ae`)

`Robinhood Cash` graded `broken` on 323 gap days and $1,911.24 across ten
periods, and its only arbiter was the month's printed opening and closing cash —
so it could say *a month* was wrong and nothing more.

The statements also print a **`Deposit Sweep Activity`** table: every movement of
uninvested cash with a running balance beside it. **309 rows across 18 of the 32
archived statements, and the parser threw all of them away.**

`pnpm rh-sweep-check` walks it beside the replayed ledger and names the days they
disagree. It compares **daily deltas, not balances** — the table tracks the sweep
while the account models sweep + brokerage-held cash, so the levels are
legitimately offset and the deltas are not.

Most disagreements are a **settlement lag**: the ledger dates the trade, the bank
dates the cash movement a day or two later, so each shows up twice with opposite
signs. `dropSettlementLag` pairs those on the transfer detector's doctrine —
exact amount, opposite sign, inside four days, mutually nearest — and 2025-04
goes from eight findings to clean.

### 1.4 The money that was actually missing (`902af37`)

Pass 42 mirrored 64 crypto cash legs; its earliest is **2025-11-04** and the
crypto account's first trade is **2025-10-16**. Ten trades in between had an
asset leg and no cash leg — the account spent $2,899.17 it never showed.

| | before | after |
|---|---|---|
| unreconciled on RH Cash | $1,911.24 | **$491.46** |
| 2025-10 | −$1,419.78 | **reconciled**, gap null |
| gap days | 323 | **293** |
| net worth | $101,594.99 | unchanged |

Net worth is unchanged because the correction sits inside an anchored historical
span — which is the shape a correct backfill should have.

**The last cent was decoded, not plugged.** 2025-10-16 reconciles to the printed
+$310.84 *without* the row I first placed on it, and 2025-10-17 needs exactly
$100.02 + $100.07 — so that trade settled on the 17th for $100.07. Moving it
closed October to zero and cleared its 30 gap days.

Two conventions the existing 64 rows taught the script before it wrote anything:
- they are **`status='excluded'`**, not `active`. `REPLAY_STATUSES` includes
  `excluded`, so the money still moves — but as `active` rows these would have
  injected **~$2,900 of phantom purchases into spending analytics**;
- `dedupe_hash` is the app's own sha256, not an ad-hoc string, so a future import
  collides with them instead of adding a second copy.

## 2. ⚠️ One decision that is yours

**Robinhood Cash still grades `broken`, and the remaining $491.46 may not be a
defect at all.** The residuals come in near-mirror pairs across adjacent periods
— +$19.79/−$19.91, +$9.87/−$10.01, −$100.03/+$99.98 — i.e. **one settlement
landing on the far side of a month end.** That is a timing truth, not lost money.

Reconciliation is binary at the cent, so one cent marks a whole 30-day span `gap`
and holds the account at `broken`. Two defensible directions:

- **tolerate an explained in-flight difference** — a period whose gap is matched
  by an opposite gap in the neighbouring period reconciles, and the UI says so.
  This is the same shape as P0.5 in-transit bridging; do them together.
- **keep the hard line** and accept that `broken` here means "off by ten dollars
  of timing", which is arguably what a hard line is for.

I did not pick. A tolerance is exactly the kind of mechanism that can hide a real
gap later, and that call is yours.

## 3. What is left

`docs/future-ideas.md` now holds **25 open, 2 partial, 35 done**. P0.1 has been
rewritten in place with the measured truth and four concrete remaining sub-items,
the two best of which are:

1. **Robinhood Brokerage has no arbiter at all** — 0 statement periods,
   `market_value` grade, so its reconciliation cannot fail and proves nothing.
   Every one of the 32 statements prints `Portfolio Value`, and
   `Portfolio Value = cash + Total Securities` holds **to the cent in 32/32**;
   `Total Priced Portfolio` prints it a second time and agrees 32/32. Capturing
   it gives qty×close a monthly check against the bank's own number.
   ⚠️ `Total Market Value` is the stock-LENDING subtotal, **not** securities.
2. **A coverage-grading artifact**: one leading `derived_unverified` day
   (2023-12-05) zeroes `verifiedThrough` for ~22 months of genuinely reconciled
   history, because `coverage.ts` counts trusted days strictly before the first
   untrusted one.

⛔ Hosting + auth remains LAST by standing instruction.

## 4. Notes for the next session

- **`pnpm rh-sweep-check` is the new lead-finder.** Era C (2026-02 onward) is
  noisy through it *by construction* — the sweep is near-empty there and the cash
  lives in `Brokerage-held Cash Activity` instead, whose rows the parser also does
  not read yet. Do not read era-C noise as defects without checking that first.
- **A `*/` inside a doc comment closes it.** `scripts/**/*.test.ts` written inside
  a block comment broke the file with an "unterminated template literal" 50 lines
  further down.
- **Top-level `await` fails under `npx tsx -e`** ("cjs output format"). Guarded
  real-DB writes need a real file; `data/` is gitignored and is the right home for
  one-shot ones.
- The **backlog done-count** the brief flagged was never in `future-ideas.md` — it
  was in pass 55's handoff, and pass 56 had already corrected it. Counted fresh
  today: 25 open / 2 partial / 35 done.
