# Handoff — the payday that had passed, five surfaces that named the wrong thing, and a bill's own page

> **Supersedes `HANDOFF-2026-09-03-the-payday-that-had-not-happened.md`.**
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**, `main`, tree clean, pushed.
> tsc clean · **4,607 unit** in ~31s · coverage gate exit 0 ·
> **E2E_GATE=1: 598 passed at `maxDiffPixels: 0`** · `pnpm ledger-check` exit 0
> on every commit via `.githooks/pre-commit`.
>
> Ledger: **10,178 active rows · 37 uncategorized — UNCHANGED.**
> **ZERO real-DB writes this session.** `data/moneyapp.db` still has its
> 2026-09-03 15:19 mtime. Nothing was imported, attached, recategorised or
> repaired: every one of the fifteen fixes is a defect in what the app SAYS
> about a ledger that did not move.
>
> **33 baselines regenerated**, every diff cropped to its changed rows and read
> before regenerating: the `/accounts` + dashboard family (the institution
> heading's "net of what you owe", and the concentration card's new wording) and
> the `holding` family ("HELD, AGAINST WHAT YOU PAID" and its two meaning
> lines). Nothing else moved. Five full gates.

---

# ⛔ 0. THE JOB — what is next

**The one question you were owed is CLOSED.** §0.1 of the last handoff asked
whether the insurance premium is $357.58 or $361.49; you said **keep $361.49**,
and nothing was written — the series already carried it on all three amount
fields. ⚠️ Recorded for the next session: **that figure has still never been
confirmed by a posted charge.** The only insurance charge in the ledger is
`PROGRESSIVE INS 800-776-4737 OH · −$357.58 · 2026-08-12 · Venture X`. If
Sep 11 posts at $357.58 the detector's CV band (0.2) absorbs it either way, so
nothing breaks; the forecast simply runs $3.91 a month high for five months
($19.55 in total).

1. **⛔⛔ `BTLEServer` at 100% of a core.** Still not rebooted — the last two
   handoffs asked. **Reboot.**
2. **28 merchants are still queued for the paid Claude pass.** Unchanged from
   the last session: the free pass changes nothing, and the paid button is
   yours. 37 rows have no category; coverage reads 99.6%.
3. **❓ Two judgement calls left below (§10), both measured, neither acted on.**
4. **Pass 76 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**

---

## 1. Found by reading the app, ranked by what was on your screen

