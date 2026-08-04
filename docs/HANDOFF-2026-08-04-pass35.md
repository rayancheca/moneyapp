# Handoff — 2026-08-04, pass 35

> Continues pass 34 (same day). The duplicate flag pass 34 introduced is now **actionable**: the
> pair, the reason, and the owner's verdict live in their own table, and there is finally a way to
> resolve a double count that is neither a delete nor a lie. The owner's cash wallet also has its
> real opening balance. Read `docs/HANDOFF-2026-08-04-pass34.md` §2–§3 first — this pass is the
> other half of that one.

## 1. Repo state

`main` = see `git rev-parse main` (do not trust a copied hash). Real DB: **9,827 txns, 10 accounts,
33 needs_review** — transaction counts byte-for-byte unchanged from pass 34.

**One real-DB write this pass**, and one schema migration:
- migration `0008` created `duplicate_candidates` (empty; additive only)
- the "1800" cash wallet's opening balance: **$0.00 → $1,800.00**, net worth **$88,974.73 →
  $90,774.73**, coverage still complete 10/10

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | 143 files / **2,500** (was 142 / 2,472) |
| `next build` | clean |
| `pnpm e2e:fresh` | **383/383** · **zero visual-baseline churn** |

---

## 2. 🔴 THE LESSON: an amnesty the next import undoes is not a fix

The owner asked me to investigate the 33 rows sitting in his review queue and clear the ones that
were provably safe. All 33 *are* provably safe (§4). I did not clear them, and that is the finding.

`detectTransfers`' PASS 2 sets `needsReview = true` on every contended outflow **and all of its
candidates, on every single run**, with no check for whether the row was already reviewed
(`categorize.ts:630-632`). Clearing those 33 flags would have looked like progress for exactly as
long as it took the owner to import his next statement. The queue would refill with the same 33
rows, and the only durable effect would have been my report claiming they were handled.

**The generalisable rule: before clearing a flag, find the code that SET it and check whether it
will set it again.** A flag that is re-derived from scratch on every run cannot be cleared — it can
only be made false at the source.

**A second, sharper version of the same error, in the other direction.** The investigating agent
diagnosed a root cause — `TRANSFER_HINT_RE` (`categorize.ts:307-308`) has no term for Robinhood's
`"External debit card transfer"` — and it was wrong, in a way that would have sent the next pass
editing a regex for nothing. `autoPairable` has four routes (`categorize.ts:498-503`), and one of
them is *both legs already carrying a Transfers-subtree category*. **31 of the 33 rows are
`user`-categorized into Transfers**, so that route already passes and the hint regex is irrelevant
to them. The actual blocker is `nearest.length === 1` (`:609`): the owner pushed $200 into
Robinhood twice on the 8th, twice on the 9th and twice on the 14th, so no outflow has a unique
nearest inflow. That is the detector being honest about genuine ambiguity, not a gap in a regex.

---

## 3. What was built: a duplicate you can actually resolve

### 3.1 `duplicate_candidates` (migration 0008)

One row per PAIR: the two transaction ids, a `pair_key`, the reason, and the owner's verdict.
Documented in full in `docs/schema.md` §duplicate_candidates. The three decisions worth defending:

**`ON DELETE SET NULL` on both transaction FKs, deliberately NOT cascade.** Transactions are
genuinely hard-deleted (`unimportFile`, `deleteManualTransaction`) under `foreign_keys = ON`, so a
plain reference throws — cascade is the obvious fix and it is wrong. `unimportFile` re-runs the
detector **fifteen lines after its delete** (`service.ts:1304` → `:1319`), so a cascade would wipe
the owner's "not a duplicate" verdict and the flagger would immediately re-derive the same pair as
unresolved. The owner would answer the same question forever and never know why.

**`pair_key` is content, not ids.** Every unimport→re-import gives the same two charges brand-new
ids. An id-keyed memory forgets the answer, which is precisely the import-order dependence pass 34
§5 item 8 recorded as an open defect. The key hashes the account plus both sides'
(posted_on, transacted_on, amount, normalized description), sides sorted. A re-parse that changes a
description changes the key — correct, because the owner judged the words he was shown.

