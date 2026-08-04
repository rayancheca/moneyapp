# Handoff — 2026-08-04, pass 34

> Continues pass 33 (same day). The quarantine double-count from pass 32/33 is addressed — by
> SURFACING duplicates rather than resolving them — and the owner's cash wallet can finally be
> given its opening balance. Read `docs/HANDOFF-2026-08-04-pass33.md` §2 and §4 first; this pass
> only makes sense against the fix that was reverted there for destroying money.

## 1. Repo state

`main` = see `git rev-parse main` (do not trust a copied hash). Real DB: **9,827 txns, 10 accounts,
33 needs_review** — byte-for-byte the pass-33 figures. **No real-DB write this pass.**

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | 142 files / **2,472** · coverage 99.64% (only pre-existing `db/backup.ts` below 100%) |
| `next build` | clean |
| `pnpm e2e:fresh` | **381/381** · **zero visual-baseline churn** |

---

## 2. 🔴 THE LESSON: I calibrated a money heuristic on data, and the data was not the evidence

I measured four candidate duplicate predicates against the real 9,827-row ledger and picked the one
that produced two hits, both of which *looked* like a textbook cross-source duplicate: one
`CPI*CANTEEN VENDING MIAMI` charge on 2026-07-09 recorded by two different files, one description a
prefix of the other. I wrote that up as "a real live double-count in the owner's data".

**It is not a duplicate. Both charges are real.** An adversarial reviewer refuted it with the one
piece of evidence I never consulted: `reconcileAccounts` sums **every** row in an account inside a
period's date range — no `import_file_id` filter (`service.ts:1172-1186`) — and compares it to the
balances the statement itself prints. The Chase Sapphire period 2026-07-03..08-02 comes out
`reconciled`. If those two $1.25 rows were one charge counted twice, that period would be $1.25
short and would have opened a gap. It didn't. The owner simply buys from that vending machine
several times a day — a single file records **three separate $1.25 charges on 2026-07-08**.

**The app already owns an exact duplicate detector, and it outranks every heuristic in this
module.** That is now the predicate's first gate (§3). Measured consequence: my "carefully
calibrated" predicate's only hit on the entire real ledger was a false positive.

Two smaller versions of the same error, both caught the same way:
- Including `excluded` rows (correct — excluded money is still in balance replay) surfaced a
  **$4,000 Microsoft buy paired with a $4,000 crypto cash settlement**. Only the description gate
  rejects it, which is why `descriptionScore > 0` is required after all — I had argued against it.
- I claimed two hand-entered `PAYMENT — Chase ····3522` rows were an unflagged double entry. They
  carry `transfer_group_id`s and were always exempt.

**The generalisable rule: when a heuristic and a reconciliation disagree about whether money is
right, the reconciliation is right.** Do not calibrate a money heuristic on row shapes alone when
the ledger carries an arithmetic proof.

---

## 3. The quarantine double-count: surfaced, never resolved

`src/services/duplicate-flags.ts` (new) — `flagDuplicateCandidates(db, accountIds)`.

It **flags both sides `needs_review`. It never supersedes, excludes, or deletes.** That is the whole
design, and it is the direct lesson of `3e5a7fc`: a double count is visible in the Review tab and
reversible by hand; a deleted charge is neither.

**The predicate**, every clause measured against the real ledger:

| clause | why, and what the looser version costs |
|---|---|
| same account, same amount | — |
| `import_file_id IS NOT` (not `!=`) | `!=` is NULL for the **172 hand-entered rows**; the pass this replaces was blind to all of them. NULL-vs-NULL is correctly false, so two manual rows are not two sources. |
| `posted==posted` OR both-`transacted`-equal | mirrors `consumeIdentity`. Cross-matching posted↔transacted chains consecutive $3.00 MTA fares (10 rows, mostly false). |
| **never** date ±1 | `docs/schema.md:188` documents ±1; it pairs two distinct month-end ETH buys (0.003247 vs 0.003508 ETH, both $9.90, same normalized text). 22 rows, mostly false. **The doc is wrong; the code is deliberately narrower.** |
| `descriptionScore > 0` | without it, a $4,000 Microsoft buy pairs with a $4,000 crypto settlement. |
| both statuses in (`active`,`excluded`) | **not `active` alone** — `excluded` hides a row from analytics but the money still moves (`REPLAY_STATUSES`), so an excluded twin double-counts net worth invisibly. |
| both `transfer_group_id IS NULL` | a transfer is the one same-amount pair that is *meant* to exist twice. |
| **not inside a `reconciled` period** | §2. The statement's own arithmetic outranks the heuristic. `accepted` is pointedly NOT exempt — that is the owner overriding a gap he could not explain, which is exactly where a double count hides. |

