# Handoff — the rules that had one caller, and eight surfaces that read the type instead

> **Supersedes `HANDOFF-2026-09-04-the-payday-that-had-passed.md`.**
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**, `main`, tree clean, pushed.
> tsc clean · **4,664 unit** in ~22s · coverage gate exit 0 ·
> **E2E_GATE=1: 598 passed at `maxDiffPixels: 0`** · `pnpm ledger-check` exit 0
> on every commit via `.githooks/pre-commit`.
>
> Ledger: **10,178 active rows · 37 uncategorized — UNCHANGED.**
> **ZERO real-DB writes this session.** `data/moneyapp.db` still has its
> **2026-09-03 15:19** mtime. Nothing was imported, attached, recategorised or
> repaired: every one of the twenty-two fixes is a defect in what the app SAYS
> about a ledger that did not move.
>
> **83 baselines regenerated** across two rounds, every diff cropped to its
> changed rows and read as a sentence before anything moved
> (`scripts/crop-visual-diffs.py` — **committed this time**; the last handoff
> named a `scratchpad/cropall.py` that was never in the repo, so it had to be
> written again). Two full gates, plus one that caught a fix I had scoped too
> wide and had to narrow (§3).
>
> ⚠️ **37 uncategorized is 31 NULL + 6 filed under the "Uncategorized"
> category.** The dashboard counts both and is right; I checked because
> `category_id is null` alone reads 31.

---

# ⛔ 0. THE JOB — what is next

**Both judgement calls are CLOSED.** §10.1 and §10.2 of the last handoff were
put to you at the top of this session, before any file was opened, and both are
shipped (§2).

1. **⛔⛔ `BTLEServer` at 100% of a core.** Still not rebooted — three handoffs
   have now asked. **Reboot.**
2. **28 merchants are still queued for the paid Claude pass.** Unchanged: the
   free pass changes nothing and the paid button is yours. 37 rows have no
   category; coverage reads 99.6%.
3. **❓ ONE judgement call is waiting on you (§10). It is measured and nothing
   on screen is false either way** — the two figures now name their own windows.
4. **Pass 76 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**

---

## 1. ⭐ THE SHAPE OF EVERY FINDING THIS SESSION

Eleven of the twenty-two are the same defect, and it is worth naming before the
list, because it is what a reader should go looking for next time:

> **A rule was given one home and one caller, and the other callers kept their
> own copy — or read the raw column the home exists to interpret.**

| the home | what it says | who did not read it |
|---|---|---|
| `lib/side-magnitude::balanceHeading` | a card in credit is not a debt | both card lenses (§3) |
| `lib/side-magnitude` (new `balanceDeltaAccent`) | a debt that grew is a loss | the balance chart, under a chip that had it right (§3) |
| `lib/empty-period` | "nothing happened" ≠ "nobody looked" | every category page (§5) |
| `lib/return-measures` | the against-cost figure is never "total return" | the tooltip under the label it had just fixed (§7) |
| `lib/account-side` | *"key off this classification, NOT the raw account type"* | `/summary`'s money-weighted return (§8) |
| `services/arrears::overdueForSeries` | one answer to "is this bill late?" | `/recurring`'s Next column (§4) |
| `listSeries`'s own comment | *"rolling a dismissed/ended series forward would invent a future charge"* | the page ABOUT the series (§4) |
| `AccountCoverage::brokenSince` | a date and a count must come from one run | `unverifiedSince`, one field over (§6) |
| `query.ts::clampPage` | written for `?page=9999`, five tests | nobody, ever (§9) |
| `BUDGET_JARGON`'s docstring | *"a headline and its definition come from the SAME branch"* | the other arm of the same ternary (§2) |
| `recurring_series.amount_cents_avg` | the detector's SEED | printed as "posted avg" (§4) |

**How I found them.** Fifteen minutes reading the rendered text of every surface
before opening a file — the `fetchtext.mjs` extractor in §11 turns a route into
its sentences, including `aria-label` and `title`, which is where four of these
lived. Then a fan-out of eleven readers over the same captures with an
adversarial verifier behind each; 38 of their findings survived, and the ones I
had already found came back independently, which is how I knew the sweep was
working. **Two of their findings were refuted by the source's own docstring**
(§12) — verifying before fixing is what stopped me "fixing" a designed behaviour.

---

