# Handoff — 2026-08-04, pass 33

> Continues pass 32 (same day). Two owner-reported outages fixed, one attempted fix **reverted for
> being worse than the bug**, and two of this session's own commits corrected after adversarial
> review. Read `docs/HANDOFF-2026-08-04-pass32.md` for the parser work that preceded this.

## 1. Repo state

`main` = `8b6296a`, pushed, clean. Real DB: **9,827 txns, 10 accounts** (the 10th is the owner's
new cash wallet). Verify with `git rev-parse main` rather than trusting this line.

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | 140 files / **2,432** · coverage green |
| `next build` | clean |
| e2e | **380/380** on a clean tree |

**Real-DB write this pass:** migration `0007` applied (`pnpm db:migrate`), backup at
`data/backups/pre-migrate-0007-2026-08-04.db`. Pure schema addition — txns, accounts, anchors and
daily_balances all identical before and after.

---

## 2. 🔴 THE LESSON: I shipped a fix that destroyed money, and only an adversarial pass caught it

Pass 32 flagged the quarantine dedupe gap as the top item and said it "needs adversarial
verification, which was unavailable". The weekly model limit reset, so this pass ran that
verification — **against my own already-pushed commit**. It refuted all four claims. The
quarantine fix was **HIGH severity and has been reverted** (`3e5a7fc` reverts `77248e0`).

What `promoteQuarantinedRows` actually did:

- **Superseded non-duplicates.** `consumeIdentity` matches on `(day, amount)` **only** — no
  description, no similarity. The sibling takeover path uses `pickTakeoverVictim`, which *does*
  compare description. Demonstrated: a real `TRADER JOES 118 −$25.00` silently marked `superseded`
  against an unrelated `SHELL GAS −$25.00` on the same day. The codebase already documents **43
  same-amount different-merchant pairs on this one card**.
- **Cascaded through reconciliation.** `reconcileAccounts` sums by **account and date, not by
  file**, and skips `accepted` periods forever. Superseding a row changed a *neighbouring*
  period's sum, flipping it from reconciled to a $25 gap and quarantining its innocent rows. End
  state in the reproduction: **$9.00 of visible activity where $59.00 of real charges exist.**
- **Leaked across calls.** The pool is rebuilt per `acceptGap`, so one ledger row absorbed two
  different quarantined rows across two accepts — **$50.00 gone**.
- **Was non-deterministic.** My comment claimed determinism, but `existingIdentityPool`'s SELECT
  has no `ORDER BY` and each row is indexed under two keys. Two insertion orders of identical data
  gave a **$50.00 swing**.
- **Still missed the real duplicate** when the other row's `transacted_on` is NULL — and Chase
  Sapphire holds 106 active rows with NULL `transacted_on` beside 1,704 that have it.
- `superseded` is one-way and nothing restores it; un-importing the winning file orphaned the loser.

**A double-count is visible and recoverable. Silent deletion of real charges is neither.** The
original bug stands, unfixed and now much better characterised (§4).

The reasoning in my own commit message was also wrong: I justified leaving `reconcileAccounts`
blind by saying superseding there would re-open the gap — but that describes the branch that
*never promotes*. And I missed three other promotion paths entirely (§4).

---

## 3. Two owner-reported outages, both fixed

### 3.1 `/investments` — "no such table: price_intraday"
Migration `0007_woozy_speedball.sql` (authored Jul 31) creates `price_intraday`. The real DB's
applied list stopped at `0006`.

**Root cause:** `getDbBundle()` caches the connection on `globalThis` so it survives hot reload —
which means `createDatabase()`, and therefore `migrate()`, runs **once per server process, not per
edit**. The dev server had been up since before `0007` existed, so it never ran. Fixed by applying
the migration; page verified rendering (portfolio $91,659.71, +9.71%).

**Guarded** so it cannot silently recur — see §5.2 for how the first attempt at that guard was
itself wrong.

### 3.2 "i added a cash account and balances didnt change"
Correct diagnosis, and it was not subtle: `createCashWallet` always seeded a **$0** anchor, and the
form offered only *Wallet name* and *Opening date*. There was **no way to say how much cash was in
it**. The owner's wallet is literally named **"1800"** and reads **$0.00**.

Added an optional `openingBalanceCents` and a "Cash on hand" field. Measured: a wallet created with
$200 reads $200 on the opening date, composes with a same-day −$20 to $180, and moves the
net-worth series.

⚠️ **The owner's existing "1800" wallet is still $0.00** — this is a create-time fix and there is
no affordance to set an opening balance on an existing wallet. It holds one manual anchor of 0
cents on 2026-08-03 and zero transactions. Either add that affordance, or set the anchor directly
after confirming the amount with the owner (do not infer it from the name).

