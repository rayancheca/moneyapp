# Handoff — 2026-08-06, pass 40

> **The Robinhood blocker did not exist.** Pass 39 concluded that `Robinhood Cash` was "an
> all-activity ledger" that could never reconcile, and parked 32 statements behind three owner
> decisions. It reached that conclusion by reading the statement's `Brokerage Cash Balance` line and
> ignoring the `Deposit Sweep Balance` line printed directly beneath it — which is where the money
> actually was. All three decisions dissolved on measurement.
>
> **Robinhood Cash's 703 unverified days are now 0**, Discover's 89 gap days are 0, and there are
> **zero `gap` days left anywhere in the ledger**. Net worth **$92,735.98 → $87,180.71**, which is
> the correction the owner approved in advance.
>
> ⛔ **NEXT: export a fresh Robinhood activity CSV.** Not a parser, not a decision — §4 explains why
> that single file closes most of what still looks broken.

## 1. Repo state

`main` = `8b6b906` (verify with `git rev-parse --short main`). Ten commits, all pushed.

⚠️ **HISTORY WAS REWRITTEN THIS PASS.** Every SHA below `a2c6cf6` differs from what an older clone
has — see §8. A full pre-rewrite backup of every ref is at
`~/Desktop/moneyapp-pre-history-purge-2026-08-06.bundle` (198 MB); delete it once you are satisfied.

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | **150 files / 2,635 tests** (was 148 / 2,559) · 99.65% statements |
| `next build` | clean |
| `E2E_GATE=1 pnpm e2e:fresh` | **386 passed, 0 failed.** 16 `investments*` baselines deliberately regenerated (§7); no other churn. |

Real DB written twice this pass, both approved. `integrity_check ok`. 9,792 active txns (+10),
216 statement periods (was 176).

Restore points: `data/backups/pre-pass40-2026-08-06.db` and the two the scripts took themselves
(`pre-2026-08-06T104147`, `pre-2026-08-06T104214`).

---

## 2. 🔴 THE LESSON: read the line *next to* the one that confirms your hypothesis

Pass 39's table compared the app's `Robinhood Cash` against the statement's `Brokerage Cash Balance`
and found them unrelated — app $41,467 against a printed $35.00 — and concluded the two "are not the
same series and never were". The line immediately below read `Deposit Sweep Balance $41,532.16`.
Against true total cash the app was within **$100.04** that month.

Every downstream conclusion inherited the error: that the account was mis-modelled, that a
migration of ~$378k of movement might be needed, that reconciling would "manufacture five-figure
gaps". None of it was true. The codebase had even documented the correct model already — the
`preferName` doc comment in `types.ts` says in as many words that the Robinhood activity CSV **is
the settlement-cash ledger**.

The transferable rule: when a measurement confirms a hypothesis, read the adjacent fields before
building on it. A number that supports your theory is exactly when you are least likely to look at
its neighbours.

A second instance of the same failure, same pass: pass 39 reported a "phantom $40.00 credit" because
it appeared on no statement. It did not check whether the *statements* were complete — three
Discover files in the archive are byte-identical duplicates of the adjacent month, so two billing
cycles were simply absent. "Absent from every statement" was true and proved nothing.

---

## 3. What shipped

**`robinhood-brokerage-statement-profile.ts`** — 32/32 statements, three layout eras, 18 tests.
Emits **no transactions**, only periods and anchors: the CSV already has the itemised rows, and
statements add proof, not money. No reconciliation change was needed — `Robinhood Cash` is type
`checking`, so the existing CASH branch already gates it arithmetically. Quirks handled, each of
which would otherwise have shifted a balance silently: parenthesised negatives (`($9.90)`), an
allocation table repeating the same labels with a percentage instead of a balance, `N/A` openings,
and a **second account `#655929651`** that appears from 2026-06 — only the first section is parsed,
so its $26.64 can never blend into the anchor.

Routing measured over **all 391 real PDFs on disk**: 32 brokerage, 24 crypto, **0 collisions, 0
unmatched**.

**The 16 crypto statements needed no new code at all** — the existing profile already matched them.
8 were new; they imported with net worth unchanged and gave Robinhood Crypto 16 periods.

**Discover** — `discover-card-csv` v2 plus a one-off correction script. Discover back-dates dispute
adjustments to the charge they reverse and puts the real posting date in `Trans. Date`. See §5.

