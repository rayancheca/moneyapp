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
> ⛔ **NEXT: rebuild the holdings book from the trade record.** The Robinhood CSV LANDED and is
> imported. It exposed something bigger than anything else in this pass: **`/investments` has been
> showing a frozen snapshot — under-counting 8 of 9 symbols and omitting GOOG entirely.** §9.
>
> ⛔ **STANDING RULE, stated by the owner this pass: NO FAKE DATA.** Every number must trace to a
> real source document. No estimates, no inference, no backfill. And its other half — *go and read
> the source*, because he was right that I had under-read what his own export already contained. §10.

## 1. Repo state

`main` = `1b25129` (verify with `git rev-parse --short main`). Fourteen commits, all pushed.

⚠️ **HISTORY WAS REWRITTEN THIS PASS.** Every SHA below `a2c6cf6` differs from what an older clone
has — see §8. A full pre-rewrite backup of every ref is at
`~/Desktop/moneyapp-pre-history-purge-2026-08-06.bundle` (198 MB); delete it once you are satisfied.

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | **150 files / 2,649 tests** (was 148 / 2,559) · 99.65% statements |
| `next build` | clean |
| `E2E_GATE=1 pnpm e2e:fresh` | **386 passed, 0 failed.** 17 baselines deliberately regenerated (16 `investments*`, 1 `category`); no other churn. |

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


---

## 9. ⛔ THE BIGGEST FINDING: `/investments` holdings are WRONG on screen today

The owner's all-time Robinhood activity export (`statements/robinhood/3ab6c2a8-….csv`, 2,260 rows,
2023-12-05 → 2026-07-31) is imported: **75 rows inserted, 2,181 deduped, net worth unchanged.**
Robinhood Cash now reads **$1,680.38** — the statement's own 07/31 close, to the cent — and July's
missing three weeks (40 recurring buys) are in. Failing periods **17 → 15**, gap days **526 → 468**.

Then reconstructing the share book from that CSV and checking it against the July statement's
Portfolio Summary found this:

| symbol | statement 2026-07-31 | reconstructed from the CSV | app `holdings` |
|---|---|---|---|
| MSFT | 45.890386 | **45.890386** ✓ | 43.63423 ✗ |
| SPY | 18.027139 | **18.027139** ✓ | 16.546213 ✗ |
| AMZN | 34.884778 | **34.884778** ✓ | 33.748471 ✗ |
| COKE | 33.959422 | **33.959427** ✓ | 32.989121 ✗ |
| UNH | 19.329560 | **19.329560** ✓ | 18.906582 ✗ |
| META | 7.283111 | **7.283111** ✓ | 6.984804 ✗ |
| GOOG | 0.312739 | **0.312739** ✓ | **absent** ✗ |
| WMT | 0.412664 | 0.412664 ✓ | 0.412664 ✓ |
| AAPL | 16.150657 | 21.150620 ⚠️ | 15.606784 ✗ |

**The reconstruction matches the statement for 8 of 9. The app matches for 1.**

The giveaway: AAPL's dividend rows print the share count they were paid on, and the app's
`15.606784` is *exactly* the 2026-05-13 dividend's count. `holding_events` also only begins
**2025-02-20** while the trade history begins **2023-12-05** — 14 months of trades never became
events. Worth roughly **+$1,570** against the statement's Total Securities.

⚠️ **Do not rebuild until AAPL is explained.** It reconstructs 5.000000 shares high (21.150620 vs
16.150657). Eight symbols land exactly, so this is one specific unfound event, not a method error.
Checked and NOT the cause: the only two price-less share events in the whole history are a COKE
split (9.0131, 2025-05-27, already reconciles) and the AAPL referral share (0.0267, 2023-12-05); the
single `ITRF` row is cash-only (−$26.64, no instrument).

**Cost basis is a RECORDED FACT, not an estimate.** Every `Buy` carries `Quantity` and `Price`.
Measured across 33 symbols: exactly 2 share events lack a price. A historical holdings table can
honestly show quantity, price, market value AND cost basis — see §10 for why the earlier
"derived estimate" framing was wrong.

---

## 10. ⛔ STANDING RULE — no fake data (owner, this pass)

> *"i dont want any fake data. i dont want reasoned data. all the data has to come from the actual
> statements. i dont want you hallucinating. the rules i told you before you can keep i just dont
> want fake data."*

Additive to every earlier rule. **The test for any number about to be displayed: which file, and
which line of it, says this?** Traceable → ship. Not traceable → do not display it; say what the
source does not carry.

⚠️ **The half that is easy to miss.** He said this immediately after I described his historical cost
basis as a *"derived estimate"* — and he was right that it is not. His export already contained the
price of every trade. **Before declaring anything unavailable, open the source documents and
measure.** Reconstructing from a real export is reading the record; guessing what the export would
have said is not. Under-reading available data is as much a failure of this rule as inventing data.

