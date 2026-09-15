# Why Chase Sapphire would not reconcile — RESOLVED, 2026-08-05 (pass 38)

> **Status: fixed.** All 18 balance-bearing periods reconcile to $0.00, Sapphire's blank chart days
> went 323 → 0, and 0 rows remain quarantined. Net worth is unchanged at $92,735.98.
>
> ⚠️ **The pass-37 diagnosis in this file's previous revision was WRONG**, and is preserved below as
> §4 because the way it was wrong is the useful part.

## 1. What was actually broken

**Every Chase Sapphire card payment was in the ledger twice.**

- Once as the line **Chase itself prints** on the statement (`Payment Thank You-Mobile`), imported
  2026-08-05 when the 18 card statements were ingested.
- Once as a **hand-entered mirror row** (`PAYMENT — SoFi Savings · CHASE CREDIT CRD`,
  `import_file_id IS NULL`) that a one-off script wrote in a **single 27ms burst on 2026-07-11** —
  months before the card had any statement at all.

The mirror carries the **bank's post date**, one to five days after the date Chase prints, and 106
of 107 have **no transaction date**. `consumeIdentity` (`import/service.ts:147-166`) keys both of
its lenses on an **exact day** — posted-to-posted, then transacted-to-transacted — so neither could
ever match a mirror to its statement twin. Nothing deduped them, and the double-counted credit made
every affected period gap.

## 2. The evidence, which identifies itself

A matcher that **never looks at a balance** — same amount, mirror dated 0–5 days after the statement
row — pairs exactly:

| tolerance | pairs | duplicated total |
|---|---|---|
| 0 days | 0 | $0.00 |
| 1 day | 37 | $12,137.96 |
| 3 days | 69 | $21,283.06 |
| **5–60 days** | **71** | **$23,983.06** |

and `sum(gap_cents)` over the 15 gapped periods is **−$23,983.06**. To the cent.

It is a **unique perfect matching**, not a greedy guess: no mirror has a second candidate, no
statement row is claimable twice, and banning any matched mirror in turn shows all 71 appear in
*every* maximum matching. The set is identical under four different iteration orders and at every
tolerance from 5 to 60 days. Delta histogram `{1: 37, 2: 20, 3: 12, 4: 1, 5: 1}` — **zero at
delta 0**, which is precisely why exact-day dedupe was blind to all of them.

Four further rows straddle a statement boundary: Chase prints the transaction date, so a charge made
in the last days of a cycle is declared by the NEXT statement while dating into the previous window.
Those are real, and they are the *only* four — the predicate (file owns exactly one balance-bearing
period, row outside that window) selects 4 rows ledger-wide, all Sapphire, zero on any other account.

## 3. The fix, and why each part is shaped the way it is

`scripts/fix-card-payment-mirrors.ts` — dry-run by default, `--apply` to write.

1. **Supersede the 71 mirrors** and **record each as a `duplicate_candidates` row** in the same
   transaction. The candidate row is not bookkeeping:
   `restoreDuplicatesLosingTheirSurvivor` (`duplicate-lifecycle.ts:33`) rescues a retired row **only**
   from a `confirmed_duplicate` candidate, and `unimportFile` hard-deletes a file's rows behind that
   guard. A bare status flip would have armed a **one-click un-import to strand up to $4,619.92 of
   payments on zero live rows, silently** — the exact failure mode commit `3e5a7fc` was reverted for.
   It is also the only surface that renders a superseded row (`DuplicatePairs.tsx:47-56`), so without
   it the retirement is invisible and irreversible through every shipped path.
2. **Move the transfer link onto the statement row ONLY when that row has none.** Exactly one paired
   statement row already carried a correct 2-member group; overwriting it with the mirror's dead
   singleton would have orphaned the SoFi Savings leg — destroying a real transfer to fix a count.
   Gate: two-member group count must not fall (708 → 708, asserted).
3. **Clamp the 4 straddlers** into their declaring window, recomputing `dedupe_hash` (it covers
   `posted_on`) and leaving `transacted_on` alone — it means the date Chase printed.
4. **One transaction for every row write.** Between supersede and clamp, 26 payments worth $8,481.48
   sit quarantined with their mirrors already retired — recorded by zero replay-eligible rows. That
   state must never be observable, and `withPreMutationSnapshot` gives no atomicity of its own.
