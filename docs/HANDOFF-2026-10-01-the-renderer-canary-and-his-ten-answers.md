# Handoff — the renderer canary, his ten answers built, and two ledger writes ready to run

> Written 2026-10-01 → 10-02 (session ca78faab, 09-28 → 10-02). `origin/main` = this handoff's commit · **66 commits**
> since `c3b9a59` · unit **353 files / 7,162 tests** · e2e **602 passed** at `maxDiffPixels: 0` (8.5 min, lid open)
> with the renderer check on · `next build` ✓ · tsc ✓ · `pnpm ledger-check` exit 0 (the pre-commit hook).
>
> His ledger was **not written** this session: 13 accounts · 10,328 active rows · 24 migrations · net worth
> **$119,958.63** on the dashboard (2026-10-01, latest balance of each account) · witness marks 43 · 222 · 212 · 256 · 13.
> The previous handoff (`docs/HANDOFF-2026-09-15b-the-queue-drained.md`) still holds §2's ledger-write history and the
> older §6A 1–14.

---

## 0. THE JOB — what is next

1. **Run the two guarded real-ledger writes his 2026-09-28 answers asked for.** Both are built, reviewed and rehearsed
   on byte copies of his ledger. Stop the dev server first, run them one at a time, `pnpm ledger-check` after each.
   ⚠️ They were not run here: on 2026-10-01 a response was stopped by a safety check before it finished, and the step
   was not retried. Nothing was written.
   - **§6A 26 — re-read the 34 files so their printed-line records exist** (`scripts/reread-unrecorded-files.ts`; its
     header is the runbook):

         pnpm tsx scripts/reread-unrecorded-files.ts --db=data/moneyapp.db             # dry run: must read PASS
         pnpm tsx scripts/reread-unrecorded-files.ts --db=data/moneyapp.db --confirm   # one transaction, own restore point
         pnpm tsx scripts/reread-unrecorded-files.ts --db=data/moneyapp.db             # "Nothing to do"
         pnpm ledger-check                                                             # names 0 unrecorded files

     Rehearsed 2026-09-29/30: 34 files read again, 62 printed-line records, **nothing else** — net worth $119,958.63 and
     /summary's 2026 return 36.34% identical, every row, period, balance and citation identical; `--confirm` WRITTEN
     PASS; a second run "Nothing to do"; a `kill -9` mid-write is found and put back.
   - **§6A 23 — pin the three Fordham aid deposits, then the STAGED Chase re-drop.** The runbook is the header of
     `scripts/pin-fordham-aid-2026-09-28.ts`. ⛔ Never `pnpm import-statements data/statements/chase-checking-3522`
     directly: it re-archives 75 duplicate PDFs and leaves a FAILED import on /imports. Expected (rehearsed): 13
     descriptions lose the margin id and keep every other word, 0 categories move, net worth identical, the three
     Fordham rows stay `Income › Financial Aid`, 0 statement citations move (25 would have before `2a93c66`).
2. **Build his three new answers** (§6A 30, 33, 34 — decided 2026-10-02, not built): acknowledge a left-out line;
   date a count-only account's balance popover; leave the agent's costs out of his spending.
3. **The queue** (§6C).
4. **Waiting on events:** the next Chase statement past 2026-08-12 (it pairs the two "Zelle From Rayan Karim Checa" rows
   on Wells Fargo: $1,529.73 on 08-31, $700.00 on 09-01); the next Wells Fargo statement (weekly payroll $1,141.92 from
   It America LLC — Oct 1 is a Thursday payday; settle-backwards and the new fourth figure will meet it).

## 1. WHAT LANDED (all pushed)

### 1a. The gate says so when the Mac's renderer moves (his either/or: keep rendering on his Mac)

