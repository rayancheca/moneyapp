# Handoff — the 09-15 queue drained, two real writes, a one-caller hunt, and your four answers

> Written 16:30 EDT while two builds were still running — §7 names them exactly. Superseded by a later
> update of this file if one exists.
>
> `origin/main` pushed at **`543e583`** (⏳ final SHA; earlier pushes `14759a7`, `9c0f956`, `93169e3`, `97d7a5c`) · **137 commits since `995e0bc`** (the previous handoff) ·
> latest push: e2e gate **602 passed** and unit **299 files / 5,975 tests** (tsc clean) on `543e583` ·
> e2e gate **602 passed** (`E2E_GATE=1`, fresh `next build`) on `14759a7` · unit suite **280 files / 5,646 tests**
> green at `9cd7acb` (measured by session 8bb0cb0a; `a7bd7af`'s two test fixes are inside it) · tsc clean ·
> `pnpm ledger-check` exit 0 after every write.
> Ledger: **10,320 active rows · 38 uncategorized** (NULL or the system category) · **13 accounts** · 42 recurring
> series · net worth **$113,125.01** (sum of each account's latest daily balance, 2026-09-15).

---

## 0. THE JOB — what is next

1. **§7 first** (two builds in flight), then **§6**, the queue, in order.
2. **Your four answers of 2026-09-15 are recorded** (memory `moneyapp-owner-decisions-2026-09-15`) — do not re-ask.
3. **When the Wells Fargo ····5481 statement covering early September arrives** — before October's lands:
   `pnpm trial-import` it → import it → `pnpm tsx scripts/link-car-payments-2026-09.ts --db=data/moneyapp.db` (dry run:
   Car lease ← one −$695.04 row posted Sep 1–18; Car insurance ← one −$1,000.00 Progressive row) → `--confirm`. The
   early lease payment falls outside the ±3-day window and, left unlinked, blocks every later lease charge (audit,
   measured on copies). Memory `moneyapp-car-lease-and-insurance`.

## 1. WHAT LANDED (all pushed in `14759a7`)

| family | what changed on screen | branch → main |
|---|---|---|
| provenance (S19, S24, S31, S32, S33) | balances dated by the day they were observed (institution cards, account header, insights window, "what you owe"); rows on another statement's anchor day say "adds up" and name it; "imported through" wording; trigger names say "is known"; counts grouped; a row's sheet grade = its grade inside every total | uc/provenance-main (6 + 8 review fixes) |
| Robinhood Agentic code | each TRACKED section of a two-account statement imports to its own account; crypto statement read by account number; pending trades / securities in #655929651 refused; `--db` / `--from` for rehearsals; `scripts/create-robinhood-agentic-account-2026-09.ts` | uc/rh-second-account-main |
| shares & rounding (F1 a, F2 A, F3 a) | a refunded category is its own relief block; subtotals are the sum of the printed rows (dashboard concentration card and /investments ticked Share agree); heatmap "<$1" | uc/shares-rounding |
| definitions (S20–S22, S26, S35) | "Earned" → "Income" over the income-kind population everywhere except /summary; savings-rate base named; /spending subcategory rows add up to the parent ("On X itself"); System/Transfers/Income definitions true of their rows; "appears once" suppressed when the payee's series has other charges | uc/definitions |
| pre-ledger LOWs | trend bars say "before your records begin"; the cash-flow graph breaks at unreached buckets; the dashboard pace staircase stops at the frontier | uc/preledger-lows |
| audit fixes | a re-parse carries a row's link/note by transaction day; first-posting runs before absorption (Nov 11 −$72.74 lands on its one-off); ended one-offs stop absorbing; guarded scripts for the WF car payments and the Sapphire one-sided pairs | uc/audit-fixes |
| recurring / car card (hunt) | car card "$1,379.53 a month, all in" → **$1,306.79** (the $72.74 balance is not monthly) and its insurance date agrees with the runway; never-billed = "never billed", neutral; All tab names end dates beside annualized figures; eating-out/fees divide by the window's own months; Calendar tab badge follows the grid | uc/recurring-surfaces |
| hunt round 2 | COKE's split reached the holding page (realized P/L $102.32 = the holdings table; NAV reconciles with the Apr/May 2025 statements); per-holding day moves dated by their own closes; terrain/Owed rollup treat carried cash days as verified; /summary keeps its spending figures with insights off; /spending and /categories no longer crash on a URL year; account order is institution → display order → name everywhere; Sankey shares name their side; "What changed" links its own month | uc/investments-dating, uc/terrain-verified, uc/summary-periods, uc/ordering-misc |
| session 8bb0cb0a | un-import rebuilds an account the file gave only a period and an anchor (`9cd7acb`) | its branch, ff'd onto main |
| e2e | 59 baselines regenerated after cropping every diff; categories-arrange spec follows the new expense definition | `14759a7` |

### 1b. Landed on local main after `14759a7` (pushed)

| family | what changed | branch |
|---|---|---|
| /spending stopped categories (hunt) | Where it went's List, Table and relief count categories that stopped spending, the population What moved counts; 5 whole periods had shown the wrong sign (2022-12 +$8.72 → −$191.28, 2024-02 +$1,242.55 → −$3,747.75, 2024-07 +$19.01 → −$2,438.09, 2025-10 +$313.04 → −$283.51, 2026-07 +$588.75 → −$2,057.14); a phone-width line names each stopped category's fall | uc/spending-population |
| /budgets frontier (hunt) | a budget's "spending imported through" is the earliest frontier over the accounts that category spends from (6 full months), not its newest row; never the ledger-wide `ledgerReaches` (refuted) | uc/budgets-frontier |
| card re-parse boundary | a card statement row dated before its period opened is placed in its own period; a straddler's ownership is decided on its stored day — a parser bump no longer breaks 3 Sapphire periods or quarantines 10 payments | uc/card-reparse-boundary |
| investments Today labels (hunt follow-up) | the portfolio header, dashboard teaser, /accounts/[id] header chip and cards, and the 1D session note name the closes they measure ("Sep 14 vs Sep 11") instead of the carried day; an investment account's Day column is dated | uc/investments-today-labels-v2 |
| attached rows survive un-import (your answer 4) | migration 0016 `transactions.file_link_source`; un-import detaches `attached` rows and keeps money/groups/links/notes; the marker survives a parser bump; the confirmation counts rows kept and transfer legs honestly | uc/unimport-keeps-attached-main → main `93169e3`: unit **295 files / 5,887 tests** |
| Robinhood Agentic safety net (design option c) | a #655929651 section the cash reader cannot prove (a Buy/Sell, securities, a pending trade, crypto movement, totals that don't add up) is WITHHELD with a durable notice ("Not imported: Robinhood Agentic ····9651's statement for Aug 1 – 31, 2026 — it shows $26.22 of securities…"), and the rest of the PDF imports; on a constructed August the old code lost $2,500.10 of Robinhood Cash and turned ledger-check red — now identical to a normal import; /imports shows "Partly imported" and the gaps panel lists the withheld window | uc/agentic-withhold-section (pushed) |
| budgets without cash wallets (your answer) | a budget's imported-through day ignores statement-less cash wallets (Car: "through Aug 11" → "through Aug 12", from Chase Checking + Venture X); a category spent only from wallets reads "Cash only" and makes no pace claim | uc/budgets-wallets-out-r2 (pushed) |
| quarter List change column (your answer, left to Claude) | a whole-comparing quarter's List prints the change and lists every category the Table does (11 quarters had dropped rows: 2026-Q2 17 → 18 with Gifts & Donations −$10.40); from md up the change column names its prior window; one pure `whereItWentRows` builds both lenses | uc/quarter-list-change-r2 (pushed) |
| merge collision | `import.test.ts` imported `dailyBalances` twice (two branches each added it) — tsc TS2300, the whole file failed to load | `2a0e7f2` — full unit suite **284 files / 5,702 tests** green, tsc clean |

## 2. ⛔ REAL-LEDGER WRITES (each: restore point · dry run / trial · invariants · re-run = nothing to do · ledger-check exit 0)

| # | what | evidence | restore point |
|---|---|---|---|
| 1 | **Robinhood Agentic** (#655929651, checking, last4 9651) created — id `01a0a5f7-fdde-7000-85d2-1cd5ddd17902`, 13 guards | then the Jun / Jul / Aug two-account brokerage PDFs re-imported at parser v4: parsed 3, inserted 25, superseded 24, deduped 0; Jun 5 $26.64 pair = one transfer group, both Investment Contribution; **32/32 invariants** vs the pre-write copy; net worth **$113,098.37 → $113,125.01** | `scratchpad/agentic-real/pre-write.db`; `data/backups/pre-2026-09-15T124848-manual-backup.db` |
| 2 | **Flamingo** merchant `019f4cbe-6483-7b62-ae95-4097de5dc797` renamed "Flamingo South Beach" (11 guards), 3 rent rows linked, exact date-stamped alias → 2 contains aliases | 4 rows, −$6,957.61, Jun 16 – Aug 4; income / spending / row sum unchanged; dashboard notices no longer mention Flamingo | `scratchpad/flamingo-real/pre-write.db`, `pre-links.db`; `data/backups/pre-2026-09-15T125025-manual-backup.db` |
| 3 | **Sapphire one-sided payment pairs linked** (your answer 1): 2025-06-10 $20.00 Checking …4122 ↔ Sapphire …d45f; 2026-03-02 $115.00 Checking …7d70 ↔ Sapphire …eff6 | one-leg groups 23 → 21; linked 90 → 91, unpaired 21 → 20; balances untouched; re-run ALREADY APPLIED | `scratchpad/pairs-real/pre-write.db`; `data/backups/pre-2026-09-15T*-link-sapphire-one-leg-groups.db` |
| 4 | **Chase Checking's cancelled $115 recorded as one cancelled transfer** (your answer 2): −$115.00 …7081 + $115.00 "…Cancelled" …7694 — a different −$115 row from answer 1's (Checking printed two identical −$115.00 lines that day) | transfers card: departures 111 → 110, unpaired 20 → 19, arrivals 29 → 28, new "1 cancelled transfer — $115.00 — left an account and came back to it"; net worth every day identical; ledger-check exit 0 | `data/backups/pre-2026-09-15T*-pair-checking-115-reversal.db` |

| 5 | **Migration 0016** (`transactions.file_link_source`) + the **34 attached Sapphire rows marked** (your answer 4 — they survive un-importing their statement) | 34 rows / $9,680.91 / 12 statements marked `attached`; active 10,320; net worth $113,125.01; re-run ALREADY APPLIED; ledger-check exit 0 | `data/backups/pre-2026-09-15-migration-0016.db` (pre-migration); the script's own `pre-*-mark-attached-sapphire-rows.db` |

| 6 | **The Sapphire +$100.00 payment re-dated to its printed 06/30** (your answer): row 019f4ea0-240b-700b retired, successor 01a0a6b6-ca20… posted/transacted 2026-06-30 with the parser's hash, same group, statement, `attached` marker and note | 13/13 guards; Sapphire 2026-06-30 −$29.11 → $70.89 and no other day; net worth $113,125.01; re-run ALREADY APPLIED; ledger-check exit 0 | `scratchpad/redate-real/pre-write.db`; the script's `pre-*-redate-sapphire-0630-payment.db` |

⚠️ `scripts/attach-sapphire-payment-rows-2026-09-14.ts` and `scripts/mark-attached-sapphire-rows-2026-09-15.ts` now refuse when re-run — on purpose: the $115 reversal grouped a row its after-state expects ungrouped. ⚠️ Un-importing 20260302 still ends in a −$798.48 gap (restored retired duplicate twins the re-import cannot match) — queued, not fixed.

## 3. ❓ YOUR ANSWERS, 2026-09-15 (closed — do not re-ask)

- Link Sapphire's two one-sided payment groups (2025-06-10 $20, 2026-03-02 $115) to their Checking debits.
- Record Chase Checking's 2026-03-02 −$115 / +$115 "Cancelled" as one reversal that nets to zero.
- Move Robinhood Cash ($0.90) and Robinhood Agentic ($26.64) **out** of "Cash you can spend today" and month-end cash — **without** making Agentic investment-side for returns.
- Attached rows **survive** un-importing their statement.

Second round (memory `moneyapp-owner-decisions-2026-09-15`, same file):
- When the agent in #655929651 buys a stock: **two accounts** — "Robinhood Agentic" keeps unspent cash, a new
  "Robinhood Agentic Brokerage" holds positions. Built on top of the section-withholding safety net (⏳).
- Budget frontier: **leave cash wallets out** (Car follows Chase Checking + Venture X).
- The Sapphire +$100.00 payment printed 06/30 carries **the printed 06/30** (Jun 30 balance −$29.11 → $70.89).
- /spending quarter List: he left it to Claude → **the change column shows on quarters** (List = Table).
- The pre-commit ledger check **fails when its count of witnesses drops**; a new statement raises the count on its
  own; sessions handle it, never him (⏳ uc/ledger-check-witness-floor).
- Not asked, shipped as measured: categories that stopped spending get no relief block (their fall is in the total
  and named in a note) — drawing zero-width wells would let the deepest set every block's height.

## 3c. The Robinhood Agentic positions design (read-only, 2026-09-15)

- Measured through the read-only Robinhood connector: #655929651 holds nothing and has $0 unsettled today.
- The agent's first Buy/Sell/crypto move or a pending trade makes the statement's cash reader throw, and today that
  refuses the WHOLE PDF: on August's figures −$2,500.10 of Robinhood Cash, runway 27 → 11 days, forecast month-end
  cash $1,093.15 → −$1,406.95, ledger-check red. The safety net (withhold only that section) ships first (⏳).
- Design file: session scratchpad `agentic-design.json` (options (a)/(b)/(c), buildPlan).

## 4. ⛔ WHAT COST TIME, AND WOULD AGAIN

- **Two branches green alone, red together.** `window-captions.test.ts` (recurring) built an `EatingOutCard` before
  ordering-misc made `spendingHref` required; `YearSpendingCard.test.ts` (summary-periods) asserted "is proven" after
  provenance renamed it "is known". Run the FULL suite after every cherry-pick batch, not only the branch's own files.
- **Two hand-resolved conflicts in `provenance.ts`** (terrain's no-holdings headline vs provenance's `recordedBy`) —
  the merge keeps both. ⏳ second-reader verdict.
- **A test stops at its first failing screenshot**, so `--update-snapshots` writes files the gate never compared
  (8 here: interaction-states at 375px, golden-path account-detail). Crop those against `HEAD` before committing.
- **A `<select>` sizes to its widest option** even when another is selected: "All earning and spending" → "All
  income and spending" moved every /transactions baseline 2px; the commit that renamed it predicted nothing.
- **A write gate keyed on a string the script never prints** ("11/11") silently held back the Flamingo rename; gate
  on the script's own success line.
- **Another session committed to `main` mid-integration** (`9cd7acb`). `SendMessage` to it worked: it moved to a
  branch, and its merge notes are in §6.
- **Verifier caps hide work.** The hunt's cap of 6 left 11 HIGH/MEDIUM unverified; a second round confirmed 10.
- **Green branches, red main, three ways.** (1) A client component (`SpendHeatmap.tsx`) imports a VALUE from
  `@/services/spending`; one new service edge (budgets → manual-transactions → db/backup) put better-sqlite3 in a
  browser bundle and `next build` failed while tsc and 5,934 unit tests were green — branch agents may not run
  `next build`. Run `pnpm exec next build` after every merge batch. (2) Tests written beside rules that merged
  after them, and a duplicate import two branches each added — run the full suite after each cherry-pick batch.
  (3) Dead agents' worktrees hold branches, so fixers pushed to `-v2`/`-r2`.
- **The 3pm session limit killed 6 agents mid-review.** Nothing was lost because each stage returns structured
  results; the resume workflow re-ran only the dead stages. Never merge a branch whose reviewer died.

## 5. ✅ CHECKED AND FOUND RIGHT — do not re-litigate

- The Sapphire attach (write of 2026-09-15 morning): each of the 34 rows is printed exactly once on the statement it
  is attached to; balances and all 19 period verdicts equal the restore point.
- Import-time linking on real statements re-imported to copies: idempotent, re-links no history.
- The Discover Sep 2026 statement was already imported (2026-09-14).
- A refuted hunt claim: /budgets must NOT take the ledger-wide `ledgerReaches` (it understates every row).

## 6. ❓ THE QUEUE — in order

**A. Owner questions still open** (ask as concrete either/ors; defaults ship meanwhile):
1. /budgets "Awaiting statements" rows still print "Projected ≈" and a pace-coloured tail beside a definition that
   offers no reading (Car $695.04, Food $321.44, Housing $2,305.73 … on 2026-09-15): keep, or drop both (breaks
   `e2e/zz-budgets.spec.ts:248` and moves budgets baselines).
2. /categories/[id] names the ledger-wide imported-through day one click from a budget row that names the
   category's: feed the category frontier into the page, or label the page's day as ledger-wide.
3. Coverage-note partial tie ("up to 15 days on Car" with eight rows at 15): name a budget only when it alone holds
   the worst gap, or keep.
4. /investments ticked Share over every holding but WMT prints ">99.9%" over cells adding to 100.0 (shipped: keep
   the floor) — or print "100.0%".
5. First-posting at a never-seen amount still depends on upload order: require a named account on the commitment,
   or accept.
6. The 34 attached Sapphire rows keep hand-built notes/descriptions the statement does not print: replace with the
   printed line, or keep.
7. (latent) A one-payment remainder landing in the same month as its own bill is summed into the car card's monthly
   figure; closing it needs a "remainder of another series" marker.
8. The all-time report's 16 questions (previous handoff §3) and B5 (Rent utilities & fees / annual fees have no
   user date) are still open.

**B. Waiting on an event:**
- **The Wells Fargo ····5481 statement covering early September:** trial-import → import →
  `scripts/link-car-payments-2026-09.ts` dry run → `--confirm`, BEFORE October's statement (§0.3).
- **The agent's first trade in #655929651:** the safety net withholds that section with a notice; then the
  two-account build's runbook creates the Agentic brokerage account and reads positions (⏳).

**C. Defects queued (no decision needed):**
- Un-importing and re-importing 20260302 ends at a −$798.48 gap (restored retired duplicate twins the re-parse cannot
  match) — duplicate lifecycle / import identity; 9 older Sapphire statements hold duplicate survivors (unmeasured).
- Re-parse `supersedeFileContribution` rebuilds only the new parse's accounts (code-read; your background task
  "Rebuild accounts whose only link to an unimported file is a period" may cover it).
- No guard stops a "use client" component's import graph reaching `@/db/backup`/better-sqlite3 (six client files
  import values from services) — move those helpers to `src/lib` or add a source-graph test.
