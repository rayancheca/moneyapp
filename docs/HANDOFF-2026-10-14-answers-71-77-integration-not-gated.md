# Handoff — his answers 71–77, one guarded write, three batches (integration NOT gated, NOT pushed)

> Written 2026-10-14 (session 19ff132d, started 2026-10-13). `origin/main` is STILL `b995ce2`. Everything below lives on
> the integration branch `uc/integrate-1013` in `.claude/worktrees/integrate-1013` (this file is committed there),
> plus batch 3's branches, which are NOT merged yet. No statements were imported this session (none since Oct 5).

---

## 0. THE JOB — what is next, in order

1. **Finish batch 3** (§3). The previous process exited mid-run: 15 of its agents finished, 8 did not. A workflow
   resume works only in the session that started it, so run a NEW workflow. Use the same script, copied to
   `.claude/worktrees/integrate-1013/zz-queue-workflow-1014.js` (untracked; it supports `item.from` and
   `item.reviewBrief`). Give it one item per unfinished piece in §3b, starting from the tips listed.
2. **Merge batch 3 into `uc/integrate-1013`** (expect an import conflict in `payday-settlement.ts` with d75's branch),
   then run `npx tsc --noEmit -p .` and the FULL unit suite (`npx vitest run --maxWorkers=4`, detached). Last
   measured at `7aca8e5`: 440 files green. Run the `scripts/` tests too: d71's fixers ran only `src/`, and
   `scripts/checking-115-reversal.test.ts` broke.
3. **Read the integrated app on his real ledger** before gating. ff local main to the integration, restart
   `moneyapp-dev-3000`, and read every surface §1 changed:
   - runway "Feb 2026 to Jul 2026 … left out" ($8,105.85 a month, 2.7 months) and the car card;
   - /recurring's pace note (May–Jul);
   - the "partly read" chips (Food Sep, /spending Sep/Aug, merchant and income pages);
   - the /spending pay notes (Jun/Jul/Aug shortfall, Sep surplus, YTD $11,117.00 = the dashboard's figure);
   - "Both fall after";
   - the pay page's "into Wells Fargo";
   - the runway's "$297.98 a month lower for it".
4. **Gate from the MAIN checkout.** Stop :3000 first, run `next build`, then e2e on :3111 under `caffeinate -i`.
   Baselines expected to move:
   - imports ×8 (low-imports-words footer);
   - spending and spending-year (d72's line under "Where it went");
   - possibly decision-cards (earn-row href assertion added).

   Read every diff family before re-basing, and copy the gate's captures before re-running any spec.
5. FULL unit after the last commit, `git push origin main`, `pnpm ledger-check`.
6. Ask him the open owner calls in §4. Most are latent, with a recommended default already built; ask only the
   ones that are genuinely his.
7. Then the LOW queue (§6). Converge: follow-ups only for HIGH/MEDIUM.

## 1. HIS ANSWERS (2026-10-13/14, all the recommended option — closed, in memory `moneyapp-owner-decisions-2026-09-28`)

| # | answer | measured on his ledger |
|---|---|---|
| 71 | an average uses only months EVERY account he spends from is read through to the end (`spendingCoverageThrough`) | Apr–Sep → Feb–Jul; runway $8,242.66 → $8,105.85, 2.6 → 2.7 months; Eating out, Subscriptions, Fees, Transfers and the car card move together; the 3-month pace → May–Jul |
| 72 | a total over days not every account is read for: chip "partly read" (amber) + /budgets' coverage line | Food Sep "$160.72 · adds up" (Food read through Aug 12); /spending Sep "checked through Sep 8" |
| 73 | a payment more than its grace EARLY, with the day before paid, pays the next due day | FPL due 8th: Jul 28 → Aug 8 |
| 74 | I file the 32 unfiled Aug card rows by a guarded write | ✅ APPLIED (§2) |
| 75 | a payroll returned the SAME day pays no payday (a day's pay rows read by their net) | latent |
| 76 | refines 73: the NEARER due day wins (tie → earlier), unless that day is already paid on time | lease Sep 2 → Sep 15 (was Aug 15 late); latent today |
| 77 | one-off charges stay IN the recent pace (no one-off mark) | rest of Oct at pace −$4,634.70, EOM cash at pace $5,074.77 (incl. Jun USCIS $2,250) |

Orchestrator defaults (built, not asked):
- /spending's shortfall note uses the DASHBOARD's net definition: $11,117.00 never reached a bank, with the
  $400.00 Jun 5 deposit named inside the banked figure.
- The runway caption: a one-off adds nothing to the shortfall ("$297.98 a month lower for it"; rate $3,452.25
  unchanged).
- 72 extends to merchant and income totals.
- An unfiled debit linked to pay counts as spending until he files it.
- An ended series drops its "Ends …" badge.
- The Nov 11 balance reads "once · $72.74".
- "Both fall after" for two paydays.
- Income reads "deposits … into <account>".

## 2. ⛔ REAL-LEDGER WRITE (one)

`scripts/file-august-unfiled-2026-10-13.ts` (commit 1aa8a21) was applied 2026-10-13. It filed 28 rows:
- Dining $1,078.48
- Groceries $30.68
- Entertainment $21.00
- Shopping › General $38.90
- Parking & Tolls $6.15

KnockBox AI −$2.20, SUPER+ −$15.00 and Move Fitness 2 × −$1.00 stay unfiled for him to name. The restore point is
`data/backups/pre-2026-10-13T165052-file-august-unfiled.db`, and ledger-check exited 0. Checked live: August Food
went from $1,114.99 to $2,224.15, and Spent stayed $12,588.08.

## 3. THE BRANCHES

### 3a. Merged into `uc/integrate-1013` (tip `7aca8e5`)
- 1aa8a21 (74 script)
- batch 2:
  - low-merge-ack `76015789`
  - low-imports-words `5136a9f`
  - low-dashboard-links `4c1b032`
  - low-late-lapse `297f615`
  - low-pace-agent `b37a250` (a HIGH, the benchmark drag, fixed and re-reviewed)
- batch 1:
  - d71 `6d11c4d`
  - d72 `516d6fc`
  - d73 `cf40c47`
  - d75 `f1903f6`
  - visible-words `ebf628b`
  - spending-shortfall `36f212f`
- merge fixes:
  - `e1172ab`: settlement's `deposits` = `daysThatBanked(rows)` (UNTESTED — a reviewer says reverting it passes every
    test; pin it)
  - `7aca8e5`: the $115 reversal fixture is read into the card's month

### 3b. Batch 3 — run `wf_e10f6898-5b0`, interrupted. Tips to continue from

| item | done | tip | still to do |
|---|---|---|---|
| review-d71 | review, r1f1, re-review | `06a5d3e` (uc/d71-fully-read-months-r2f1-r1f1) | follow-up for the re-review's 2 MEDIUMs: "Recent pace $0.00" printed above the no-average sentence; the income average has no floor |
| d72-extend | fix `fdcebdc`, review | `fdcebdc` | follow-up: 2 HIGH (a graded "Net" page says "a lower bound", false for a two-sign sum; /spending stat cards print Spent $0.00 / Savings 100% over days the page dashes) + 2 MEDIUM (merchant pages name two different days for one window; countedFlow misses the cash-only empty state); then a re-review |
| d75-consistency | fix `8fc0b01`, review (4 MEDIUM), r1f1 `16a26a2` | `16a26a2` | r1.2 for the 4th MEDIUM (Earned vs banked's `bankedCents` nets a LATER-day return; settlement doesn't); pin e1172ab; `/categories/<Income>` "Received" not swept (owner call §4) |
| review-shortfall | review (2 MEDIUM) | `36f212f` | follow-up: a payroll returned on a later day prints "paydays came to $0.00, and none of it reached a bank"; a payroll imported past the statement into a month with no read payday lowers YTD/ALL and no month names it |
| d76-nearer → lows-grace-docs | fixes `f8b5320` → `eb48365` | `eb48365` | REVIEW 7aca8e5..eb48365 (never reviewed), then follow-ups |
| lows-budget-words | fix, review, r1f1 `9249ae7`, re-review (2 MEDIUM) | `9249ae7` | r2: nothing tests a subcategory whose parent is spent only from cash; the /budgets plan popover describes pre-67 rollover |
| lows-pay-words | fix `878c3d5`, review (1 MEDIUM) | `878c3d5` | follow-up: item 6's grace rule reached 2 of 4 "never reached a bank" readers (the forecast says "not banked yet") |
| small-defaults | fix, review, r1f1 `d54c28e` | `d54c28e` | re-review of 89f235d..d54c28e |
| lows-posted-avg | fix `a295e0a`, review; r1f1 made no commit | `a295e0a` | item 5 (Car insurance posted avg −$678.79 from the $1,000 prepayment) is an owner call (§4) |

The journal of every finished agent, with full findings and open questions, is under
`~/.claude/projects/-Users-rayankarimcheca-dev-MoneyApp/19ff132d-8caa-43fa-be1b-a627973e495f/subagents/workflows/wf_e10f6898-5b0/journal.jsonl`.
Batches 1–2 are in `wf_2cb6b9f2-af3`, `wf_aeade448-670` and `wf_939a740e-597`.

## 4. ❓ OWNER CALLS RAISED BY BATCH 3 (ask only the genuine ones, each as an either/or with a measured example)

- **Visible:** Car insurance "posted avg −$678.79 ± $454.26" beside −$357.58. Sep 3 −$1,000.00 is 2.80× the
  amount; every other payment across 26 series is 0.24–1.10× its rate. When does a payment count as covering more
  than one month, and what should the line say?
- **Visible:** his pay popover says "That is 2 deposit days at the rate in force now — below the 3 … an anecdote"
  next to the $1,141.92 he set. (A) keep it, or (B) drop the anecdote when the amount is his own.
- **d76:** when two payments are both nearer the same day and neither is on time, the earliest pays it and the second
  pays nothing (built), or (b) …. The full text is in the journal.
- **d75:**
  - a credit linked to pay alone on its day, unfiled: (A) not pay until filed (built in 16a26a2), or (B) pay;
  - is `/categories/<Income>` "Received" one of the Income figures (does it net a transfer-filed same-day return)?
- **Latent, recommended default built (confirm or skip):**
  - "Ended before Jan 11, 2027" badge;
  - the car card's heaviest month keeps a one-charge (decision 56 "car card unchanged");
  - a not-started month dashes "has not happened yet";
  - rollover wording "lately";
  - Rewards/Investments/Uncategorized "Net" pages graded too;
  - the young-ledger pace floor (2-mo avg);
  - pay anchor before the first deposit keeps its weeks.

## 5. ⛔ WHAT COST TIME

- **The Mac slept overnight.** Three agents died (ECONNRESET, ENOTFOUND, "your computer went to sleep"). A follow-up
  that dies leaves its findings UNFIXED, and the later re-review sees only the next delta. Check every journal
  for `type: failed` before trusting an item. Run `caffeinate -i -t 43200` for the length of a batch.
- **The script never reviews round-2 follow-ups.** Every round-2 tip needs a review in the next batch (§3b).
- **Agents ran only `src/` tests.** A `scripts/` test broke on the integration.
- **The process exited mid-batch,** and a workflow cannot be resumed across sessions.

## 6. THE LOW QUEUE

### 6A. From the 2026-10-13 handoff §6C
Every group was assigned:
- batch 2 done: merge, ack, discover-cycle, imports-words, balance-words, dashboard-links, late-lapse, pace-agent;
- batch 3 (§3b): category-headline, budgets-statement-words, budgets-67-69, payday-unread-reason, pay-page-passed,
  pay-and-avg-words, fixture-paycheck, posted-avg-*, carrier-grace, read-on-landing, named-and-landing,
  runway-caption.

Re-check what batch 3 left.

### 6B. New this session (47 from batches 1–2 + repair, then 17 from batch 3)
- d71: measuredMonthsClause still says "the last six months" for a window the floor shortened; stale docstrings
  about the shared window; Car's budget editor silently loses its guide on his ledger (its left-out-months note drops
  with the figure); a JSDoc comment is attached to the wrong describe block; the income pace includes September
  (Robinhood Cash is read through Sep 9); `categoryTrends.trailing3moAvgCents` still averages calendar months; a
  2-month pace reaches the trend rule calibrated for 3; an empty ledger shows a pace row.
- d72: the comparison proof names only the current window when both are partly read; the line says "of this
  period", not "of this window"; insight proofs that read partly read show the chip with no line; the merchant
  "always read the same day" comment is false.
- d73/76: paidByThen `before === null` is unpinned; a commit message presents a made-up FPL shape as his.
- d75:
  - a later-day return: Earned vs banked says $1,141.92 "never reached a bank" while the calendar says paid;
  - a return switches a single-rate Amount history to the step chart;
  - a partly returned day sharing a payday reads gross;
  - "Income recorded" is gross vs banked net for later-day returns;
  - `loadCategoryIndex` runs per settlement call, uncached;
  - 8fc0b01 conflicts with the integration's imports.
- visible-words: the What-moved chart description says "The largest move is" of one category; `seriesAccountWord`
  says "from" for a positive "other" series; the fee note's "has not said what it is. It is $0.15"; runway and car
  card "one other does too" counts differ (being fixed in small-defaults); heaviestMonth's stale warning; a $6.05
  remainder between the runway's shortfall and the Subscriptions gap.
- shortfall: "never reached a bank" is said of payroll-era paydays a later deposit can still pay; single-day windows
  open with "banked $X more than its paydays came to"; money toward no payday split inside/beyond names every day
  twice; tests no longer pin `passed` in the crossed predicate.
- merge-ack: a prune that fails after a merge commits reports a failed merge; withPreMutationTransaction's doc
  says "exactly what the restore point holds"; reasonCarriesControl's doc is stale; the writer's exemption covers any
  stored reason; the Make recurring toast's Undo is untested.
- imports-words: a later N/A statement keeps "nothing in it could have failed"; the download sentence is false for a
  two-account OFX ("downloads" vs "documents"); the movedCycle docstring overclaims; four comments still say "the
  schedule counts it"; `CountRefusal.kind` has no reader; 74f25fb moves the 8 imports baselines (re-base at the
  gate).
- dashboard-links: page.test.ts checks wiring with source regexes; Subscriptions/car header links (being fixed in
  small-defaults); an empty Active says "confirm a suggestion above" (small-defaults).
- late-lapse: the running-late reason "one paid from another account" is said of pay too; the forecast arrears
  oneChargeOn pass is untested; an anchor typed past its end still shows "Ends …" (small-defaults).
- pace-agent: a view press at its bound renders twice after Back's save; a cut-short SPY pick goes to a URL with no
  benchmark; the harness doesn't model setBenchmarkAction's revalidation; a commit message understates the drag.
- posted-avg: two names for one rate ("at today's rate" / "at the rate in force now").
- small-defaults: the insights strip on the Nov 11 page still reads /yr; the narrowed All tab says "the figure you
  followed".
- budget-words: the dashboard income row's screen-reader text runs two clauses together; the future-month dash is
  marked ⚖️ though he never decided it; the cash-only/parent-account sentences use words the row doesn't.
- pay-words: a second "Cash pay" (the dashboard income card's caveat); the calendar legend's "Not yet known"
  doesn't describe `not_looked_for`; the forecast's "Pay not banked yet" covers unlooked-for paydays; items 8/12 are
  unconfirmed.
- From reading the app: the dashboard group rows' delta day differs from their members' with no label (e.g.
  Robinhood "+$469.21 Aug 31 vs Aug 30" over members as of Oct 9); the calendar's "not yet known (not banked yet)"
  of cash weeks sits beside the dashboard's "never reached a bank".

## 7. ENVIRONMENT
- macOS 27.2.
- Gates run under `caffeinate -i` (about 10 min).
- e2e uses :3111; his dev server is `moneyapp-dev-3000` (`.claude/launch.json`); stop it before `next build`.
- Ledger copies for agents: copy `data/moneyapp.db` fresh (post-74); the old scratchpad copies are session-scoped.
