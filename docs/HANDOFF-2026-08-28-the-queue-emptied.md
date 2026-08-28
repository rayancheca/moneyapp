# Handoff — the queue emptied, and an arbiter that fired before it was finished

> **Supersedes `HANDOFF-2026-08-27-provenance-kinds.md`.**
>
> **`main` = `390f270`** + this doc, tree clean, pushed. tsc clean ·
> **4,223 unit** · coverage **99.76% stmts, 100% funcs** ·
> **E2E_GATE=1: 582 passed at `maxDiffPixels: 0`** (8.4m) ·
> **`pnpm ledger-check` exit 0**, and it now runs on every commit.
>
> Live ledger: **10,111 active rows** · income **$117,924.62** · spending
> **$167,828.49** · net worth **$113,038.43**. Three approved writes applied,
> all three rehearsed on a `.backup` copy first, none of them moving a cent.

---

# ⛔ 0. THE JOB — what is next

**The four-item queue is empty.** 72d, the fixture cards, 73 and 74 all shipped.
What is left is in priority order:

1. ⛔ **MOVE THE REPO OFF THE DESKTOP.** He asked for it and the runbook is
   written: **`docs/move-off-the-desktop.md`**, ten steps, every command
   verified against this machine. Do it FIRST — §6 is why it stopped being a
   performance question.
2. **The COKE stock split.** Pass 73's arbiter found that this app values
   split-adjusted prices against unadjusted quantities: three of the six
   `Robinhood Brokerage` disagreements are one 10× error. §3.
3. **Pass 75** (the state-coverage audit) and onwards, as scheduled in
   `docs/program-passes-60-94.md`.
4. **HOSTING goes last** — unchanged. `docs/deploy-plan-gcp-firebase-auth.md`.

---

## 1. 🔴 The measurement that changed what pass 72d IS

The plan called for a model that SELECTS among an insight surface's sentences.
Before building it I measured what there was to select from
(`scripts/probe-insight-pool.ts`, 533 real surfaces):

| | |
|---|---|
| insights rendered → surfaces | 0 → **364** · 1 → 4 · 2 → **144** · 3 → 16 · 4 → 5 |
| candidates offered | 360 |
| accepted **and proven** | **360** |
| dropped by the cap | **0** |

And raising `MAX_INSIGHTS` from 4 to 40 produced the **identical distribution**.
No page in this ledger has ever had a fifth thing to say, and the write gate has
never once refused a candidate a surface offered. **A model asked to pick the
best four of four would have had no choice to make, anywhere.**

So the model's job is an ORDER, which is a real but small one — and that is why
`insightModelEnabled` defaults to **OFF**, and why the refresh run walks the four
pages a person lands on rather than all 533, 528 of which show three sentences
or fewer.

⚠️ **The honest next step for insights is not a better selector — it is more to
say.** 364 silent surfaces is mostly correct (67% of merchants have one visit
and are deliberately withheld), but 144 pages saying exactly two things is a
vocabulary limit, not a ledger limit.

### What shipped anyway, and is worth having

- **The kill switch**, global plus one per surface (`INSIGHT_SURFACES`, eight
  entries — including the dashboard's notices, because a notice is an insight
  and leaving it outside would have left app-written prose on the page he reads
  every day). Off is a fully honest app: every figure keeps its provenance
  badge, every chart keeps its numbers, only the prose goes. **ABSENT means ON**,
  so a surface added later speaks rather than being silently mute.
- **The cache**, keyed on the pool's CONTENT (`lib/insight-hash`): every field of
  every fact, the candidate list in order, and the vocabulary's own fingerprint
  read off `CLAIMS` rather than a constant somebody must remember to bump. A
  moved figure invalidates exactly the judgement that rested on it and nothing
  has to expire it. Two facts that RENDER the same but are not the same (1st of
  2 vs 1st of 20) hash differently.
- **The model**, whose only output is an order of keys from a closed enum. It
  cannot emit a word or a digit — not because a validator would catch it, but
  because there is no field it could put one in. `applyOrder` is a REORDER,
  never a filter: a hostile, malformed or empty answer leaves the editorial
  order alone.
- **Cost measured, not estimated** — real `response.usage` per call into
  `ai_calls` under a new `select_insights` purpose, the same monthly cap, and
  `claude-categorize`'s run-state machine, re-entrancy guard and Stop.

⛔ **A page render NEVER calls a model.** The cache is read at render and filled
from `/settings`, because a page whose cost depends on how often it is looked at
is not a page anyone can leave open.

---

## 2. 🔴 A merchant named `<UNKNOWN>` was taking its own page down

