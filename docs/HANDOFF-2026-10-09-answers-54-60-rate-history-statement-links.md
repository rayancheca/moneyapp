# Handoff — §6A 54–60 answered and built, two gated batches, statement links, Amazon Prime ended

> Written 2026-10-09 (session a37147c9, started 2026-10-08). `origin/main` = this handoff's commit. Since `f97585f`:
> 25 fixer branches in eight workflows, each read by a skeptical reviewer against a COPY of his ledger, every
> HIGH/MEDIUM sent to a follow-up (and re-reviewed once), LOWs queued below (§6C, 79 of them).
> Batch A gated + pushed `8f6ecc1` (2026-10-08). Batch B: gated + pushed `6b4e99b` (2026-10-09) — gate 561 passed + 56 failed, all visual and all explained (§1d), re-based from the gate's own captures, 56/56 on re-run. Unit **409 files / 8,401 tests** (1 skipped on purpose) · tsc ✓ · `next build` ✓ · `pnpm ledger-check` exit 0.
>
> His ledger: written **three times**, each guarded and approved by him in chat — see §2. Migrations 0025 (`user_amount_history`) and 0026
> (`user_billed_with_series_id`) applied by batch B (restore point `data/backups/pre-2026-10-09-batch-b-migrations-0025-0026.db`).

---

## 0. THE JOB — what is next