`descriptionScore` moved to `src/lib/description-score.ts` so the flagger and `pickTakeoverVictim`
provably share one definition of "these two records describe the same purchase".

**⚠️ Read this before "fixing" the reconciliation guard.** Two independent reviewers filed it as a
HIGH defect that `NOT_ALREADY_PROVEN` makes it *impossible* to flag any row `reconcileAccounts`
promotes — `reconcileAccounts` stamps `reconciled` and promotes in the **same statement**
(`service.ts:1192-1198`), so every promoted row is inside a reconciled period. The observation is
correct and the severity is not: it only promotes when the gap recomputes to **exactly 0**, and that
sum counts quarantined rows with no file filter, so a period that closes to 0 **provably holds no
double count**. Flagging zero there is the right answer. The path that matters is `acceptGap`, which
stamps `accepted` — deliberately *not* exempt. The regression test in `import.test.ts` covers
exactly that and goes red when the flagger is removed. Only the comment was wrong; it is now fixed.

**Wired into all six promotion paths** — pass 33 listed five and missed `unimportFile`, which
`reconcileAccounts`+promotes exactly as an import does:
`importStatementFiles` (now **after** `reconcileAccounts`, not before — the old flagger ran at
`:644` and never saw the rows the reconcile at `:647` had just promoted), `acceptGap`,
`unimportFile`, `bulkApply`, `applyUndoPatch`, `setTransactionFlags`.
Every call site is outside an open write transaction, which matters: `acceptGap` runs inside
`withPreMutationSnapshot`, and that `VACUUM`s and **throws** inside a transaction (`backup.ts:217`).

`flagFuzzyDuplicates` is **deleted** — strictly subsumed, and it matched **0 rows** on the real
ledger by construction (it demanded description *equality*, but the partial unique index means any
cross-file duplicate that survives insertion must have different raw text).

**Measured impact on real data: ZERO newly flagged rows** — verified by running the real function
over a `.backup` copy of `data/moneyapp.db` across all 10 accounts. The real DB has 0 quarantined
rows and 0 gap periods, so this is a **forward-looking safety net, not a retroactive correction**.
It only bites after an import that fails to reconcile.

---

## 4. The owner's cash wallet can now be given its opening balance

`setCashWalletOpening` + an inline editor on the wallet row (`/accounts`). The owner's "1800" wallet
reads **`Opened with $0.00`** and is now editable in place.

**⚠️ It is still $0.00 and I did not change it.** The amount is the owner's to enter — inferring
$1,800 from the wallet's *name* is exactly the kind of guess that has no place in a money app.

Two design decisions worth keeping:
- **The date is not editable.** Re-anchoring the wallet's own opening day takes `addManualAnchor`'s
  upsert. Accepting a date would insert a **second** chain-grade anchor, and two unequal anchors
  with no transactions between them turn every interior day to `basis='gap'` — dropped from the
  chart, from the latest balance, and from net-worth coverage.
- **No date is displayed either.** `createCashWallet` anchors the day *before* the opening date but
  the ordinary Add-an-account form anchors *on* the day, so any single label misreports one path by
  a day — and a wrong date invites a "correction" through the anchor form, which is the second-anchor
  path above. Above one anchor the editor is replaced by "later balances recorded", because
  derivation seeds its forward walk from the LAST anchor and editing the opening would move nothing
  the owner can see — **and worse**. Measured on a two-anchor wallet ($100 opening, one −$20 row,
  $80 recorded a month later): changing the opening to $500 flipped **30 interior days from
  `derived` to `gap`**, and gap days are dropped from the account chart, from `latestBalances`, and
  from net-worth coverage. That is derivation being *honest* — a $500 opening genuinely cannot reach
  a recorded $80 after −$20 — so the guard belongs in the UI, not in the service, which stays
  permissive to match the general `AnchorForm` on `/accounts/[id]`. **Do not "fix" this by making
  the service refuse: that would block a legitimate correction of a mistyped opening.**