Fifteen. Every one was read off the running app before any file was opened —
eleven on the first pass over the main surfaces, four on a second pass over
detail pages (a merchant, a category, a card in credit, a bill's own page).

| # | what the screen said | what is true |
|---|---|---|
| 1 | /budgets: "$0.00 in so far, **$3,141.00 still expected**" over "4 paydays fall in this month, scheduled at **$4,188.00**" | yesterday's $1,047.00 was in NEITHER leg — the same hole the 09-03 session closed for the ONE day the payday is today |
| 2 | /accounts table: Discover "**55.3%** of owed", Chase Sapphire "**8.2%** of owed" | slices of $1,008.33, with a card in CREDIT taking 8.2% of a debt — while /accounts/&lt;Discover&gt; read 60.2% of the same debt the same day |
| 3 | /accounts table: "OWED — 3 accounts **−$842.89**" over a closing sentence reading "owed **$842.89**" | one figure, two signs, three rows apart, the second reached through `Math.abs` |
| 4 | /accounts cards: "**Capital One −$367.99**" directly above "**Venture X $367.99**" | one debt, two signs, no word between them |
| 5 | /imports: Cash on Hand "**no statements**" … "1 day rests on **an export with no closing balance**" | it has no statement period, no import file and one hand-entered anchor |
| 6 | /spending: "**No activity in this period**" over September 2026 | four elapsed days, not one imported for any account — a measurement of a window nobody read |
| 7 | /recurring All tab: "**4 series are running late**" over a RUNNING LATE section holding **2** | the other two sat under "Suggestions · 2 to review", already inside the $3,567.60 above them |
| 8 | /investments/crypto/ETH: "**Total return** +$8,119.73 +28.50%" | an against-COST figure, four lines under the page's own "−29.72% time-weighted" |
| 9 | /merchants/&lt;Zelle&gt;: "140 transactions" … "**2 visits. Too few to describe a monthly habit.**" | 138 of the 140 are transfers; the cause is classification, not sparsity |
| 10 | /summary/2022 and /summary/2023: no "What you spent" section at all | $4,528.51 and $32,732.55 went out in them, withheld by a gate about a DIFFERENT year |
| 11 | dashboard: "**32.2% of everything you own is ETH**" | struck against net worth ($113,656.08), not against what he owns ($114,498.97) |
| 12 | /categories/&lt;Food&gt;: five series under "Recurring series", each "weekly · **lapsed**" | all five are **dismissed** — his own rejections, printed back as bills that went quiet |
| 13 | /accounts/&lt;Chase Sapphire&gt;: "**AMOUNT OWED −$82.72**", in red | the bank owes HIM $82.72, and four other surfaces already said "in credit" |
| 14 | /recurring/&lt;rent&gt;: "**Next expected — Oct 1, 2026**" | September's rent came due Sep 1 and never posted; four other surfaces say so |
| 15 | /recurring: "PROJECTED NET **−$426.60**" over a strip reading "as scheduled **+$620.40**" | $1,047.00 apart, and `committed`'s own docstring says that headline exists to stop exactly this |

Two more were found by the tools rather than the eye and are recorded where
they belong: an **axe `definition-list` violation** the `Stat` hint had carried
latently (§4), and a **`-$0.00`** a card at exactly zero would have printed
(§8) — caught the moment `balanceHeading` was first tested.

---

## 2. ⭐ THE PAYDAY THAT HAD PASSED — the other six days in seven

The 09-03 session moved `incomeExpectation`'s forward leg from `today + 1` onto
`today`, and closed the gap on the one day a week the payday IS today. Read on
2026-09-04, a Friday, the day after a Thursday payday:

    $0.00 in so far, $3,141.00 still expected from Cash job (weekly pay)
    4 paydays fall in this month, scheduled at $4,188.00

$1,047.00, on one screen, called nothing at all. `postedCents` stops at today
and the walk opens on it, so a payday BEHIND today with nothing banked is in
neither — and that is six days in seven, not one.

⛔ **It is REPORTED, never added to "still expected".** Income has no arrears
leg by doctrine: a payday that passed without a deposit is evidence about the
IMPORTS, not about the job, and projecting it would inflate a cash figure on a
ledger whose owner is paid in cash. The header names it instead:

    1 payday worth $1,047.00 already passed this month with no deposit against
    it — counted in neither figure above. That is evidence about what has been
    imported, not about whether the money was earned.

$0.00 + $3,141.00 + $1,047.00 = $4,188.00, and the three legs are now
exhaustive over the schedule.

**The rule has one home.** `unbankedIncomeForSeries` sits in `services/arrears`
beside `overdueForSeries`, the bills version — same tolerance arbiter, same
abutting boundary at `today`, so "did this scheduled amount arrive?" cannot get
two answers. `incomeExpectation` reads it; so does the forecast (§9).

⭐ **Eleven mutants across the two.** One survived the first pass and is worth
recording: **widening `paidToday` to the series' tolerance changed no test in
the file.** The two lookups answer two different questions — "was this
occurrence met?" (a range, because banks post either side of an anchor) and "is
TODAY's pay already inside `postedCents`?" (an exact date, because only a
deposit dated today answers it). Widened, one deposit deletes a payday it never
paid. Two more survived on the shared rule and were the same guard: without the
income-kind filter every unpaid BILL became a payday, and without the money-in
filter a refund-shaped income series SUBTRACTED from the count.

---

## 3. A card in credit, on the two surfaces §7c did not reach

The 09-03 session fixed `account-insights` and left `/accounts`' table lens
untouched, so on 2026-09-04 the same debt read **60.2%** on one page and
**55.3%** on another.

`lib/side-magnitude` now owns the rule both read: held is the POSITIVE part of
an asset-side balance, owed the NEGATIVE part of a liability-side one, and an
account on the wrong side of its own sign contributes nothing and takes no
share. The row says which — *"in credit — no share of the debt"* — rather than
printing 0.0% of a debt.