## 2. ❓ THE TWO CALLS YOU MADE, AND THE TOOLTIP THAT WAS BACKWARDS

**§10.1 — the −19,240.6% savings rate. You chose: NAME THE DENOMINATOR.**

    SAVINGS RATE  -19240.6%   overspent · of $52.95 earned

Always, not past a threshold — nothing there was wrong, only unreadable, and a
threshold would have been a second rule to keep. "Earned" is the word the
sibling card two along already uses for the same figure. 2024 reads
"14.9% · kept · of $32,717.06 earned".

**§10.2 — "up to 4 days on Car". You chose: DROP THE NAME WHEN THEY ALL TIE.**

    12 of 12 budgets are grading days the ledger has not reached — 4 days each.

⚠️ One under-measured budget is not a tie; it is still named.

**And the tooltip on the line above them was the exact negative of its figure.**
`/budgets` read "Over-allocated by $377.56" over "That income minus the monthly
total below" — $4,537.00 − $4,914.56 = **−$377.56**. One definition served both
arms of a ternary and can only be right about one of them. `BUDGET_JARGON`'s own
docstring states the rule it broke.

---

## 3. ⭐ THREE CARDS THAT READ BACKWARDS, ON A PAGE HEADED "AMOUNT OWED"

`/accounts/<Discover>`:

    30 days  +$119.27      red   — the chip
    ▲ +$557.62 · 3M        GREEN — the chart, forty pixels below it

The chart is fed the OWED frame — a rising line is a rising debt — and was
coloured by `delta > 0 ? gain : loss`, the ASSET rule. Its own docstring claimed
"the delta accent reads correctly for both assets and debts". All three cards
were wrong on the same day: Discover's debt growing $557.62 from nothing was
green, Venture X's $1,869.30 paydown was red, Chase Sapphire crossing into
credit was red.

⛔ **THE ARROW IS A DIRECTION AND THE COLOUR IS A VERDICT, and in the owed frame
they are opposites.** Taking the arrow from the accent printed "▼ +$557.62" of a
debt that grew. That distinction cost me a second pass here and a third on the
holding pages (§7); it is the one thing to remember from this section.

**And `/accounts` printed "−$82.72" in debt-red for Chase Sapphire** — on BOTH
card lenses, the route's own and the dashboard's strip. Four surfaces already
said "in credit" about that balance on that day. `balanceHeading` had shipped
the previous session with exactly one caller; these were the fifth and sixth,
and they are one component now.

⚠️ **Scoping a fix too wide is a fix.** Pairing the trust card's date with its
run (§6) turned the fixture's `broken` Discover row into "14 days unchecked, of
43 in all" — but that row's date is "stopped adding up on Nov 15, 2024", which
is a different question, and the total is what belongs beside it. Only the
"nothing checks it SINCE" clause is about a run. The gate found it; cropping the
diff and reading it as a sentence is what made it obvious.

---

## 4. THE RECURRING SURFACES: A BILL, A REJECTION, AND A SEED

**The Next column walked past a charge the same page called overdue.**
`/recurring?tab=all` said both of these on ONE screen: the math table
*"came due 2026-09-01 and has not posted"*, and the Next column **"Oct 1"**
under a section headed *"Active — charged within their cadence"*. `nextExpectedOn`
walks forward by construction. It is the same defect the bill's own page carried
until 2026-09-04, one surface over and fixed the same day.

**An ended or dismissed series invented three future charges.**
`/recurring/<Hoffman LL>`, badge "**Ended**", over "Next expected — Sep 8, 2026
−$1,786.46 · Oct 8 · Nov 8", of a series whose one linked charge is dated
2025-06-02. `/recurring/<YA-FIT Smoothie Bar>`, badge "**Dismissed**", over three
more — on dates 4 days apart that its own lead sentence called *"weekly on
Thursdays"*: a Friday, a Tuesday and a Saturday.

⛔ **Dismissed is you saying a pattern is NOT recurring, and it is also the
detector's re-detection sink. A dated future charge under that badge is the app
arguing with you.** `noScheduleReason` says which of the two it is rather than
dropping the card in silence.