**Atomicity (pass 33 §7 item 4) — confirmed and worse than reported.** `createCashWallet` inserted
the account, then anchored at `openingOn - 1`; an opening date of exactly `MIN_FINANCIAL_DATE` —
which the form's own `min` offered — anchored at 1969-12-31 and threw *after* the account row
existed. The orphan was not inert: it appeared in the wallet list reading "no balance yet" and made
**every net-worth day incomplete**, while the user was told creation had failed. It also stranded a
new `Cash` institution on a first-ever wallet. Fixed with validate-before-insert (the repo's own
precedent) **and** a transaction wrap. The snapshot/VACUUM branch is unreachable there because the
account id is brand new — which is precisely why `setCashWalletOpening` is *not* wrapped.

Also closed: the server never bounded `openingOn <= today`; only the browser did, and a server
action is a network boundary. A future opening date was already *measured* to drag the net-worth
series past today.

**No orphan exists in the real DB** — checked read-only; every active account has ≥1 anchor.

---

## 5. Findings recorded but NOT acted on

1. **`needs_review` is cleared by categorization** (`categorize.ts`, `bulk-edit.ts`,
   `rule-corrections.ts`) **and by the one-click "Mark all reviewed" amnesty**
   (`markAllReviewedBefore`). Categorizing or amnestying a flagged duplicate silently dismisses the
   warning, and nothing re-flags it — the only re-entry points are status promotions and imports.
   The flag is a bare boolean with no reason column, so the Review tab cannot say *why* a row is
   there. A `duplicate_candidates` table is the real fix.
2. **A flagged `excluded` twin is flagged where nobody looks.** The predicate deliberately admits
   `excluded` (that money is still in balance replay), but every prompting surface filters
   `status='active'` — `review-count.ts:11,25`, `review-inbox.ts:184`, `transactions-query.ts:37`.
   So an excluded duplicate gets `needs_review=true` and appears in no queue. Not wrong, but not yet
   useful.
3. **Excluding one side of a duplicate does not fix a double count** — `excluded` is still in
   balance replay, so net worth keeps counting it. There is currently **no** user action that
   resolves a duplicate. Flagging tells the owner; it does not let him act.
4. **Every opening-balance save takes a full `VACUUM INTO` of the 12.8 MB database.** The inline
   editor sits on `addManualAnchor`'s overwrite branch, which takes a pre-mutation restore point,
   and `keepPreMutation` is only 12 — so a few corrections can push older restore points out. Fine
   for one deliberate edit; it is a low-friction control on an expensive path.
5. **The create form rejects `1,800`.** "Cash on hand" parses with `Number()` on a `type="number"`
   value, so a grouped or `$`-prefixed entry silently disables Create with no message — while the
   inline editor next to it accepts `$1,800.00` through the ledger's string parser. The two
   disagree about what a valid amount is.
6. **The `db.transaction` wrap in `createCashWallet` has no reachable trigger** and no test proves
   it, because the schema refines now reject every input that used to reach the failing write. It is
   deliberate defence in depth, not dead code — but do not mistake the green tests for coverage of
   it.
3. **A cash wallet can be typed `investment`** through the ordinary Add-an-account form, and
   derivation then ignores its manual transactions entirely.
4. **`createAccountResultAction` has the same orphan class** (a credit account with a negative
   "balance owed" throws after the insert) and anchors at `todayIso()` rather than the day before,
   so a wallet made through that form silently drops a same-day first transaction.
5. **A transaction dated exactly on the opening anchor's day is invisible** on a single-anchor
   wallet, and the Add-transaction date input does not exclude it.
6. **The bulk-import scale test is still unwritten** — and the investigation argues it should stay
   that way in its proposed form: `importStatementFiles` **sorts its input** (`service.ts:628-630`),
   so permuting one call is a provable no-op, and the synthetic corpus produces no quarantined rows
   and no `transactedOn ≠ postedOn` rows, so it cannot reproduce either defect. A bounded
   *batch-boundary* test is the version worth writing.
