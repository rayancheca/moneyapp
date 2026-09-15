# Handoff — the owner's decisions, applied; five ledger writes; and a weekly limit mid-flight

> `main` pushed at **`fb290f5`** · **66 commits since `e818154`** (last handoff) · unit suite
> **262 files · 5,266 tests green** at `7950913` (+ later script/lib tests) · tsc clean ·
> `pnpm ledger-check` **exit 0** · e2e gate **602 passed** (`E2E_GATE=1`, 8.4m, fresh `next build`) on `fb290f5` +
> the rewritten cash-note tests + 48 regenerated baselines (§7b) — all three land in the commit after `fb290f5`
> Ledger: **10,319 active rows · 38 uncategorized** (NULL or the system category) · net worth
> **$113,098.37** as of 2026-09-15 (Brokerage's cache rebuilt through today after a dated script cut it at Aug 31 — §4) · 12 active accounts · 42 recurring series.
>
> ⛔ **Subagents hit the weekly limit** (resets 10am America/New_York) after a DNS outage had already
> killed or stalled a round of them. Five branches are left in the state §7 describes — none is lost.

---

# ⛔ 0. THE JOB — what is next

1. **§7 is the queue, in order.** Every branch is named with its exact state. Two are UNREVIEWED code
   (`uc/provenance`, and `uc/rh-second-account` which is also unfinished). Review before cherry-picking.
2. **The owner decided everything in §3 — do not re-ask.** He answered "recommended" to the hunt families
   and gave explicit words for the rest. Standing rule: **he does nothing by hand** (memory
   `owner-does-nothing-by-hand`): an authorized link/correction is a guarded write the session performs.
3. **When the Wells Fargo statement for early September arrives:** link the $1,000 Progressive payment to
   `Car insurance` and the $695.04 lease payment to `Car lease`, and set the lease's user next date to
   2026-10-15 (memory `moneyapp-car-lease-and-insurance`). Neither will auto-link (wrong amount/date).

---

## 3. ❓ THE OWNER'S DECISIONS — 2026-09-14 (all closed; do not re-ask)

**The hunt families** (§ of the diagnosis `scratchpad/hunt-diagnosis.json`). He answered *"part a use the recomended for all … okay to all other recs"*, with these exceptions in his own words:
- **B (unlinked postings).** *"im not attaching shit by hand. you can see breezeline is there"* → the session linked Sep 10 Breezeline itself. *"obviously thats my fpl bill"* → the Jul 28 FPL row is linked. *"no im not doing anything by hand … the gym and parking as well i told you the dates and prices"* → import-time linking plus a first-posting link, scoped to rows the upload inserted (B2 a); Gym and Parking dates are held as user dates.
- **D (remove-balance wording).** *"idk"* → the recommended wording, which is the only version that stays true.
- **G (series labels).** *"okay for other wells fargo only write what you have"* → no billing account written for Car insurance (no statement shows one); G2 (a) keeps the posting-count check; G3 (b) "scheduled, never billed".
- **Car.**
  - Insurance is **$357.58** (the Venture X statement), not $361.49.
  - **$1,000 was paid early from Wells Fargo.** It covered Sep 11 and Oct 11 in full and $284.84 of Nov 11, so **Nov 11 = $72.74**, then $357.58 on Dec 11 and Jan 11.
  - **The first lease month was paid early from Wells Fargo:** *"wait till the statement"*.
  - **The $5,000 cash down payment stays:** *"the 5k cash for the car you can set yourself"*.

**Hand-typed balances** (from the verified all-time report). Every item is his final call:
- Remove the three duplicated anchors: **done**.
- Attach the 34 printed Sapphire payment rows to their statements and drop the unprinted Mar 2 +$115/−$115 pair.
- Import the staged Robinhood files and replace the typed Jul 10 ETH event with the statements' 15 trades.
- Keep Cash on Hand's $5,000.
- Track Robinhood **#655929651** as **"Robinhood Agentic"** (checking, last4 9651; *"i gave claude agentic in robinhood 25$ to trade"*). The Jun 5 **$26.64** pair (the statement figure) is labelled **Investment Contribution**. Its positions come from **statements only**. Its linked crypto account #311407134147 ($0) waits until it holds crypto.

## ⛔ REAL-LEDGER WRITES THIS SESSION (each: restore point · dry run on a copy · invariants · re-run = nothing to do)

| # | script | what | restore point |
|---|---|---|---|
| 1 | `data/categorize-claude-sub-2026-09-14.ts` | 2 × ANTHROPIC* CLAUDE SUB → Subscriptions › Software (his "yes") | (earlier in session) |
| 2 | `data/owner-decisions-2026-09-14.ts` | link Breezeline Sep 10 + FPL Jul 28; refile 2024-09-18 −$0.79 → Credit Card Payment; Car insurance $357.58, next Dec 11; new one-off "Car insurance — Nov 11 balance after the $1,000 early payment" −$72.74; Gym/Parking user dates | `data/backups/pre-2026-09-14T153833-manual-backup.db` |
| 3 | `data/remove-duplicate-anchors-2026-09-14.ts` | Sapphire manual $0 (2025-02-03), Discover manual −$180 (2024-08-18), Robinhood Cash live $7,235.65 (2026-07-10), via the app's `deleteAnchor`; every day's balance + verified-ness identical | `data/backups/pre-2026-09-14T163810-delete-anchor*.db` |

Net worth unchanged by all three ($113,520.04); income moved +$0.79 to $117,925.41 (now equal to /spending's Earned); `pnpm ledger-check` exit 0 after each.

## THE ALL-TIME MONEY PICTURE (read-only; verified twice)

`scratchpad/all-time-money-picture-2026-09-14.md` (sent to him as a file — it names family members; not published):
- **Window:** 2022-08-25 → 2026-09-12.
- **In − out:** in $279,403.71 − out $197,340.83 = **+$82,062.88**, whichever way pass-through and refunds are counted.
- **Spending:** $170,649.49 net / $176,527.18 gross. Earned $58,551.60.
- **Bridge:** $5,000 Cash on Hand opening + $82,062.88 + $5,460 own transfers in transit + $20,997.16 investment growth = **$113,520.04**, residual $0.00 on every account and year.
- **The first build was wrong in two places, both corrected before he saw it:** $5,460 of in-transit own transfers had been counted as money in, and 23 gambling-operator rows sat outside Gambling. The mechanically assembled report still carried stale first-build text, and two more readers caught it — ⭐ always read a reconcile step's `correctedTables`, never the build's `report` fields.
- **SoFi Savings started at $0.00** (first statement 2023-10-27 $0 → $500.08); the ~$14,574 was old CSV history.
- **16 open questions sit in the report's "Questions for you" section; none blocks anything:**
  - his own-Wise $8,830.47;
  - father's money filed outside Pass-through;
  - the girlfriend's $4,000 exit rows;
  - the earned definition;
  - Discover 2024-10-29 $40 credits;
  - who paid Venture X +$1,960 / Sapphire +$300;
  - re-downloading the Discover Sep 2024 / Nov 2024 / Mar 2025 duplicates and the missing Aug/Sep 2025;
  - the fate of Capital One 360;
  - reimbursements, loans, parent Transfers and Income R&R filing;
  - Coinbase buys.

## ⛔ REAL-LEDGER WRITES ON 2026-09-15 (continued — each rehearsed on a copy, guarded, idempotent)

| # | script | what | restore point |
|---|---|---|---|
| 4 | `scripts/attach-sapphire-payment-rows-2026-09-14.ts` | 34 hand-built Sapphire payment rows attached to the 12 statements that print them; the unprinted 2026-03-02 +$115/−$115 pair superseded; the Checking −$115 "Cancelled" leg unlinked | `data/backups/pre-*-attach-sapphire-payment-rows.db` |
| 5 | `pnpm import-statements <staged>` | Aug brokerage PDF, Aug 7 – Sep 9 activity CSV, Jul + Aug crypto PDFs: 4 parsed, 42 rows, 0 deduped — identical to `pnpm trial-import` | `data/backups/pre-2026-09-15T100725-manual-backup.db` |
| 6 | `scripts/rebuild-robinhood-holdings.ts --confirm` | brokerage holdings rebuilt; both statement closes 9/9; +$742.28 | its own pre-mutation snapshot |
| 7 | `scripts/extend-eth-history-2026-08.ts --db data/moneyapp.db --confirm` | typed 2026-07-10 ETH event → 15 statement trades; ETH 14.619066 → 14.203959; −$1,050.97 | its own |
| 8 | `scripts/mark-coke-split-2026-08-31.ts --apply` | **re-marked COKE's 2025-05-27 split** that write 6 had erased (§4) — NAV +$445.12 / +$667.86 / +$1,021.71 on Mar 31 / Apr 30 / May 23 2025 | its own |

`ledger-check` gained three price-mark baseline entries (Crypto Jul 31 +$40.06, Aug 31 +$28.11; Brokerage
Aug 31 +$106.25), each on a statement whose quantities match to the share. Statement backups ran
(`pnpm backup:statements`).

## 4. ⛔ THE REGRESSIONS I CREATED — read before doing anything like them

- **The holdings rebuild erased a column it never knew about.** `rebuild-robinhood-holdings.ts` deletes and
  re-inserts every brokerage `holding_event` and wrote each with the schema default `event_kind='trade'` —
  including COKE's split. Its dry run checked only the two statement closes, so it looked perfect.
  **`ledger-check` caught it** (three drifts whose month-end quantities and prices were byte-identical to the
  backup). Fixed in `fb290f5` (`ShareEvent.eventKind`). ⛔ Never bless a new drift into the baseline until
  quantities AND event kinds match the pre-write backup.
- **Re-running a dated one-shot script froze its old "today".** `mark-coke-split-2026-08-31.ts` calls `rebuildAccount(db, id, TODAY)` with `TODAY = "2026-08-31"`, so re-running it on 2026-09-15 cut Robinhood Brokerage's cached curve at Aug 31 (a sum of each account's latest row then read $113,150.74 against the true $113,098.37). Rebuilt through today behind `data/backups/pre-2026-09-15T101659-manual-backup.db`: 243 days through Aug 31 unchanged, Sep 1–15 restored. ⛔ Before re-running any dated script, grep it for a frozen `TODAY` passed to `rebuildAccount`.
- **The second reader on this session's own commits** (116 agents, 8 real): the deactivate dialog label lost
  "this period" (`c6f8a68`); the Fees all-time clause counted charges but totalled a net (`8117c24`); two
  spelled-out dates lost their comma (`4b28ef0`); the Robinhood parse-context fix had no test through the import
  path (`3ff44df`).
- **The money report's first build was wrong and the assembled document still carried it.** A reconcile step's
  `correctedTables` superseded the build's `report` fields; I assembled from the latter until the verifiers'
  disagreement flag stopped me. ⭐ Read `reconciliation.correctedTables`, never `report`.
- **The remove-balance dialog's first rewrite still printed false sentences** (Cash on Hand's only balance "left
  to be derived from transactions alone"); a second reader found 11 — fixed in `2d2360a`.

## 5. ✅ CHECKED AND FOUND RIGHT — do not re-litigate

- The Honesty card's count and its link agree in every month holding system-category outflows.
- `?period=all` is case-sensitive but the page labels the window it shows (September) — honest.
- No raw ISO date remains in /summary prose (the unverified claim does not hold today).
- `sharePercent` on a negative bridge share: "-0.0%" was latent (none under 0.05% today); fixed anyway (`c7eff06`).
- The re-sent Robinhood CSV (`augustmidseptemberreportrobinhood.csv`) is byte-identical to the staged one.
- The first-posting rule claims **0** existing rows over the whole ledger (dry run, no scope); an import with an
  empty scope changes nothing (hashes identical).

## 7. ❓ THE QUEUE — every unfinished branch, exactly as left

1. **`uc/provenance`** (6 commits on `85fb958`, full suite 256/5,181 green in its worktree) — S19/S31 row grades,
   S24 balances dated by the observed day, S33 count badges, S32 "imported through", provenance trigger names
   "is known" instead of "is proven" for verdicts that deny a proof, thousands separators. **Both review rounds
   died** (outage, then weekly limit). Review, then cherry-pick (main is 20+ commits ahead; expect conflicts in
   observation-frontier / empty-period with the windows + pre-ledger families).
2. **`uc/rh-second-account`** — track Robinhood **#655929651 "Robinhood Agentic"** (checking, last4 9651; owner
   answers in memory `moneyapp-handtyped-balances-decisions-2026-09-14`). `c1a71ee` imports each TRACKED section
   of a multi-account statement; `c3dd0af` reads the crypto statement by account number, not position;
   `a78b6eb` is WIP rehearsal plumbing saved from a dead agent (`import-statements --db`, `trial-import --from`,
   `scripts/create-robinhood-agentic-account-2026-09.ts`) — **unreviewed, unfinished**. The scout's measured facts
   and runbook are in the workflow journal `wf_563f1a57-c92` (label `scout:rh`). ⛔ Tracking 9651 before that code
   lands makes every Robinhood statement import refuse.