⚠️ **The table's net-worth frame is load-bearing and was NOT flipped.** Balance
and change are both signed against net worth precisely so both columns can be
added across the two sides into the footer ("Held less owed … $113,656.08").
Flipping the rows would break that arithmetic. So the caption says so, and the
closing sentence stopped reaching for `Math.abs` — which carried §7c's own
latent fault: if card credits ever exceeded card debts it would have printed a
DEBT where there is a credit.

The institution headings got the mirror of it. The heading is a net across the
group's sides while every row under it prints a card as what you owe; it says
so now, and only on groups that actually hold a liability.

---

## 4. 🔴 An axe violation the fixture could not reach, made reachable

Adding two `hint` lines to the holding page's stat tiles turned three specs red
at once with `definition-list` (serious): a `dl > div` may hold only
properly-ordered dt/dd groups, and the hint was a third child beside them.

**The bug was already there.** `Stat`'s only hint-passing caller is the
day-change tile, which passes `null` whenever the figure really is today's —
which is what the e2e fixture has. A latent serious violation, invisible for as
long as no second caller existed. `PortfolioStats` had already learned this and
says so in its own comment; `PositionCard` had not. The hint lives inside the
`<dd>` now.

⚠️ **Another entry for the unreachable-in-the-fixture list, from the other
side:** a fixture that cannot express a condition cannot test it — and it also
cannot fail on it.

---

## 5. "No activity in this period", of a month nobody had read

`/spending` printed that over September 2026 on 2026-09-04, with the newest
active row at 2026-08-31. The dashboard's pace tile already refuses the same
claim — *"an em dash, not a $0.00: when not one elapsed day of the month is
imported, 'you have spent nothing' is a claim about a month nobody has looked
at"* — on the tile that LINKS here.

`lib/empty-period` names which of six worlds an empty window is in (no ledger,
not yet happened, past the newest row, before the oldest, straddling one end,
genuinely inside the records), and the heading and body come out of one call so
they cannot describe different ones. The window is clipped at today, so a month
still running is not "uncovered" for days that have not happened.

⚠️ The frontier is whole-ledger, so the covered branch says the window *sits
inside what has been imported* and never that every account is imported through
it — Discover reaches Aug 9 while the ledger reaches Aug 31.

**And the empty branch keeps its notes.** "What this page cannot see" was
mounted only in the non-empty branch, so the one period where a reader most
needs it was the branch that dropped it. September now carries *"Cash job
(weekly pay) implies $1,047.00 of earnings in this period and none of it
reached an account."*

---

## 6. Three sentences that named the wrong thing

**An export that does not exist.** `coverageDetail`'s unverified branch ended
with a hard-coded *"— N days rest on an export with no closing balance"*, so it
asserted a document for every account with that grade. Cash on Hand has none.
The row printed "no statements" beside the badge and then explained itself with
an export, on one line. It branches on the field the badge already prints.

**A total return that was measured against cost.** `/investments` labels the
TIME-weighted figure "Total return" and calls the against-cost one "Held,
against what you paid", warning in so many words that *"the largest is not the
best of them"*. The holding page called the against-cost one "Total return",
unqualified, directly above "Money-weighted" — on a page whose own header read
"−29.72% time-weighted". `lib/return-measures` holds the words now and both
surfaces read them, under a test that the against-cost measure can never be
called a total return again.

**"Everything you own", of net worth.** The concentration card divided by
`latestBridgedNetWorthCents` — its own field documents that as "everything he
owns, debts netted" — and called it everything he owns. Assets are $114,498.97
against a net worth of $113,656.08, so "32.2% of everything you own is ETH" was
struck against a base $842.89 smaller than the words named. The card's own
rest-note already carried "debts already netted off"; the two sentences above it
did not. Same shape §7c recorded across five surfaces: the qualifier existed and
only some of the sentences carried it.

---

## 7. Two counts a reader could not reconcile

**"2 visits" of a merchant with 140 rows.** The merchant card counts purchases
(money out, expense-kind) and the page's heading counts every active row. The
component's own comment names Target's 79 against 77 and says the two must be
reconcilable. On `Zelle` they read **140 and 2** — 99 Reimbursements, 26
Internal Transfer and 13 Transfers, all transfer-kind, plus exactly 2 Rent
charges — and the card explained its missing rate as *"2 visits. Too few to
describe a monthly habit."* Sparsity, at a merchant seen 140 times over nine
months. The gap is named once now, beside the figure it explains and separate
from `monthlyBasis`, because it is true whether or not a rate could be given.
And the basis line says "purchases", the word the Purchases tile's own comment
says to use.

