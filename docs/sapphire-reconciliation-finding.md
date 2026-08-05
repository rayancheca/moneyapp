# Why Chase Sapphire will not reconcile — diagnosis, 2026-08-05

> Owner asked for this to be fixed properly (his choice, over skipping it or papering over it with
> UX copy). This document is the measured diagnosis. **The fix is a redesign of how card statements
> reconcile, not a patch — do not attempt it as a quick change to `reconcileAccounts`.**

## What is broken, in one line

Chase card statements print the **transaction** date, reconciliation sums by **posted** date, and
the card's transactions arrived from **two different kinds of file that each hold only half of
each period**. All three have to be addressed together.

## Established facts (all measured on the real ledger, not inferred)

**1. The parser bugs are FIXED and are not the cause.** Two real defects were found and shipped:
fees/interest were folded into the purchases section total, and sub-dollar amounts printed without
a leading zero (`.78`, not `0.78`) were silently dropped — 71 real charges worth $32.95. All 18
statements now parse and each foots to the cent on its own printed numbers. **Reconciliation is a
separate problem that those fixes revealed rather than caused.**

**2. Statement periods still show a gap on 16 of 19 periods**, ranging from −$390 to −$4,216.93.
Only the last three (2026-05-03 onward) reconcile.

**3. Reconciling by DATE RANGE mis-attributes boundary rows.** `reconcileAccounts`
(`import/service.ts:1174-1188`) sums `postedOn BETWEEN periodStart AND periodEnd`. But the parser
records the single printed date as BOTH `transactedOn` and `postedOn`
(`chase-card-statement-profile.ts`, `// the card statement prints ONE date and it is the
transaction date`). A payment made 03/01 and posted 03/03 appears on the **March** statement while
falling inside **February's** window.

Measured, with statements as the ONLY source for the card: the 2025-02-03→03-02 window held
**$9,465.98** of credits where that statement counts **$5,249.05** — a difference of **$4,216.93,
exactly that period's reported gap.**

**4. File-scoped reconciliation does NOT fix it — I tested it, and it is worse.** Summing each
period against its own `import_file_id` leaves every period gapped, and reveals why: the per-file
sums come out to *only the credits* (e.g. the 2025-03-03 period's file sum is exactly its printed
`Payment, Credits -$2,017.98`).

**The Chase "Spending Report" PDFs contain no payments.** The card's purchases came from the two
Spending Reports; its payments came from the statements. **Neither file holds a complete period**,
so no single-file scoping can ever balance one.

**5. The no-file-filter behaviour is deliberate and must not simply be reverted.** Pass 34 recorded
it as load-bearing: a period that reconciles with no file filter is what proved two identical
`CPI*CANTEEN` charges were both real. Any redesign has to keep that property for bank accounts.

## Why the naive fixes fail

| Idea | Why it fails |
|---|---|
| Filter the sum by `import_file_id` | Measured above: purchases and payments are in different files. Every period still gaps. |
| Un-import the Spending Reports, keep statements only | Tested. Worse — and it *also* loses the purchase history the statements' own dedupe already consumed. |
| Widen the period window by a few days | Guesswork against real money; would silently double-count a row that legitimately sits near a boundary. |
| Loosen the tolerance | Never. The cent-exactness is the entire value of this ledger. |

## The shape of a real fix

A statement is **self-proving**: the parser already verifies `previous + activity = new` to the
cent, so a statement that parses carries an internally consistent row list. The database-level
question is therefore not *"do rows in this date range sum correctly"* but **"does the ledger
contain exactly this statement's rows"** — a completeness check, not a range sum.

Sketch, to be designed properly rather than rushed:

1. Record which statement each row **belongs to** (its declaring statement), separately from which
   import file happened to insert it. A row consumed by `consumeIdentity` from an earlier file
   still *belongs* to the statement that later declared it.
2. Reconcile a card period against **its declared row set**, not a date range. Bank accounts keep
   the current date-range behaviour, preserving the pass-34 property.
3. Only then decide what a gap means: with a complete declared set, a gap is a genuine missing row
   rather than a boundary artifact.

⚠️ This touches quarantine (`import/service.ts:1205-1219` flips row status on the reconcile
result), so a wrong version can quarantine real rows or un-quarantine bad ones. **It needs the same
adversarial verification the parser fix got** — diagnose, refute, then implement.

## Do not lose

- The two parser fixes are shipped and independently verified (26 → 38 statements passing across
  every PDF in the repo, zero regressions). They stand regardless of what happens here.
- Backups taken before each real-DB write today: `data/backups/pre-sapphire-import-2026-08-05.db`
  and `data/backups/pre-subdollar-fix-2026-08-05.db`, both `integrity_check ok`.
- The card's transactions are now **more** complete than this morning (1,810 → 1,901 rows). The
  chart is not yet better, because chart coverage needs periods to reconcile, not rows to exist.