| what | evidence |
|---|---|
| **A renderer canary in `e2e/global-setup.ts`**: a frozen page (Geist Sans/Mono from the files the app ships, the display stack, SVG text, shadow, grain) drawn before seeding; a gate STOPS in ~0.4 s when its pixels differ from `e2e/baseline-renderer.json`, naming what moved | recorded 2026-09-29: macOS 27.2 (26B5091g) · chromium r1228 · Playwright 1.61.1 · canary `2ce694d7efb7`; deterministic 36/36 under load; Chromium r1217–r1234 all draw it identically |
| **`pnpm e2e:rebase-renderer` [`--confirm`]**: control run of the whole suite into a scratch root → every baseline judged → any "content" refuses → re-bases ONLY what the gate's own comparator fails → verify gate → writes a commit message, never commits | first live run: control 602 ✓; 109 identical / 93 renderer-only / 0 content; nothing copied, record only (`d019373`); a second run "Nothing to do" |
| **The judge** (`scripts/e2e-renderer/diff-verdict.ts`: ink-fine, ink-coarse, ink-lone, ink-tone) | calibrated on real history: c3b9a59's 111 drift pairs all renderer-only (1.74x under a limit); 242 real UI changes all content (≥1.85x over); 164 synthetic edits — swapped digits, 1-px shifts, a comma for a period, faint text re-toned — all content (≥1.72x) |
| three skeptical reviews → 15 HIGH/MEDIUM fixed | a failed restore no longer leaves a red re-base; SIGHUP/SIGKILL found by a mark in `.git`; only a pushed TIP counts as gated; a Geist upgrade is a UI change, never drift |

⚠️ Facts this turned up: **the gate is not pixel-exact** — `maxDiffPixels: 0` still passes pixels under Playwright's
0.2 YIQ threshold and anything pixelmatch calls anti-aliasing (why 91 baselines survived the OS upgrade, and why 93
pre-27.2 drawings stay committed). **Headless Chromium draws `--face-display` in Iowan Old Style**, not New York.

### 1b. His answers and three queued defects (each: fixer → skeptical reviewer → follow-up, RED first)

| item | what changed | branch |
|---|---|---|
| §6A 21 loud dropped line | a line a re-read leaves out that a still-imported file prints is named in the upload outcome, on /imports and by `ledger-check` ("lines left out by a re-read: 0" today) — never added back on a guess | uc/loud-dropped-line |
| §6A 27 agent income out | one classifier `isIncome(idx, agentsCash, …)` behind /spending, the Sankey, /budgets (posted, forward legs, basis), the forecast's pace row and the `flow=in` drill-downs; the net-worth bridge names "Agent's income" (dimmed $0.00 today) | uc/agent-income-out |
| §6A 28(3) typed-total date | a summed total resting only on his count prints the day the count stops standing, in net worth's words (`footingBounds`, shared with "what you owe") | uc/typed-total-date |
| §6A 29 fourth figure | /budgets names a payday another month's money paid ("paid early, by the deposit of …") and, mirrored, money in so far that paid another month's payday — the figures add up to the month's schedule | uc/early-pay-figure |
| witness floor | a witness that LEFT fails whatever the count does (a swap no longer passes; a raise never erases one); arrivals join a failing mark | uc/witness-floor-set |
| storage layout | `migrateStorageLayout` moves an original with every read of it and files a copy by the accounts it prints | uc/storage-layout-scope |
| empty book | `removeEmptyBooks` deletes the records naming an empty book in its own transaction; a statement anchor leaves with the file holding its period (`removerOf`) | uc/empty-book-fk |
| §6A 23 runbook | `scripts/pin-fordham-aid-2026-09-28.ts` + `probe-chase-redrop.ts` (pairs lines by their own words; passes only the margin id leaving) | uc/chase-redrop-runbook |
| §6A 26 runbook | `scripts/reread-unrecorded-files.ts` (one transaction, journal, kept restore point, archive-root guard) + **an importer change**: a re-read keeps each balance citing the statement it cited, second downloads included (`reread-citations.ts`, `2a93c66`) | uc/reread-34-runbook |

### 1c. Round 2026-10-01 — seven queue items (each: fixer → skeptical reviewer → every finding fixed, three per follow-up)

| item | what changed | branch |
|---|---|---|
| the archive is not a source | `pnpm import-statements` and `pnpm trial-import` refuse a folder inside, equal to or holding an archive (real paths: symlinks, `/var`, case) and any file named as the archive's own copy (`<sha16>-<name>` of its own bytes) — also refused at the /imports upload; the refusal prints the staged recipe | uc/import-refuses-archive |
| the calendar asks settlement | /recurring's calendar takes a payday's payer from settle-backwards (the answer /budgets reads): one deposit no longer chips two paydays; each day's figure is its marks' settled money (`flowEntryOf`), so a cell, its heat and the Day Sheet's "Day total" match the strip; a pay row dated after today is not drawn; the Upcoming tab, the dashboard's "before your next paycheck" and a series' next dates drop a payday a deposit already paid | uc/calendar-follows-settlement |
| the agent's income, everywhere | the /recurring strip and grid, the income card's pay lines, the Upcoming chips, /categories/<income> and the Fees card leave the agent's income out (latent: none exists) | uc/agent-income-recurring |
| "what you owe" in net worth's words | a counted card's caveat reads "you counted it on …, and nothing checks it since …" (`countedDetail`, net worth's own sentence); an unverified card's open-run caveat now uses net worth's verb, "nothing checks it since" | uc/owed-caveat-counted |
| one live-file rule | `LIVE_FILE` had NINE spellings in 7 files — one home in `src/db/schema/imports.ts` with a source-scan guard | uc/live-file-one-home |
| no original in another bank's folder | an original no read places goes to `_unfiled/` and stays put (the importer used to file it under a guessed bank, Chase for 180 of 241 reads in another bank's folder) | uc/storage-layout-no-wrong-bucket |
| the two slider flakes | test-only: `pressView` + `delayServerActions` make each restore prove its press landed; :472 now reports what it opened on (its one failure is still unexplained) | uc/chart-slider-flakes (d65316a) |

