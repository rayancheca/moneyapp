# Handoff — the queue drained, the agent's book, an import lifecycle that survives a round trip, and your ten answers

> Written 2026-09-17. `origin/main` = **`f0ad619`** · **225 commits** since `995e0bc` (two handoffs ago), **54**
> since yesterday's push · unit **317 files / 6,415 tests** · e2e **602 passed** at `maxDiffPixels: 0` ·
> `next build` ✓ · tsc ✓ · `pnpm ledger-check` exit 0.
>
> Your ledger: **13 accounts · 10,320 active rows · 32 uncategorized · 255 statement periods · 309 anchors ·
> 42 recurring series · 24 migrations** · net worth **$110,914.77** (latest balance of each account, with this
> morning's live prices; $113,125.01 at the last statement closes). Witness marks unchanged: value anchors 43 ·
> chain endpoints 221 · chain windows 211 · statement periods 255 · accounts 13.
> New record tables: 2 account numbers · 105 statement copies · 305 printed-line records.

---

## 0. THE JOB — what is next

1. **§6 is the queue**, in order. Nothing is in flight: every branch this session opened is merged and pushed.
2. **Your ten answers (2026-09-15 → 09-17) are recorded** in memory `moneyapp-owner-decisions-2026-09-15` and in
   §3 / §6A — do not re-ask. One question is open and waiting for you: **§6A 21** (a re-read that drops a line a
   still-imported re-download prints — bring it back, or make the loss visible).
3. **When the Wells Fargo ····5481 statement covering early September arrives** — before October's lands:
   `pnpm trial-import` it → import it → `pnpm tsx scripts/link-car-payments-2026-09.ts --db=data/moneyapp.db` (dry
   run: Car lease ← one −$695.04 row posted Sep 1–18; Car insurance ← one −$1,000.00 Progressive row) → `--confirm`.
   The early lease payment falls outside the ±3-day window and, left unlinked, blocks every later lease charge.
   Memory `moneyapp-car-lease-and-insurance`.
4. **The next time you drop a statement file**, the import re-reads what is pending: the Discover CSV (v1 → v2) and
   33 Robinhood brokerage PDFs (v3/v4 → v5). Both were rehearsed on copies this session: no figure moves, hand-set
   attributes carry, `ledger-check` stays green.

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

| 7 | **Migrations 0018–0023 + the three record-keeping backfills** (your answer 19), 2026-09-17 | the first script's open applied 0018 `statement_positions`, 0019 `statement_copies`, 0020 `account_numbers`, 0021 `unimported_transfer_legs`, 0022 `printed_lines`, 0023 `unimported_row_attributes` (18 → 24 migrations; the two new columns are NULL on every existing row, and every old column is byte-identical). Then `record-account-numbers` (2: Venture X ····4208 also printed ····9082 and ····4147), `record-statement-copies` (105 — "keeps 103 periods and 3,269 rows under another download"), `record-printed-lines` ×6 chunks (305 records, 23,071 lines). Each: dry run first, own restore point, re-run = "Nothing to do" | every figure compared before/after: net worth, per-account latest balance, daily_balances digest, periods by verdict + gap, anchors by source, active rows + sum, categories by source, notes, transfer groups, attached rows, marks — **only the migration count moved**; `pnpm ledger-check` exit 0 with "import records: 0 parsed file(s) … with no record" | `data/backups/pre-2026-09-17-migrations-0018-0023.db` (WAL-inclusive, integrity ok, 25 tables identical) + each script's own `pre-*.db` |

| 8 | **The cash job's weekly pay $1,047.00 → $1,141.92** (your word, 2026-09-22: FICA should never have been withheld), 2026-09-22 | one UPDATE on `recurring_series` `019f72da-1fbc…`'s `user_amount_cents`; 14 guards — every other series, transactions, daily_balances, anchors, periods, budgets, accounts, holdings, holding_events and net worth byte-identical. Levelled monthly **$4,537.00 → $4,948.32**; income-card rate follows; runway **26 → 29 days of cash**; /budgets September $4,188.00 → $4,567.68 (4 paydays), October $5,235.00 → $5,709.60 (5). Re-run = nothing to do; ledger-check exit 0 | `data/backups/pre-2026-09-22-weekly-pay.db` + the script's own `pre-*-set-cash-job-weekly-pay.db` |

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

### Your answers of 2026-09-16 / 09-17 (closed — do not re-ask)

- Un-importing a file that TOOK OVER rows brings those rows back when their own file is still imported.
- A re-read that stops reading an account DETACHES and keeps that account's attached rows.
- An un-import → re-import round trip gives back your hand categories, notes and recurring links.
- The agent's dividends stay OUT of /summary's investment income (interest on its cash still shows under
  "Interest on other accounts").
- Run the three record-keeping backfills on the real ledger (done — §2 row 7).
- After un-importing the Wells Fargo PDF, Wells Fargo keeps the opening balance that statement printed ($0.00,
  Jul 26) labelled as from a statement you un-imported; net worth does not move; it reads unverified until the
  statement is back.

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

- **A gate run under load invents failures.** The gate beside the full unit suite and six stalled agents: 2.7 h,
  36 failed — 16 real, 20 "element is not stable" / 30 s click timeouts, single tests taking 10–17 min. The same
  tree then passed 602 in 8.6 min. Read the failure KIND before chasing one; never regenerate a baseline from a
  loaded run. And read a gate's own `gate rc=` line: a wrapper ending in `grep` reports the grep's exit.
- **A migration collision is not fixed by renumbering.** drizzle applies only migrations whose journal `when` is
  later than the last applied, so a branch renamed to a higher number but generated EARLIER is skipped silently.
  Renumber AND give it a later `when`, rebuild the snapshot cumulatively on the one before it.
- **A 16-finding fix list kills an agent.** Two workflows lost a fixer to "no progress for 180000ms"; the survivor
  had made 8 commits on a detached HEAD. Split fix stages into small sequential agents, tell them to run anything
  over 60 s detached and poll it, and recover a dead agent's work with `git -C <worktree> log <branch>..HEAD`.
- **Per-commit cherry-picks cannot resolve a semantic merge.** Two branches had each rewritten the same re-read
  step; picking commit by commit meant resolving it repeatedly. One merge of the final states, by an agent that
  ran both sides' tests, was right.
- **`sqlite3 -readonly` cannot open the ledger when it has no `-shm`** (WAL mode, nothing else attached):
  `sqlite3 "file:data/moneyapp.db?immutable=1" ".backup …"`. But an immutable read IGNORES the WAL — check for a
  `-wal` file first, and take restore points through a `mode=ro` connection so the WAL is included. This session's
  first restore point missed your 09:40 price refresh for exactly that reason.
- **An agent wiped shared scratch** with `rm -f *.db` at the top of the session scratchpad. Every cited restore
  point survived (they live in subdirectories and in `data/backups`), but prompts now say: own `mktemp -d`, never
  wildcard-delete a shared directory.

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
9. (from the queue-defect reviews, none reachable on your ledger today) the eating-out card in refund-only months:
   headline "-$5.00 a month", "Average ticket -$30.00", "0.0 purchases a day", groceries row "-$20.00";
   `renderMultiple` prints 1,000× and up without a separator ("2500.0×"), reachable by the eating-out card and the
   times-the-usual notice.
10. "against <window>" is still spelled inline in the /spending List column title + sr-only text, `massifTableCaption`,
   `massifAbsentNote`, `massifEmptyState` (which can still write "the change is $0.00" on an empty plate — 0 of 17 on
   your ledger); the one-home guard covers only "level with".
11. `formatQuantityE8` still pulls `services/holdings` into AccountHoldingsTable / PortfolioHoldingsTable's browser
   graph (it builds today); a same-named, different formatter lives in `lib/robinhood-holdings.ts` — one rule or two
   is a code-reading question, decide before moving it (after `uc/agentic-two-accounts` lands, it owns that file).
12. The client-bundle guard's forbidden list is pinned to a `next build` probe taken at `25b9435`; a Next/Turbopack
   upgrade needs a fresh probe and row edits.
13. (round 2, shipped the stricter default) Between two balances you COUNTED by hand (Cash on Hand), do rows imported
   from a document make that span "checked"? Shipped: no — only a statement checks.
14. (round 2) Net worth's "checked through" date while Cash on Hand rests only on your count: shipped (a) stop the
   day before it goes unchecked; (b) would leave Cash on Hand out of that date and say so.
15. ✅ ANSWERED 09-16 — **bring them back** (building). Un-importing the Wells Fargo PDF leaves the 39 Rocket Money rows it took over retired
   (−$2,396.67 of net worth) although the Rocket Money export is still imported: bring them back on un-import, or
   keep them retired.
16. ✅ ANSWERED 09-16 — **detach and keep** (building). When a newer parser version stops reading an account a statement used to give it, that account's
   attached rows are retired with the old read: detach and keep them (as un-import now does), or retire them.
17. ✅ ANSWERED 09-16 — **keep them out** (as shipped). The agent's DIVIDENDS are left out of /summary's investment income under your 2026-09-14 rule
   (the agent's money is not yours for returns): keep them out, or count them as money received. Interest paid on
   Robinhood Agentic's cash still shows under "Interest on other accounts".
18. ✅ ANSWERED 09-16 — **give them back** (building): an un-import → re-import round trip restores your hand
   categories, notes and recurring links on the rows it removed, as it now does for hand-linked transfers
   (a SoFi 2025-03 round trip had moved 24 rows / $5,573.78 back to Uncategorized).
19. ✅ ANSWERED 09-16 — **run the three record-keeping backfills** on the real ledger after the merge
   (`scripts/record-account-numbers.ts`, `record-statement-copies.ts`, `record-printed-lines.ts`; no amount moves).
20. ✅ ANSWERED 09-17 — **keep the printed opening**: after un-importing the Wells Fargo PDF, Wells Fargo keeps the
   opening balance that statement printed ($0.00, Jul 26), labelled as from a statement you un-imported, and the 39
   kept rows build on it — net worth doesn't move; it reads unverified until the statement is back (building).
21. ❓ OPEN (found by the last reviewer, MEDIUM, pre-existing shape): when an export is re-read at a version that
   DROPS a line, and a still-imported re-download of that export prints the same line, the row leaves the ledger
   silently — no gap (an export's period is `not_applicable`), no count in the upload outcome, no ledger-check
   finding. Measured: dropping the +$25.00 Wells Fargo opening deposit moved WF $2,396.67 → $2,371.67 and net worth
   with it; un-importing that same export would have KEPT all 39 rows. Your either/or: (a) bring the dropped line
   back under the still-imported printer (risk: a line the new version deliberately re-dated could be counted
   twice — the rule cannot tell "dropped" from "re-dated"); (b) leave it out but make it VISIBLE — count it in the
   upload outcome and raise a ledger-check finding. Nothing is silent-safe today.
22. ❓ OPEN — **your budgets still add up to the OLD income.** The eleven were sized from $4,537.00 a month
   (`lib/income-budget`: income sets the size, trailing spend sets the shape). Your pay is now $4,948.32 levelled,
   so /budgets shows $411.32 more unallocated every month. (a) leave them and let the surplus show as unallocated,
   or (b) re-propose them against the new income (same rule, bigger pool) — say which and it is one guarded write.
23. ❓ OPEN — **the 13 Chase rows that still carry the statement's margin digits.** The parser fix (below) cleans
   what it READS, but those rows came from 27 older byte-copies of the same months, imported at v1, whose sha is
   not the archive copy. The ONLY run that corrects them is re-dropping `data/statements/chase-checking-3522/`
   (75 files). Measured on a copy with the fix in place: **16 ledger lines move** — the 13 descriptions plus three
   Fordham rows the merchant map re-derives `Financial Aid → Education` — 0 quarantined, net worth unchanged at
   $110,914.77, nothing crossed, ledger-check byte-identical. Cosmetic side effect: those files' recorded names
   gain their sha prefix. (a) run it (trial-import first, then import, behind a restore point), or (b) leave the
   13 descriptions as they are.
24. ❓ OPEN (from the identity fix's reviewer, MEDIUM) — **13 Chase Sapphire charges and 4 daily balances still
   depend on which file was read first.** The fix stops a re-read absorbing a line whose transaction day
   disagrees; full order-independence would mean letting a later, better-dated read RE-DATE a charge an earlier
   file already recorded. That is a behavioural widening with its own double-count risk. (a) widen it, or
   (b) keep today's rule and accept that the first file to print a charge owns its day.

**B. Waiting on an event:**
- **The Wells Fargo ····5481 statement covering early September:** trial-import → import →
  `scripts/link-car-payments-2026-09.ts` dry run → `--confirm`, BEFORE October's statement (§0.3).
- **The agent's first trade in #655929651:** the safety net withholds that section with a notice; then the
  two-account build's runbook creates the Agentic brokerage account and reads positions (⏳).

**C. Defects queued (no decision needed):**
- ⛔ (hosting phase, measured 2026-09-17) the build's file tracer follows the import service's archive paths
  under `data/`: every server trace listed the ledger databases, backups and statement files (630 in each route
  trace). `next.config.ts` now excludes `data/**` and the 23 route traces are clean, but
  `.next/server/instrumentation.js.nft.json` still lists **1,258** of your files (Next applies the exclude per
  route only). Before any standalone/hosted build: make `statementsRoot()`'s `process.cwd()` path opaque to the
  tracer or strip `data/` from the deployed tree, and assert 0 `data/` entries in every `.nft.json`.
- (agent-raised card, pre-existing) re-reading Spending Report PDF (1).pdf at a bumped version puts Sapphire
  2026-07-03→08-02 into gap −$1.25 and quarantines 72 rows (`identityWeight` absorbs on a posted-day match when the
  transaction days disagree) — start only after this merge is pushed.
- ⏳ (queue round 2, in flight) un-importing and re-importing 20260302 ends at a −$798.48 gap: un-import restores retired
  duplicate twins the re-parse cannot match; 9 older Sapphire statements hold duplicate survivors → `uc/unimport-duplicate-twins`.
- ⏳ (queue round 2) a parser-version re-read rebuilds only the NEW parse's accounts although `supersedeFileContribution`
  deleted the old file's periods/anchors (the re-read sibling of `9cd7acb`) → `uc/reparse-rebuild-scope`.
- ⏳ (queue round 2) Cash on Hand's popover says "Checked through 2026-08-03" about a balance you typed; an investment
  account with no holding events still reads "priced from holdings" (reachable once the agent's book exists) →
  `uc/provenance-manual-and-eventless`.
- ✅ fixed on local main (`980ad69`): the client-bundle import guard, the EOM note's `$0.00` half, the eating-out
  multiple, the "level with" wording.
- The Chase card parser is at version 1; both things that made a bump unsafe have landed (the card re-parse boundary
  and the 06/30 re-date write), so a future bump no longer breaks periods, quarantines payments or re-dates 06/30.
- `scripts/attach-sapphire-payment-rows-2026-09-14.ts` and `scripts/mark-attached-sapphire-rows-2026-09-15.ts`
  refuse when re-run, on purpose — do not use them as checks.

## 7. ✅ WHAT LANDED AFTER THE CHECKPOINT (all pushed, `4e1c1c4` → `f0ad619`)

| what | evidence |
|---|---|
| **The witness floor** (your answer): `pnpm ledger-check` fails when its count of witnesses DROPS, raises the mark on its own when one appears, and `--lower-marks=<kind> --confirm` lowers it after a removal you approved | migration `0017_ledger_witness_marks`; the first real run recorded 43 · 221 · 211 · 255 · 13 and every run since holds |
| **Four queue defects**: the EOM note prints one amount instead of a `$0.00` half; eating-out and concentration share `renderMultiple` ("<0.1×", never "0.0×"); "level with" has ONE home behind a TypeScript-parser guard, and the relief rail dates a day's change to its own day; a unit guard walks every `"use client"` import graph for `better-sqlite3`/`fs`, and four client components stopped carrying whole service graphs | 14 commits; 16 recurring baselines traced by crop before regenerating |
| **Round 2 — the import lifecycle**: a parser-version re-read rebuilds every account the retired file wrote; a re-read the new parser cannot finish keeps the old read; removing a statement keeps an anchor a neighbour or a second download still prints; Sapphire 20260302's round trip closes (no −$798.48 gap); a takeover's payment is not doubled; Cash on Hand's typed $5,000 is never "checked"; an event-less investment account is not "priced from holdings" | 10 commits, each RED-first, reviewed and fixed |
| **Round 3 — what a round trip must not lose**: un-importing the first of two downloads no longer deletes 85 rows and a period the other prints (59 such statements); a failed archive move no longer leaves rows under a "Failed" file or stops the upload; the Discover re-read keeps Claude's categories; a pre-reissue Venture X statement no longer creates a second account; round trips keep hand-linked transfers ($11,476.31 when both sides round-trip) and no longer count $12,975.87 of card payments as spending; un-importing Spending Report PDF (1) no longer puts 8 reconciled Sapphire periods into gap; the confirmation says what a round trip really does | 11 commits; 24 verifier findings + 4 from the final review, all fixed |
| **The agent's brokerage book** (your answer: two accounts): migration 0018 pairs a book to its cash account by a stored link (`accounts.cash_account_id`, UNIQUE); `isOwnPortfolioBook` keeps the agent's positions OUT of your returns and IN net worth; parser v5 reads a #…9651 section that proves positions; the book is created only by a statement that proves them | 11 commits over two review rounds: a refreshed-then-un-imported book stayed in net worth at $27.37; −0.1 WMT after an un-import; name-match mutants survived; the bridge called the book "Unexplained"; a quiet later month let a sold 0.25 WMT return; your WMT page counted the agent's shares; /summary counted its dividend; links opened your page or a 404 — all fixed, 14/14 lifecycle mutants killed |
| **The final integration**: both lifecycles in one merge, ONE rule for who keeps a month a second download prints, migrations renumbered 0019–0022, your answers 15/16/18/20 built, the backfills rehearsed | 2 HIGH + 14 MEDIUM from three review lenses, 2 MEDIUM from the final review, then 2 HIGH + 4 MEDIUM from a last reviewer on the two commits nobody had read — all fixed but §6A 21 |
| **The build stopped shipping your money**: every server trace listed `data/moneyapp.db`, the backups, `data/statements` and `data/inbox` (630 entries per route) | `outputFileTracingExcludes` clears all 23 route traces; the instrumentation trace still lists 1,258 → §6C, hosting phase |
| **Your background task** "Rebuild accounts whose only link to an unimported file is a period" | `9cd7acb`, merged in `14759a7` |

**Owner-visible behaviour that changed today** (nothing moves on your ledger until you act):
- Un-importing a statement whose rows another still-imported file prints keeps those rows, and keeps the opening
  balance the removed statement printed (labelled "from a statement you un-imported", never "checked").
- Un-import → re-import gives back your categories, notes, recurring links, splits, exclusions and transfer links.
- Un-importing a statement while a LATER statement of the same brokerage book exists is refused, naming the later
  month to remove first.
- The /imports confirmation now counts what is kept, what is detached and what is lost, honestly.

Session scratchpad (9ebfed64): `queue-after-merges.md` (the full queue with evidence), `hunt-result.json` +
`hunt-overflow-verdicts.json` (the one-caller hunt), `agentic-design.json`, the rehearsal copies and runbooks
(`agentic-real/`, `flamingo-real/`, `pairs-real/`, `mark-real/`, `redate-real/`), `crop-diffs.py`.
