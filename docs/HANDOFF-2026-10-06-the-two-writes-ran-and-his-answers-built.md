# Handoff — the two ledger writes ran, his answers 30–44 built, the press race fixed

> Written 2026-10-06 (session 2a7bb5b7, 10-05 → 10-06). `origin/main` = this handoff's commit. Since `e578461`:
> six fix → skeptical-review → follow-up rounds over twelve branches, then integration. Unit **368 files / 7,529
> tests** · e2e **614 passed** at `maxDiffPixels: 0` on the final tree (lid open, `caffeinate -i`, renderer check
> on; no baseline moved; one earlier gate's single failure was load, §4) · `next build` ✓ · tsc ✓ · `pnpm ledger-check` exit 0 (pre-commit hook).
>
> His ledger was written **four times**, each guarded, each with its own restore point (§2): 13 accounts · 10,328
> active rows · **25 migrations** (0024 `left_out_acknowledgements`) · net worth **$119,999.32** (2026-10-02, the
> ledger's latest valuation day) · witness marks 43 · 222 · 212 · 256 · 13, unchanged.

---

## 0. THE JOB — what is next

1. **The queue** (§6C). Nothing is waiting on him except §6A's open wording questions, all latent.
2. **Waiting on events** (unchanged): the next Chase statement past 2026-08-12 (it pairs the two "Zelle From Rayan
   Karim Checa" rows on Wells Fargo: $1,529.73 on 08-31, $700.00 on 09-01); the next Wells Fargo statement (weekly
   payroll $1,141.92 from It America LLC — settle-backwards and the fourth figure will meet it); the next Robinhood
   statements (Cash's open run since Sep 1; Agentic, Brokerage, Crypto closed 6 days ago, not imported).
3. **Optional tidy-up, measured, not run:** `migrateStorageLayout(db, { move: true })` would now place the 34 originals
   that only retired reads name (§6C institution branch): on a copy it moves 24 originals (48 retired reads)
   `robinhood-cash/` → `robinhood-combined/`, beside their live reads, plus 7 moves main already planned; 0 left
   unplaced. It moves files in `data/statements/`, nothing in the ledger's money. ⛔ Dry run on a fresh copy first.

## 1. WHAT LANDED (all pushed)

### 1a. His answers (each RED first, reviewed, every HIGH/MEDIUM fixed)

| answer | what he sees | notes |
|---|---|---|
| **§6A 30** a left-out line can be acknowledged | `pnpm ledger-check --acknowledge-left-out=<mark> --reason='<what was read on the statement>'` (dry run) then `--confirm`; ledger-check keeps listing the line ("Acknowledged on <day>: <reason>") and stops failing; /imports and the upload outcome say the same | table `left_out_acknowledgements` (migration 0024, CHECK reason not ASCII-blank; the writer also refuses Unicode/zero-width blanks); keyed by account, day, amount, printed words and the printing file's sha256 — never a row id; one acknowledgement per line (Kuhn matching, own mark first); a different `--reason` for an acknowledged line is refused. Latent: 0 left-out lines today |
| **§6A 33** a count-only account's popovers are dated | Cash on Hand: the balance popover, "1 transaction landed" AND a single row's sheet all read "The date it is checked through, Aug 10, 2026, is the last day Cash on Hand rests on the balance you counted on Aug 3, 2026 — your word, not a check." — checked in the running app 2026-10-06 | one verb, **"counted"**, for a balance he typed (statement balances keep "recorded"); a day before a count reads "replayed backwards"; a typed-balance account that BREAKS bounds every date the day before it broke: "…is the last day before X stopped adding up on <day>; until then it rests on the balance you counted on <day>" (latent) |
| **§6A 34** the agent's costs are not his | /spending's Spent, the Fees card, /budgets, category and merchant pages, forecast pace and the Sankey leave out any fee or expense the agent's cash pays — and its UNFILED money out; the bridge names it on its own band **"Agent's costs"** beside "Agent's income" | one classifier `isHisExpenseRow` / `isHisUnfiledSpending` (analytics.ts); /categories/<Uncategorized> and the dashboard's "N uncategorized" KEEP the agent's unfiled rows (session decision: a filing queue, not Spent). Latent: the agent holds one $26.64 transfer |
| **§6A 35** days before a first balance don't grade an account | Robinhood Agentic graded **verified**: /imports "2 accounts nothing is checking", net worth "2 have nothing checking them"; its line reads "adds up through Aug 31, 2026, and unchecked days before that"; its "26 days unchecked" is quiet (faint), not amber — checked in the running app | the trust card's footer leaves EVERY account's days before its first balance to the note (`66703b2`: it had counted Robinhood Cash's Dec 2023 days as "rest on nothing": "42 … 41 in Robinhood Cash" → "16 … 15 in Robinhood Cash"); a verified card's note in "what you owe" is quiet and never repeats its row's date |
| **§6A 36** | /imports keeps "replayed backwards from it, with nothing earlier to check them against" | — |
| **§6A 37** | a verified card's "what you owe" note reads "unchecked days before its first balance" | kept as built (latent) |
| **§6A 38** | the trust card's footer: the amber sentence says only what rests on nothing; "8 days of balances rest on a balance you counted — 8 in Cash on Hand — your word, not a check." is its own faint line | `TrustDays.countedNote`; never depends on another account's days |
| **§6A 39** | a scheduled credit to the agent's cash is named by its category, as the bridge names its row (a Fees refund nets inside "Agent's costs"; an income-category credit stays "Agent's income") | one resolver for a series' category, shared by the forecast, the series page and the calendar hue (a filed row outranks unfiled ones). Latent |
| **§6A 41–42** | kept as built: the trust card's "None of N days of balances rests on nothing, and none fails to add up."; an unfiled scheduled credit to the agent stays "Agent's income" | — |
| **§6A 43** | a clawback filed in an INCOME category on the agent's cash LOWERS "Agent's income" — on the bridge (it used to sit in "Moved") and in the forecast (it used to net in costs); the card says so when a month nets negative | one rule, `agentsBand` → `isAgentsIncomeCategoryRow`; EOM net worth unchanged. Latent |
| **§6A 44** | a view press clears a stale `?error=` banner (as /recurring's tabs did) on /recurring, /investments, /accounts, /accounts/[id] | one list of one-shot params beside `pressBase` |
| **§6A 40** | the period arrows ‹ › (and /recurring's tabs) keep a view only the URL held, building on the page's newest asked URL so a press in flight is never undone | browser test fails on the old src |

### 1b. §6C defects fixed

| defect | what changed |
|---|---|
| **the in-flight press race** (reverted `555a4ef`) | ONE newest-asked view per PAGE (`src/lib/page-asks.ts`, provider in the root layout; Next's `onRouterTransitionStart` via `src/instrumentation-client.ts`): two pills pressed before either lands both take; a same-page link followed while a press saves lands with the press; a press keeps every other switcher's URL-held view (a shared `/?chart=bridge` survives a cards press) and never saves it; **Back/Forward re-saves the view the page he returns to drew from his preference** (his B2) and the views his own presses put in that URL — never a shared link's. Harness: real React 19.2.7 + a port of Next 16.2.10's action queue (`src/hooks/useViewState.harness.ts`); new browser tests in `e2e/zz-zz-view-switcher.spec.ts` (each fails on the old src) |
| **`import_files.institution_id` was a guess** | the importer records the bank of the accounts a read resolved (`institutionReadBy`); a retired read with no records goes by the live read of its bytes; backfill run on his ledger (§2) |
| storage layout | an original only retired reads name is placed by the live read of the same sha256 (`readsInPlaceOfRetired`) — code only, see §0.3 |
| /summary's gambling block | names "What you spent" only when that figure is on the page; reads Lost over the same window on a running year; no loss prints "$0.00", never "−$0.00" |
| the Chase re-drop probe | `worthOnEveryDay` (`bba44d3`): compares net worth on every day the ledger had; days a re-read carries past its last must hold that worth |

## 2. ⛔ REAL-LEDGER WRITES — four, all guarded (dev server stopped, lid open)

| write | restore point (data/backups/) | result |
|---|---|---|
| §6A 26 re-read the 34 unrecorded files | `pre-2026-10-05T124024-reread-unrecorded-files.db` | WRITTEN PASS: 34 read again, 62 printed-line records, nothing else; "Nothing to do"; ledger-check 0 unrecorded |
| §6A 23 pin the 3 Fordham aid deposits | `pre-2026-10-05T124045-pin-fordham-aid.db` | APPLIED: `Income › Financial Aid`, source `user` |
| §6A 23 staged Chase re-drop (75 PDFs from a scratch folder) | `pre-2026-10-05T124332-manual-backup.db` | 75 parsed, 1,536 superseded/inserted, active 10,328 → 10,328, archive still 76, 0 failed; probe "ONLY THE MARGIN IDS MOVED" (13 → 0); the pin travelled; ledger-check byte-identical |
| migration 0024 (applied on the next open) | `pre-2026-10-06-migration-0024.db` | 25 migrations |
| §6C institution backfill | `pre-2026-10-06T112308-record-read-institutions.db` | 213 reads Chase → their bank (Capital One 3, Discover 29, Robinhood 44 + 100 retired, SoFi 34, Wells Fargo 3); "NOTHING TO DO"; ledger-check exit 0 |

## 3. ❓ HIS ANSWERS (closed — do not re-ask)

Memory `moneyapp-owner-decisions-2026-09-28` (second and third batches). 2026-10-05/06: 35 days before a first
balance don't grade an account (header 2) · 36 keep the words · Agentic's line "adds up through …" · a verified card's
caveat is a quiet note · the trust card's count beside a verified account is quiet · the agent's UNFILED outflows are
out of his Spent · a press he walked away from with Back keeps its save, and Back re-saves (B2) · one verb "counted" ·
a single row's sheet is dated · a broken count bounds the day before it broke.

## 4. ⛔ WHAT COST TIME, AND WOULD AGAIN

- **Turbopack refuses a `node_modules` symlink that points outside the project** ("points out of the filesystem
  root"): an integration worktree under the scratchpad cannot `next build`. Build and gate from the main checkout
  (ff local main to the integration branch, gate, then push) — workflow worktrees inside `.claude/worktrees/` build.
- **`git checkout -- <file>` to undo a mutation erases the whole uncommitted change.** `cp` a backup first.
- **The session was cut off mid-question** (2026-10-05); the answer was lost. Re-ask; never assume the recommended one.
- **Every fix → review round found another layer** (four rounds). Converge by sending only HIGH/MEDIUM to follow-up
  fixers and listing LOWs here (§6C), not by a fifth round.
- **The last gate (answers 38–40) read 612 passed, 1 failed** — `zz-zz-intraday.spec.ts:54`, the 5 s wait for "Today's
  session loaded" after the server action; the load average was 12.5 (two Unreal Editor processes at ~180% each and
  `mediaanalysisd` at 104% — his, not ours). That spec file passed 8/8 alone on the same tree; nothing in the round
  touched it (SessionNote, refreshIntraday). The next gate, on the final tree, passed 614/614 under the same load.
- A reviewer's `pnpm install` in a worktree re-ran `prepare` (`core.hooksPath`); it stayed correct. Tell agents not to
  run `pnpm install`.

## 5. ✅ CHECKED AND FOUND RIGHT (in the running app on his ledger, 2026-10-06)

/imports header "2 accounts nothing is checking"; dashboard "2 have nothing checking them, 1 is empty"; trust card:
"Robinhood Agentic — adds up through Aug 31, 2026, and unchecked days before that", "26 days unchecked" in
`text-ink-faint`; Robinhood Cash "nothing checks it since Sep 1, 2026 · 15 days unchecked, of 41 in all"; the footer
"16 of 7,812 days of balances (0.2% of them) rest on nothing — 15 in Robinhood Cash, 1 in Cash on Hand. No day
provably fails to add up …" (since §6A 38 the counted days are their own faint line, read on a copy of his ledger by
the reviewer: "8 days of balances rest on a balance you counted — 8 in Cash on Hand — your word, not a check.") and the
note "52 days before an account's first balance are unchecked — 26 in Robinhood Agentic, 26 in Robinhood Cash —
replayed backwards from it, …"; net worth $119,999.32; Cash on Hand's three popovers dated as in §1a.

## 6. ❓ THE QUEUE

### 6A. Questions for him (latent; nothing ships until asked)

✅ 30–44 answered and built (memory `moneyapp-owner-decisions-2026-09-28`, five batches).
45. The forecast's "at your recent pace" figure for the agent's income counts only money IN, so a clawback that
    already posted (in an income category, no schedule) lowers the bridge's "Agent's income" (§6A 43) but not the
    pace projection: $4.00 paid and $3.00 clawed back monthly reads +$1.00 on the bridge and +$3.48 projected. His own
    income pace also counts money in only. Net the agent's pace too, or leave the pace as money in? (Moves the pace EOM
    net worth.)
- Older: §6A 1–14 of the 09-15b handoff still have shipped defaults.

### 6C. Defects / leftovers queued (each LOW, latent on his ledger unless said)

- §6A 30: a mark whose acknowledged lines carry two reasons accepts either (dry run names the first); `reasonSaysNothing`
  lets C0/C1 controls and U+2800 through; the de-dup key's day is untested; the partial-mark output says "with
  another reason" beside the stored one.
- §6A 33: the "Record a balance" form, "No balances recorded yet", the remove-balance dialog and the "you entered it"
  badge still say record/entered (session decision: control labels, not sentences); a count-first account re-checked
  by a later statement keeps the statement's date (session decision, by §35's logic).
- §6A 34: /spending's partly-imported empty state and /categories/[id]'s measured-zero sentence don't mention the
  agent's money; /merchants/<id> still names the agent's series as a billing cadence.
- Press race: ‹ › can still undo a press when a non-press link dropped the ask first; the page-asks header comment
  still says any link drops the ask; Back's re-save is judged per URL, not per history entry; a range pill pressed within milliseconds of
  Back's save may draw the old view; Back does not save `accts`.
- A read whose statements are at two banks keeps the guessed bank (none exists).
- §6A 43: /spending's empty state does not count the agent's income-category clawback as the agent's money; a test
  fixture creates Agentic as plain `checking` (his ledger: investable) so its EOM cash moves with the agent's balance.
- §6A 44: the 'in flight' unit test does not test a press made in flight.
- Four old worktrees hold uncommitted edits from agents that died on 09-15 (`wf_713fcba7-8e4-11`
  uc/investments-today-labels, `wf_31beb6c9-c14-1` uc/budgets-wallets-out, `wf_31beb6c9-c14-2`, `-3`, and
  `wf_39db326f-919-3`); every commit of theirs is on main. Read before deleting.
- Hosting phase: `next build` warns that `migrateStorageLayout`'s `path.join(statementsRoot(), …)` traces 12,942 files.

## 7. ENVIRONMENT

- macOS 27.2 Beta 2 (26B5091g); the renderer canary matched on both gates.
- Keep the lid open for a gate; run it with `caffeinate -i`.
- Workflow agents: one defect per prompt, ≤900 chars of evidence, "start with a tool call within a minute", own branch,
  no `pnpm install`; a reviewer per branch; follow-ups only for HIGH/MEDIUM.