`/merchants/019f4ccc…` rendered the error boundary instead of a page. Confirmed
with `curl` before and after; it renders now.

`claude-categorize` had written a merchant whose canonical name is literally
`<UNKNOWN>` — four real transactions behind it — and every insight surface puts a
merchant's name into a fact subject, which `insight-facts` refuses (`{ }` could
be re-read as a slot by the READ gate) **by throwing**.

Found by measuring the insight pool, not by any test. The rule now lives in one
place (`lib/printable-name`) and is enforced on both sides:

- **Prevention** at every boundary that takes a name from a person or a model:
  `renameMerchant`, `createCategory`/`renameCategory`, `accountInputSchema` AND
  `accountEditSchema` — ⚠️ guarding only the create path would have left the
  rename UI's own schema open — and the model's `canonicalName` in
  `claude-categorize`, which is CONTENT the app prints, not just the write
  selector its injection guard already covers.
- **Containment** on all six surfaces that name a ledger entity. A bank prints
  what it prints and a row already in the table predates any guard, so a subject
  the app cannot name renders as silence.

The four rows were **unlinked, not renamed**: `<UNKNOWN>` is the model saying "I
don't know", so a flight booking, two Bronx card taps and a Miami address had
been filed as one merchant with four `exact` aliases that would have kept
pulling future imports in.

---

## 3. ⛔ THE BIGGEST FINDING: this app values a stock split wrongly

Pass 73 gave `Robinhood Brokerage` — the last account with no arbiter — the
`Total Securities` anchor its statements print. On its first run it reported six
month-ends where the ledger and the document disagree. **Three of them are one
stock split.**

Coca-Cola Consolidated (COKE) split 10-for-1 in May 2025. Yahoo back-adjusts
price history, so the app holds COKE at **$135.58** on 2025-04-30 where the
statement printed **$1,355.81** — exactly a tenth — while the position of that
era is the un-split one. On each of the three dates the whole account's
disagreement equals the COKE line's, to the cent:

| period end | account off by | COKE printed | COKE in the ledger |
|---|---|---|---|
| 2025-02-28 | −$91.21 | $1,417.12 | $141.712 |
| 2025-03-31 | −$445.12 | $1,350.00 | $135.00 |
| 2025-04-30 | −$667.86 | $1,355.81 | $135.581 |

**A split-adjusted price multiplied by an unadjusted quantity is a 10× error**,
and it is in every historical valuation this app draws — the value chart, net
worth on those days, the return figures. The other three disagreements
(+$8.16, −$89.15, −$197.62) are cached closes differing from the broker's marks;
every QUANTITY matches the statement exactly on all six dates, so none of it is
a missing position.

⛔ **This is the next real correctness pass.** It is recorded in
`ledger-check`'s baseline so a seventh disagreement is what fails — not so this
one is forgotten.

### How the arbiter is built

- The profile emits a **second `ParsedStatement`** carrying the securities
  anchor, with **no transactions**: the trades are in the CSV, and an investment
  period whose movement is zero is exactly right — `periodVerdict` records the
  residual as `value_anchor` market change rather than accusing it of being a
  gap.
- `pnpm ledger-check` compares printed against `portfolioSeries` **to the cent**.
  ⛔ Not a percentage: a band that scaled with the position would be loosest
  exactly where the money is, and the three largest disagreements here are a 10×
  error a percentage band would have to be absurd to catch.
- ⚠️ A day **outside** an account's book is worth zero, not unknown. Reporting it
  as unvalued made seven $0.00 crypto anchors read as findings when the two
  sides agreed exactly.

### ⛔ Two parsing traps, both hit while measuring

1. **The footnote marker is ONE asterisk in 2025 and TWO in 2026.** A regex
   accepting `\*?` does not fail on the 2026 line — it falls through to the next
   line that does match, which belongs to a different table.
2. **`Total Securities` appears again under `Loaned Securities`**, where the
   columns are value / estimated dividend / share of portfolio. Reading it
   printed 2026-03's closing balance as **$421.61** — an annual dividend
   estimate — instead of $44,521.74. The end anchor after exactly two money
   tokens excludes it.

Measured twice by different routes (straight from the PDFs, and through
import → `statement_periods` → `portfolioSeries`), and both agree: 24 of the 32
statements carry an anchor, every closing equals the next opening, and the
printed total equals the sum of the statement's own holdings table in **all 24**.
The documents are right; the ledger is not.

---

## 4. ✅ The $1,505.00 crypto hole — found by the new arbiter, and closed

The check fired on the account next door before the brokerage import even
happened. `Robinhood Crypto` had been carrying nine disagreements nobody knew
about, and one of them was not a rounding difference:

> **2025-10-31: the statement prints $1,505.00 of crypto and the ledger values
> the account at $0.00.**

**The cause was written down in the data.** The book's first `holding_events` row
was a placeholder, honestly labelled *"opening balance per Nov 2025 statement
(pre-Nov history unknown)"*, written on 2026-07-10 when November was the earliest
statement imported. The October statement has since arrived — and its ten trades
sum to **0.39130100 ETH, the placeholder's own quantity to the eighth decimal**.

That equality is what made it a backfill rather than a guess, and
`scripts/backfill-october-crypto-history.ts` refuses to run without it. Sixteen
days of October gained a value they always had; **not one day the book already
covered moved**, no transaction was written, and 2025-10-31 went from $0.00 to
$1,504.86 — a **14¢** price mark.

⚠️ **My own guard failed first, and the guard was wrong, not the number.** It
demanded agreement to a cent, which is what a statement anchor owes and what
crypto cannot give: no closing auction, so the app's daily close and Robinhood's
venue mark differ. It now asserts the thing that matters — a hole the size of
the whole position became a price mark — with a bound still far too tight to
hide the smallest October trade ($100.01).

⚠️ And `changed-value-drift` fired on the way through, exactly as designed. Good
news still has to be written down, or the check would call the old figure
expected the next time it appeared.

---

## 5. ✅ Pass 74 — and why the plan's shape was unsafe

The plan said: call `reconcileAccounts` from `rebuildAccount`. That would have
been a cascade with no fixed point. `reconcileAccounts` does two jobs — it grades
and it **quarantines** — and `rebuildAccount` is called BY the paths that change
statuses (bulk edit, duplicate resolution, manual rows). A rebuild that changed
more statuses would need another rebuild nothing runs. And quarantine is a
decision about a FILE; a rebuild the owner did not ask for must not hide rows
behind his back.

So the grading half is **`regradeStatementPeriods`**, which touches no status,
and `rebuildAccount` calls it on **both** exits — including the early return for
an investment account with holding events, which is the path Robinhood Brokerage
and Robinhood Crypto take and where pass 73's `value_anchor` verdicts live. The
RULE is still `periodVerdict`, and a test asserts the two paths agree: after
`reconcileAccounts` there is nothing left to re-grade.

⚠️ **Two of my own tests were wrong before they were right.** One asserted "no
status moves" against a period that never closed, so the rows were already
quarantined. The other flipped a status to make the ledger differ — but
`RECONCILE_STATUSES` includes `quarantined` on purpose (it is how a held period
is graded back), so that changed no sum and the test would have proved nothing
while looking like it proved everything.

**`pnpm ledger-check` now runs on every commit** — `.githooks/pre-commit`, wired
by `prepare` via `core.hooksPath` so it arrives with an install rather than being
copied into `.git/hooks` by hand where it would be untracked and invisible.
~0.75s, no network, **silent on success**, and it skips itself where there is no
database (a fresh clone, CI, a worktree) because a hook that fails there is a
hook everybody turns off. Both paths verified, including that it really blocks.

---

## 6. ⛔ THE DESKTOP: it is no longer a performance argument

Last session's evidence was load and non-reproducing failures. This session
found something harder, sitting in `data/` right now:

```
data/moneyapp 2.db-shm   Aug  6 10:27      data/moneyapp 5.db-shm   Aug 24 12:20
data/moneyapp 2.db-wal   Aug  6 10:23      data/moneyapp 5.db-wal   Aug 24 12:20
data/moneyapp 3.db-shm   Aug  6 16:23      data/moneyapp 6.db-shm   Aug 25 12:48
data/moneyapp 3.db-wal   Aug  6 16:21      data/moneyapp 6.db-wal   Aug 25 12:48
data/moneyapp 4.db-shm   Aug 24 12:19
data/moneyapp 4.db-wal   Aug 24 12:12
```

**Five separate iCloud conflict copies of the live database's write-ahead log**,
on five occasions across three weeks. There is no conflict copy of `moneyapp.db`
itself and the ledger checks green — but a sync daemon racing a SQLite WAL is how
a database gets torn, and this is the ledger.

⛔ **The runbook is `docs/move-off-the-desktop.md`.** Ten steps, every command
run against this machine first. The one thing that genuinely breaks is
**`import_files.storage_path`: 329 absolute paths** rooted at the old location —
`scripts/repoint-statement-paths.ts` fixes them in one command, and its no-op
path is verified (it reports "nothing to repoint" while the repo is still in
place). Everything else is already relative: `core.hooksPath`, `launch.json`,
`statementsRoot()`, and there is exactly one git worktree.

---