**`retired_from_status`.** A pair can legitimately contain an `excluded` row: `excluded` hides a row
from analytics but its money still moves through balance replay, which is exactly why an excluded
twin double-counts net worth and why the detector admits one. Restoring it as `active` on undo
would silently reverse a decision the owner made for his own reasons.

### 3.2 The flagger now records pairs (`duplicate-flags.ts`)

**The predicate is unchanged** — identity join, description gate, both-sides-in-replay, transfer
exemption, and the `NOT_ALREADY_PROVEN` reconciliation guard. Do not loosen any of it; pass 34 §6
records what happened the last time someone was tempted to. What changed is the output: the pair is
written to `duplicate_candidates` with a sentence naming the amount and the day, and the boolean
still lands on the rows. The return value is still "rows newly flagged", so every existing count
assertion holds.

Two new behaviours:
- **A dismissed `pair_key` is never re-asked**, even when the ids have changed. This is the fix for
  the order-dependence above.
- **A `confirmed_duplicate` pair re-opens if it can be re-derived at all.** `BOTH_IN_REPLAY` cannot
  see a superseded row, so re-deriving a settled pair means the retired side came back — undone by
  hand, or restored by `unimportFile`. A stale "confirmed" verdict would otherwise hide a live
  double count from the queue for ever.

### 3.3 `resolveDuplicate` / `undoDuplicateResolution` (`duplicate-resolution.ts`)

Confirming retires ONE side — `status = 'superseded'`, out of `REPLAY_STATUSES` and out of every
analytics total, still in the table — and remembers which and from what status. Nothing is deleted,
no winner is ever chosen automatically, and there is no "resolve all".

**Every clause of the detector's predicate is re-checked at RESOLVE time**, not trusted from flag
time: a candidate can sit in the queue for weeks while a side gets linked as a transfer, excluded,
or proved by a statement that arrived later.

⚠️ **The reconciliation guard is asked AGAIN here, about the side being retired, and that is
load-bearing.** `NOT_ALREADY_PROVEN` in the flagger guards `t1` alone — deliberately, for per-row
precision — and because the identity join can pair two rows that agree on `transacted_on` while
disagreeing on `posted_on`, a pair can be recorded with one side inside a reconciled period and one
side outside it. Retiring the proven side would make that statement stop footing, and the next
`reconcileAccounts` would find a gap and **quarantine every row of that period's file**. The UI
shows "Proved by a statement" on such a row instead of offering a button that throws.

Undo exists because nothing else in the app could do it: `applyUndoPatch` refuses to write `status`
onto a superseded row and refuses to SET `'superseded'` at all, `setTransactionFlags` throws on one,
and **no transactions view renders one** — so without an undo, retiring would have been a silent,
unreachable delete from the owner's point of view. It guards against the retired row's dedupe slot
having been claimed while it was away (the partial unique index excludes superseded rows, and
manual `occurrence_index` is numbered over non-superseded rows only).

### 3.4 The money-loss hazard nobody had reported

Found by reading `unimportFile`, not by any prior pass: **retire B as a duplicate of A, then unimport
A's file, and the charge is recorded by ZERO live rows.** `unimportFile` deletes every row of the
file regardless of status (`service.ts:1304`), A goes, B stays `superseded`, and the money silently
leaves balances and net worth — the owner asked to remove a FILE and got a missing CHARGE. It is
reachable from a one-click button on `/imports`.

`restoreDuplicatesLosingTheirSurvivor` (`duplicate-lifecycle.ts`) puts the retired copy back before
the delete, **inside the caller's transaction**, and is wired into both hard-delete paths
(`unimportFile`, `deleteManualTransaction`). It lives in a leaf module because
`duplicate-resolution.ts` imports `reconcileAccounts` from `import/service.ts`, so putting it beside
the resolver would be a cycle. There is an end-to-end regression test that drives the real
`unimportFile`; removing the restore call turns it red with `expected 'superseded' to be 'active'`.

⚠️ **Two things about this function were wrong in its first version and were caught by reviewing my
own diff (§6). Do not undo either.**
- It ran on the bare `db`, outside the caller's `db.transaction`, while its own docstring claimed
  "the restore and the delete stand or fall together". They did not: each restore autocommitted on
  its own, so a later failure would have left rows restored beside survivors that were never
  deleted — the double count, produced by the fix for the double count. It now takes the `tx`
  handle.