7. **`docs/schema.md:188` is wrong** about the fuzzy pass being date ±1 (§3). Someone should fix the
   doc rather than the code.
8. **A soft violation of import-order independence that I introduced, and could not cleanly avoid.**
   `docs/schema.md:187-188` requires that any permutation of the same file set yields an equivalent
   database. The old `flagFuzzyDuplicates` was unscoped and had no reconciliation guard, so it
   converged regardless of order. The new guard makes flagging depend on whether the period was
   `reconciled` **at the moment of the sweep**: import A-then-B can flag a pair that B later proves
   reconciled (and nothing un-flags it), while B-then-A never flags it at all. Both orders end with
   identical **money** — the divergence is one review hint — and it cannot be fixed by re-clearing,
   because `needs_review` is a bare boolean with no reason column, so the flagger cannot tell its
   own flags from the owner's. This is the same root cause as item 1 and the same fix: a
   `duplicate_candidates` table.

---

## 6. Process notes

**The adversarial pass paid for itself again, and this time it corrected ME.** Four investigators
plus four refuters on the plan, then four reviewers plus per-finding verifiers on the diff. Every
investigation report came back `partly-wrong`, including claims I had already acted on. The single
most valuable finding — that reconciliation refutes the duplicate heuristic — came from an agent
whose only instruction was to disagree.

**The review of the diff itself: all four lenses said `fix-first`; of the five findings escalated to
a verifier, ONE was confirmed and four were refuted.** That ratio is the point of the verify stage —
without it I would have "fixed" four non-defects, one of which (loosening the reconciliation
exemption) would have reintroduced the exact false positive this pass exists to prevent. What
actually needed fixing:
- **CONFIRMED**: the new e2e assertion was a *tautology* — `expect(row).toContainText("$1,800.00")`
  cannot fail if the preceding aria-label assertions pass, because the row renders that figure twice
  (opening trigger + derived balance). It now targets the derived balance through its own locator,
  and the regression the verifier named (dropping `rebuildAccount`) turns 7 tests red.
- Two of my unit tests passed for the wrong reason (a same-file case whose descriptions the
  description gate already vetoed; an "idempotent ids" case that no mutation could fail). Both
  rewritten and mutation-proven.
- A real hole the reviewers found independently of any finding: `descriptionScore("", x) === 2`,
  because `"".includes("")` is true — so a description that normalizes away matches *everything*.
  Guarded, with a test.
- Three new `bulk-edit.ts` call sites had shipped with zero tests. Now four, mutation-proven.

⚠️ **The most seductive finding was the one that was wrong.** Two independent lenses filed HIGH on
`NOT_ALREADY_PROVEN`, correctly observing that `reconcileAccounts` stamps `reconciled` and promotes
in the same statement. The verifier's verdict: "its conclusion is backwards." A period that closes
to exactly 0 — counting quarantined rows, with no file filter — provably holds no double count.
**Do not loosen that clause.**

⚠️ **Do not run the gate while agents are working** (unchanged from pass 33). Agents were told
read-only and to use `sqlite3 "file:…?mode=ro"` for real-DB facts; one still correctly flagged my
own untracked files as evidence of a concurrent session — a good instinct, wrong conclusion.

⚠️ **A new e2e spec that creates an account must sort after every spec that photographs or totals
one.** Named `zz-cash-…`, mine ran before `zz-golden-path` and made its full-page
`accounts-managed-light` baseline 32px taller. The fix was the filename, not the baseline — I nearly
updated a baseline to accommodate a test-ordering bug. It is now `zz-zz-zz-` and restores its own
state.

⚠️ **The Browser pane returned uniformly blank screenshots** for this app while `get_page_text`
worked fine. Drive Playwright directly (`@playwright/test`, from *inside* the repo so module
resolution works) for anything visual.

---

## 7. Next

1. **Make the duplicate flag actionable** (§5 items 1-2) — a reason on the flag, and a resolve
   action that actually removes the double count. Today the owner can be told and can do nothing.
2. **The opening balance on the owner's "1800" wallet** — ask him the amount, then set it in the UI.
3. §5 items 3-5: the wallet-creation defects in the *other* form.
4. §5 item 6: the bounded batch-boundary import test.
5. **Hosting — ⛔ still NOT YET, by explicit instruction.**