⛔ **Reverted (`555a4ef`):** that fixer's follow-up also changed `useViewState` so a press made while another is in
flight builds on it. A second reader found a narrow regression (Back/Forward during an in-flight press resurrects the
view he left) and that the same lost press survives across two hook instances on /spending and other URL writers on
/investments; the first gate it met failed `zz-zz-view-switcher.spec.ts:98` in that code. Queued (§6C).

Owner-visible on his ledger: /recurring's calendar on Jun 4, Jun 5, Sep 3, 10, 17 and 24 (Sep 24 shows the payday the
Sep 23 lump paid and the Sep 24 deposit "toward the payday of Aug 20"; the Day Sheet says "$X counted on this day").

### 1d. Round 2026-10-01b — five leftovers the reviewers named

| item | what changed | branch |
|---|---|---|
| /imports' coverage row, LIVE | Robinhood Agentic no longer reads "closes … through Aug 31, 2026; the first day it does not is Jun 4, 2026": it now reads "closes to the cent through Aug 31, 2026 (31 days ago); the 26 days before its first balance, on Jun 30, 2026, are unchecked — replayed backwards from it, with nothing earlier to check them against" (`beforeFirstBalance`, one reader shared with net worth's line). The other 12 rows are unchanged | uc/imports-coverage-first-day |
| a checked card's caveat | "nothing checks it since …" dates from `uncheckedSince`, in net worth's words (his three cards: byte-identical today) | uc/card-caveat-unchecked-since |
| the All tab's Next | /recurring?tab=all and the next dates beside it drop a payday a deposit already paid early (`stillToCome`) | uc/all-tab-next-asks-settlement |
| strip = forecast | the calendar strip's "as scheduled" and the Upcoming net leave transfer-kind series out, as the forecast card's net does (his ledger has none) | uc/strip-transfers-match-forecast |
| one LIVE_ROW | `LIVE_ROW` has one home with a source-scan guard; the single-status `"parsed"` checks use `isLiveFile` (his ledger: 0 `parsed_with_claude` files) | uc/live-row-one-home |

8 `dashboard-grid` baselines re-based for the owed card's new "…except 1 that is newer" (`ed4850b`): every diff cropped
first — six are that sentence; at 768 px it wraps a third line and the page grows 9,084 → 9,104 px (one change).

## 2. ⛔ REAL-LEDGER WRITES — none this session. The two ready ones are §0.1.

## 3. ❓ HIS ANSWERS, 2026-09-28 (closed — do not re-ask)

Memory `moneyapp-owner-decisions-2026-09-28`: keep the Mac renderer · 21 make it loud · 22 leave the budgets (the
handoff was wrong: they total $4,914.56; October reads "$33.76 left to allocate") · 23 clean, but pin the three Fordham
aid rows first · 24 first file wins · 26 re-read, keeping every category · 27 the agent's income out, the bridge names
it · 28 keep (1) and (2), (3) print the day · 29 a fourth figure.

## 4. ⛔ WHAT COST TIME, AND WOULD AGAIN

- **Two gates ran for 8.0 h and 9.5 h** and failed 46 and 51 — every one a timeout, zero pixel mismatches: the lid was
  closed on battery ("Maintenance Sleep" every ~15 min, 97 sleeps on 09-30). `caffeinate -i` and the app's keep-awake
  beat idle sleep only. Check `pmset -g log` and `AppleClamshellState` before believing a long gate.
- **The session was cut off mid-workflow** (09-28 16:37). Recovery: read each journal (`type: started` vs `result`),
  save a dead agent's uncommitted diff as a patch, clean its worktree, re-run only what never finished.