## 7. The e2e fixture: three decision cards nothing had ever photographed

`noticesCard`, `carCard` and `incomeCard` all returned null on the seed, so nine
of the deck's ten rendering cards could be photographed and these three could
not. Measured first — each was waiting for something different: no top-level
`Car` category at all; no confirmed income series with any evidence linked; and
no merchant with a single expense charge (every one in the corpus has 23+).

⛔ **Not one cent moved.** Income $154,925.15, spending $119,536.33, 1,428 rows
and the sum of every daily balance are byte-identical before and after; only
`categories 67→68` and `series 6→8`. Every change is a link, a column, or a
commitment with no posted rows — a new transaction would have re-derived
balances and moved net worth, the bridge, runway and every account chart, to
photograph three cards.

🔴 **And it found a real layout defect.** `/recurring/[id]` overflowed to 378px
inside a 320px viewport as soon as a linked row carried a long descriptor.
`truncate` was on an **inline span**, where `overflow` and `text-overflow` do
nothing and only `white-space: nowrap` applies — so the utility was not merely
inert, **it was the cause**. Invisible until a linked row was long enough.

⚠️ Two things were wrong first: the rent link matched on the DAY alone, which
attached every row posted that morning to the rent schedule and produced *"Rent
fell by $1,793.32"* — another charge's drift, in rent's name. And linking the
payroll turned the round $3,200.00 nobody was ever paid into a $256.81 drift on
every payday; the schedule now agrees with its own evidence ($2,943.19).

88 baselines regenerated, every diff cropped and read first. Two were worth
seeing: the **cash-earnings disclosure banner** now renders on `/spending` (a
whole path that was dormant), and Housing's forecast switches to the rent
schedule.

---

## 8. Still open

- ⛔ **The COKE stock split** — §3. The next correctness pass.
- **`docs/move-off-the-desktop.md`** — §6.
- **The insight vocabulary, not the selector** — §1. 144 surfaces say exactly two
  things.
- **Eight crypto price marks**, −$24.65…+$18.94 on printed values of
  $1,505→$27,360 (0.01%–0.7%). Crypto has no closing auction. In the baseline.
- **`accountCoverage(db, day)` takes a TODAY, not an as-of** — documented, not
  changed. A future caller reaching for historical grading gets today's answer.
- **Discover is missing five statements**, 152 days, named on `/imports`.
- **45 `WEIXIN*` rows, $340.00**, deliberately in bare `Shopping`.
- **HBO Max is registered as RENEWING** — one click on `/recurring` ends it.
- **4 transfer legs, $1,462.00** (bucket C) still unpaired.
- ⚖️ **`notFound()` returns HTTP 200** — closed as framework behaviour last
  session; two hypotheses tested and refuted. Do not repeat them.

---

## 9. Notes that keep costing time

- ⛔ **TWO DEFINITIONS OF SPENDING, and I nearly reported a $7,189.78 regression
  because of it.** The figure every handoff quotes — **$167,828.49** — is the
  signed sum of expense-KIND rows. `periodTotals().spentCents` is a wider measure
  and reads **$175,018.27** on the same ledger. Both are right; only one is the
  headline. Check which one a comparison is using before believing it moved.
- ⚠️ **A green first run on new tests is when to mutate them, not to trust them.**
  ~45 mutants this session across four passes; every survivor was either a real
  test gap now covered, or dead code now deleted. Narrowing `parseKeys`' catch to
  the parse alone is what made its own type guard load-bearing — with the catch
  around everything, deleting `Array.isArray` changed nothing.
- ⚠️ **`tsc` catches tests that assert nothing.** `updateAccount` was missing from
  a test file's imports and a bare `.toThrow()` passed on the ReferenceError.
- ⛔ **`pnpm e2e:update <file>` does not work** — the flag takes a mode, not a
  path. `npx playwright test e2e/visual.spec.ts --update-snapshots`.
- ⛔ **`crop-visual-diff.mjs`'s second argument is the BASELINE NAME**, not an
  output name; it reads `<dir>/<name>-diff.png`.
- ⚠️ **`MONEY` in the Robinhood profile is itself a capture group**, so
  `(N/A|${MONEY}) ${MONEY}` puts the closing value at index **3**. Index 2 is the
  opening again — which reads as a value that never moved all month.
- ⛔ **Measure the FIXTURE before writing an e2e assertion**
  (`scripts/probe-e2e-missing-cards.ts` says why each card is null).
- ⛔ **EMPTY IS NOT A WEAKNESS**, still. A day outside a book is worth zero, not
  unknown; a merchant the app cannot name says nothing rather than crashing; a
  pool of one sentence is not a judgement.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`