**"4 series are running late" over two rows.** Every forecast query on
`/recurring` selects `status in (detected, confirmed)`, so Amazon Prime and
Rocket Money — sitting under "Suggestions · 2 to review" with Confirm and
Not-recurring buttons — were already inside the $3,567.60 PROJECTED SPENDING at
the top of the same screen. Every other section on the tab says whether it is
forecast; the one that looks least forecast said nothing. It says so now, and a
suggestion carries its evidence word whenever it is not `active`, so the count
over the tab has four findable rows.

---

## 8. Three surfaces that contradicted a decision, a gate and a doctrine

**Five dismissed series, printed back as bills that lapsed.**
`/categories/<Food>` listed Nabila Inc, CC Vending, Fordham Sambazon, PURA VIDA
BAY ROAD MIAMI BEACH and YA-FIT Smoothie Bar under a heading reading "Recurring
series", each labelled "weekly · lapsed". All five are `dismissed` — you saying
a pattern is NOT recurring — and dismissed is also the detector's re-detection
sink, so those rows exist only because you rejected them. And "lapsed" is an
evidence state; `seriesEvidence`'s own docstring says it is *"only meaningful
for a detected/confirmed series"*. `seriesRowLabel` chooses the qualifier WITH
the row now, and `ended` series stay — they really did bill there and stopped.

**Two years lost their spending section over a gate about a different year.**
`comparedWindows` refuses a comparison when the predecessor is only partly in
the ledger — right, and about the COMPARISON. It refused the whole window, so
/summary/2022 and /summary/2023 printed EARNED, ALL MONEY IN and PASSED THROUGH
and said nothing at all about the money that went out in them. The prior window
is optional now; the absence is stated in **two** sentences, because a
predecessor the ledger holds PART of is a misleading baseline while one it holds
NONE of is not a baseline at all.

**"AMOUNT OWED −$82.72", in red.** The terrain says "Owed · in credit", the
cards card "$82.72 in credit", the accounts table "in credit — no share of the
debt". The account's own page held the negative without the word and painted a
credit as a loss. `balanceHeading` returns the label and the figure together and
the tone follows the label. ⚠️ An OVERDRAWN asset account keeps "Balance" and
the negative tone — an overdraft is a debt, not a credit. ⚠️ And a card at
exactly $0.00 printed **"-$0.00"**: negating zero gives `-0`. Guarded, with the
guard under a mutant.

---

## 9. The bill's own page, and the card that leaves a payday out

**`/recurring/<Flamingo South Beach (rent)>` read "Next expected — Oct 1, 2026"
and nothing else**, for a rent charge that came due 2026-09-01 and never posted.
Four surfaces said so on the same day: the forecast counts it as a component
("came due 2026-09-01 and has not posted"), /budgets says "2 bills totalling
$2,291.21 due by today and no import has covered them yet", the runway says
"came due earlier this month and never posted", and the calendar marks Sep 1
with a "?". `nextExpected` walks forward from today by construction, so the
backward half was invisible — it comes from `overdueForSeries` now, the same
call the forecast makes, so the page cannot disagree with it about the bill.

**And the forecast card names the payday it leaves out.** `committed`'s own
docstring records that the schedule-only headline exists because the card and
the month strip below it used to disagree "and the one the eye lands on first
was the one with the pace baked in". They disagreed again — "PROJECTED NET
−$426.60" over "as scheduled +$620.40" — by exactly the passed payday. Both are
right: spending's arrears ARE a component and income's deliberately are not,
so the card sums a different set of days from the line under it, and only the
line said which set it drew. `unbankedIncome` is reported and never summed, so
the math table's claim that its rows sum exactly to the projections stays true.

---

## 10. ❓ Looked at, measured, and deliberately NOT changed — two are yours

### 10.1 ❓ `/spending` prints a savings rate of **−19,240.6%**

Measured on `?from=2026-07-01&to=2026-07-31`:

    EARNED $52.95 · SPENT $10,353.96 · REFUNDS +$113.11 · NET -$10,187.90
    SAVINGS RATE  -19240.6%   overspent