3. **Shares & rounding (S17, S27, S28)** — not implemented. Owner: F1 (a) a refunded category gets its own "—"
   block; F2 (A) a subtotal is the sum of the printed rows; F3 (a) a heatmap day under 50¢ prints "<$1".
4. **Definitions (S20–S22, S26, S35)** — not implemented. Owner: "Earned" → "Income" over the income-kind population
   everywhere incl. the dashboard bridge (/summary keeps "Earned"); name the savings-rate base; suppress "appears
   once" when the charge posted again; keep Reimbursements/Gifts/Loans/Pass-through under Transfers and fix the
   copy. **Then** the Flamingo writes, dev server stopped: `scripts/rename-flamingo-merchant.ts --apply` and
   `data/flamingo-merchant-links-2026-09-14.ts --db=data/moneyapp.db --confirm` (both rehearsed on copies).
5. **Pre-ledger LOW findings** (fixer died): MonthlyTrendBars still says "not imported yet" for months before the
   records; CashFlowGraph draws running totals through buckets its tooltip refuses; a test docstring figure.
6. **Linking** (merged): the first-posting real-data review never ran. Gym (−$100) will never auto-link while 185
   other $100 rows exist and no account is named on it. Under G2 (a), after a first-posting link the calendar says
   "too few charges" while arrears counts the next miss owed — owner-accepted. Carried commit bodies cite
   `uc/linking` SHAs (ancestor names changed in the rebase).
