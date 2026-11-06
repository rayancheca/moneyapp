# Handoff — round 4 merged, batches 8f–10b worked the LOW queue, five gated pushes

> Written 2026-11-06 (session 7bc70d19, started 2026-10-23 from `aa0bd72c`). Pushes this session: `2b4ed44e`
> (Oct 29, batches 7/7b) · `b86f4e88` (Oct 30, batches 8–8d) · `95cdf198` (Nov 4, 8f: round 4 of the billed-with
> pairing) · `66f568f8` (Nov 5, batches 9, 9b, 9c, 9d + 24 re-based) · `73890338` (Nov 5, 9e) · `b1ea1d83` (Nov 6,
> batch 10 minus NW-end, 10b + 16 re-based) — 146 commits, 364 files. Gate 622/622 at `b1ea1d83`; full unit 476 files /
> 10,518 at `ab19df9c` (the last code commit; the commit after it is PNGs). `pnpm ledger-check` 0 after every push.
> Session notes with every number: `work/handoff-draft.md` and the queue `work/batch8-low-queue.md` (L1–L177), both
> under `~/.claude/projects/-Users-rayankarimcheca-dev-MoneyApp/7bc70d19-82f1-4310-a115-e04395ecd3a7/work/`.

---

## 0. THE JOB — what is next, in order