The rate is `net ÷ earned`, and July's recorded income is $52.95 of dividends,
interest and other income — the cash job's $5,235.00 never reached a bank, which
the note directly under the cards says in full. Other windows read fine: 2024
**+14.9%**, 2025 **−12.6%**, June 2026 **−128.7%**.

There IS a guard (`earnedCents > 0` → "—", "no income yet"); it catches only the
exact-zero denominator. The house style elsewhere is to refuse a ratio its
denominator cannot carry and say why — `merchantProfile` will not state a
monthly rate under three visits, `topOverRest` returns null rather than print
"−4.2× everything else".

⛔ **Not changed, because the obvious fix collides with a decision you already
made.** On 2026-08-21, asked as a concrete either/or, you chose to leave BOTH
readings standing when the spending and income surfaces disagree about the
unbanked cash — *"suppressing this one would tell a working man he has no
income. Do not 'fix' the disagreement without asking again."* Refusing the rate
whenever there is unbanked pay would refuse it on every recent window.

**The question: should the savings rate refuse itself when its denominator
cannot carry it, and if so on what rule?** Three options, in the order I would
rank them: (a) leave it — every input is on the same row and the note is below
it; (b) name the denominator on the card, so "−19240.6%" reads as "of $52.95
banked"; (c) refuse it past some bound and say what it would have been measured
against. Nothing here is wrong, only unreadable.

### 10.2 ❓ "up to 4 days on Car", when all twelve budgets are at 4 days

`/budgets` reads *"12 of 12 budgets are grading days the ledger has not reached
— up to 4 days on Car."* Every one of the twelve is at 4 (Sep 1–4 elapsed, none
imported), and `reduce` with a strict `>` keeps the first alphabetically. Naming
one when they all tie implies Car is distinctive. Not wrong; a wording call.

### 10.3 Deliberately left alone, with the reasoning

