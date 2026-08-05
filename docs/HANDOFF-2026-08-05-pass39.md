# Handoff — 2026-08-05, pass 39

> **111 statements imported, zero rows inserted, net worth unchanged to the cent.** That is the
> headline and it is not a disappointment — it is the point. The statements added no new money;
> they added *proof*. Chase Checking went 25 → 47 reconciled periods with no holes, SoFi advanced a
> month, and Discover's 690 unverified days collapsed to zero.
>
> ⛔ **Your repo was PUBLIC with 18 real Chase statements committed in it. It is now PRIVATE**
> (owner's call, taken this pass). The PDFs are still in git history — see §5.
>
> ⛔ **NEXT: the Robinhood modelling decision** (`docs/robinhood-statement-finding.md`). 32 perfect
> statements are on disk and cannot be used until three questions are answered. Do not write the
> parser first.

## 1. Repo state

`main` = `e29c17f` (verify with `git rev-parse --short main`). Seven commits, all pushed.
**The GitHub repo is now PRIVATE.**

| gate | result |
|---|---|
| `tsc --noEmit` | clean — **was RED on arrival**, see §3 |
| unit | **148 files / 2,559** (was 147 / 2,550) |
| `next build` | clean |
| `E2E_GATE=1 pnpm e2e:fresh` | **383 passed, 0 failed. Zero baseline churn.** |

**Real DB — written this pass, with approval.** 9,782 active txns (**unchanged**), 176 statement
periods (was 135), `integrity_check ok`. Net worth **$92,735.98 → $92,735.98, unchanged**, verified
via `netWorthSeries` before and after, not by SQL.

Restore points: `data/backups/pre-statement-backfill-2026-08-05.db` and the script's own
`pre-2026-08-05T162847-manual-backup.db`.

---

## 2. 🔴 THE LESSON: statements do not add money, they add proof — and the guard you trust is not the one doing the work

All 47 Chase files arrived **new by sha256**, including the 27 imported months ago. Chase
regenerates the PDF bytes on every download, so `ux_import_files_sha_parser` did not stop a single
one. Every one re-parsed in full. The only thing between that and a double count was
`dedupe_hash` — the mechanism that failed in pass 33 and again in pass 38.

It held: **0 inserted, 3,195 deduped, net worth unchanged.** But that was measured, not assumed,
and the measuring is the transferable part. `pnpm trial-import` copies the DB, redirects
`MONEYAPP_ORIGINALS_DIR` into `.trial/`, and prints the full before/after diff. The real run then
printed identical numbers. **Never import a re-downloaded statement batch without trialling it.**

The corollary worth carrying: an import that inserts zero rows is not a no-op. These 111 files
moved 690 days from "nothing is checking this" to verified, and closed a 22-month hole in Chase
Checking — while changing no balance anywhere.

---

## 3. What shipped

**`src/services/coverage.ts` + the panel on `/imports`** — the honest answer to "did my upload
work?", per account. Sourced from `daily_balances.basis`, not period counts.

⚠️ **The subtlety that makes it correct, and would silently break it:** `derived` means two
unrelated things. For cash accounts `derivation.ts:209` writes it to mean the transaction walk
landed *exactly* on the next anchor. For investment accounts `crypto-history.ts:124` writes it to
mean every held symbol had a fresh market close — a price-freshness flag with no arithmetic in it.
`accountCoverage` therefore branches on `account.type` **before** it reads basis at all. Without
that branch the two accounts with no arbiter (Robinhood Brokerage $66,289, Crypto $27,332) render
the same green as a card that reconciles to the cent. 9 tests pin this.

**`pnpm backup:statements`** — mirrors the archive to iCloud Drive. **386 files, ~51 MB.**
Additive-only by design: never deletes, never overwrites in place, parks byte-different files
beside the original. A mirror that deletes would faithfully propagate an accidental `rm -rf data/`
into the one copy meant to survive it. Covers **both** `data/statements/` and the `statements/`
drop folder, because a statement is ground truth from the moment it lands, not from the moment it
imports.

**`pnpm trial-import` / `pnpm import-statements`** — §2. The latter refuses to run without
`--confirm` and takes a `manualSnapshot` first.

**`fix: main was typecheck-red`** — pass 38's `reconcile.test.ts:46` seeds `status: "imported"`,
which is not in `IMPORT_STATUSES`. `tsc --noEmit` had been failing on clean `main` ever since. The
tests passed anyway because drizzle's `text({enum})` is compile-time only and SQLite accepted it.
**Check `tsc` on arrival; a green unit suite does not imply a green typecheck.**

---

## 4. The import, per account

| Account | Before | After |
|---|---|---|
| **Chase Checking 3522** | 25 periods, **22-month hole** 2024-07→2026-05 | **47 periods, zero holes**, verified → 2026-07-10 |
| **Discover 4741** | unverified, 690 days nothing checking | statements → 2026-07-02; **690 unverified days → 0**; 89 `gap` days remain (§4.1) |
| **SoFi Checking / Savings** | verified → 2026-06-30 | verified → **2026-07-31** |
| Chase Sapphire | verified → 2026-08-02 | unchanged — the 18 dropped PDFs were already imported |
| Robinhood ×3, Cash on Hand | — | unchanged, see §6 |

### 4.1 ⚠️ Discover's one real defect — a $40 phantom credit

One period fails: **2024-09-19 → 2024-10-18, gap −$40.00**, and 89 days (2024-08-19 → 2024-11-17)
are `gap`. The cause is identified, not mysterious:

The CSV contains `AUTOMATIC PAYMENT -CRAN ADJUSTMENT TO YOUR ACCOUNT +$40.00` on 2024-10-03. **No
Discover statement prints it** — checked Sep, Oct and Nov 2024. The statement's own summary is
internally consistent (`210.79 − 1,353.03 + 1,351.21 = 208.97`), so the extra $40 is the app's, not
Discover's. It has been quietly inflating the ledger since 2024 and was invisible until statements
arrived to argue with it.

**Deliberately not "fixed".** It needs the owner's call: accept the gap in the UI (`acceptGap`
exists for this), or delete the row if he agrees it is phantom. Do not silently exclude it —
`excluded` rows still move money through reconciliation.