1. **Nothing waits on a write** — all three of today's ledger writes ran (§2). Discover/Capital One closes ~Oct 9 on its moved cycle: the /imports row now reads "closes around the 9th, from only its last 2 statements — the 10 before closed around the 2nd" and links to Capital One.
2. **Read the running app after the next imports** (Chase past Aug 12 pairs the two "Zelle From Rayan Karim Checa"
   rows on Wells Fargo; Wells Fargo's next statement brings weekly payroll — the first real test of the per-payday,
   era and reach rules; Discover/Capital One closes ~Oct 9 on its moved cycle; Robinhood/SoFi/Sapphire statements are
   all "Ready to pull" — /imports now links each row straight to the bank's statements page).
3. **The queue** (§6) — all LOW or latent. §6A lists defaults built without asking (latent) that he may want to see.

## 1. WHAT LANDED

### 1a. His answers (asked 2026-10-08/09 as either/ors, each the recommended option unless said)

| # | his answer | what he sees / what was built |
|---|---|---|
| 54 | MERGING files unfiled rows under the target's category | `mergeSeries` shares attach's rule (`filingTargetOf`/`rowsToFile`/`mergeFilings`); the confirmation says "N not filed yet will be filed under <path>" before the press; the toast names the filing. Latent (no unfiled row on a live series). |
| 55 | cash weeks before Aug 27 priced at $1,047.00 | migration 0025 `user_amount_history` (past periods, JSON), `rateOn`/`ratePeriodOf` (src/lib/series-kind.ts); projections, implied earnings, per-payday expected, calendar grading and residual σ read the rate AT the payday; headline/forecast/runway read the CURRENT rate. Earned vs banked after the write: implied $19,415.52, "$11,117.00 never reached a bank". |
| 55a | payroll pays payroll weeks only | settlement era bound (`periodOf`): extra reads "toward no payday" |
| 55b | leftover never pays a later week | reach bound in `take()`; the pooling test rewritten |
| 56 | a one-time charge reads "once" | `isOneCharge`/`oneChargeDays`: "once · Nov 11"; out of the Subscriptions card's monthly total ($3,816.92 → $3,744.18) into a One-off group |
| 57 | a bill lapses only on CHECKED days | `hasStoppedForecasting(s, today, checkedThrough)`, `checkedDaysSinceLastMatch`; archived accounts and cash wallets measure to today (no statement will come); a LIVE account with nothing read holds its bills (5c43fd9/6362736 reverted an over-reach of my brief) |
| 57-fix | my question mis-stated Amazon's evidence; told, he said "I cancelled it: end it" | `scripts/end-amazon-prime-2026-10-08.ts` — APPLIED (§2) |
| 58 | hide the count form on holdings-valued accounts | Robinhood Brokerage/Crypto: no "Add a balance you counted"; `addManualAnchor` refuses (`derivesFromHoldings`) |
| 59 | utilities are billed with the rent | migration 0026 `user_billed_with_series_id`; "billed with the rent, last seen Sep 2"; out of never-billed ($477.90 → $222.95 with 56); paid when the rent's payment of the period posts (implied, recorded); read on the rent's accounts |
| 60 | "not posted" waits for the grace days | one predicate `dueDayIsRead` (due + tolerance) for the calendar ✕, the bill's page, runway, /budgets, End dialog, forecast; e2e Meal Kit now quiet |
| request | /imports rows click through to the bank | `src/lib/statement-sites.ts` (official URLs researched 2026-10-09: Chase statements page, Wells Fargo Statements & Documents sign-on, Capital One card documents sign-in for Venture X AND Discover (his answer), SoFi/Robinhood sign-in + next step); schedule, Missing statements, dashboard teaser |

### 1b. Visible defects found by reading his app (2026-10-08)

| defect | fix |
|---|---|
| Runway "A further $2,296.20 came due…" included Amazon Prime's $4.99 two cards from "STOPPED BEING FORECAST — Amazon Prime"; "and 11 more" counted its arrears-only line | the lapse was checked on YESTERDAY in the arrears walk; one `hasStoppedForecasting` on the day of the question everywhere (`arrearsThisMonth`); a lapsed series' page has no Next dates, past-tense cadence |
| /recurring "MONEY IN — all of it running late" two lines under "the ledger has not looked for its deposit"; pay badge "Running late" | "running late" counts only checked days; quiet "Awaiting statements" (own All-tab section) |
| Pay page "posted avg +$1,789.15 ± 1881.46" (raw mean over the lump; no $ / separator) | posted average of the current rate era's per-payday samples (none printed for his pay); ± formatted "± $583.58" |
| Rent page "Already due, and not posted" (warning) over an unread Oct 1 | the arrears read/unread split on the page, runway, /budgets, End dialog; unread = quiet |
| "$72.74 a month" for the one-time Nov 11 balance; "Rent utilities & fees — never billed" | §6A 56, §6A 59 |

### 1c. §6C queue items fixed
Discover "closes around the 9th, from only its last 2 statements — the 10 before closed around the 2nd" (moved-cycle
rule); Missing statements no longer counts Chase Spending Reports as statements (`statementsByAccount`/
`countsAsStatement`, Robinhood opening statements still count); Robinhood Agentic now has a month-end rhythm;
same-day lump + week divided per payday; pace leftovers (CAR_LEASE_STARTS_ON doc, "Nothing has been spent" wording,
negative up-front caption, stale comments, refund one-off); "Balances" heading + empty lines by whether an account can
take a count; acknowledgement reason guards (\p{Cf}, embedded controls, counts, "or" header); weekly payroll's Wed/Thu
wobble not "Deposited irregularly"; agent-money dead code/cache/fixtures; pre-commit hook prints ledger-check listings;
press-race bounded wait for ‹ ›/tabs/setParam; arrears read on the series' landing accounts.

### 1d. Baselines re-based (66), every family read
- Batch A (10): account-detail ×8 + golden path ×2 — the count form gone from the fixture's holdings-valued account
  (§6A 58) and "Recorded balances" → "Balances"; pixel-identical outside that band.
- Batch B (56): budgets ×8, dashboard ×8 (runway split $125/$45 flips under §6A 60), dashboard-grid ×8 (+ Step B:
  Paycheck 14 → 13 paydays), imports ×8 (statement links; nav AA ≤ 27/255), recurring-calendar ×8 (Meal Kit ✕ → ?,
  Storage unit the ✕), spending ×8 (July's "not looked for" note gone under one payday universe), spending-year ×8.
  ⚠️ The e2e fixture's Paycheck anchor (Jul 10) is a week off its own ACME deposits — aligning the seed is queued.

## 2. ⛔ REAL-LEDGER WRITES (dev server stopped, restore point each)

| write | restore point | result |
|---|---|---|
| end Amazon Prime (`scripts/end-amazon-prime-2026-10-08.ts`) | `pre-2026-10-09T125440-end-amazon-prime.db` | APPLIED 2026-10-09; re-run ALREADY APPLIED; ledger-check 0 |
| §6A 55 pay-rate history (`scripts/set-pay-rate-history-2026-10-08.ts`) | `pre-2026-10-09T145951-set-pay-rate-history.db` (+ `pre-2026-10-09-batch-b-migrations-0025-0026.db` before the migrations) | APPLIED: `[{"throughOn":"2026-08-26","amountCents":104700}]`; implied $21,696.48 → $20,557.44, never reached a bank $12,256.04 → $11,117.00, monthly basis $4,948.32 unchanged; re-run ALREADY APPLIED; ledger-check 0 ("rate histories: 1 stored") |
| §6A 59 utilities billed with the rent (`scripts/link-utilities-to-rent-2026-10-08.ts`) | `pre-2026-10-09T150002-link-utilities-to-rent.db` | APPLIED: never billed $405.16 → $222.95, headline $3,744.18 unchanged, "billed with the rent, last seen Sep 2"; re-run ALREADY APPLIED; ledger-check 0. ⚠️ The script refuses once October's rent payment is imported (it expects five rent rows) — it is done, so that only matters if it is ever re-run. |

⚠️ The auto-mode permission classifier refused the FIRST real-ledger run (even the dry run) on 2026-10-08; he then
approved all three in chat (2026-10-09). If it refuses again in a later session, ask him — never work around it.

## 3. ❓ HIS ANSWERS (closed — do not re-ask)
Memory `moneyapp-owner-decisions-2026-09-28`: 54, 55/55a/55b, 56, 57 (+ Amazon correction), 58, 59, 60, the
statement-site request and Discover → capitalone.com.

## 4. ⛔ WHAT COST TIME
- **A failed `cd` in a `;` chain ran `git checkout` in his main checkout** (detached it for a minute). Use `git -C`.
- **Workflow `scriptPath` is refused once the session cwd is a worktree** — copy the script into the cwd.
- **My own brief over-reached twice**: "an account with no checked record → today" (reverted) and a question that
  mis-stated Amazon's evidence (corrected with him). Measure before writing an example into a question.
- **Overnight the Mac slept**: a reviewer stalled six times (10 min each); resuming the workflow replayed the fixers.
- **Merges between branches cut from the same base conflicted every time two touched recurring.ts** — an agent with
  both diffs composed them; each merge was followed by the FULL suite (it caught one cross-branch failure).

## 5. ✅ CHECKED IN THE RUNNING APP ON HIS LEDGER
2026-10-09 on :3000 after the writes: Earned vs banked "$7,156.60 of the $20,557.44 … 19 paydays, Jun 4 – Oct 8 … $11,117.00 of it never reached a bank; the other $2,283.84 is for paydays after Sep 24"; runway "A further $2,400.08 came due earlier this month and no import has covered it yet." (rent + utilities + Breezeline + FPL; no Amazon); Subscriptions "$3,744.18 a month, still forecast", "Nothing on the books has gone quiet long enough to stop being counted", One-off "once · Nov 11 · never billed $72.74", "$222.95 … 6.0% … never been billed"; pay page "Awaiting statements", Per charge +$1,141.92, no posted-average line; /recurring MONEY IN unlabelled, footer "… are awaiting statements"; /imports — 11 schedule rows + 1 Missing-statements row link out (`target=_blank`, `rel=noopener noreferrer`) to Chase / Wells Fargo / Capital One (Venture X + Discover) / SoFi / Robinhood.

## 6. ❓ THE QUEUE

### 6A. Built with a default, not asked (all latent on his ledger)
- A deposit exactly halfway between two paydays belongs to the NEWER one's era.
- A series with a rate history that is NOT read per payday: posted average over every era (fixer recommends the
  current era only, like his pay).
- A payday he dates ahead keeps the weeks between as paydays; a deposit before a skipped payday pays the payday it
  reached (55b).
- The rent's due day counts as read only once ALL accounts it has ever paid from are imported through due + grace
  (Venture X Jun, Chase Jul, Wells Fargo since Aug) — conservative; the alternative is the landing-account rule.
- Pay on an ARCHIVED account: its chip measures to today while the income card says the ledger has not looked —
  wording not chosen.
- /budgets: a category spent only from an archived card reads "Awaiting statements" up to 6 months.
- Capital One 360 Checking gets no statement link until it has statements (the researched link is card-only).
- A lapsed series' cadence sentence is past tense; a lapsed DETECTED series stays in Suggestions with a note.
- The runway's "What you spend a month" drill-down: /spending's Spent is gross and the figure nets $888.62 refunds +
  $6,100 up-front — (A) caption the reconciliation, or (B) a transactions view of exactly the rows. His call.
- Chase's link opens its "Statements & documents" sign-in page; where it lands after sign-in is unverified (the hint
  says "Chase · statements"; switch that entry to `opens: 'sign-in'` if he reports it lands on the home screen).
- The e2e seed's Paycheck is anchored Jul 10 while its ACME deposits fall a week earlier; under one payday universe
  earlier months read "paid by the deposit of a week later". Moving the seed's anchor to Jul 17 is a fixture task
  (moves the upcoming strip and more dashboard baselines).
- A future raise: changing the Amount re-prices every payday after the last history period — a raise needs a
  "from when?" (the rate-history script is the pattern).
- Older: §6A 1, 3–14 of the 09-15b handoff still have shipped defaults.

### 6C. LOW findings (79, by branch)
### merge-files (7)
- mergeIntoSeriesAction does not revalidate /transactions, though the attach and Make recurring actions do because they file
- Every series page computes the merge preview, including pages where the merge control is hidden
- categoryPathOf is a seventh copy of the "Parent > Child" path printer
- The confirmation is read when the page renders, the merge re-reads when he presses, and nothing checks they still agree
- Owner's call, back to the queue: attach's toasts still say nothing about what they filed, while the merge toast now does
- Nothing tests the toast's filing where MergeControl calls it; the commit's mutation-check claim only covers the label function
- The new e2e has never run; its expected values check out on a copy of the e2e database, but the gate is its first run
### discover-cycle (6)
- A moved cycle has no outlier tolerance: one Capital One close ≥4 days off sends the panel back to "closes around the 2nd … next closes Jan 2"
- On the same panel, two rows say 2 statements are "not enough to call a cycle" while Discover's row calls one "from only its last 2 statements"
- Detection fails when the old cycle has missing statements: the shrinking 'before' slice reads as every-n-days and the rule switches off for a month
- An existing statement-cadence assertion was rewritten despite the brief's "every existing test passes" (disclosed, and justified)
- A hole on a day-of-month cycle can still show no count (null), although by the new docstring every hole ends at a close
- Outside this commit (from a3650b8): holes among the older closes switch the moved-cycle rule off, so the phrase flips month to month (seen on Discover's real history)
### lump-same-day (4)
- (3) confirmed: June's $1,047.00/$400.00 rows go amber once a third weekly deposit lands. Owner's call, not caused by this commit
- A raise that lands on the same day as a lump is averaged away
- Behaviour change: two same-day deposits with money left over now read changed, where each used to read paid
- Pre-existing, outside this diff: the series page's 'posted avg ± σ' uses raw rows beside the per-payday history
### pace-leftovers (3)
- Item (7) is still open, and its premise is wrong: the /spending link misses by $6,988.62, not by the captioned $6,100.00
- budgetOneOffCents |amount| change newly shows a negative projection ('Projected ≈ -$1,050.14') in a month where a refund over the plan nets the category negative
- pace-geometry comment over-claims: 'always owns the top' and 'only a month holding up-front money lifts it above' hold only for a positive up-front sum no larger than actual-to-date
### counted-leftovers (5)
- cards-owed still uses "recorded" for having no balance of any kind
- Archive dialog: "Balance, leaving the totals" sits directly above "Balances kept"
- Holdings-priced accounts still get "Add a balance you counted" with a subtitle that is false there (pre-existing, for the queue)
- The page-gate test checks how balanceListWords is called, not what it is given
- New module in components/ pulls in better-sqlite3 through a non-type import
### ack-leftovers (5)
- The new comment says the writer refuses a line break, but it accepts U+2028 and U+2029
- Bidi controls inside a reason pass both guards and print raw (outside the asked Cc scope)
- docs/schema.md still describes the old guard
- INVISIBLE's comment says 'prints as nothing', but \p{Cf} includes visible glyphs
- The pinned per-day count reads '1 of its 3 lines alike acknowledged already' twice for one reason when 2 of the 3 are acknowledged
### pay-label-weekly (4)
- Test comment and commit message give MLK Day as the reason a Thursday payroll landed Friday
- The caveat uses the cadence constant (2 days) while settlement and the calendar use the pay series' stored tolerance (3)
- Semimonthly 15th/last-business-day pay and monthly-15th pay still read irregular in some real years (inherited from main)
- Skipped-week test comment still describes the replaced median rule
### agent-money-tidy (2)
- The fixture change left the forecast's agent-series EOM-cash guard with no test that fails if it breaks
- Comments and commit claim the agent clause reuses /spending's row-list read; on /spending it does not
### two-bank-read (4)
- The hook prints a count of 0 directly above a line it names, for an acknowledgement that matches no line
- docs/future-ideas.md still states the old folder rule
- Commit subject says the statement is 'filed under both' banks, but it goes into one folder whose name lists both
- The hook test's fixtures drift from the real sentences they stand for
### press-race (1)
- The 5 s limit doesn't apply when a view press follows the writer during a hung Back save: neither the pill's range nor the press's view is ever drawn
### arrears-lapsed (3)
- arrearsReadCents still writes out arrearsThisMonth's window by hand
- End dialog on a lapsed series: the headline says it "leaves the forecast" while its lines show nothing leaving
- The lapsed reason talks about a "bill" and a "charge" for transfer and other series too
### late-over-unread (6)
- Two frontier helpers still give the pay series different checked days. The new docstring says there is one.
- The new seriesEvidenceTone keeps 'Never billed' amber on the series page, while the chip calls it neutral.
- Amazon Prime is 'running late' in the forecast band and footer but 'lapsed' on the All tab, on the same page.
- Wording: 'N series have not been looked for yet' and 'the charge each is waiting on' for a payroll deposit
- Between Oct 1 and Oct 5 checked, the same card warns that a payday was missed on a read day while calling the pay "awaiting statements — cannot be called late yet" (owner's call, not a code error)
- Comment out of date after the landing-rule change
### late-lapse (5)
- LAPSED_MISS_LIMIT stays 3 although its stated reason (one cycle of import lag plus two missed charges) no longer applies
- Subscriptions card: 'N days past tolerance' now counts read days, beside 'last seen <date>', which is calendar age
- Test named 'its arrears walk asks the same' does not check arrears
- Pre-existing, outside the diff: from Nov 12 the Nov 11 insurance one-off reads '~$0.00/yr' and a $0.00 committed line
- Doc comments still say the frontier is built only from accountCoverage
### count-form-holdings (3)
- 8 account-detail visual baselines will diff: the fixture's Robinhood Brokerage loses the count form, and the commit re-bases none of them
- On an account priced from holdings with no balances in its list, "No balances yet" says "yet" while the header shows a value
- The brokerage book's refusal still says "typed"; §6A 50 made "counted" the one verb, and the new refusal beside it says "count"
### gaps-withheld (2)
- /imports footer still calls the two Robinhood opening statements 'a spending report, an export without a closing figure', while the same page's schedule and Missing statements now count them as statem
- Nothing tests the /imports wiring that keeps a Robinhood opening statement out of 'What the statements proved'
### lapse-archived (3)
- Awaiting-statements sentence says 'every account it posts to has been checked through' a day the archived card it posts to never reached
- A Robinhood test fails at both 98acbeb and 82d75d7; the fixer's own run shows it, but the report does not mention it
- The "Awaiting statements" sentence says every account a series posts to was checked through a live card's day, which is false for the archived one
### rate-history (3)
- firstPaydayOn never walks forward, so Earned vs banked can count paydays from before any deposit
- The pay popover still describes the raw rows as 'an average, not a repeat'
- After a merge, the billed-with wording uses the merge target's name, not the owner's phrase 'billed with the rent'
### already-due-unread (5)
- /budgets' arrears figure has no read split: always 'not imported', in warning colour
- A visible definition still says 'never posted'
- The unread card's body adds words he has not chosen
- A due day counts as 'read' once imports reach the day itself, so 'Already due, and not posted' (warning) can still be said when a covering posting could land on unread days within the tolerance
- The new body text for a read day is awkward and assumes one occurrence
### carrier-and-grace (5)
- Grace for a carried series is max(own, carrier), so the pair splits when the carried series' own tolerance is wider
- Archived/cash-wallet accounts: a bill still inside its grace reads 'no import has covered it yet', though no import will ever come
- A rent split into two payments either side of the month's edge appears twice on October's grid: a $2,109.00 'paid by its payment of Sep 30' mark next to the Oct 2 row
- 'Each payment judged by its own series' tolerance' is not pinned by any test: judging every posting by the widest tolerance passes all tests
- Comments still describe the old e2e Storage unit dates
### statement-links (3)
- The 8 /imports visual baselines move but were not re-based, so the visual gate is red at 8f7c5ec and no one has looked at the new rows on screen yet
- The link's screen-reader name leaves out the visible hint text
- The doc comment on AccountStatementGaps.site leaves out the card-only reason for a null site

## 7. ENVIRONMENT
- macOS 27.2; lid open, AC; gates under `caffeinate -i` (batch A 11.8 min; batch B 10.5 min).
- e2e's webServer uses port 3111 — stop any preview on 3111 first. His dev server runs from the main checkout on :3000
  (standing permission to stop it; restart it after).
- Workflow script used all session: `.claude/worktrees/integrate-1008/zz-queue-workflow.js` (fixer → reviewer on a
  ledger copy → follow-ups for HIGH/MEDIUM → one re-review; `item.tasks` for a sequential chain, `item.start` per item).