- It had no dedupe-slot guard. A restore puts the row back inside
  `ux_transactions_account_dedupe … WHERE status != 'superseded'`, and the slot can be taken while
  it is away (`editManualTransaction` renumbers `occurrence_index` over non-superseded rows only and
  guards *only* on "is this a manual row" — `manual-transactions.ts:211`). **It SKIPS that
  candidate; it does not throw.** Copying `assertRestorable` verbatim from the undo path would have
  been worse than the bug: throwing converts "one restore skipped" into "this file can never be
  un-imported", and the row holding the slot *is* that money, so there is nothing to rescue.

### 3.5 The Duplicates tab

A fifth `TXN_VIEW`, with a bespoke body like Review's. It is **not** folded into the review inbox:
that surface groups by MERCHANT and clears a whole cluster with one button, so a pair dropped in
there would be swallowed by unrelated rows and its warning dismissed by the existing primary
action. `viewCondition('duplicates')` is deliberately **not** gated on `status='active'`, or it
would hide the `excluded` side that makes a pair worth showing.

Resolved pairs stay listed, because a retired row is `superseded` and no other tab renders one —
dropping it once resolved would make a retire indistinguishable from a delete.

---

## 4. The 33 review rows: all explained, none cleared

17 outflows + 16 inflows of one story — the owner funding Robinhood from SoFi by debit card and
from Chase by ACH. **Zero money problems**, established with the arbiters in the order pass 34
established them:

| account | flagged | proof |
|---|---|---|
| SoFi Checking | 16 | **16/16 inside `reconciled` periods** — the statements prove the money to the cent |
| Chase Checking | 1 | **1/1 inside a `reconciled` period** |
| Robinhood Cash | 16 | **all 16 from ONE import file** — Robinhood itself reported both rows of each pair |

Robinhood Cash has **zero** statement periods, so the reconciliation arbiter is UNAVAILABLE there
and its absence was not treated as proof. All 33 already carry `transfer`-kind categories, so no
total is affected either way. Corroboration: the Robinhood doubles map 1:1 onto reconciled SoFi
debits with a 1–2 day settlement lag, and in every amount bucket the reconciled bank side shows at
least as many movements as Robinhood shows credits — a phantom duplicate would make Robinhood show
*more*, not fewer.

**Why they were not cleared: §2.** The permanent fix is to make the detector pair them, and there is
already prior art for the shape — `categorize.ts:616-624` deterministically resolves a same-day
mirror multiset by id. The same idea generalises: when N equal outflows face N equal inflows between
the same two accounts, any bijection gives the same aggregate flow, so a deterministic one is safe.
**Not done this pass** — transfer detection is delicate and this is a different feature.

---

## 5. Findings recorded but NOT acted on

1. **Nothing re-flags a duplicate after the owner categorizes one side.** The candidate row now
   survives (that is the point of the table), but `needs_review` is still cleared by fifteen paths,
   so a pair can be invisible in the *review* queue while still open in the *duplicates* queue.
   That is a deliberate split — the duplicates tab is the authority — but the two counts can
   disagree and nothing explains why.
2. **The nav badge still counts only `needs_review`.** An open duplicate raises the Duplicates tab
   count but not the sidebar badge, so a double count is invisible from anywhere but that page.
   The shell renders exactly one badge per nav item.
3. **A duplicate pair spanning two accounts is impossible by construction** (the join requires the
   same account), so a cross-account double count — the same charge imported into two different
   accounts — is not detected at all. Unmeasured; likely rare.
4. **`pair_key` collapses an N-way collision — filed three times, refuted three times.** Three
   identical rows on one day give pairs AB/AC/BC with the SAME content key, so dismissing one
   dismisses the memory for all of them. Every verifier independently concluded this is the
   *intended* contract rather than a defect: the key is content, and by construction those pairs
   ask literally the same question of the owner. **Do not "fix" it by adding ids to the key** —
   that would reintroduce the re-import amnesia the key exists to end. The one real consequence is
   §5 item 7.