---

## 4. The quarantine double-count: what is actually true now

The bug is real and unfixed. What the review established beyond pass 32's account:

- **Three more promotion paths** flip `quarantined → active` with no duplicate check, all missed:
  `setTransactionFlags` (`bulk-edit.ts:402-403`), `bulkApply`/`bulkApplyByFilter` with
  `restore:true` (`bulk-edit.ts:97` — can promote the entire "quarantined" view in one call), and
  `applyUndoPatch`, whose `undoFieldsSchema` accepts a client-supplied `status:"active"`.
- **`reconcileAccounts` has a genuine miss too**: its gap is summed over
  `posted_on BETWEEN period_start AND period_end`, but a twin matched on `transacted_on` can sit
  *outside* that window. So the double-count can arrive through the path pass 32 argued was safe.
- Any real fix must compare **description similarity**, not just `(day, amount)` — mirror
  `pickTakeoverVictim`, do not reuse `consumeIdentity`.
- It must be **persistent across calls**, or one ledger row keeps absorbing new claimants.
- The pool admits `excluded` rows and manual rows (`import_file_id IS NULL`) — the real DB has
  **172 manual rows** eligible to win such a match and make a statement charge disappear.

**No live corruption exists today**: the real DB has **0 quarantined rows and 0 gap periods**. This
is forward-looking, and it only bites after an import that fails to reconcile.

---

## 5. Two of this session's own commits were corrected

### 5.1 Cash-wallet form broke at laptop widths
The added fifth control pushed **Create and Cancel entirely off-screen** between 768 and 1024px,
scrolling the whole document sideways. Fixed: buttons on their own row, columns engage at `lg`
(measured — the three fields need **833px** of content width). Verified 375/768/820/900/1024/1280
all clean.

⚠️ **`e2e/overflow.spec.ts` is structurally blind here**: `WIDTHS = [320, 375, 440]`, all *below*
the breakpoint where the form stacks, and no spec ever opens the create form. Worth adding a
mid-width case — this is the second pass in a row where the overflow gate missed a real overflow.

### 5.2 The migration guard used the wrong predicate
Comparing `count(*)` against journal length is **not** how drizzle decides. Its migrator applies a
file only when the newest applied `created_at` is older than that file's timestamp. Count disagrees
in both directions:
- a journal entry stamped *older* than the watermark makes the count trail **forever** while
  `migrate()` correctly applies nothing — so the guard re-ran `migrate()` and opened a write
  transaction **on every call**, permanently, while the schema stayed broken and silent;
- a migration swapped across a branch or worktree keeps the count **equal** while a real migration
  is pending — suppressing the very fix it exists to deliver.

Both are live here: this repo hand-edits `_journal.json` (entry 4's `when` is an exactly-round
number) and uses worktrees. Now compares `max(created_at)` against the newest journal entry, runs
at **module scope** (in dev, exactly once per hot reload — the only moment a migration can appear
while the process lives, and no fs/JSON.parse in a request handler), and wraps `migrate()` so a
losing process in a race cannot 500 unrelated pages.

---

## 6. Process notes

⚠️ **Do not run the e2e gate while agents are working.** One run failed on
`zz-spending-drilldowns.spec.ts` and was **not trustworthy** — an adversarial agent had
`src/db/client.ts` temporarily mutated while the build and suite ran. The bundle-staleness guard
caught it afterwards. Agents that touch `src/` and a concurrent `e2e:fresh` are incompatible.

**The e2e flake picture so far:** `zz-zz-intraday.spec.ts:215` failed on a clean baseline and
passed on the changed tree (pass 32), and `zz-spending-drilldowns.spec.ts:10` failed only in the
agent-contaminated run. Neither is attributed to a code change.

**Adversarial review paid for itself twice over.** Four agents, ~675k tokens, and every single
claim came back refuted — including one that would have silently destroyed the owner's money. For
anything touching dedupe, balances or money identity in this repo, treat an unrefuted fix as
unfinished.

---

## 7. Next

1. **The quarantine double-count** — now well characterised (§4). Needs description similarity, a
   persistent pool, and all five promotion paths, not two. Do not restore `77248e0`.
2. **An "edit opening balance" affordance** for existing cash wallets, so the owner's "1800" wallet
   can be made right (§3.2).
3. **Parser hardening carry-over from pass 32**: the bulk-import scale test is still unwritten.
4. `createCashWallet` is **not atomic** — a `1970-01-01` opening date (which the input's own `min`
   permits) throws after the account row is inserted, leaving an orphan. Pre-existing.
5. **Hosting — ⛔ still NOT YET, by explicit instruction.**