**"posted avg" was not the average of the postings.** It printed
`amount_cents_avg` — the detector's seed, written at creation, never recomputed
as rows attach. Rent: "4 matched · posted avg −$2,285.70" of four charges
averaging **−$1,739.40**. Cash job: "2 matched · posted avg +$1,046.00" of two
deposits averaging **+$723.50** — a figure matching neither deposit nor their
mean. The same seed was the `±` band on a series' page, printed beside "no basis
yet" with **zero** linked rows.

⚠️ **It now reads "Car insurance · posted avg −$357.58"** against the $361.49 the
schedule carries — the app surfacing §0's open question on its own.

---

## 5. EVERY CATEGORY PAGE DENIED A MONTH NOBODY HAD IMPORTED

    Spent · September 2026   $0.00   0 transactions
    Top merchants   "No merchant spending in this period."
    Transactions    "No transactions in this period."

`lib/empty-period` was written for that error the previous session, for the
surface these pages link to, and shipped with one caller. This is the second.

⚠️ `/spending` prints an explicit Uncategorized bucket above its copy and a
measured zero is only honest there with that named; a category page has none, so
that clause is the caller's to ask for now.

**And the Budget card answered the page's question with another period's
number.** `/categories/<Housing>?period=2026-07`: "Spent · July 2026 ·
$2,653.58" over "monthly budget for this category · $0.00 of $2,291.21". The
budget is always graded at TODAY. The figure was right for September; the
sentence was the defect. `/budgets`' own detail card already said "Grading Sep 1
– Sep 30".

**Money arriving printed as a minus, over the same rows printed as a plus.**
`/categories/<Pass-through>?period=2026-08` read "Net · August 2026 ·
**−$5,000.00**" over two rows of **+$1,000.00** and **+$4,000.00**. Only an
EXPENSE category belongs in the money-out frame.

⛔ **Two components then each went wrong about the same all-negative series.**
`MonthlyTrendBars` scaled with `Math.max(m, p.spentCents)` seeded at 0, which
cannot tell a run that is entirely NEGATIVE from one that is entirely zero — so
Pass-through, Cash Back and Gifts received each printed *"No spending in the
last 12 months."* above a year of their own rows. And the chart's accessible
name was hard-coded to "Monthly spending" on every page, including Salary's.

---

## 6. A DATE AND A COUNT FROM TWO DIFFERENT RUNS, TWICE

    Robinhood Cash    nothing checks it since Dec 5, 2023 · 52 days unchecked
    Cash on Hand      nothing checks it since Aug 11, 2026 · 1 day unchecked

The second row is coherent and the first is not. Robinhood Cash has **32
statement anchors**, the newest closing 2026-07-31 — 35 days before the reading
— and 946 of its 998 balance days are anchored or derived. Its 52 unchecked days
fall in two runs with all of that between them: 26 of prehistory before its very
first anchor, and 26 at the end.

`AccountCoverage.brokenSince` exists because of this exact trap and its docstring
names this exact account. The guard only ever covered the gap case.

**`/imports` had the same account worse:**

    Robinhood Cash · Unverified · statements → 2026-07-31
    nothing closes to the cent from its first day; …

⛔ **`verifiedThrough` must not run past the point the chain BROKE — but a run
of untrusted days BEFORE the first trusted day is not a break. Nothing broke;
the chain starts later.** The test is measured from the first TRUSTED day now,
with a test either side of it so a mid-chain gap still stops the walk where it
did.

**Downstream:** *"The whole picture stops being proven at the first account that
stops being checked"* filtered to `grade === "verified"` — so the two accounts
printed six lines above under "nothing checks it" never entered the comparison
the sentence describes. On the e2e fixture that moved the figure from
"2026-07-04 — 4 days ago" to "2024-11-14 — 601 days ago", which is what the
sentence has always claimed; on the real ledger it did not move at all.

---

## 7. THE INVESTMENT SURFACES

**An arrow pointing against the only number it touched**, on three of twelve
holding pages, in the DEFAULT view:

    +$6,023.43                                              ETH
    ▲ (-29.72% time-weighted) · your return · since Oct 16, 2025

In Return · $ the figure the arrow precedes is the PERCENTAGE and `accentOf`
reads the dollars. The two measures really do disagree in direction — money made
against a time-weighted rate — which is the whole reason the page prints both.
GLD was the mirror: `▼ (+0.29%)`.