**Chart honesty + the missing headline %** — "partial coverage" fired on 1,440 of 1,443 days in
warning colour. Pre-start (an account had not opened yet) is now neutral and worded "open"/"opens";
interior gaps (Discover's 89, now 0) keep the warning. And the net-worth **% change had rendered on
no range pill since 2026-08-03** — the rule required both endpoints fully covered, and adding the
cash wallet made every start endpoint partial. It now compares the accounts both endpoints cover and
names what it dropped.

⚠️ **The subtlety that made the first attempt wrong:** the restored % was paired with the *raw
all-account* dollar delta, so the header printed `+$31,492.04 (+21.85%)` where the shared accounts
had moved $13,380.54. Pairing a shared-scope percentage with an all-account dollar does not remove
the fabricated number — it relocates it into the pairing. `sharedCoverageChange` now returns
`deltaCents` and both surfaces print it.

**`transfer_ambiguities`** — PASS 2 re-flagged every answered question on every import, so the
review queue could never drain. Content-keyed (survives unimport→reimport), `SET NULL` not
`CASCADE`, and **wired into `applyCorrection`** — a verdict table nothing writes to is shelf-ware.
The queue item was also mislabelled: the duplicates flagger contributes **zero** of the 33; all 33
are PASS-2 transfer ambiguities. The 33 rows are untouched — draining them is still an owner call.

**`trial-import` was writing to the database it promises not to touch.** It printed "the real
database was never opened for writing" while opening it through `createDatabase()`, which calls
`migrate()` on every open. That is how migration 0009 reached the real DB mid-pass. Additive DDL,
no data changed — but the claim had to become true. Now opens READONLY.

---

## 3b. Shipped after the first draft of this handoff

**Row-selection on `/investments`** — `DataTable`'s selection API was complete and used by nobody.
Ticking holdings now prints a ledger-style total: count, combined value, combined share, today's
move. The rule that matters is the null rule — sum only non-null values per figure and always state
how many rows fed it; a figure with no contributors is `null`, never `0`, because "none of these is
priced" and "these are worth nothing" must not render alike. Selection is keyed on account+symbol,
so one symbol in two accounts stays two legs. Clearing moves focus to the select-all box (the Clear
button removes itself from the document). 16 `investments*` baselines regenerated — the checkbox
column shifts the table, which is the intended change.

⚠️ **One test was replaced because it could not fail.** "Two accounts holding the same symbol are
not deduped" asserted a property the reducer cannot violate — its input type carries no symbol. The
real invariant lives in the selection key and is pinned there now. A test that cannot fail is worse
than no test: it reads as coverage.

**The other four dashboard modes got their % back too.** Split/assets/liabilities/accounts kept the
old both-endpoints-complete rule. ⚠️ The trap: a rollup's `complete` goes false for TWO reasons —
a member is uncovered, OR a covered member is an estimate — and it also drives the dashed line.
Feeding it to the comparison would have suppressed the % on every carried day, which is most days.
`rollupLine` now emits coverage detail ALONGSIDE `complete` rather than changing it.

---

## 4. ⛔ NEXT: one CSV export, not a parser

`Robinhood Cash` now grades **`broken`** — 14 periods reconcile, 17 report a gap. That is honest,
and it is not a modelling problem. **The app's Robinhood activity CSV stops on 2026-07-07.**

Compare July against the statement's own cash ledger:

| statement | app |
|---|---|
| 07/06 **+$5,043.62** | ✓ present, dated 07/02 (settlement lag) |
| 07/07 **−$3,000.00** | ✓ exactly (−$2,947.50 − $52.50 fee) |
| 07/08 **+$4,999.74** crypto sale | ✗ **missing** |
| 07/17→07/31 **−$5,584.63** (11 debits) | ✗ **all missing** |

The `+$3,579.67` `excluded` row dated 2026-07-10 labelled *"Reconciliation — Robinhood settlement
residual"* was invented to paper over exactly this. It is not a modelling artefact; it is three
weeks of missing activity wearing a plug's clothing.

**Ask the owner for a fresh Robinhood activity CSV covering 2026-07-01 → today.** Import it, then
delete the plug. July should land within ~$29 (the dividend + sweep lines).

⛔ **Do NOT delete the plug first.** Without the missing rows it drops Robinhood Cash to $3,655.98
and moves net worth $3,579.67 the wrong way while looking like a cleanup.

**The crypto question is settled** and needs no further asking. The 2026-07-07 `Crypto Money
Movement COIN $4,999.74` was a **sale of ETH**: the app's cumulative ETH at 2026-06-30 is
`17.417212`, exactly the statement's June close, and a holding event on 2026-07-10 already records
`−2.798146 ETH` ("user-confirmed current quantity — July activity, statement pending").
$4,999.74 ÷ 2.798146 = $1,786.78/ETH, a sane July price. The ETH side is recorded; only the cash
landing was never entered.

**The older gaps are a different story** and are genuinely worth a look: several cancel in adjacent
months (`+$100 / −$100`, `+$1,100 / −$1,000`), the displacement signature that the Discover fix
turned out to be. 2026-03 (`+$9,924.43`) and 2026-04 (`−$7,699.81`) are the largest and also cancel.
Their cumulative sum is −$5,555.31, matching the net-worth correction, so the ledger is at least
internally coherent.

---

## 5. Discover — what pass 39 got wrong, and the arithmetic that settled it

Both $40.00 credits are real refunds of `STEPHANCODES.COM` charges. Both really posted **2024-10-29**
(their `Trans. Date`); the parser filed them to 2024-09-18 and 2024-10-03 because it read
`Post Date`, which Discover back-dates for dispute adjustments.

Three consecutive spans were each wrong by exactly ±$40 — which is what a displacement looks like
and a fabrication does not:

| span | before | after | anchor |
|---|---|---|---|
| A `2024-08-19..09-18` | +$9.21 | **−$30.79** | −$30.79 |
| B `2024-09-19..10-18` | +$41.82 | **+$1.82** | +$1.82 |
| C `2024-10-19..11-18` | −$193.34 | **−$113.34** | −$113.34 |

Only span B has a `statement_period` row, which is why a period-only reading sees one implicated
credit rather than two. Applied: **Discover `broken` → `verified` through 2026-07-02, 89 gap days →
0, net worth unchanged to the cent.**

⚠️ **Three Discover statements in the archive are byte-identical duplicates of the adjacent month** —
`Statement_092024` = `082024`, `Statement_112024` = `102024`, `Statement_032025` = `022025`. Those
three billing cycles have no independent arbiter. Worth re-downloading.

---

## 6. The rest of the queue

1. ⛔ **Robinhood activity CSV** (§4) — the highest-value single action left.
2. **The 33 review rows** — the mechanism is fixed; draining them is an owner call. Still open from
   pass 36: two identical Robinhood **+$6,000** rows on 2025-07-07 against −$6,000 out of SoFi on
   07-07 *and* 07-08. Robinhood Cash now has statements, so this may finally be answerable.
3. **`DataTable`'s `selectable` subtree is dead code** — no consumer passes it, so its
   `pointer-coarse:` branch is unreachable. Delete it, or give it a consumer. Owner's call, noted in
   the spec header so it is not re-litigated.
4. **`DashboardModePanel`** still carries the old both-endpoints-complete suppression, so the
   split/accounts/liabilities modes still show no %. Same fix as the hero, different file.
5. **Docs quoting the old copy** — `docs/adversarial-review-2026-07-27.md:997`,
   `docs/future-ideas.md:918`, `docs/ux-overhaul-plan.md:277` still say "Partial coverage".
6. ⛔ **Hosting LAST.** `docs/deploy-plan-gcp-firebase-auth.md`. Allowlist known:
   `rayankarimcheca@gmail.com` + `rayanchecakarim@gmail.com` (transposed — copy, never retype).

**The +$6,000 question from pass 36 is ANSWERED.** The two identical Robinhood +$6,000 rows on
2025-07-07 are BOTH REAL: the July 2025 statement's sweep ledger steps twice,
`$19,846.18 → $25,846.18 → $31,846.18`. Not a double count. One of the 33 already settled.

---

## 8. ⚠️ Git history was rewritten (owner-approved)

The 18 real Chase Sapphire PDFs committed while the repo was public have been purged from history
with `git-filter-repo --path statements/ --invert-paths`, and `main` force-pushed.

- **Every SHA below `a2c6cf6` changed.** An older clone cannot fast-forward; re-clone instead.
- Verified after: 0 statement paths across ALL refs (the 4 stale `claude/*` branches predate them
  and carried none), 194 synthetic test fixtures intact, `.gitignore` protections for `statements/`
  and `data/` both survived, `.git` 393 MB → 194 MB.
- One commit vanished — `fix: stop tracking real statements` — correctly pruned as empty once the
  files it deleted never existed.
- **Backup:** `~/Desktop/moneyapp-pre-history-purge-2026-08-06.bundle`, every ref as it was.
- ⚠️ Anything GitHub already cached, or any clone taken while the repo was public, may still retain
  the files. The rewrite cannot reach those.

---

## 7. Process notes

- **`pnpm trial-import` before every real import.** It is why a 48-file import into real money data
  was boring: the trial and the real run printed identical numbers, including the −$5,555.27.
- **Two agents disagreed about whether one Discover row or two should move.** Neither was asked to
  arbitrate — the span arithmetic settled it, and it showed both were partly right: only one row is
  implicated by a *period*, but three *spans* were each off by $40. Compute the thing both sides are
  arguing about.
- **A green unit suite does not imply a green typecheck, and a green typecheck does not imply a
  green coverage gate.** `src/lib/**` requires 100% branch coverage; one new ternary failed it.
- **The reviewer earned its keep twice**: the chart's dollar/percentage mismatch and the fact that
  the new verdict table had no writer. Both were "the feature works" claims that were true in
  isolation and false in use.