5. **A row in more than one pair leaves siblings that cannot be answered** — retiring through one
   candidate strands the others pointing at a superseded row. Fixed READ-SIDE only
   (`STILL_ASKABLE`): an *unresolved* pair whose sides are not both in balance replay is dropped
   from the queue and the count. It deliberately does not filter RESOLVED pairs, or the retired row
   would vanish from "Already decided" and undo would become unreachable — turning a reversible
   retire back into the silent delete. Auto-resolving the siblings was considered and rejected:
   writing `dismissed` hits the shared `pair_key` and suppresses future real detections, and writing
   `confirmed` retires money nobody asked to retire — the `3e5a7fc` class.
6. **Nine `low` findings were confirmed and left alone**, the largest being that
   `clearReviewIfSettled` can clear a `needs_review` flag the owner had set by hand for an unrelated
   reason. The verifier's judgement — which I agree with — is that the alternative (leaving the
   survivor flagged) produces the permanent unexplainable orphan this pass exists to remove.
7. **A dismissed pair whose row is later hard-deleted keeps suppressing** its `pair_key` while being
   invisible in the queue (both read paths require non-null ids). Correct in spirit — the owner did
   answer that question — but there is no way to see or revisit it.
8. **The 33-row detector fix (§4)** — the real remedy for the review queue.
9. **`docs/schema.md` line 188 was wrong** about the fuzzy pass being date ±1, as pass 34 recorded.
   **Fixed this pass**, with the measurement that refutes it.

---

## 6. Process notes

**Six parallel investigations, each adversarially refuted, then four review lenses over the diff
with a verifier per finding — 34 agents.** Every one of the five investigation reports came back
`partly-wrong`, and the refutations changed the design three times:
- `ON DELETE CASCADE` — proposed as "not optional" — would have silently destroyed the owner's own
  verdicts. Now `SET NULL`.
- The survivor's `needs_review` is never cleared by retiring, leaving a permanent orphan in the
  review queue. Now cleared on both sides, but only when no other candidate still asks.
- The reconciliation guard had to be re-asked at resolve time about the *retired* side, because the
  flagger's guard is deliberately one-sided.

**The review of the diff: 19 findings, 8 refuted outright, 9 `low`, and 2 `medium` that were real
and are fixed (§3.4, §5 item 5).** That ratio is the entire point of the verify stage — without it
I would have "fixed" eight non-defects, and two of the proposed directions were actively dangerous:
one would have made a file permanently un-un-importable, and one would have reintroduced the
re-import amnesia. **The single most-filed finding — the `pair_key` collision, raised independently
by three lenses — was refuted by all three verifiers as the intended contract.**

⚠️ **Both surviving defects were in the fix for the money-loss hazard, not in the feature.** The
code that existed to stop money vanishing could itself have doubled money (a partial commit) or
bricked un-import (an unguarded restore). Written defensively, reviewed carelessly, it would have
shipped — the lesson is that the riskiest code in a pass is usually the safety mechanism.

⚠️ **The repo's own guards caught me twice, and both are worth trusting.** The e2e global setup
refused to run against a stale `.next` (`pnpm e2e:fresh`, always). And `src/db/schema.test.ts`
asserts an exact table list, which is a guaranteed red on any new table — that is the point.

⚠️ **A failing test is not always a bug in the code.** My first e2e run failed to find the "Retire
this one" button. The cause was that I had seeded the pair onto a date inside a **reconciled**
period, so the UI correctly showed "Proved by a statement" instead — the guard working exactly as
designed. The spec now selects an account with no reconciled period covering the seeded day, and
says why.

⚠️ **`next dev` refuses to run a second server in the same directory**, so a throwaway database
cannot be previewed alongside the owner's. Verify populated UI through an e2e spec instead.

⚠️ **A new e2e spec that creates rows must sort after every spec that photographs or totals the
ledger** (pass 34's lesson, still true). Named `zz-zz-zz-duplicate-pairs`, and it deletes its own
rows in `afterAll`.

---

## 7. Next

1. **The transfer-detector fix for the 33 rows** (§4) — the only way that queue empties for good.
2. §5 items 1–2: make an open duplicate visible from outside its own tab.
3. Pass 34 §5 items 3–5: the wallet-creation defects in the *other* form (`createAccountResultAction`
   has the same orphan class, anchors on the day instead of the day before, and a cash wallet can be
   typed `investment` and then be ignored by derivation).
4. Pass 34 §5 item 6: the bounded batch-boundary import test.
5. **Hosting — ⛔ still NOT YET, by explicit instruction.**
