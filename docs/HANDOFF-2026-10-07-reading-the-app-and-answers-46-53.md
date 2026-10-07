# Handoff — §6A 46–53 answered and built, two guarded writes, the visible defects reading his app found

> Written 2026-10-07 (session 8cf31349). `origin/main` = this handoff's commit. Since `f3fc609`: twelve fixer branches,
> each skeptically reviewed, every HIGH/MEDIUM sent to a follow-up, LOWs queued below (§6C). Unit **375 files /
> 7,713 tests** (1 skipped on purpose) · e2e **614 / 614 passed** at `maxDiffPixels: 0` on the final tree (lid open, `caffeinate -i`, renderer check on; 34 baselines re-based, every diff explained — §1d) · `next build` ✓ · tsc ✓ · `pnpm ledger-check` exit 0.
>
> His ledger was written **twice**, each guarded (§2): 13 accounts · 10,328 active rows (unchanged) · 25 migrations
> (none added) · witness marks 43 · 222 · 212 · 256 · 13, unchanged.

---

## 0. THE JOB — what is next

1. **The queue** (§6C) — all LOW, most latent. Nothing waits on him except §6A's latent questions.
2. **Waiting on events** (unchanged): the next Chase statement past 2026-08-12 (pairs the two "Zelle From Rayan Karim
   Checa" rows on Wells Fargo, $1,529.73 on 08-31 and $700.00 on 09-01 — still the dashboard's "2 to review"); the next
   Wells Fargo statement (weekly payroll $1,141.92 — the first test of today's lump/raise rule on real weekly rows; see
   §6C "June rows amber"); the next Robinhood statements; Discover closes ~Oct 8–9 on its new cycle (§6C).
3. **Read the running app again after the next imports** — it found every visible defect below in under an hour.

## 1. WHAT LANDED (all pushed)

### 1a. His answers (each RED first, reviewed, every HIGH/MEDIUM fixed)

| answer | what he sees | notes |
|---|---|---|
| **§6A 46** the agent's pace follows the bridge below zero | a month the agent is clawed back more than it is paid reads below zero at "your recent pace" (−$0.87 / −$1.87 on the $4/$5 fixture), as the bridge's −$1.00 | `agentsIncomeAtPace` = committed + pace; the ❓ tests in `agents-credit-by-category.test.ts` flipped. Latent |
| **§6A 47** attaching files an unfiled row by its series' category | his Sep 2 lease row and Sep 3 $1,000 insurance prepayment filed (Car › Car Payment, Car › Car Insurance) — September's /spending now shows **Car $1,695.04 (31.3%)**, "No uncategorized spending" | the write: §2. The rule: `fileUnfiledUnderSeries` (recurring-links.ts) in `attachTransactions` + "Make recurring" joining a series; never onto a transfer-kind series, never against the series' sign; clears the review flag like other hand filings (a duplicate pair keeps it); lossless undo. Detection's links untouched; `mergeSeries` not (§6A 54) |
| **§6A 48** the pace leaves out the car's up-front money | /recurring's forecast has no Car pace line (was −$1,639.78 = the $6,100 ÷ 3); November's predicted Car spend $3,085.95 → $1,052.62 | one predicate `isUpfrontCarRow` (src/services/car-upfront.ts) shared by the car card, the forecast, /spending's and /budgets' predictions |
| **§6A 49** /categories/[id] names the category's own imported-through day | Car, October: "…spending in Car is imported through Wed, Aug 12, 2026" (its budget row's day; was the ledger's Sep 24) | `categoryCoverage` exported, `categoryReachFor`, src/lib/category-reach.ts; a dormant subcategory asks its nearest ancestor; ONE empty-state builder (`categoryEmptyCopy`) keeps the agent's-money clause |
| **§6A 50** "counted" on the balance controls | Cash on Hand: "Add a balance you counted", "you counted it", "Remove this balance you counted", /imports grade "Counted"; a hand-entered ROW keeps "you entered it" | new verdict `counted`; and a TOTAL with only some rows typed reads **"part you entered"** (/summary/2026's "Spending rose by $42,950.02…" was badged "you entered it" — false of a $66k total with one $5,000 typed row) |
| **§6A 51** the up-front money is out of the runway, /budgets' run-rate, the pace tile and budget guidance | **runway 2.0 → 2.6 months** (spend $9,259.32 → $8,242.66, running down $3,294.34); caption "…leaving out the $6,100.00 paid up front for the car, which the car card spreads over the lease" | counted once as spent, never extrapolated (`computePace`); /spending's "typical pace" line too (`613fcf7`, review) |
| **§6A 52** "up front" = Car rows before the lease starts (2026-09-11) | a later repair/registration/EV charge is ordinary spending | `CAR_LEASE_STARTS_ON`, strict `<` |
| **§6A 53** the storage-layout move | 31 originals moved (§2) | `scripts/storage-layout-move-2026-10-07.ts` |

### 1b. Visible defects found by reading his app (§6C's method — `memory moneyapp-read-the-app-first`)

| defect (his ledger, 2026-10-07) | fix |
|---|---|
| Dashboard "Worth a look": **"It America LLC (weekly pay) rose by $3,425.76 between its usual amount and Sep 23"** — the 4-week $4,567.68 lump, which settlement spends on four paydays at $1,141.92 | the calendar measures a settled deposit PER PAYDAY (`src/lib/per-payday.ts`), its spread too; the series page draws it as "4 paydays at $1,141.92 each"; a $1,200 week still reads "rose by $58.08" |
| /summary/2026 "**Cash job** … the job that replaced it" | names the confirmed/ended pay series: "It America LLC (weekly pay)" |
| /spending "**Cash is deposited in lumps**"; dashboard "you bank in lumps" over a payday the ledger had not read | "One deposit can bank several paydays at once…"; "…It falls after Sep 24, the last day every account that pay lands in has been checked through — so the ledger has not looked for its deposit." |
| Earned vs banked "$13,397.96 **never reached a bank**" incl. the unread Oct 1 payday | "$12,256.04 of it never reached a bank; the other $1,141.92 is for paydays after Sep 24 … has not looked for it" |
| /recurring and /budgets named **Aug 12** (Chase, two June cash deposits) as the day his pay's account is checked through | a payday is looked for where the pay lands NOW — the series' own account (Wells Fargo, Sep 24) — one rule, every caller (review HIGH) |
| Runway "$2,296.20 came due earlier this month and **never posted**" over days no import covers | "…and no import has covered it yet" (/budgets' words); "never posted" only for read days |

### 1c. §6C leftovers fixed

| item | what changed |
|---|---|
| §6A 30 acknowledgement edge cases | a mark carrying two reasons names both ("or …"); `reasonSaysNothing` refuses C0/C1 controls and U+2800; a test pins the day in the key; the "another reason" sentences say the stored one stays |
| §6A 34/43 the agent's money in empty states | /categories/[id] says the agent's money in the window is left out; the count includes an income-category clawback on the agent's cash; /merchants/<id> never names the agent's series as his bill; the §6A 45 fixture is investable like his ledger |
| the press race | ‹ › after a non-press link; a link to the URL on screen (review MEDIUM); the header comment; a range pill during Back's save waits for it; Back saves `accts` only when his press put it; a real in-flight press test |
| a read at two banks | `pnpm ledger-check` LISTS it ("reads of accounts at two banks: 0" today), never fails; bulk query (~0.7 ms) |
| a gate flake found on the way | the dashboard deck's height flipped a pixel at random (768px dark: 3,380 or 3,381px, 2 of 5 repeats) — the front card measured an integer or one 1/64-px layout unit above it; `deckHeight` (src/lib/card-deck.ts) subtracts one unit before the ceiling: 16/16 repeats stable |

### 1d. Baselines re-based (34), each diff read before it was kept

| family | the one change |
|---|---|
| `dashboard-*` ×8 | runway arrears: "A further $170.00 came due earlier this month and never posted." → "…: $125.00 never posted, and no import has covered the other $45.00 yet." |
| `dashboard-grid-*` ×8 | the same sentence, and Earned vs banked's "The difference — never reached a bank" → "$8,829.57 of it never reached a bank; the other $2,943.19 is for paydays after Jun 30, … has not looked for it" (3 read silent paydays + 1 unread, as the card's own verdict says); the grid reflows below |
| `summary-year-*` ×8 | "Cash job" → "Salary, not Fordham payroll", basis "…not all attached to one pay series, so which job they are, this ledger does not say" (the fixture's 18 rows sit in two series) |
| `account-detail-*` ×8 + golden path ×2 | "Record a balance" / "Record balance" → "Add a balance you counted" / "Add balance" |

Dark variants also carry antialiasing-level noise from the subset re-base run; the next FULL gate reproduced them
exactly (31 of 32 — the 32nd was the deck flake above, fixed in code, not re-based).

## 2. ⛔ REAL-LEDGER WRITES — two, both guarded (dev server stopped, lid open)

| write | restore point (data/backups/) | result |
|---|---|---|
| §6A 47 file the two car rows (`scripts/file-car-rows-2026-10-07.ts`) | `pre-2026-10-07T131342-file-car-rows.db` | APPLIED: only the two rows' category/source moved (every other row, every balance, every series compared); re-run ALREADY APPLIED; ledger-check exit 0 |
| §6A 53 storage-layout move (`scripts/storage-layout-move-2026-10-07.ts`) | `pre-2026-10-07T132821-storage-layout-move.db` + manifest `storage-move-2026-10-07T1728.json` (from, to, sha256 — copy `to` back to `from` to undo) | rehearsed on a scratch copy of data/statements + a repointed ledger copy; MOVED 31 originals / 55 reads (24 robinhood-cash/ → robinhood-combined/, 2 of them byte-identical duplicates dropped; 5 Venture X 4147 → 4208; 2 robinhood-brokerage-3525/ → robinhood-cash/); 519 → 517 files; every stored path names a file; re-run NOTHING TO MOVE; ledger-check exit 0 |

## 3. ❓ HIS ANSWERS (closed — do not re-ask)

Memory `moneyapp-owner-decisions-2026-09-28`, sixth and seventh batches: 46–53, every one the recommended option.

## 4. ⛔ WHAT COST TIME, AND WOULD AGAIN

- **Fixer worktrees branch from `origin/main`, not local main** — every branch today started at f3fc609. Two merges
  conflicted (`categories/[id]/page.tsx`: taking either side silently dropped the agent's-money clause or failed the
  branch's pin — a reviewer caught it with `git merge-tree` before the merge; `spending.ts`/`committed.ts` imports).
  Tell a follow-up to `git merge main` first.
- **Reviewers found a HIGH or MEDIUM on 8 of 12 branches.** Two were visible on his ledger only (the Aug 12 frontier
  via two June cash deposits; σ measured on raw amounts widening the band to ±$3,258.78). Point reviewers at a ledger
  COPY — every real-data finding today came from one.
- **Unit timeouts under load**: `committed.test` "over every day of the month" timed out at 5 s with load 10 (my runs
  + agents); 1.2 s alone. Don't run suites beside agents.

## 5. ✅ CHECKED IN THE RUNNING APP ON HIS LEDGER (2026-10-07)

The dashboard no longer says "rose by"; runway "2.6 months of cash" with the caption; car card "14.2% of the $9,207.35"
(was 13.8% of $9,489.85 — moved by §2's filing, which made the Sep 2/3 payments Car spending; reconciles to the
cent); Earned vs banked split; /recurring "It falls after Thu, Sep 24, 2026"; /summary "It America LLC (weekly pay)"
and "part you entered"; Car's category page "spending in Car is imported through Wed, Aug 12, 2026"; Cash on Hand's
counted wording; September /spending "Car $1,695.04 (31.3%)", "No uncategorized spending".

## 6. ❓ THE QUEUE

### 6A. Questions for him (latent; nothing ships until asked)

✅ 46–53 answered and built.
54. Should MERGING two series file the merged rows that are unfiled by the target's category, as attaching now does
    (§6A 47)? A merge cannot be undone, which is why the fixer left it out. Latent.
- Older: §6A 1, 3–14 of the 09-15b handoff still have shipped defaults (2 closed by §6A 49).

### 6C. Defects / leftovers queued (each LOW, latent on his ledger unless said)

- **Discover "closes around the 2nd"** (/imports) while its last two closed Aug 9 and Sep 8 (Capital One's cycle,
  memory `moneyapp-discover-is-capital-one-now`); the 12-close median takes ~6 more closes to move. Visible, but the
  tolerance already holds the "late" call to Oct 9. A regime-change rule (two newest closes agree, off the median)
  would fix the wording.
- Lump pay: two deposits on ONE day are not divided per payday (a lump + a weekly deposit the same day reproduces
  "rose by"); `RecurringCalendar.test.ts:231` fixtures the lump as `paid_different`; **the June $1,047/$400 rows will
  read amber against today's $1,141.92 once a third weekly deposit gives the spread a measure** (true — the rate
  changed — but no notice: outside the 90-day window).
- Press race: Back's re-save per URL, not per history entry (`test.skip`, Next exposes no entry key); the pill's
  `await backSaves` has no timeout; ‹ ›, tabs and `setParam` keep the Back-save race; **Next 16.2.10's action queue
  loses an action sent while a navigation that discarded another is pending** (`app-router-instance.js`: `last` not
  updated) — upstream, class unchanged by our code.
- Attach (§6A 47): plurality fallback on a mixed-category series; rows filed in the same call don't vote; a row he
  parked unfiled by hand is refiled.
- Pace (§6A 48/51/52): `CAR_LEASE_STARTS_ON`'s doc says "first scheduled payment" (lease 09-15, insurance 09-11); the
  runway's "Nothing has been spent in the months counted" is wrong if only up-front money was; a negative up-front sum
  (a refund) prints "-$X" in the caption; "What you spend a month" links to /spending, whose total ÷ 6 differs by the
  captioned amount; stale comments `pace-geometry.ts:89`, `pace-readout.ts:15`; `spendBaseline` scans twice;
  `budgetGuidanceCents` re-reads the rule per budget; the one-off guard `budgets.ts:1381-1405` compares to the plan; no
  test of an unlinked post-lease Car row in the runway baseline.
- Counted (§6A 50): the list heading "Recorded balances" (holds both kinds); "No balances counted yet" on accounts that
  can't take one; the remove dialog's statement path untested.
- /summary pay label: `depositsAreIrregular` would flag a weekly payroll posting in Wed+Thu pairs (gap spread 5 days).
- Pay wording: `arrearsReadCents` reads every account a series ever posted to (rent: Chase's Aug 12 — errs toward "no
  import yet", conservative); the cash-earnings multi-account test was not seen red.
- Agent's money: `isAgentsIncome` has no production caller (dead); `agentsMoneyRowCount` reads the agent's accounts
  uncached; no test of a split agent row in the category count; agents-costs/income/unfiled fixtures still make
  Agentic spendable.
- Acknowledgement (§6A 30): `\p{Cf}` invisible format characters (U+FFF9–FFFB, U+13430–1343F) pass alone; a reason
  with an embedded control char is stored and printed raw (a re-paste is refused, nothing wrong written); "the reason
  stored" singular beside two; the multi-mark header doesn't explain the "or" lines.
- Two-bank read: the pre-commit hook discards ledger-check's output on success, so the listing shows only on a manual
  run; `accountsFolder` names a two-bank read's folder after its first account's bank.
- Category page (§6A 49): one top-level category with no rows falls back to the ledger's day, in the ledger's words.
- Older, still open: the four 09-15 worktrees with uncommitted edits (read before deleting); `next build`'s trace
  warning on `migrateStorageLayout`.

## 7. ENVIRONMENT

- macOS 27.2 Beta 2; lid open, AC; gate under `caffeinate -i`.
- Agents: one defect per prompt, evidence + a ledger COPY path, "start with a tool call within a minute", own branch,
  no `pnpm install`, `git merge main` before a follow-up; a reviewer per branch; follow-ups only for HIGH/MEDIUM.