- Cash on Hand's balance popover says "Checked through 2026-08-03" about a balance typed by hand.
- The forecast card's EOM-cash note prints its "$0.00 in the headline" half.
- The eating-out card prints a multiple `multipleFact` would refuse when refunds exceed charges.
- The "level with <prior window>" wording is spelled inline in three places (List phone line, massif rail,
  massif description).
- Chase-card parser bump: safe for periods and the quarantine now; still re-dates the 06/30 row unless the 06/30
  re-date write lands first (⏳).
- `scripts/attach-sapphire-payment-rows-2026-09-14.ts` refuses as a post-check on purpose (the $115 reversal
  grouped a row it expects ungrouped) — do not use it as a check.

## 7. ⏳ IN FLIGHT AT WRITING (16:30) — finish these first

1. ✅ **DONE 16:35 — `uc/ledger-check-witness-floor` merged** (your answer: the pre-commit check fails when its
   count of witnesses drops; growth raises the mark on its own). The migration was renumbered to
   `0017_ledger_witness_marks`; the first real `ledger-check` applied it (18 migration rows) and recorded marks
   INSIDE the ledger — value anchors 43 · chain endpoints 221 · chain windows 211 · statement periods 255 ·
   accounts 13 — and a second run held (exit 0). A drop now fails the hook and names what left; after a removal you
   approved: `pnpm ledger-check --lower-marks=<kind> --confirm`. A lone chain-grade anchor (Cash on Hand's $5,000)
   is its own witness now. Known limits: a swap (one witness out, a different one in) passes; editing a balance
   changes no count; a moment-only account's first statement can drop endpoints. Restore point:
   `data/backups/pre-2026-09-15-migration-0017.db`.
2. **`uc/agentic-two-accounts`** (your answer: two accounts when the agent buys stock). Built on the section safety
   net now on main. Constraints given: positions from statements only; the cash account paired to its brokerage by a
   stored link, not a name; the agent's positions kept OUT of your own brokerage returns (your 2026-09-14 naming
   decision); Agentic cash not spendable; the brokerage account NOT created on the real ledger until a
   securities-bearing statement arrives. Implemented (`bf443ef`: `accounts.cash_account_id` UNIQUE,
   `holding_events.import_file_id`, `isOwnPortfolioBook`; measured on a ledger copy — 0 differing surfaces, net worth
   $113,125.01); reviews and fix running.
   ⛔ **MIGRATION HAZARD:** the branch names its migration `0017_statement_positions` with a journal `when` EARLIER
   than main's `0017_ledger_witness_marks`, which is already applied to the real ledger. drizzle applies only
   migrations later than the last one applied, so a plain renumber would be SKIPPED there and every query touching
   the two new columns would fail. Merge with `scratchpad/renumber-agentic-migration.py <branch>` (dry-run with
   `--check` passed at 16:50: only `accounts` + `holding_events` change; 0018 gets a later `when` and a snapshot
   chained onto main's 0017), take a restore point, then verify 19 migration rows and both columns on the real
   ledger.
3. ✅ **DONE — your background task** "Rebuild accounts whose only link to an unimported file is a period"
   (`9cd7acb`, session 8bb0cb0a) is on main since `14759a7`; its branch holds nothing unmerged.
3b. **Queue defects** (workflow running): the end-of-month note's `$0.00` half, the eating-out multiple, "level
   with" wording given one home, and a unit guard that no client component's import graph reaches `better-sqlite3`
   (the `97d7a5c` build break, §4). Branches `uc/eom-note-zero-half`, `uc/eating-out-multiple`,
   `uc/level-with-one-home`, `uc/client-graph-guard`. The end-of-month fix will move the recurring and
   recurring-calendar baselines — trace them before regenerating.
4. After every merge batch: `pnpm exec next build` BEFORE the gate (§4).

Session scratchpad (9ebfed64): `queue-after-merges.md` (the full queue with evidence), `hunt-result.json` +
`hunt-overflow-verdicts.json` (the one-caller hunt), `agentic-design.json`, the rehearsal copies and runbooks
(`agentic-real/`, `flamingo-real/`, `pairs-real/`, `mark-real/`, `redate-real/`), `crop-diffs.py`.
