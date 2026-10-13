# Handoff — six visible defects, his answers 61–70, three gated batches

> Written 2026-10-13 (session f3de5789, started 2026-10-12). `origin/main` = this handoff's commit. Since `ece3bda`:
> three batches, each fixer branch read by a skeptical reviewer against a COPY of his ledger, every HIGH/MEDIUM sent to
> a follow-up (and re-reviewed once), LOWs queued below (§6C).
> Batch 1 gated + pushed `aa23d34` (gate 593 + 24 re-based). Batch 2 gated + pushed `ef111ad` (gate 554 + 64 re-based;
> unit 426 files / 8,913). Batch 3 gated + pushed with this handoff (gate 577 + 40 re-based + 1 stale spec fixed; unit
> 427 files / 8,948). No migrations. **No ledger writes this session.** `pnpm ledger-check` exit 0
> after each push.

---

## 0. THE JOB — what is next

1. **No statement has been imported since Oct 5.** When the next ones land (Wells Fargo ~Oct 24 with weekly payroll,
   Chase Checking past Aug 12, Discover/Capital One's ~Oct 9 close, Venture X ~Oct 14, Robinhood/SoFi/Sapphire), read
   FIRST on his real ledger: the pay's per-payday settlement on real weekly rows; the two "Zelle From Rayan Karim Checa"
   rows pairing; the rent's Oct 1 turning "not posted" only once WELLS FARGO's checked statement passes Oct 4 (his 62 —
   no longer waiting on Chase); September's rollover arriving on its own once September is read (his 67); the budget
   dashes (64) and "— in so far" (68) turning into figures as days are read.
2. **Read the running app for visible defects** — it found 6 this session (§1b). Then the queue (§6).

## 1. WHAT LANDED

### 1a. His answers (asked 2026-10-12/13 as either/ors; each the recommended option)

| # | his answer | built |
|---|---|---|
| 61 | caption the runway's spend arithmetic | "$56,444.55 spent − $888.62 back − $6,100.00 up front, over 6 months" under "What you spend a month $8,242.66" (`spendArithmeticCaption`, same reads as the link) |
| 62 | a bill's "not posted" reads the accounts its last two payments used | `dueDayReadings` → `silenceMeasuredThroughBySeries` (landing accounts, CHECKED day — the chip's and lapse's); rent now reads Wells Fargo (Sep 24), not Chase (Aug 12) |
| 63 | posted avg counts the current rate's payments only | `atTodaysRate`; latent (only pay has a history) |
| 64 | no elapsed day read → Spent and Left "—" | /budgets rows, category budget card, deactivate dialog; all 12 of his rows today |
| 65 | rows without a statement: the words follow the reading | every "no import has covered it yet" → "no statement has covered it yet" |
| 66 | a named account AND where it last paid; the earlier day stands | `landingAccountsBySeries` adds, never replaces; latent (only dismissed Pura Vida) |
| 67 | a closed period with any unread day banks nothing | September's $761.52 of rollover held back on 9 rolling budgets; panel says so |
| 68 | "— in so far" with no income day read | /budgets header; the dashboard's "Income recorded in Oct" follows the same flag (built as implied) |
| 69 | no "Projected ≈" on a partly read Awaiting row | /budgets |
| 70 | keep "End series" on a dismissed series, worded truthfully | its dialog says the rows become recurring history again |

Defaults built without asking (latent): §6A.

### 1b. Visible defects found by reading his app (2026-10-12)

| defect | fix |
|---|---|
| Rent "posted avg −$1,849.76 ± $583.58" under −$2,109.00 though every month paid more (Jun 16's one payment = two card rows) | per payment (same-day rows one sample): "posted avg −$2,312.20 ± $85.27 · its payments carry Rent utilities & fees too"; Amount history one bar per payment |
| Calendar's Oct 1/8 paydays "not banked yet" beside the dashboard's "the ledger has not looked for their deposits" | reason by the income mirror's frontier (`checkedThroughBySeries`): unread → "no statement has covered it yet" |
| Pay page silent about Oct 1/Oct 8 while bill pages list "Already due" | "2 paydays worth $2,283.84 already passed this month" + dates, from `unbankedIncomeForSeries` |
| "$701.04 due before your next paycheck (Oct 15)" counting bills due ON Oct 15 | "due by" |
| Runway "What you earn a month" → bare /spending (October, not imported) | → the pay schedule (`incomeBasisHref`); Earned vs banked's "Schedule →" too |
| Housing "SPENT · OCTOBER 2026 $0.00 · 0 transactions" over its own "not imported yet" | "—" (`emptyFigure`); partly covered empty windows say "a lower bound" |

Also found by the gate: the recurring calendar's 24 rapid "Previous month" presses lost clicks once each month's read
grew ~5 ms (the grid stepped from the SHOWN month) — `useMonthPaging` now steps from the month last asked for, on all
three calendars.

### 1c. Queue items fixed (§6C of the 10-09 handoff)
merge-files (revalidate, preview only where shown, one path printer, refuse a merge that differs from its confirmation,
attach toasts name the filing); discover-cycle (holes and one outlier no longer flip the moved-cycle phrase; hole
counts); ack guards (U+2028/9, bidi); /imports footer (reports vs opening statements vs QFX), link names contain the
visible hint, hook output; balance words ("counted"); arrears words (one window, End headline true of its lines, by
kind, read/unread split on /budgets); late-lapse (one-off past its day "was expected once", "Ended" section, one tone
for Never billed); carrier-grace (month-edge rent drawn once, late payment pays its due day late); pace/agent
(negative projection, press-race bound, agent EOM test); pay words (popover per payday, no RangeError before a raise's
first deposit, same-day reversal not a sample); the e2e fixture's Paycheck anchor Jul 10 → Jul 17.

### 1d. Baselines re-based, every family read
- Batch 1 (24): dashboard/grid ×16 ("due by", runway caption), imports ×8 (footer split 9 + 18).
- Batch 2 (64): the fixture anchor (dashboard, grid, recurring, recurring-calendar, budgets, spending, spending-year
  ×8 each), series-detail ×8 (Storage unit ended → "6 scheduled commitments").
- Batch 3 (40): budgets ×8 (no "Projected ≈" on partly read rows, 69), dashboard/grid ×16 ("has not posted"), spending
  and spending-year ×16 (earnings note "or the ledger has not looked for its deposit"). zz-budgets' "$778.36" check
  became "no projection printed" (the sum stays pinned in budgets.test.ts).

## 2. ⛔ REAL-LEDGER WRITES
None this session.

## 3. ❓ HIS ANSWERS (closed — do not re-ask)
Memory `moneyapp-owner-decisions-2026-09-28`: 61–70 (2026-10-12/13).

## 4. ⛔ WHAT COST TIME
- **A root `zz-*.ts` probe broke `next build`** (it imported an export a branch removed). Probe from a worktree or the
  scratchpad; `ls zz*` before a build.
- **I pushed `aa23d34` with a red unit test** — my calendar fix (5d156a4) after the last full unit run. Repaired in
  batch 2. Run the FULL unit suite after ANY commit before pushing.
- **Re-running one spec cleared `test-results/`** and the gate's captures with it — copy captures first.
- **An 11-file conflict** between two branches that both reworded recurring surfaces (late-lapse vs arrears words) —
  an agent briefed with both intents composed it (6cae7c5).

## 5. ✅ CHECKED IN THE RUNNING APP ON HIS LEDGER (2026-10-13, :3000)
Rent "posted avg −$2,312.20 ± $85.27 · its payments carry Rent utilities & fees too"; pay page "2 paydays worth
$2,283.84 already passed this month … Oct 1 +$1,141.92, Oct 8 +$1,141.92"; strip "$701.04 due by your next paycheck
(Oct 15)"; runway caption as 61; earn and Schedule links → the pay series; Housing "Spent · October 2026 —"; calendar
Oct 1/8 "no statement has covered it yet"; /budgets rows "Spent — · Budget $X · Left —"; runway "A further $2,400.08
came due earlier this month and no statement has covered it yet." After batch 3: /budgets "— in so far"; Transport "Budget $227.95", Cash & ATM $130.00, Shopping $280.00 — no rollover
(67); dashboard "Income recorded in Oct 2026 —" with "Not one day of Oct 2026 has been checked in the accounts that pay
lands in, so nothing is shown."

## 6. ❓ THE QUEUE

### 6A. Built with a default, not asked (latent on his ledger)
- One-off past its day: "was expected once on Nov 11" (never "charged"); keeps "Never billed"; files under "Ended".
- A payment past its grace pays its due day late (no ✕ left); no "paid N days late" mark.
- Carrier and carried bill each answer on their own grace (no pair grace).
- A pay anchor dated before the first deposit keeps its weeks (a first lump pays them back).
- Pay's badge gate counts paydays always (one count with bills).
- A view press to the default during a hung Back save draws once the save lands.
- A refund that takes a budget below zero: no projection.
- An "other"-kind series is worded as payments (merge choice, 6cae7c5); its present-tense cadence still says "charges".
- The dashboard's "Free to spend" tile keeps "at least $X projected" on a partly read month (decision 69 named budget rows).
- QFX balance records: anchor ownership as shipped (no QFX on his ledger).
- A merge refuses on a changed category id, not a renamed path.
- Owner calls still open (latent): a payment more than its grace EARLY — pay the earlier unpaid day or the later day
  early? A payroll returned the same day — un-pay its payday on the calendar and Earned vs banked?
- Older: §6A of the 10-09 handoff (deposit halfway → newer era; archived pay wording; Capital One 360 link; Chase's
  landing after sign-in unverified; a future raise needs a "from when?").

### 6C. LOW findings (73, by branch; some may already be fixed by a later branch — check first)
#### posted-avg-occurrence (1)
- The rent's half-cent mean rounds toward zero: -$2,312.20, where the brief expected about -$2,312.21
#### payday-unread-reason (4)
- In recurringCalendar, the local `checkedThrough` holds the silence frontier, while the payday frontier from checkedThroughBySeries is called `paydaysCheckedOf`
- A payday with an unchecked landing account says 'no import has covered it yet' where the pay sentence says 'the ledger has not checked every account that pay could land in'
- The service test says the Day Sheet agrees, but it only renders the cell aria-label
- For pay landing on an archived account or a cash wallet, 'yet' implies a statement that is not coming
#### pay-page-passed (3)
- Checked-payday body uses /budgets' sentence, not the forecast's; the forecast still calls his ACH payroll 'Cash pay' (pre-existing, his wording call)
- The checked split ignores tolerance, so a payday inside its grace days gets warning colour (inherited)
- Doc comments not updated for the new reader
#### dashboard-links (4)
- For more than one schedule, /recurring?tab=all lists schedules that are not behind the rate
- A dashboard test name still describes the on-payday rule with the old "before" wording
- No e2e check pins the earn row's link; only the unit tests do
- With more than one pay schedule, /recurring?tab=all lists every bill too, not just the schedules behind the rate
#### category-headline (6)
- The dash state has no rendered (e2e or visual) path, so the zero-tolerance gate cannot see it
- The task named three kinds to dash; the commit also dashes a month that has not started
- The same fact in two wordings: the pace tile says "is not imported yet", the category headline "has not been imported yet"
- No test covers a partly-covered window on the card, so a wrong day count goes undetected
- The card colours "left" from alert while /budgets headlines the pace: a measured Off-pace row reads green "$X left"
- categoryBudgetRef repeats reads the page already made (about +23 ms per category page)
#### read-on-landing (2)
- Fixer's 'every other series is unchanged' is inaccurate: two dismissed series also moved
- Docstrings still say due days are read when 'imported through', not 'checked through'
#### runway-caption (1)
- When the window holds a net refund of the up-front money, the caption words it differently from the phrase the same card already uses
#### posted-avg-era (3)
- The evidence line's counts no longer add up when a payment from before the change was posted as two rows
- The anecdote gate counts payments when there is a rate change and rows when there is not, so the same two payments are graded both ways
- Wording: "That is one payment …" right after the sentence about the earlier payments; "at the new rate" is not his phrase
#### low-merge (3)
- A merge refused by the re-read inside its transaction still writes a restore point, though the code comment and commit message say no refusal does
- The two transaction-sheet toasts that now name the filing are not tested where LinkPanels raises them
- Five category-path parsers still split on a literal " > " rather than PATH_SEPARATOR, so the separator's 'fails the build' promise does not cover them
#### low-discover-cycle (3)
- Test name promises a header check that the test never makes
- The new hole-count bound is pinned from below only. The 15-day threshold can move anywhere up to 25 days and every hole test stays green.
- `movedCycle`'s docstring still says the longest run folds in a transitional first close; 4effbce now keeps one nearer the old day out of the run.
#### low-ack (2)
- The module's own header still describes the old guard: 'a control character among its words' only
- A reason stored under the old guard with a bidi control could never be given again, so a partly acknowledged mark would fail for good
#### low-imports-words (6)
- The documents sentence still calls a QFX download that printed a ledger balance "an export without a closing figure" (wording unchanged by this diff; no OFX/QFX on his ledger yet)
- balanceLessNotes doc says the footer's counts add up to the periods imported; counting reports as documents breaks that
- The opening-statement note states two things no code checks: "an account's first" and "the statement schedule counts them"
- future-ideas.md describes the old two-bank rule inaccurately
- Test fixture comment says "His ledger's shape", but the fixture includes an OFX download his ledger does not have
- Comment and commit message say 'every day' of Agentic's June and Cash's Dec 2023 read the period line; the first days show no period line at all
#### low-balance-words (2)
- Dropping 'yet' for an account priced from its holdings rests on a false claim: statements and live readings do add balances to that list
- Comment still says 'no recorded balance' beside the row this commit reworded
#### budgets-statement-words (5)
- The /budgets overdue note still speaks of "the room left" over 12 rows that now print "Left —"
- Stale comments, and the coverage-grade change reaches readers that are not tested
- Calendar press-race fix: after a failed month load, the next press skips a month or goes nowhere
- Other All-tab section notes still use bill words over pay and transfers, despite 17ff00a's 'ONE table' claim
- /spending's cash-earnings note still says paydays after the last checked day 'have not been imported yet' (decision 65 wording)
#### named-and-landing (3)
- The paydayIsRead docstring and a recurring-calendar comment still say the bills' reading uses every account a series ever posted to, which contradicts the rule this commit built
- The dueDayIsRead docstring still lists the landing accounts without the account the series names
- The new landingAccountsBySeries docstring says the old rule could draw a ✕ for PURA VIDA, but a dismissed series never reaches the calendar
#### low-late-lapse (5)
- annualizedCaveat/annualizedEndNote 'stopped' branch is now unreachable, and its comment is false
- The running-late staleness sentence still gives the import-lag reason that fcdd51b says no longer applies
- A mid-cycle end date reads "Ends Nov 30, 2026" in the future tense beside "Its schedule has ended — every date it holds has come"
- Merge confirmation still says "Its charges move here" whatever the candidate's kind
- The staleness sentence still says "expected about every 30 days" of the one-off (pre-existing; §6A 56 says once)
#### low-carrier-grace (4)
- On an account read through today, the last day a payment may post already draws ✕ "not posted"
- The plural /budgets note uses a singular phrase
- The new docstring and commit message say the pair 'can split one way only'; it splits the other way when the carrier has no landing accounts
- Test coverage checked: the new tests do pin the fix; the accounts test pins a change nobody made
#### low-pace-agent (4)
- Spoken sentence says "projected $0.00" where the row now prints no projection
- Benchmark pick still waits without a bound on its own server action, queued behind a slow Back save
- RecurringCalendar (5d156a4): after a failed month load, the next press steps from the month that failed
- Predates the branch, same rule: a plain link followed while Back's save is in flight draws the view he walked away from, and nothing redraws it
#### pay-and-avg-words (3)
- Queued item (1), firstPaydayOn walking forward, was not fixed. It was turned into an owner's call that exists only in code comments.
- Deposits left out at two different older rates are all described as "at an earlier rate"
- Counting paydays makes a detected pay series reach "derived" (no badge) with only 2 deposits
#### fixture-paycheck (4)
- Comments in src/ and the seed still describe the e2e Paycheck as anchored a week off its deposits
- The e2e check on the far edge of the 30-day window no longer catches anything
- Surfaces the fixture now reaches for an unread payday have no text test, and two are not in any screenshot
- spending-year note: 'the other 1 payday falls after that' — singular should read 'the other payday' (template plural)
#### budgets-67-69 (5)
- The screen-reader text for the dashed header reads as a broken sentence
- No test ever renders the '— in so far' branch
- The panel's flat 'a missing statement cannot bank itself as savings' does not cover the coverage rule's documented gap
- One read-half literal still skips the new constants, and one comment still says 'Never posted'
- NOTHING_CARRIED shares one heldBack array with every non-rolling budget

## 7. ENVIRONMENT
- macOS 27.2; gates under `caffeinate -i` (~10 min each). The Mac ran on battery this session (lid open).
- e2e's webServer uses :3111. His dev server: `.claude/launch.json` now has `moneyapp-dev-3000` (pnpm dev on :3000)
  for the preview tool; stop it before `next build`.
- Integration worktree `.claude/worktrees/integrate-1012` (`uc/integrate-1012`); workflow script
  `.claude/worktrees/integrate-1012/zz-queue-workflow.js` (fixer → reviewer on a ledger copy → HIGH/MEDIUM follow-ups →
  one re-review; `item.tasks` chains, `item.start` per item).