1. **The portfolio table calls a Saturday "exact".** MSFT has no close for
   Aug 29 or 30, so the weekend value carries Friday's equity marks while ETH
   moves (Aug 28 → 29 is exactly −$815.74, ETH's own move). Labelling it
   "carried forward" would read as a fault where there is none: on a
   non-trading day the last close IS the correct mark. The `complete: false`
   tail after the newest stored close still says "carried forward", which is a
   different fact.
2. **The Robinhood group row's two dates** — unchanged from §9.1 of the last
   handoff, and still a judgement about a label rather than a wrong number.
3. **The category picker still offers "Uncategorized"** — deliberately, since
   09-03: it is how you say "leave this one category-less", and it writes NULL.

---

## 11. Notes that cost time, and would again

- ⛔ **A gate that refuses a comparison must not refuse the measurement.**
  `comparedWindows` was right about the delta and took the year's own total with
  it — two whole years with no spending sentence, and the bug lived in a
  function about the year BEFORE them.
- ⛔ **`seriesEvidence` is only meaningful for a live series, and its own
  docstring says so.** Two callers read it anyway. The vocabulary now chooses
  by status first, in one place, with a test.
- ⛔ **A latent a11y violation becomes real the moment a second caller
  exists.** `Stat`'s hint had been wrong since it was written and the fixture
  could not reach it.
- ⚠️ **JSX trims whitespace at line breaks.** "within 3 daysof it" shipped for
  one commit, caught only by reading the rendered sentence back off the app.
- ⚠️ **`-0` formats as "-$0.00".** Caught by the first test written against a
  new function, not by any reading.
- ⛔ **Read a diff by cropping it to its changed ROWS.** A `PIL` script that
  finds the diff's red bands and crops actual/expected to each turns a
  1440×11000 screenshot into three legible strips
  (`scratchpad/cropall.py` pattern). Every one of the 33 baselines was explained
  this way before being regenerated.
- ⚠️ **`pnpm e2e` refuses a stale `.next`.** `E2E_ALLOW_STALE=1 npx playwright
  test` is right only when the bundle really is current; `pnpm build` then
  `npx playwright test <specs>` is the cheap way to iterate on one family.
- ⚠️ `npx vitest run --maxWorkers=4` — 4,607 in ~31s. Coverage gate:
  `npx vitest run --coverage --maxWorkers=4`.
- ⛔ The dev server on :3000 is left running, as it was found.

---

## 12. What was measured, and when

Every figure here is **as of 2026-09-04**, read off the running app. The
portfolio is struck at the closes stored for 2026-09-03; net worth read
$113,656.08 throughout and nothing this session moved it.

Confirmed live after the fixes, read off the page text:

    /budgets      "1 payday worth $1,047.00 already passed this month with no deposit against it"
    /accounts?view=table  "60.2% of owed" · "in credit — no share of the debt" · "39.8% of owed"
    /accounts     "Capital One  net of what you owe  -$367.99"
    /imports      Cash on Hand "1 day rests on entries alone, with no document to check them against"
    /imports      Robinhood Cash "52 days rest on an export with no closing balance"  (unchanged)
    /spending     "September 2026 has not been imported yet — Nothing has been imported for 4 days
                   of it; the ledger stops on Mon, Aug 31, 2026."
    /spending?from=2026-08-27  "No activity in this period — This window sits inside what has been imported…"
    /recurring?tab=all  "SUGGESTIONS — detected, not yet confirmed — and already in the forecast above…"
                        "Amazon Prime · Detected: Subscription · Monthly · about -$4.99 · running late"
    /recurring    "1 payday worth $1,047.00 already passed this month with no deposit imported
                   (Cash job (weekly pay)) — not counted above, and not in EOM cash."
    /recurring/<rent>  "Already due, and not posted … Sep 1, 2026  -$2,109.00"
    /investments/crypto/ETH  "HELD, AGAINST WHAT YOU PAID  +$8,119.73 +28.50%"
    /merchants/<Zelle>  "Measured from 2 purchases. The 138 other rows here are money in, transfers,
                         or uncategorized — none of them a purchase…"
    /summary/2022 "Spending in 2022 came to $4,528.51." · "…the ledger opens on Aug 25, after all of it."
    /summary/2023 "Spending in 2023 came to $32,732.55." · "…the ledger opens on Aug 25, 2022, so that
                   year is only partly in it…"
    /categories/<Food>  "No recurring series detected in this category yet."
    /accounts/<Chase Sapphire>  "IN CREDIT  $82.72"
    /accounts/<Discover>        "AMOUNT OWED  $557.62"   (unchanged)
    dashboard     "32.2% of your net worth is ETH" · "…95.9% of your net worth — what you own with
                   your debts netted off."

---

# 📋 THE PROMPT FOR THE NEXT SESSION

> Read `docs/HANDOFF-2026-09-04-the-payday-that-had-passed.md` first — it is the
> brief. §0 of it is the job.
> Repo `/Users/rayankarimcheca/dev/MoneyApp`, `main` clean and pushed. Baseline:
> 4,607 unit in ~31s · tsc clean · coverage gate exit 0 · `E2E_GATE=1`:
> 598 passed at `maxDiffPixels: 0` · `pnpm ledger-check` exit 0 on every commit.
> Ledger: 10,178 active rows · 37 uncategorized. Zero DB writes last session.
>
> Two judgement calls are waiting on me (§10.1 the −19,240.6% savings rate,
> §10.2 "up to 4 days on Car"). Otherwise the job is the same as the last six
> sessions: find what is wrong. Do not invent features.
>
> 1. ⭐ OPEN THE APP AND READ IT BEFORE YOU GREP IT. Fifteen of fifteen came
>    from reading sentences — eleven on the first pass over the main surfaces,
>    four on a second pass over DETAIL pages (a merchant, a category, an account
>    in credit, a bill's own page). The second pass is where the last two
>    sessions both found their sharpest four.
> 2. When a figure is right and a sentence about it is wrong, the sentence is
>    the defect. Nine of fifteen were words, not arithmetic.
> 3. Grep for who ELSE answers a question before fixing one caller — twice this
>    session a rule had been fixed on one surface and left broken on another,
>    and both times the two numbers were on screen the same day.
> 4. Read a BASELINE as a sentence, not as pixels; crop the diff to its changed
>    rows first (§11).
> 5. If you find a decision, put it to me EARLY with the measurement.
> 6. HOSTING goes last. Never propose a hosted-DB migration.