7. **Sapphire attach** (applied): its two reviewers never ran. Implementer's open questions: the 06/30 row's
   re-parse cost; the attached rows' notes; two single-leg groups (2025-06-10 $20, 2026-03-02 $115).
8. **The all-time report's 16 questions** (in the report) and B5: Rent utilities & fees and the annual fees have
   no user date — once three postings link, the stats recompute replaces the registered day.

## 7b. THE BASELINES THAT MOVED

**48 pixel baselines regenerated** at `fb290f5` after cropping every diff (`scratchpad/crops/`, 162 strips) —
exactly 8 per family (2 themes × 4 widths), nothing else moved, and each commit's own message predicted the move:

| family | what the crop shows | commit |
|---|---|---|
| `investments`, `investments-loss` | each holding's 30d sparkline gains its 31st daily point | `0605ca1` |
| `merchant-detail` | Year on year: "The ledger opens on Jul 1, 2024, so 2024 is only partly in it"; the 2024 bar marked "from Jul 1" | `cfbe1bf`, `e6bc71c` |
| `spending` | What moved "Jul 1 – 4, 2026 against Jun 1 – 4, 2026" + its note; Where it went drops the Change column; the June ghost goes; pace "at least $10,102.16 … 4 days of July 2026 not imported yet"; a Car row (forecast $578.00) and Food's forecast $737.78 → $862.78 (the fixture's Car lease and Meal Kit overrides); the Paycheck note scoped to "all of it after Tue, Jun 30, 2026, which nothing has imported yet" | `7ff6f90`, `8e7c06d`/`d77a666`/`85fb958`, `ab901cb`, `8a589bb` |
| `spending-year` | What moved "Jan 1 – Jul 4, 2026 against Jan 1 – Jul 4, 2025"; pace "at least $60,429.67 … 4 days of 2026 not imported yet"; the 2025 ghost goes | `7ff6f90`, `8e7c06d` |
| `summary-year` | window note "every account you spend from has been imported through"; "Work-study ended May 13, 2026," | `d0ad025`, `b071632` |