**And the tooltip under "Held, against what you paid" still said "Add an average
cost to see TOTAL RETURN"** — the one name `lib/return-measures` exists to keep
off that measure, one line under the label corrected for exactly that the day
before. The test that it *"can never be called a total return again"* was about
the label. ⚠️ On a closed position the advice could not work either: all 24
zero-quantity holdings showed it.

---

## 8. A "MONEY-WEIGHTED" RETURN THAT NO CASH FLOW REACHED

    Investment return   115.42 % a year
    Money-weighted, from $65,038.62 on 2025-12-31 to $108,980.71 on 2026-09-03,
    across 9 cash flows.

The contribution query excluded the investment leg's mirror with
`type in (checking, savings)` — and a brokerage's settlement sleeve is typed
`checking`. `lib/account-side` exists for exactly this and says so:
*"key off this classification, NOT the raw account type."*

So both legs were selected, they land on the same day, `byDay` nets them to
zero, and `money-weighted-return` drops zeroed days: **of 23 flow days, 16
vanished and the 7 survivors netted to +$87.22.** With almost nothing left the
XIRR degenerates to the raw close/open ratio annualised — which is what 115.42%
is. The window took in **$25,554.42 of new money** ($26,854.42 out of Chase
Checking, $1,300.00 out of SoFi) against $25,641.64 of mirror legs that are not
new money at all. **It reads 36.15% a year now, across 21 cash flows.**

---

## 9. A DESTRUCTIVE CONFIRMATION THAT OVERSTATED WHAT LEAVES

    Un-importing rocket-money-export-2026-08-25.csv deletes every row it
    brought in. There is no undo for this inside the app.
    Transactions deleted: 39 transactions
    Money leaving the ledger: $6,447.92 in · $4,051.25 out

All 39 rows are `superseded`. No total in this app can see them. **Eleven files
are in that state.** The row count stays whole — 39 rows really are deleted —
and "39 transactions · $0.00 in · $0.00 out" is the honest reading.

⛔ **And some of what does leave comes straight back.** `unimportFile` calls
`restoreDuplicatesLosingTheirSurvivor` BEFORE its delete. All 12 rows of
`20250302-statements-9805-.pdf` are duplicate survivors whose twins sum to the
same $4,619.92 the confirmation called money leaving — **fifteen files, 71
pairs**. Counted, never re-derived: that restore has slot conflicts and status
floors this page must not reimplement.

**And `/transactions?page=9999`** rendered "No matching transactions … Page 9999
of 204 · 10178 transactions" — an empty state saying the filters match nothing,
over a line saying 10,178 rows match them. `clampPage` exists, has five tests,
and its docstring names the symptom to the character. Nothing outside its own
test file had ever called it.

---

## 10. ❓ THE ONE CALL LEFT — two "30 day" windows, one day apart

`/accounts/<Chase Checking>` and `/accounts?view=table`, one click apart:

    the account page   since Jul 15   +$2,009.91   (green)
    the table          Change         -$2,237.09   -42.7%   (red)

Both are right for their own window. The chip walks back **30 calendar days**
from the account's last covered day (Aug 14 → Jul 15, $997.69); the table takes
the **last 30 covered points** (Jul 16 → Aug 14, $5,244.69) and prints both
endpoints under "The balance series, printed". The balance jumped **$4,247.00 on
Jul 16**, so one day is the whole difference, and every other account happens to
agree in sign.

**Neither was labelled** — the chip said "30 days" and the column says "Change".
The chip names its baseline now, so nothing on either page is false and a reader
can see which is which.

**The question: should the two use ONE window?** Three options, in the order I
would rank them: (a) leave it — both are named, and 30 calendar days and 30
covered days are genuinely different questions on a sparse series; (b) make the
account page use the table's rule, so one number answers it everywhere;
(c) make the table use the calendar rule. This is the only thing left where two
surfaces answer one question with two numbers, and I did not want to pick a
figure for you.

### 10.1 Deliberately left alone, with the reasoning

1. **The dashboard's "Worth a look" flags three charges that are linked to
   confirmed series** — Flamingo rent, Progressive/Car insurance, HBO Max. I was
   ready to call it a defect until I read `notices-card.ts`, which names all
   three by name and says *"a first sighting is the shape a new commitment
   has"*. It is the point of the card, not a fault. **A designed behaviour with
   its reasoning written down is why verification comes before the fix.**
2. **"Predicted budgets — Nothing to predict"** was reported and refuted: the
   sentence is in the HTML but sits inside a closed dialog no reader reaches.