1. **NW-end, round 3, then merge** (L79's option 2, ⚖️ built not asked: the net worth chart, its hover, its pills and
   the headline's change say they end on the last day the stored balances reach). Branch `uc/b10-net-worth-end-r2f1`,
   tip `69b27403`, from `73890338` — NOT merged. Its round-2 re-review: "No HIGH found; it can merge, with three
   MEDIUM follow-ups" — **L166** the thin-window refusal counts the chart's days, not the days the header's line has a
   value (Owed/Accounts views draw a window the same line alone refuses: an empty plot or a '• $0.00' change);
   **L167** naming the days measured only kicks in where `onSharedAxis` added empty leading days; **L168** the
   Accounts-view hover fix has no test that fails when reverted. Fix those RED first on top of main, re-review, then
   merge, read the dashboard on his ledger, gate (expect net worth / accounts baselines to move — read them as text
   first), push. ⚠️ This area failed review twice: the first approach (carry the last balance to today, batch 9b,
   branches `uc/b9b-net-worth-end*`) never converged, and round 1 of this one introduced two HIGH regressions. Its own
   LOWs are L169–L177. ⚖️ Its built default: the Owed and Accounts views end on net worth's own day (one day axis).
2. **Build the three recommended defaults the fixers left unbuilt** (he said no questions mid-run — build and list):
   **L89 (A)** in January every surface dates a matched pay row against today ("Dec 31, 2026"), not against the newest
   row; **L124 (B)** a drag RIGHT on the deck uncovers nothing (the card behind only shows while the drag goes toward
   the next card), so the deck never shows a card the gesture does not deliver; **L133 (A)** once the rent's own end
   has closed the rent day a carried day pairs with, that day falls due on its own day (owed sooner — the safe side).
3. **L140** (MEDIUM, a guard's reach, nothing he sees): the static gate in `src/lib/server-action-scan.ts` misses a
   form adapter bound through `onSubmit`, a button's `formAction` or a spread.
4. **When statements land** (Wells Fargo ~Nov 24 with three more paydays; the cards' October cycles; Chase Checking
   past Aug 12; SoFi past Jul 31; Robinhood past Sep): drop → `pnpm trial-import` → `pnpm import-statements --confirm`
   → `pnpm ledger-check` → `pnpm backup:statements`. ASK HIM ONCE before filing new unfiled card rows (decision 78
   covered the Oct-21 rows only; 2026-10-29's "File all 15" covered those 15 only); template
   `scripts/file-october-imports-2026-10-21.ts`. His pay now files itself at import (`fileImportedLinks`, 304c59a4).
5. **Read the running app on his ledger for visible defects** — the highest-yield check (memory
   `moneyapp-read-the-app-first`).
6. **The LOW queue** (§5). Converge: follow-ups only for HIGH/MEDIUM; LOWs go back in the queue.

## 1. HIS LEDGER

- **2026-10-29, authorized in his words ("File all 15"):** the Wells Fargo statement Sep 25 → Oct 26 imported (16
  rows, reconciled $6,817.95 → $3,521.92) and 15 unfiled rows filed — payroll ×5 attached to the weekly pay as
  Salary, the lease to Car lease, three card payments linked. Guarded write with a restore point.
- No other write by this session. ⚠️ **But the file changed on 2026-11-05**, and what wrote it is known:
  - 14:06:08 — `.githooks/pre-commit` runs `pnpm ledger-check` on `data/moneyapp.db` for every commit made in the
    MAIN checkout (my PNG re-base commit). By design (PASS 74); silent in worktrees (no `data/`).
  - 14:30:33 — a price refresh (`refreshPrices`; only the /investments "Refresh prices" button calls it) wrote 104
    price_cache rows (his 10 symbols, Oct 23 → Nov 5), two `live` anchors dated Nov 5 (Robinhood Brokerage $74,029.49,
    Robinhood Crypto $31,923.54) and 28 daily_balances rows for those accounts. Not this session or its agents (no
    server of mine was running; no agent touched /investments). His other session **"MoneyApp statements batches 4–6"**
    (Remote Control on, cwd the main checkout) was last active 14:28 — the likely source, his own use.
  - Checked: transactions identical to the Oct 29 copy (13,026 rows, sum −$6,894.16); only those three cache tables
    differ; ledger-check passes. Consequence: the dashboard now reads "Thu, Nov 5, 2026: $109,886.04 … measured to the
    closes stored for Nov 5".
- Read at Nov 6 (b1ea1d83's code): runway "A further $2,291.21 came due earlier this month and no statement has
  covered it yet" (rent $2,109.00 + what it carries $182.21, due Nov 1), 1.2 months of cash; Earned vs banked 23
  paydays Jun 4 – Nov 5, "$10,917.00 of it never reached an account the ledger reads; the other $2,283.84 is for
  paydays after Oct 26"; /budgets "$3,425.76 still expected", "12 of 12 budgets show no verdict … — 6 days each".

## 2. HIS ANSWERS AND THE DEFAULTS

One answer of his after 2026-10-29: **80** (2026-11-06, below) — he kept 55a (memory
`moneyapp-owner-decisions-2026-09-28` holds 21–80).

**⚖️ Built, not asked** (each marked so in its commit and code):
- 8d (A): an import FILES what it links to a series he confirmed (`fileImportedLinks`, source `confirmed_series`).
- E7 (B): each day of what a carrier carries pairs with the carrier's own day of that period — each rent payment pays
  that month's utilities. The calendar's "paid early" is measured against the day the grid draws. A carried bill reads
  "charges monthly around the 1st, due with the rent on the 16th"; its field is "Its own next date". The day a carried
  series STOPS is its last charge's fell-due day, on every reader (9b/9e).
- Batch 7 (A): Money in's pace ends at the last month every account its income habitually lands in is read through.
- Batch 9: `calendarWindowLabel` (a whole month/quarter/year window says its page label); every "never" pay sentence
  says what never reached **an account the ledger reads** (the card's positive "Reached a bank" row is kept — batch 10
  labels it "Reached an account the ledger reads" when nothing is banked); /imports names a filing on any live row;
  L26 (a) kept "no later import can undo that".
- Batch 9c: L20 (A) the /budgets note counts its dash rows and says why ("Of them, 2 have nothing found and not one
  elapsed day imported"); L24 (B) an over row whose line can rise by less than its overage keeps "no later import can
  undo that"; an import files a carried row he excluded as it files an active one (a gap-held row still waits).
- Batch 9d (A): a drag that has moved 10 px uncovers the card directly behind the front one (his 2026-08-27 ask); a
  step fades the new front in over 300 ms (none under reduced motion); a pointercancel never steps the deck.
- Batch 9b: L16 money back reads "toward no due day" and is not counted in the posted average; L15 (a) kept.
- Batch 10: L93 "…as is the percentage of one of them; more can still roll over into the other"; L98 a gapped run
  names every period; IMPORT item 12 (B) linking claims active rows only (an excluded row arriving with no link is
  neither linked nor filed).

**✅ His answer 80 (2026-11-06, "Keep it (55a)") — closed, do not re-ask:** a raise paid as its OWN same-day entry
beside the old rate (e.g. $1,141.92 + $58.08 every Thursday) reads "toward no payday" everywhere and shows on no
"amount changed" surface — and STAYS so. He chose (A, as built — his 55a) over (B, the fixer's pick: once two
consecutive paydays each hold the week to the cent plus an extra, read them as the day again — amber; Worth a look
"rose by $X" — a one-off like Oct 15's $200.00 staying quiet). Recorded in `weekBesideExtra`'s doc
(`src/lib/per-payday.ts`) and pinned by the per-payday test "a $58.08 beside the week four Thursdays running…" (it
fails if the week beside an extra is read as the day). Latent today. His payer already sends off-cycle money under a
second descriptor ("IT AMERICA LLC PAYROLL RAYANCHECA RAYAN CHECA").

**⏳ Still his call** (recorded in `landBack`'s doc): presses that return a value (runs, Undo cards, inline edits)
leave a shown refusal banner in place.

## 3. WHAT LANDED ON MAIN (`aa0bd72c..b1ea1d83`)

- **Batches 7/7b, 8–8d** (to b86f4e88): the LOW queue of 10-22, payroll recognized and filed at import, one rule for
  every "did not arrive" sentence (a row on the series' account within tolerance of THAT payday, to the cent, is
  NAMED, never counted paid — `unattachedMatchesBySeries`, `leftOutOf`), the budgets carry ceiling (`mayStillLapse`).
- **8f** (95cdf198): round 4 of the billed-with pairing merged with 8b–8d. The two sides met outside the conflicts: the
  one rule asked a bill's day on `date` (since E7, the day it FALLS DUE) — it now asks on `ownDate`.
- **Batch 9** (51 LOWs, 7 tasks) + **9c/9d/9e**: pay sentences, /budgets words and carry edges, imports and toasts, the
  deck after d27f4f8f, /recurring's page asks, the three owner-call defaults, the drag reveal (and a real phone bug:
  a vertical pan could step the deck), one stop day for every reader of a carried series.
- **Batch 9b** (27 LOWs): round 4's LOWs (L57 ended schedules, L74 the End dialog's span, L76/L77 month-end clauses,
  L80/L81 a carried day's own window), pay L72/L51.
- **Batch 10 + 10b** (54 LOWs + L139): ⚠️ **L139 MEDIUM fixed** — the runway's forward leg counted a carried charge
  on its own day, so between that day and the rent day it fell due with it sat in neither leg (owed money hidden from
  the runway); now counted on the day it falls due. Every unsettled `void X().then(…)` press settled; a refusal is
  shown once and Back never brings it back (`landBack`, every form adapter); a failed forecast keeps its own month's
  note; the pay words, the budgets note, the deck's edges, page asks, the carried-series docs.
- Baselines re-based, each read as TEXT first: 64 (b86f4e88), 24 (66f568f8), 16 (b1ea1d83).

## 4. OPEN — not merged or not converged

- **NW-end** (§0.1): `uc/b10-net-worth-end-r2f1` 69b27403, L166–L168 then merge.
- **L140** (§0.3).
- **The three unbuilt defaults** (§0.2): L89, L124, L133.
- Known limits, not queued: the one rule names a row only within tolerance of its day (a late row of a carried bill on
  the rent's day is not named — the same limit any bill has); the runway's split trusts the asks (unreachable).
- ⚠️ `pnpm test` (coverage gate, 100% on src/lib/**) exits 1 at a70538e5 (L146) — pre-existing gaps; the unit suite
  itself (`npx vitest run`) is green.

## 5. THE LOW QUEUE

Full evidence: `work/batch8-low-queue.md` (path above). Everything below L140 was worked by batches 8–10 (fixed,
no longer holding, or dropped with a reason: L3, L18, L22, L47, L106 "checked and found right — do not re-litigate"
(09-14), L126 a commit message, L134 re-based). Open, L140–L177:

**Batch 10b IMPORT-landback — 6 + 1 MEDIUM left after round 2**
- L140 ⚠️ MEDIUM (a guard's reach, not something he sees): A form adapter can still leave every gate through how its form is bound: onSubmit, a button's formAction, or a spread.…
- L141 Forecast failure: once the 5-second toast is gone, 'October 2026 has ended … the calendar below shows what actually posted' stands over November's grid
- L142 A view press that clears a refusal still comes back on one Back: same rule, a second kind of press the fix did not reach (existed before this commit; his call against B2)
- L143 e2e/error-banner.spec.ts still names the removed returnPath()
- L144 The commit message overstates what the review's mutation names: it says four page lines, and three are named
- L145 The new carve-out and the new adapter union can each be broken with all 57 targeted tests green
- L146 `pnpm test` (coverage, 100% on src/lib/**) exits 1 at a70538e5. The scan that got its own test file is still below the threshold, and its new export-stop paths are untest…

**Batch 10 PAY-words — 3**
- L147 Item 5 now says 'not attached to them' of a single row matched to a single bill, whenever the sentence adds up several bills (runway, budget row line and spoken text, Dea…
- L148 Item 9 is only half done: the stale verdict now says 'the other one' twice in one sentence, about two different paydays
- L149 Item 10's sweep missed some comments: several that describe current behaviour still say 'never reached a bank'

**Batch 10 BUDGET-words — 3**
- L150 L97 comment still misstates the exact half-percent boundary
- L151 L114's realistic fixture is not pinned: reverting it to 0 keeps every test green
- L152 Mutating the over headline's "<1" boundary to "<2" leaves two percents of headline unpinned

**Batch 10 IMPORT-flow — 7**
- L153 The un-import comment's measurement reads as 71 rows per file
- L154 Exempting `load…` from the press gate leaves the sheet's own load showing "Loading…" forever on failure
- L155 The landing gate finds adapters by the literal text `Promise<void>`, so an unannotated adapter escapes both landing tests
- L156 The gate checks that a form writes <RefusalShownField>, not that the page's refusal reaches it; AllSeriesView's optional `refusal` can be un-threaded silently
- L157 The P&L day sheet keeps saying 'Loading…' after its load failed, and the new test pins the open sheet without checking its body
- L158 The press gate's load exemption looks only one function up, so a load awaited through a helper slips past it
- L159 HookSlots now hides a transition rejection unless a later settle() runs; before, vitest failed the run

**Batch 10 DECK-polish — 3**
- L160 Tooltip.tsx:69-74 — handleToggle calls hide(), so the toggle from the tooltip's OWN hide can cancel a hover that began just after it (Popover's handler has an `&& open` g…
- L161 css-sources.test.ts:19-20 claims the app-alone compile leaves out 'a file in it that only a test reads', but it strips only *.test.ts, *.harness.ts and *.md — the six src…
- L162 CardDeck.test.ts:533-541 pins that one 400 ms swipe steps two cards ('named, not chosen') against the deck's recorded rule 'one swipe is one card' (batch 9 G), without a …

**Batch 10 PAGE-asks — 1**
- L163 moved() stops the redraw waiting on a press from before the Back, but that press can still land on a link made after the Back, so the page renders twice (a regression fro…

**Batch 10 E7-carried — 2**
- L164 The seventh shape's test name leaves out what makes it different (a rent detected on the 31st), so a failure looks like a rent typed on Nov 30
- L165 Pre-existing, outside 59374295..3819b49b: the car card's twelve months admit each day by the same rule, and no test pins that argument

**Batch 10 NW-end — NOT merged — 3 MEDIUM + 9 LOW**
- L166 ⚠️ MEDIUM (round 3 before the merge): The thin-window refusal counts the chart's days, not the days the header's line has a value, so the Owed and Accounts views draw a s…
- L167 ⚠️ MEDIUM (round 3 before the merge): Naming the days measured only kicks in where onSharedAxis added empty leading days: the same Wells Fargo change on the same pill rea…
- L168 ⚠️ MEDIUM (round 3 before the merge): The hover part of the Accounts-view fix has no test that fails when it is reverted
- L169 The Flow comment says its pills use the same windows as the chart, but they still count from today
- L170 One Oct 29 figure is named several different ways
- L171 The other dashboard views name a dragged window differently from the Net worth view and from their own Reset chip
- L172 Owed can silently take over the Split view, while the comments still say assets leads it
- L173 observedBalanceDays rebuilds the card's date separately, and no test ties the two
- L174 A carried-day test lost its cash-account check
- L175 Two golden-path screenshots move and are not updated on this branch
- L176 noValuePhrase cuts the screen-reader readout short with '+N more' and shows a no-statement day in the faint tone instead of the warning tone
- L177 Price charts are not untouched as the commit claims: a From/To typed on a weekend now shifts the header and both inputs to trading days, while the Reset chip keeps the ty…

## 6. ⛔ WHAT COST TIME

- **Agents died four ways, all recovered by RESUMING, not relaunching:** a network outage (Oct 30, ENOTFOUND), an
  expired login (Nov 4 ~17:30, 401), the Mac sleeping on battery overnight despite `caffeinate -i` (Nov 4→5 and 5→6:
  "Connection lost while your computer was asleep"), and another DNS outage (Nov 5). The recipe (memory
  `moneyapp-durable-gotchas`): list each run's `failed` journal entries, remove the dead agents' rv-*/wf_* worktrees
  and the fixer's branch, then `Workflow({scriptPath, resumeFromRunId})`. Embed the args in the script so prompts
  stay byte-identical. A dead fixer with partial work: rename its branch `-wip-0`, save its diff, add a "§0 An
  interrupted run" to the brief FILE (the prompt only names the file, so the resume still caches). **Before a night
  run, the Mac must be on power with the lid open.**
- **A fix that will not converge:** NW-end took two approaches and four review rounds. Dropping it from the round and
  shipping the rest kept main moving; give such an item its own small batch.
- **macOS cleans /tmp:** the OCR text-diff tool vanished from the scratchpad. It lives in `work/tools/` now (`ocr`
  reads a tall page in 900 px tiles and drops tile-edge lines; `textdiff.py` diffs lines; `tokendiff.py` counts words
  order-free — use it when a longer sentence makes the page taller and every row below shifts).
- **The pre-commit hook writes to his ledger** when a commit is made in the MAIN checkout (`pnpm ledger-check`;
  witness marks, rarely). Commit PNG re-bases there knowing it.
- I typed a full sha from memory once (`7389033842c3…`); the builder caught nothing — copy shas from `git rev-parse`.
- zsh: `=====` at the start of a word is a command lookup (`echo "----"` instead); a command the safety check cannot
  parse (`${(f)T}`) is refused — use Python for read-only DB work (`sqlite3` with `?mode=ro` / `?immutable=1`).

## 7. ENVIRONMENT

- macOS 27.2; the gate on :3111 takes ~9.3 min (622 tests); his dev server `moneyapp-dev-3000` was left STOPPED.
- `.claude/worktrees/integrate-1104` (uc/integrate-1104) = main at `ab19df9c`+PNGs. Batch branches `uc/b8f-*`,
  `uc/b9-*`, `uc/b9b-*` … `uc/b10b-*`; the unmerged ones are `uc/b10-net-worth-end*` (round 3 here) and
  `uc/b9b-net-worth-end*` (the abandoned first approach; its WIP diffs are in `work/batch9b-wip/`).
- His other session "MoneyApp statements batches 4–6" (Remote Control) works in the main checkout too.
- Workflow scripts: `workflows/scripts/batch10-low-queue-2026-11-05.js` is the latest template (args embedded,
  `fix → review → follow-ups ×2 → re-review ×2`, `stillOpen` for the orchestrator).