**The one functional failure was a test green for the wrong reason, not a regression.**
`zz-spending-drilldowns.spec.ts` asserted NO cash-earnings note on `/spending?period=2026-07`, calling the
fixture's schedule current. The note reads confirmed income series only, and the fixture's one is Paycheck, whose
ACME deposits the seed stops on 2026-05-08 on purpose. The series the docstring named, "Employer (cash)", is only
`detected`. The test passed only because `zz-inline-renames`' "Detect now" runs first (workers: 1) and, until
`622fbff`, moved Paycheck's 49 deposits onto a detected "Acme Corp (payroll)", leaving the note nothing to read.
Measured: base code (`e818154`) on the fixture prints "…on Jul 3, 2026 and none of it reached an account", and
the committed `spending` baseline had photographed that note all along. Rewritten as two tests: silent on 2026-04
(both paydays banked; the basis is still series-stale, so it pins the gate's `unbankedCents > 0` half) and July's
scoped sentence (fails at base: no note in-suite, "none of it reached an account" in isolation).

## 8. NOTES THAT COST TIME, AND WOULD AGAIN

- ⭐ **An e2e assertion of ABSENCE can be held up by an earlier spec's defect.** Playwright runs one worker over
  one database, files in alphabetical order, so every `zz-` file after `zz-inline-renames` sees a ledger "Detect
  now" has rewritten. Before trusting `toHaveCount(0)` in a `zz-` file, ask what the files before it did to the
  seed (memory `moneyapp-e2e-fixture-facts`).

- **A workflow killed mid-flight leaves worktrees holding branches** (`git worktree list | grep "\[uc/"`). A
  resumed agent cannot check the branch out. Commit any WIP in the dead worktree, then `git checkout --detach` it.
- **The pre-commit hook runs `ledger-check`.** A commit that changes its baseline in anticipation of a data write
  blocks every later commit until the write lands — apply the write, then commit.
- **A dated script's `TODAY` constant outlives its date** — see §4; after re-running one, check each account's last `daily_balances` day against today.
- **`sqlite3 -readonly` cannot open the WAL-mode ledger after a write** ("unable to open database file (14)"); use
  Python's `file:…?mode=ro` URI.
- **zsh**: unquoted `$VAR` is not word-split; `timeout` does not exist; `grep` is ugrep (complexity limits) — memory
  `moneyapp-durable-gotchas`.
- **`pnpm e2e:fresh` needs the dev server stopped** (shared `.next`). The owner's own dev server was `next-server`
  on :3000 (pid from his terminal); `.claude/launch.json` defines `moneyapp-dev` on :3111.