3. **The `/imports` Cash on Hand sentence** — "(32 days ago)" reads as a count
   to a skimmer but is an AGE, correctly labelled. 7 carried + 1 loose + the
   anchor = the 9 days that account has. Not a defect.
4. **The category picker still offers "Uncategorized"** — deliberate, since
   09-03. And "37 uncategorized" is 31 NULL + 6 filed under that category; the
   dashboard counts both and is right.

---

## 11. NOTES THAT COST TIME, AND WOULD AGAIN

- ⛔ **A `title=` or `aria-label` is a sentence the app is making.** Four of this
  session's defects lived only there: the over-allocated tooltip, "Add an
  average cost to see total return", "Jul 27: no activity", and "Monthly
  spending" on a Salary chart. **Read a page with its attributes rendered.** The
  extractor that does it is 40 lines and is worth keeping:
  **`scripts/read-surface.mjs`** inlines `⟨aria-label: …⟩` and `⟨title: …⟩` into
  the text stream. It is the single highest-yield tool of the session, and it is
  committed — `node scripts/read-surface.mjs / '/accounts?view=table'`.
- ⛔ **When a module's docstring names a defect, grep for the OTHER callers
  before believing it is closed.** Eleven of twenty-two were a rule with one
  caller. Every one of those docstrings was accurate; none of them had reached
  the second surface.
- ⛔ **A guard that is tested but never called is not a guard.** `clampPage` had
  five green tests and no caller for as long as it has existed. `grep -rn
  <name> src/ | grep -v test` after writing one.
- ⛔ **The arrow is the direction of the line and the colour is the verdict.**
  In an owed frame they point opposite ways. I got this wrong once in each
  direction before writing it down.
- ⛔ **A dev server can 404 a route that exists.** `/summary/<year>` returned
  404 for every year at session start and the route was fine — a stale
  compilation. **Restart before believing a 404.** Ten minutes.
- ⚠️ **A subagent can leave files in the repo.** Three `scripts/probe-*.ts` from
  the fan-out broke `tsc` twenty minutes later. `git status` after a workflow.
- ⚠️ **The coverage gate is stricter than the unit gate** (`src/lib` branches at
  100%). It caught a `?? fallback` that a guard three lines up had already made
  unreachable — a real dead branch, and only that gate saw it.