- **A follow-up stage that took `findings.slice(0, 4)` dropped three** — one was a real hole (holding events re-filed
  under another statement would have passed as "only records"). Chunk every finding, three per fixer; log any cap.
- **The re-read's importer change needed two review rounds**: 106 of his 266 statement balances cite a SECOND download,
  which the first cut could not keep — and it would have silently moved 25 Chase opening-day citations in §6A 23.
- The first gate on the merged main failed 6 interactive specs at 15–18 minutes each while `photolibraryd` ran at 78%:
  load, proved by the clean re-run.
- **A follow-up fixer's APP change that no gate had seen** (`useViewState`, ten surfaces) rode in on a test-only flake
  fix. Its first gate failed in that code; a second reader found a regression; reverted. A fixer's change outside its
  ask needs its own reviewer before it merges.

## 5. ✅ CHECKED AND FOUND RIGHT

- On his ledger in the running app (2026-10-01): the bridge legend reads "Agent's income — $0.00" beside "Income
  +$45,937.98"; /budgets October reads "Budgeted $4,914.56 of $4,948.32 expected income · $33.76 left to allocate ·
  $0.00 in so far, $5,709.60 still expected from It America LLC (weekly pay)".
- The kept-transfer-leg defect (`claim` in `unimported-transfers.ts`) was already fixed on main: the transaction-day
  lens runs first and the posted-day lens refuses a contradicting day.

## 6. ❓ THE QUEUE

### 6A. Questions for him

✅ **30–34 ANSWERED 2026-10-02 (all recommended; memory `moneyapp-owner-decisions-2026-09-28`, second batch):**
30. a left-out line — ALLOW AN ACKNOWLEDGEMENT: after a session reads the line on the statement it records it
    acknowledged (like the witness floor's `--lower-marks … --confirm`); ledger-check keeps listing it but stops
    failing. ⏳ **To build.**
31. the three Discover dedupe keys — LEAVE them (a future download prints the same back-dated date and matches by key).
32. a payday paid early by last month's deposit reads "paid early" from the day itself — as shipped.
33. a count-only account's balance popover — DATE IT too, in net worth's words. ⏳ **To build.**
34. the agent's COSTS — LEAVE THEM OUT too (not his spending on /spending's Spent or the Fees card; the bridge names
    them). ⏳ **To build.**

Still open, new from round 10-01b (his calls; nothing ships until asked):
35. Robinhood Agentic is graded "unverified" only because of its 26 days before its first balance, so /imports'
    header says "3 accounts nothing is checking" and net worth says "3 have nothing checking them" — although its
    balance rests on three reconciled statements. (a) prehistory alone does not make an account "nothing is
    checking", or (b) keep the grade and word the header differently.
36. The new /imports words for those days — "replayed backwards from it, with nothing earlier to check them against"
    — first UI text for them; keep, or his own words.
- Older: §6A 1–14 of the 09-15b handoff still have shipped defaults and were not put to him this session.

### 6B. Waiting on an event — §0.3.

### 6C. Defects queued

- **The in-flight press race (reverted fix, `555a4ef` says why).** One "newest asked view" per PAGE, not per hook
  instance (/spending's CashFlowView + CategoryMassif; /investments' ChartFocus range and BenchmarkPicker), plus a
  guard that drops it when the server state moved under it (Back/Forward). Verify in a real browser, not jsdom.
- `import_files.institution_id` still stores the importer's guess (Chase for 180 of 241 reads in another bank's
  folder); nothing reads it outside tests. 34 originals (66 retired Robinhood reads) are now reported unplaced by the
  storage migration — whether to place an original by the live read of the same bytes is open.
- 33 Robinhood rows were recorded on 2026-08-28 under their own sha-prefixed names (archived `<sha>-<sha>-<name>`);
  the importer keeps accepting that shape so re-reads work.
- ⛔ Do NOT run `migrateStorageLayout(db, { move: true })` on the real ledger before a measured dry run on a copy.
- Two runbook runs at once on one ledger can collide (documented in its header): run one write at a time.
- Hosting phase: `.next/server/instrumentation.js.nft.json` still lists 1,258 `data/` files.

## 7. ENVIRONMENT

- macOS **27.2 Beta 2** (26B5091g). After any macOS or Playwright update the gate stops in ~0.4 s with what moved:
  `pnpm e2e:rebase-renderer` (dry run), then `--confirm`. Never re-base by hand again.
- Keep the lid open for a gate; run it with `caffeinate -i`.
- Workflow agents: one defect per prompt, ≤900 chars of evidence, "start with a tool call within a minute", own branch.