---

## 11. The reactivity work — root cause found, foundation shipped

The owner's ask: changing a chart's range should move the whole page, on every tab with a graph;
plus the transaction-list flow.

**Root cause, measured.** `ChartFocus.tsx` held the range in `useState(defaultRange)` and never
wrote it anywhere. The param was URL-*seeded* but never written back, so on `/investments`, the
dashboard hero, the account chart and the holding chart a pill press **could not reach the server at
all**. Not a missing wire — a one-way street.

**Shipped:** `rangeParam` opts a caller in; local state still leads so the chart re-slices on the
same tick, and the URL sync rides a transition behind it. `replace` not `push` (a range is a lens,
not a place in history). `/investments` opted in and verified live: pills write `?range=1M`, survive
a reload, stay pressed. Callers without `rangeParam` are byte-identical.

**Three corrections to the brief, all measured:**
- **There is no 20-row list.** Caps are 5, 6, 8, 10 and 50 (`PAGE_SIZE=50`). "like 20 entries"
  matches no constant in `src`.
- **The filter is NOT lost.** Every "View all" already carries its params into `/transactions`.
  What is lost is his PLACE: `/transactions` is the only detail destination in the app with **no
  breadcrumb**, and the dashboard's brushed window is React-only with no URL form. Two filter chips
  also render nameless ("Filtered category", "One merchant").
- **`/spending` is already fully reactive.** Do not sell work there. Its only gap is the heatmap
  showing one month of a YTD/ALL period.

**A live bug, still open:** `ReturnViewParts.tsx:89` computes best day / worst day / max drawdown
over the FULL series while the chart above shows a slice — all-time numbers under a 1M chart, with
nothing saying so. `lib/portfolio-returns.ts:102` already takes a pre-sliced run, so the fix is
passing the window. ⚠️ `dailyReturns()` starts at `i=1`, so the slice must include one day BEFORE
the window start or the first day silently loses its return.

**Cheapest remaining win:** `/flow` — `flow/page.tsx:44` hardcodes `2000-01-01` while
`transfer-flow.ts:145` already honours a range. Page-level change, no service work.

**Drill-down recommendation:** a drawer over the current page built from the existing `Sheet` +
`LedgerRowExpander` + one paged server action — not expand-in-place, not virtualization (10,003 rows
total). ⚠️ Trap: `bulkApplyByFilterAction` re-parses raw URL params server-side
(`actions.ts:456`), so a drawer holding its filter in React state and offering a bulk action would
mutate the WRONG set. And `RecentTransactions.tsx:81 → TransactionSheet.tsx:151` is a
Sheet-inside-Sheet hazard.

---

## 12. Also settled this pass, by measurement

**The SoFi → Robinhood chain is real and balances to the cent.** 44 rows out of SoFi Checking
(`$54,104.31`), 44 rows into Robinhood Cash (`$54,104.31`), and **43 of 44** pulls have a same-day,
same-amount sweep from SoFi Savings. Two caveats worth carrying: that savings→checking sweep is
SoFi's overdraft protection and fires **241** times for unrelated reasons, and from 2026 the funding
source switched to **Chase Checking**, bypassing SoFi entirely.

**The 2026-05-20 `$87.22` triple is not a double count.** An `ACH Deposit` was cancelled
(`ACH CANCEL`, −$87.22) and an `Instant bank transfer` from account 3522 succeeded.

**The pass-36 +$6,000 question is closed.** Both rows are real — the July 2025 statement's sweep
ledger steps twice: `$19,846.18 → $25,846.18 → $31,846.18`.

---

## 13. The queue, as it now stands

1. ⛔ **Explain AAPL's 5.000000 share gap, then rebuild the holdings book** from the trade record
   (§9). Fixes today's wrong numbers AND is the prerequisite for historical holdings — both need the
   same event history. Include cost basis; it is recorded, not inferred.
2. **Fix the all-time stats under the windowed chart** (§11).
3. **Wire `/investments` panels to `?range=`** — holdings, allocation, top movers, P&L heatmap.
   ⚠️ `holdings` has 9 rows and structurally cannot represent a past period; rebuild from
   `holding_events`. `holdingRows` also filters `isActive=true`, hiding the 25 exited symbols that
   are most of the point of a historical view.
4. **`/flow` range** (§11) — cheapest win.
5. **The transaction drawer + `/transactions` breadcrumb + name the filter chips** (§11).
6. **Robinhood CRYPTO activity export** would close July's remaining `+$1,798.35` gap — the
   securities export does not carry the crypto entity, so the `$4,999.74` ETH-sale transfer is still
   missing. ⛔ Do NOT delete the `+$3,579.67` plug first; the arithmetic now says that makes July
   worse.
7. **The 33 review rows** — walk them together; several are already settled by §12.
8. ⛔ **Hosting LAST.**