- ⚠️ **`vitest` refuses to start while the e2e gate is running** ("THE BOX IS
  ALREADY BUSY"). Sequence them.
- ⚠️ `npx vitest run --maxWorkers=4` — 4,664 in ~22s. Coverage:
  `npx vitest run --coverage --maxWorkers=4`.
- ⛔ **Crop a diff to its changed ROWS.** **`scripts/crop-visual-diffs.py`**
  finds the diff's red bands and stacks expected-over-actual for each — a
  1440×11000 screenshot becomes three legible strips. All 83 baselines were
  explained this way; one of them (§3) changed the fix. Crop ONE width and theme
  per family: 64 failures are usually 8 changes.
  ⚠️ **Both tools are in `scripts/` now.** The last handoff pointed at a
  `scratchpad/` path that no commit contained, and rewriting it cost an hour.
- ⛔ The dev server on :3000 is left running, as it was found.

### The unreachable-in-the-fixture list grew again

Three `/accounts` fixes cannot be seen in `data/e2e.db` at all: it holds **no
card in credit**, **no account with a null balance**, and **no two accounts
whose balances are as of different days**. The card-in-credit rule has now been
fixed on six surfaces across two sessions and the fixture has never once gone
red for it.

---

## 12. WHAT WAS MEASURED, AND WHEN

Every figure here is **as of 2026-09-04**, read off the running app. Net worth
read $113,656.08 throughout and nothing this session moved it.

Confirmed live after the fixes, read off the page text:

    /accounts              Sapphire "$82.72 in credit"
    /accounts?view=table   "Owed — 3 accounts, sharing $925.61 · -$842.89"
                           "no balance — no share"  (Capital One 360)
                           "Each balance is as of its own last covered day,
                            Wed, Aug 5, 2026 to Thu, Sep 3, 2026 — so this is
                            not one moment, and every row prints its own."
    /accounts/<Discover>   "▲ +$557.62 · 3M"  in RED, over "since Jul 15 +$119.27"
    /accounts/<Cash on Hand>  remove-balance: "Days that stop being verified — 8 days"
    /accounts/<Robinhood Brokerage>  "…is priced from its holdings, so this
                           recorded balance verifies nothing."
    /recurring?tab=all     rent "Oct 1 · Sep 1 — not posted"  ·  "posted avg -$1,739.40"
                           Car insurance "posted avg -$357.58"
    /recurring/<Hoffman LL>   "Nothing expected — This series has ended…"
    /recurring/<YA-FIT>       "…You said this is not a recurring series…"
    /categories/<Dining>   "September 2026 has not been imported yet. Nothing has
                            been imported for 4 days of it…"
    /categories/<Housing>?period=2026-07  "monthly budget · grading Sep 1 – Sep 30"
    /categories/<Pass-through>?period=2026-08  "Net · August 2026  $5,000.00"
    /spending?from=2026-07-01&to=2026-07-31  "-19240.6%  overspent · of $52.95 earned"
    /spending?period=2026-07  "6 up · 9 down"  ·  "The largest move is Government,
                            down $2,250.00."
    /spending?period=2026-08&cash=sankey  "From outside this period"
    /spending?period=2026-08  "Jul 27: not part of Aug 2026 — open its ledger"
    /budgets               "— 4 days each"  ·  "The monthly total below minus that income"
    /flow                  "25.9% of gross went out and came back"
    /imports               Robinhood Cash "closes to the cent through Jul 31, 2026
                            (35 days ago) … 26 days rest on an export with no
                            closing balance, of 52 unchecked in all"
                           rocket-money-export: "Money leaving the ledger: $0.00 in · $0.00 out"
                           20250302-statements: "…of which comes back: 12 rows whose
                            retired duplicate is restored"
    /investments/crypto/ETH  "▼ (-29.72% time-weighted)"
    /investments/stock/NVDA  "Nothing held — this measures positions you still hold."
    /settings              "…It also stores “mark it a transfer”, which rules do not apply."
    /summary/2026          "Investment return  36.15 % a year"  across 21 cash flows
    /summary/2022          "Nothing went back out of these accounts in 2022, so this
                            year holds only the arriving leg."
    /transactions?page=9999  "Page 204 of 204"
    dashboard              "Robinhood Cash · nothing checks it since Aug 3, 2026 ·
                            26 days unchecked, of 52 in all"

---

# 📋 THE PROMPT FOR THE NEXT SESSION

> Read `docs/HANDOFF-2026-09-04b-the-rules-that-had-one-caller.md` first — it is
> the brief. §0 of it is the job.
> Repo `/Users/rayankarimcheca/dev/MoneyApp`, `main` clean and pushed. Baseline:
> 4,664 unit in ~22s · tsc clean · coverage gate exit 0 · `E2E_GATE=1`:
> 598 passed at `maxDiffPixels: 0` · `pnpm ledger-check` exit 0 on every commit.
> Ledger: 10,178 active rows · 37 uncategorized. Zero DB writes last session.
>
> One judgement call is waiting on me (§10, the two "30 day" windows on
> /accounts). Otherwise the job is the same as the last seven sessions: find
> what is wrong. Do not invent features.
>
> 1. ⭐ OPEN THE APP AND READ IT BEFORE YOU GREP IT — **with its `title` and
>    `aria-label` attributes rendered into the text.** Four of last session's
>    twenty-two lived only there: `node scripts/read-surface.mjs /budgets`.
> 2. ⭐⭐ **When a module's docstring names a defect, grep for the OTHER callers
>    before believing it is closed.** Eleven of twenty-two were a rule with one
>    home and one caller while a second surface kept its own copy — or read the
>    raw column the home exists to interpret. §1 is the table of them.
> 3. A guard that is tested but never called is not a guard (`clampPage`).
> 4. When a figure is right and a sentence about it is wrong, the sentence is
>    the defect — but VERIFY first: two of last session's reported defects were
>    designed behaviour with the reasoning written down (§10.1).
> 5. Read a BASELINE as a sentence, not as pixels:
>    `python3 scripts/crop-visual-diffs.py test-results /tmp/crops`. One of last
>    session's strips changed the fix it was meant to bless.
> 6. If you find a decision, put it to me EARLY with the measurement.
> 7. HOSTING goes last. Never propose a hosted-DB migration.