5. **The import path's full settle sequence** afterwards (`categorizeAll → detectTransfers →
   reconcileAccounts → rebuildAccount → flagDuplicateCandidates`), not a subset — six released rows
   had no category.

**Measured end state (real DB, and reproduced on a copy first):**

| | before | after |
|---|---|---|
| periods reconciled | 3 / 18 | **18 / 18** |
| Sapphire `gap` chart days | 323 | **0** |
| `gap` days ledger-wide | 323 | **0** |
| quarantined rows | 83 | **0** |
| net worth | $92,735.98 | **$92,735.98** |

Historical net worth **does** move, correctly and by design: on the 323 days the card was previously
excluded from `netWorthSeries` (basis `gap` is skipped, `derivation.ts:366`), a liability now counts,
so the line is lower — e.g. 2025-03-15 $54,050.25 → $53,744.84.

## 4. The wrong diagnosis, kept because the failure is instructive

Pass 37 concluded the cause was **boundary mis-attribution**: reconciliation sums by date range while
Chase prints the transaction date, so payments land in the neighbouring window. It wrote a spec around
recording a "declared row set" per statement.

That story was coherent, it explained the direction of the error, and one measurement appeared to
confirm it (a window holding $9,465.98 of credits where the statement counted $5,249.05, a difference
equal to that period's gap). **It was still wrong.** The excess credits in that window were the
duplicate mirrors, not boundary spill. Boundary drift accounts for **4 rows**, not 71.

Three lessons, in the order they cost time:

- **A difference that equals the gap is not proof of a mechanism.** Both stories predict the same
  arithmetic; only one survives asking *which specific rows* and *where did they come from*. The
  `created_at` burst on 2026-07-11 settled it in one query.
- **The proposed fix was the tell.** The declared-set design's core predicate is a **tautology** —
  the parser already throws unless `previous + activity = new`, so "does the ledger contain the
  statement's declared rows" is an identity that would have flipped all 15 gapped periods to
  `reconciled` and un-quarantined 70 duplicate payments straight into balance replay. It would have
  made the double count *worse* while reporting success.
- **`reconcileAccounts` had zero direct test coverage.** Every existing test drove it through a
  fixture import, and no fixture reproduced this shape. `src/services/import/reconcile.test.ts` now
  pins it, including the falsification case: a payment recorded twice, two days apart, must NOT
  reconcile.

## 5. Still open

### The straddler: fixed in the importer, 2026-09-15

A forced parser-version re-parse of the Sapphire statements on a copy of the ledger put the four
straddlers back on their printed days: 5 periods to `gap` and 47 rows quarantined, identically in
either file order. What shipped is not the plan in the superseded subsection below. The parser was not
changed, and the posted lens was not skipped.

- **Placement.** `importOneFile` STORES a row dated outside its statement period on the nearest edge
  and keeps the printed day as `transacted_on`, for every account whose periods must close to the cent
  (not investment). The rule is `postedInsidePeriod` (`src/lib/statement-period.ts`); the Discover
  parser's inline clamp calls it too. `chase-card-statement-profile.ts`, its version and its test at
  line 91 are unchanged: the parser still reports the printed day.
- **Matching another record of the same money reads the PRINTED row.** Identity (posted lens first,
  then transacted), the takeover victim and the re-parse carry all look for a row on the day the file
  prints. The posted lens never sees the placed day, so `LA GAVIOTA DELI GROCERY` cannot claim
  `NEW BEST GOURMET DELI` on the opening day. That was the hazard the old plan's "skip the posted lens"
  answered.
- **Ownership reads the STORED row.** Ownership asks which source covers the day the row posted. Read on
  the printed day (as first shipped), an export whose coverage ended on the previous statement's close
  day dropped the charge as owned and the period gapped. An export whose coverage began on the posting
  day did not own the charge, and the statement recorded it a second time. Takeover still asks about
  the printed day, because that is where its victim sits.

Two limits remain:

- **An identity twin across the boundary.** Suppose the previous statement closed with a genuinely
  distinct charge of the same amount, dated the day the straddler prints. Identity consumes that row's
  slot, the straddler is counted as a cross-format dedupe and never stored, and its own period gaps.
  This is not in today's Sapphire data: the forced re-parse produced no gap. A fix would stop identity
  from consuming a row that sits inside a different, closed statement period of the same account.
- **A version bump is still gated.** `scripts/attach-sapphire-payment-rows-2026-09-14.ts` forbids one
  until the owner decides the 06/30 payment's posting day. Its header lists everything a bump still
  changes.

Also worth knowing: **0 of 25 synthetic `chase-card-*.pdf` fixtures match `isChaseCardStatementText`**
— the golden acceptance test exercises a different profile entirely, so "the golden test is green" is
false assurance for anything in this parser. The importer tests for the straddler drive
`parseChaseCardLines` directly for that reason.

### Superseded: the 2026-08-05 plan (kept for its measurements)

**The parser is not fixed for FUTURE statements.** The clamp was applied to the 4 existing rows as
data; `chase-card-statement-profile.ts` still records the printed transaction date as `posted_on`, so
the next statement carrying a straddling charge will gap again (~4 rows per 18 months).

The fix is measured but **deliberately not shipped this pass**, because it is not safe alone: a
re-parse of all 20 archived Chase card PDFs shows **87 of 1,991 declared rows fall outside their own
window**, and clamping moves 60 of them from the transacted lens to the **posted** lens, which
`consumeIdentity` tries **first and with no description check**. One already lands on a different
merchant — `LA GAVIOTA DELI GROCERY` would claim `NEW BEST GOURMET DELI`. That is the `3e5a7fc`
failure class exactly.

Ship the clamp only together with its mitigation — skip the posted lens when
`postedOn !== transactedOn` — and note two consequences:

- `chase-card-statement-profile.test.ts:91` asserts `transactedOn === postedOn` for every row and
  will need to change.
- If the profile `version` is bumped, `import_files.parser_version` must be updated on the 18 files
  in the same transaction, or a re-upload triggers `supersedeFileContribution` + re-parse and
  activates the false-dedupe path across 165 rows.

Also worth knowing: **0 of 25 synthetic `chase-card-*.pdf` fixtures match `isChaseCardStatementText`**
— the golden acceptance test exercises a different profile entirely, so "the golden test is green" is
false assurance for anything in this parser.

## 6. Do not lose

- Backup before the write: `data/backups/pre-card-mirror-fix-2026-08-05.db` (9,918 txns,
  `integrity_check ok`), plus the script's own `pre-card-payment-mirrors` restore point.
- The retirement is **reversible through the shipped UI** — the 71 pairs appear in the Duplicates
  tab as `confirmed_duplicate` / `card_payment_mirror` and can be taken back individually.
- One-way door now in effect: with those periods `reconciled`, `isProvenByReconciliation`
  (`duplicate-resolution.ts:100-108`) will **refuse** to retire any duplicate dated inside
  2025-02-03..2026-08-02 through the UI. A reconciled statement is treated as proof a charge is real.