Also note **3 Discover statements are genuinely missing**: 2025-04, 2025-08, 2025-09. Discover's
own cycles merge across two of them so only one real hole survives, but they are worth grabbing.

---

## 5. ⛔ The repo was public with real statements in it

Found while committing: `statements/` was **untracked but not ignored**, and 18 real Chase Sapphire
PDFs had been committed in `2e6333b` and were in HEAD of a **public** repo.

**Accurate scope — I overstated this at first and corrected it.** No full card number: Chase masks
it itself (`Account Number: XXXX XXXX XXXX *805`). What *was* public: the cardholder's full name,
the card's last four, and ~132 itemised transactions per statement × 18 months — merchant, location,
date and amount for every purchase.

**Done:** removed from HEAD, `statements/` added to `.gitignore` (one `git add -A` would have
published another 143 files, including Robinhood statements that *do* carry a full account number
and home address), and **the owner chose to make the repo private**, which is now in effect.

**Still open:** the PDFs remain in git history. Purging needs `git-filter-repo` + force-push, and
anything already cloned or cached may retain them regardless. The owner's instruction was "push
everything to github just make it private" — history rewrite was not requested. Raise it once, do
not nag.

---

## 6. ⛔ NEXT: the Robinhood decision — read `docs/robinhood-statement-finding.md` first

32 consecutive monthly brokerage statements (2023-12 → 2026-07, zero gaps) are in
`statements/robinhood/`. They are excellent — the cash ledger closes to the cent
(`192.22 − 8,584.63 + 10,043.43 = 1,651.02`). **They are still not importable, and the blocker is
structural.**

🔴 **The app's `Robinhood Cash` is not Robinhood's cash.** The statement's balance sits near **$0**
(swept settlement cash); the app's runs to **$41,467**, because **2,068 of its 2,181 rows are
trades**. It is an all-activity ledger. Reconciling the two would manufacture five-figure gaps that
mean nothing — pass 38's lesson wearing a new hat.

🔴 **And a Portfolio Value anchor would not help the brokerage twice over.** `reconcileAccounts`
stamps `value_anchor` unconditionally for `type='investment'` (`service.ts:1190`), so those periods
*cannot* report a problem; and `rebuildAccount` returns early into `rebuildInvestmentHistory`
whenever `holding_events` exist (**1,925 do**), so the anchors would be written and silently
ignored. Building the parser now yields something that either does nothing or lies.

**Three owner decisions, in the doc's §4.** Ask before writing any code.

Today all 32 files match **no** profile, so importing them fails cleanly per file with
`"No parser profile matched this file"` and writes nothing. No interim guard needed.

---

## 7. The rest of the queue, unchanged

3. ⛔ **Touch emulation** — still pending from pass 38. Exactly two `pointer-coarse:` call sites
   (`DataTable.tsx:66`, `TransactionsLedger.tsx:71`), both revealing hover-only row controls.
   ⚠️ `fullyParallel: false, workers: 1` and all specs share one DB — a second project must not
   double-run.
4. **Chart "partial coverage"** — still a copy job, not a data job. ⛔ never backfill Cash on Hand.
5. **Duplicate/review leftovers** — 33 rows still carry `needs_review`; fix the re-flagging before
   touching the queue.
6. ⛔ **Hosting LAST.** `docs/deploy-plan-gcp-firebase-auth.md`. **Auth allowlist now fully known:**
   `rayankarimcheca@gmail.com` + backup `rayanchecakarim@gmail.com` (note the transposition — copy,
   never retype).

---

## 8. Owner facts learned this pass

- **"Chase College Checking" is account 3522** — confirmed by `Account Number: 000000889063522`
  inside the PDFs, not by filename. It is Chase's product name for the account already in the app.
  Not a new account. (He first said the folder was "a mistake", then filled it — trust the content.)
- **The statements are ground truth and he knows it** — he asked for them to be kept safe before
  being told they weren't. He chose **iCloud Drive** for the off-machine copy.
- **He chose privacy over a history rewrite** for the exposure in §5.
- **He downloads more than asked** — 32 Robinhood statements against a request for 24, back to
  2023-12. Ask for the range that is actually useful; he will get it.
- ⭐ Standing permission from pass 38 confirmed again: **just stop the dev server** if it's in the
  way. It was running at :3000 this pass and stopping it was correct.

---

## 9. Process notes

- **The `.trial/` pattern is the reusable win.** Copy the DB with SQLite's backup API, redirect
  `MONEYAPP_ORIGINALS_DIR`, import, diff. It cost one script and it is why a 111-file import into
  real money data was boring.
- **I overstated the git exposure before verifying it.** A regex for a 16-digit card number matched
  across a newline in joined text. The correction took one careful re-read. **When reporting a
  security finding, check the match itself before naming its severity** — the urgency is not a
  reason to skip that, it is the reason to do it.
- **Two agents in the pass-38 workflow disagreed 3× on "unverified".** The code settled it
  (`derivation.ts:209`), not the louder agent. That disagreement is what produced the coverage
  panel's type branch, which is the one thing in it that is easy to get wrong.
