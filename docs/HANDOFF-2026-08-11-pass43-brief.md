# Handoff / brief — next pass (written 2026-08-11)

> Pass 42 closed the Robinhood settle-date work (`docs/HANDOFF-2026-08-06-pass42.md`, `main`
> `32e8242`). **This document is the brief for the NEXT pass**, and it is mostly new ground: the
> owner has leased a car, opened a Wells Fargo account, and rejected the budgets surface outright.

## 0. The owner's new facts, verbatim

> *"i have created a wells fargo account so be prepared for that. pull statements from online to see
> what a wells fargo checking account statement looks like and import it and parse it. it will be
> deleted later when i give you the real one next month."*
>
> *"also i got a car so i need you to include that in the budgets and also adversarily review and
> brainstorm and apply many changes to the budgets section as it is not complete in the slightest.
> not really functional or useful. if i was a new user i would be lost and not able to do much"*
>
> *"i bought a car, 24 month lease. 5k down. 559.89 a month"*
> *"insurance is 369 a month for 6 months then itll lower around 20% hopefully"*

⚠️ Note the hedge in his own words: **"hopefully"**. The 20% insurance drop is an EXPECTATION, not a
recorded fact. Under the no-fake-data rule it must never be stored as if measured — see §2.3.

---

## 1. 🚗 The car — the arithmetic, from his numbers only

| | value |
|---|---|
| lease term | 24 months |
| due at signing | **$5,000.00** |
| monthly payment | **$559.89** |
| lease total | $5,000 + 24 × $559.89 = **$18,437.36** → $768.22/mo amortised |
| insurance, months 1–6 | **$369.00/mo** = $2,214.00 |
| insurance, months 7–24 *(expected −20%)* | ~$295.20/mo = ~$5,313.60 |
| insurance 24-mo total | ~**$7,527.60** → ~$313.65/mo avg |
| **all-in over 24 months** | ~**$25,964.96** → ~**$1,081.87/mo** |

**Cash out the door:** **$928.89/mo** for the first 6 months, then ~**$855.09/mo**.

Against earned income of ~$1,046/wk ≈ **$4,532.67/mo** (`docs/income-ground-truth.md`), the car is
**~20.5% of gross now, ~23.9% amortised**. Fuel, registration, tolls and maintenance are on top and
are **not** in any of these figures.

### 1.1 What the ledger says Transport actually costs today

Measured, last 6 complete months (2026-02-01 → 2026-07-31), children of `Transport`:

| subcategory | avg/mo | n | direction once he is driving |
|---|---|---|---|
| Rideshare | $250.46 | 62 | should **fall** |
| Public Transit | $94.54 | 122 | should **fall** |
| Auto Maintenance | $44.35 | 4 | lease may absorb some |
| Gas | $36.84 | 17 | should **rise** |
| Parking & Tolls | $11.12 | 9 | should **rise** (Miami Beach) |
| **total** | **$437.31** | | |

**The Transport budget is $520/mo.** The car payment plus insurance alone is $928.89 — it exceeds
the entire category before a litre of fuel.

⚠️ **The car is NOT purely additive, and the offset must be OBSERVED, not assumed.** $345/mo of
rideshare + transit should decline, but by how much is unknown until the data arrives. Do not
pre-bake a guess into a budget. Set the known commitment, then re-measure in 60 days.

### 1.2 The taxonomy gap — measured

`Transport`'s children are exactly: Gas, Rideshare, Public Transit, Parking & Tolls, Auto
Maintenance. A search of all 73 categories for insurance/lease/car/auto returns only
`Personal Care`, `Auto Maintenance`, `Card Annual Fees`, `Credit Card Payment`.

> **There is no `Car Payment` category and no insurance category of any kind.** Both must be created
> before the first payment posts, or the lease lands in `Uncategorized` or gets swallowed by
> `Auto Maintenance`.

✅ Creating them needs no new code *as of today*: `createCategory` ships at
`src/services/category-edit.ts:78`, wired through `createCategoryAction`
(`src/app/categories/actions.ts:119`) to `CategoryManager.tsx:67`, reachable from `/categories`.

> ⚠️ **CORRECTION — and a lesson about concurrent sessions.** An earlier draft said the adversarial
> review was "refuted" for claiming no category-creation path existed. **The review was RIGHT when it
> ran.** A second Claude session added `createCategory` in commit `5a3d5c1` at **2026-08-11 12:23**,
> between the agent's read and mine. I measured after the fact, found the function, and blamed the
> agent for a difference that concurrency created.
>
> 🔴 **The lesson: in a repo with more than one session live, `git log --since` is part of verifying a
> claim.** "I checked and it's there" does not refute "it wasn't there" unless you also check *when*
> it arrived. Re-measurement beats quotation (the standing rule) — but only if you also date it.

---

## 2. 💰 Budgets — the measured diagnosis

The owner's verdict is "not functional or useful". Read literally that is too harsh, and the
distinction matters for what to build. **The container is decent; the contents are wrong, and the
model cannot express his actual life.**

### 2.1 What already ships — do NOT rebuild it

Verified by reading the code:
- empty state (`page.tsx:75`), create form, and per-period sections
- **four period kinds** — daily / weekly / monthly / annual (`BudgetForm.tsx:19-24`)
- **pace status** (`budgetPaceStatuses`) and a **6-month spend guide** per budget
  (`budgetGuidanceCents`, `page.tsx:52-54`)
- **parent/child rollup with double-count protection** (`hasOverlappingChildBudget`, `page.tsx:92`)
- **drill-down** — each row links to `/categories/{id}` (`BudgetRow.tsx:77-78`)
- it **is** in the nav (`src/components/shell/nav-items.ts`)

### 2.2 What is actually broken — measured

**(a) Half the budgets are numerically wrong.** Budget vs actual average/month over the last 6
complete months:

| category | budget | actual avg/mo | verdict |
|---|---|---|---|
| Travel | $50 | **$600.65** | **12× over** |
| Entertainment | $60 | **$290.19** | **4.8× over** |
| Fees | $30 | **$102.86** | **3.4× over** |
| Food | $1,430 | $1,990.88 | +$561 over |
| Health | $170 | $251.69 | +$82 over |
| Housing | $2,109 | $1,814.73 | $294 slack |
| Shopping | $1,540 | $1,070.40 | $470 slack |
| Cash & ATM | $710 | $520.43 | $190 slack |
| Transport | $520 | $463.31 | $57 slack — **about to break** |
| Subscriptions | $180 | $97.69 | $82 slack |

Five of ten are set BELOW actual spend, three of them by 3–12×. **A page that renders red every
month, every month, teaches nothing** — that is the "not useful" complaint in one line. All ten were
created in one burst on `2026-07-16` and none has been revisited.

**(b) No income awareness.** Total budgeted is **$6,799/mo** against ~**$4,533/mo** income — 150%.
Nothing on the page says so. There is no "left to allocate".

**(c) No rollover — by explicit design.** `page.tsx:66` says so in the UI copy: *"leftover is visible
but never rolls over."* That is a defensible default and a real gap; it is the single most-requested
budgeting behaviour and it is what a sinking fund needs.

**(d) The model cannot express a changing amount.** Every budget is one `amount_cents` with
`starts_on`/`ends_on`. Editing it appears to overwrite. His insurance is $369 for 6 months and then
something else — there is no way to say "amount A until D, then amount B" while keeping A's history.

**(e) No one-off / sinking fund.** The $5,000 due at signing is not a monthly anything. Today it
either distorts a month or vanishes.

**(f) ~~Mid-month starts may not pro-rate~~ — REFUTED by reading the code.** All 10 budgets start
`2026-07-16`, and `budgetStatuses` **already clamps** the graded window to `startsOn`
(`budgets.ts:169-170`), while `budgetPaceStatuses` paces on the budget's OWN life — *"a 4-day-old
budget paces on 4 days, not on the month"* (`budgets.ts:470-473`). This is handled. Do not
"fix" it.

### 2.2b ⭐ The recurring engine ALREADY feeds budget projections — build on it, don't duplicate it

`budgetPaceStatuses` projects with `recurringPostedCents` + `budgetTail` + `projectSpend`
(`budgets.ts:486-500`), and the comment explains it takes real care to keep spent-to-date and the
expected tail **disjoint**, so a bill posted early is never counted twice.

**Consequence for the car:** a $559.89 fixed monthly payment is exactly a recurring series, so the
recurring layer — not a new parallel "commitments" concept — is the right home. This project has a
documented history of specifying work a shipped mechanism already does.

> ⛔ **BUT — corrected in §7.2, and this is the important part.** "Register it as a recurring series
> and the projection picks it up **with no new machinery**" is **WRONG**, verified.
> `recurringSeriesIdsForCategory` (`analytics.ts:100-120`) resolves series → category **only through
> posted transactions**, so a hand-entered commitment with zero posted rows has no category and
> `budgetTail` never sees it. Measured: **Transport has 0 linked series.** Since the lease debits
> Wells Fargo and will not post until next month, this path is **inert** until `recurring_series`
> gains an explicit `category_id` (§7.4).

### 2.3 The insurance step-down is the acid test

Any design must record **$369/mo as fact** (he is paying it) and the **−20% at month 6 as a forecast
he stated with "hopefully"** — visibly distinct from a measured amount, and never silently promoted
to truth. If the schema cannot hold that distinction, that is the schema change worth making.

*(The full adversarial review landed — see **§7**, and the complete 400-line spec in
`docs/budgets-overhaul-spec-2026-08-11.md`.)*

---

## 3. 🏦 Wells Fargo — arriving next month

New checking account. No `accounts` row, no institution, no parser exists yet.

### 3.1 ⚠️ The specimen-data problem — read before importing anything

He asked to pull a statement online, import it, and delete it when the real one arrives. **Importing
specimen transactions into `data/moneyapp.db` would put fabricated money into his net worth** — the
exact thing his own standing rule forbids:

> *"i dont want any fake data. i dont want reasoned data. all the data has to come from the actual
> statements. i dont want you hallucinating."*

✅ **DECIDED 2026-08-11 — FIXTURE ONLY.** Build and test the parser against a specimen held as a
**fixture**, never as a real import: `data/e2e-originals/` + the fixture world
(`scripts/fixtures/render.ts`), with `pnpm trial-import` against `.trial/trial.db` for a live
rehearsal. The parser ends up fully exercised, the real ledger stays clean, and nothing has to be
deleted when the real statement arrives.

⛔ The specimen must not be imported into `data/moneyapp.db` under any circumstances.

### 3.2 Parser plan

Model on the two existing deposit-account CSV profiles in
`src/services/import/profiles/csv-profiles.ts` — `chaseDepositCsv` and `sofiCsv`. A `wellsFargoCsv`
needs: a `matches()` predicate, a `requireHeader` guard, a date regex tolerant of non-zero-padded
dates (the Robinhood lesson — strict `MM/DD` silently dropped 80% of rows), the debit/credit sign
convention, and an `accountHint`.

⚠️ Wells Fargo's CSV export is **historically headerless** — confirm against a real specimen before
writing `requireHeader`. Details to pin down with citations, not assumption: column order, date
format, sign convention, and whether a running balance column exists.

### 3.3 Before the real statement lands

An `accounts` row + institution must exist and the `accountHint` name must match, or the import
routes to the wrong account. Wire it the way another checking account is wired. New institution, so
two known traps do **not** apply: nothing is already imported (parser-version staleness is moot) and
there is no byte-regeneration history yet.

⭐ **This is now on the critical path, not optional.** The lease debits Wells Fargo (§5.2), so the
account row must exist **before** the lease and insurance recurring series are registered — see §6
for the binding order. Creating the account is the cheapest item in the whole queue and it unblocks
the car work.

---

## 4. The queue

**Dependency:** the Wells Fargo *account row* gates the car work, because the lease debits it (§6).
It is also the smallest item here. Do it first — it is minutes, not a pass.

1. ⭐ **Create the Wells Fargo account row + institution** (§3.3) — unblocks 2 and 3. Tiny.
2. ⛔ **The car** — the two missing categories, the lease + insurance as recurring series bound to
   Wells Fargo, the $5,000 one-off, the insurance step-down, and the "known but unobserved"
   treatment so it is visible now without inventing transactions (§1, §6).
3. ⛔ **Budgets overhaul** — §2 and §7. The owner's headline ask. Do it after the car, so the car is
   a real test case for the new model rather than a retrofit.
4. **Wells Fargo parser** (§3) — specimen as **fixture only**; the real statement lands next month.
5. **The last $1,911.24 on Robinhood Cash** — 74% is 2025-10; the rest is four adjacent cancelling
   pairs down to 1¢. Suspect the 65 hand-entered rows, NOT the crypto export.
   (`docs/HANDOFF-2026-08-06-pass42.md` §5.)
6. **All-time stats under the windowed chart** — `ReturnViewParts.tsx:89` computes best/worst day and
   max drawdown over the FULL series while the chart shows a slice. ⚠️ `dailyReturns()` starts at
   `i=1`, so the slice must include one day BEFORE the window start.
7. **Wire `/investments` panels to `?range=`.**
8. **`/flow` range** — `flow/page.tsx:44` hardcodes `2000-01-01` while `transfer-flow.ts:145` already
   honours a range. Cheapest win left.
9. **Transaction drawer + `/transactions` breadcrumb + name the filter chips.**
10. **Robinhood crypto export.** ⛔ Do NOT delete the $3,579.67 plug first.
11. ⛔ **Hosting LAST** — standing instruction: the whole queue first.

## 5. Owner decisions — ANSWERED 2026-08-11

1. ✅ **Specimen data: FIXTURE ONLY.** The Wells Fargo specimen never touches `data/moneyapp.db`.
   Build and test the parser against `data/e2e-originals/` + the fixture world, rehearse with
   `pnpm trial-import` against `.trial/trial.db`. Nothing to delete later.
2. ✅ **The lease debits WELLS FARGO.** See §6 — this has a consequence nobody had noticed.
3. ⏸️ **Rideshare/transit** — not answered; proceeding on the stated recommendation: **hold them at
   today's levels and re-measure in 60 days** rather than pre-baking a guess at the decline.

---

## 6. ⚠️ THE CONSEQUENCE: the car is invisible to the app until next month

The lease debits Wells Fargo. Wells Fargo has **no account row and no transactions** — its first
statement arrives next month. Measured today:

- **No $5,000 down payment exists anywhere in the ledger.** The largest outflows since 2026-05-15 are
  Robinhood transfers (−$9,000 on 06-24, −$3,906.35 on 07-02) — nothing resembling a car dealer.
- **Every account's data predates the car**: Chase Checking stops **2026-07-10**, Chase Sapphire
  07-30, Venture X 07-14, Discover 06-23, SoFi **05-31**. (Statement staleness is normal here, not a
  defect — but it means the car cannot possibly have landed yet.)

**So for the next month the app will show Transport comfortably UNDER its $520 budget while he is
actually paying $928.89/mo.** That is the worst possible failure mode for a budgeting tool: quietly
reassuring while wrong.

This makes the "known commitment, not yet observed" distinction the **central** design requirement of
the next pass, not a nice-to-have:

- the $559.89 lease and $369.00 insurance are **facts he stated** — they should be visible now
- but they are **unobserved in the ledger** — they must never be rendered as if they were measured
  transactions (no-fake-data rule), and must not be double-counted the moment the real Wells Fargo
  rows arrive

The recurring-series engine is the natural home (§2.2b — `budgetTail` already projects unposted
recurring charges into budget pace **without** inventing transactions, and takes explicit care to keep
spent-to-date and the expected tail disjoint). ⚠️ **Verify that disjointness holds when the real
Wells Fargo rows land** — that is the exact seam where a double-count would appear.

**Binding order matters:** create the Wells Fargo account row → register the lease + insurance as
recurring series **on that account** → then the budget projection picks them up. Registering them
against the wrong account now would need unpicking later.

---

## 7. The adversarial review — findings and build order

12 agents, 5 refutation-tested lenses. Full spec: **`docs/budgets-overhaul-spec-2026-08-11.md`**.
Everything below was independently re-verified by the main loop before being written here.

### 7.1 🔴 THE FINDING: the page is asserting a measured zero where "not measured" is true

Run `budgetPaceStatuses(db, '2026-08-11')` against the real DB today and **all ten budgets return
`spent=$0.00 · pace=under · bounds=2026-08-01..2026-08-31`.** The page reads
*"$0.00 spent · On track · 0% used · $6,799 left"* across the board — not because he has spent
nothing, but because **August has not been imported yet.**

That is the NO-FAKE-DATA failure pointed at a rendering instead of a row, and it is the honest answer
to "not really functional or useful": he looks at this page during the two-thirds of every month when
it has nothing to grade, and it confidently tells him he is fine.

**It gets worse — the app already knows better.** `recurringCalendar(db,'2026-08','2026-08-11')`
returns **`missedCount = 4`**: rent **−$2,285.70 due 2026-08-08**, Breezeline −$50.00 (08-10),
FPL −$14.21 (08-10), Amazon Prime −$4.99 (08-05). All came due, none arrived. **Housing still renders
green**, because `budgetTail` anchors at `addDays(today, 1)` (`budgets.ts:364`) and never looks
backwards.

**Diagnosis in one line:** everything on `/budgets` is derived from the past, and his two real
questions — *"can I afford this?"* and *"what am I locked into?"* — are both about the future.

### 7.2 ⚠️ CORRECTION to what I told you last turn

I said the lease could just be registered as a recurring series and the budget projection would pick
it up "with no new machinery". **That is wrong, and I verified it.**

`recurringSeriesIdsForCategory` (`src/services/analytics.ts:100-120`) resolves series → category
**only through posted transactions** (`selectDistinct(transactions.recurringSeriesId) … where
categoryId in subtree`). A hand-entered commitment with **zero posted rows has no category**, so
`budgetTail` (`budgets.ts:361`) will never see it. Measured: **Transport has 0 linked series today.**

Since the lease debits Wells Fargo and won't post until next month, **every "just add a recurring
series" plan is inert until `recurring_series` gains an explicit `category_id`.** That is why §7.4's
first column is the load-bearing one.

### 7.3 Ranked build order (value ÷ effort)

| # | item | effort |
|---|---|---|
| 1 | ⭐ **Say what the page does not know** — per-row coverage. A row whose accounts have no data in `bounds` must not render `$0.00 · On track`; say *"no data yet for 1–31 Aug — Chase Checking imported through 10 Jul"* and suppress the pace verdict. `accountCoverage` + `CoveragePanel.tsx:48` prose + `StalenessNote` badges **all already ship** — reuse, don't reinvent. | **S** |
| 2 | **Show the bill that was due and never arrived** — add `overdueCents` as a third term, rendered left of the today-tick. ⚠️ **Consume `recurring-calendar.ts:150-163`**, don't write a second matcher, or `/budgets` and `/recurring` will disagree about the same rent bill. | S–M |
| 3 | **Anchor the plan to income** — "Left to budget", with a *named basis*. $6,799 budgeted vs **$4,184** projected August income (4 × $1,046 confirmed weekly series) = **162%**. Nothing on the page says so today. | M |
| 4 | **Let him look at a month that has data** — `page.tsx:48` hard-codes `todayIso()`. The whole period-nav apparatus already exists (`src/lib/period.ts`, `PeriodSelector`). ⚠️ not S — pace/tail math is `today`-relative. | M |
| 5 | **The car** — §7.5. | M+M+S |
| 6 | **Committed floor** — warn when a budget is set below known commitments; never block. | S |
| 7–12 | 6-month guide on the row · window carried into drill-down · "Recalibrate" · "Everything else" row · dashboard tile · empty-state onboarding. | all S |

### 7.4 The schema change — three columns, one table, no new tables

```sql
ALTER TABLE recurring_series ADD COLUMN category_id  TEXT REFERENCES categories(id);
ALTER TABLE recurring_series ADD COLUMN ends_on      TEXT;
ALTER TABLE recurring_series ADD COLUMN amount_basis TEXT NOT NULL DEFAULT 'posted';
```

- **`category_id`** — the load-bearing one (§7.2). Union it into `recurringSeriesIdsForCategory`.
- **`ends_on`** — a 24-payment lease that stops at 24; the 6-month insurance term.
- **`amount_basis`** `'posted'|'stated'|'estimated'` — the vocabulary for "expected, not confirmed".
  ⚠️ **Port, don't invent:** `daily_balances.basis` is already a five-level confidence ladder in
  production; mirror its naming and rendering doctrine.

All 27 existing series are NULL/`'posted'` → **behaviour is byte-identical today.** `budgets` is
untouched. Three SQLite `ADD COLUMN`s: instant, no backfill, reversible.

**Net worth — what the car must NOT do.** It is **not an asset** (leased, no source document states a
value) and the remaining $13,437.36 is **not a liability** (`isLiability` is hardcoded to
`type === 'credit'`, `accounts.ts:35`; booking it would drop net worth $13k overnight for a
commitment not yet incurred). The honest form is a third annotated number:
*"net worth $91,392.26 · $13,437.36 committed over the next 24 months"* — which falls out of
`ends_on` for free.

### 7.5 The car, concretely

Two new categories under `Transport`: **Car Payment** and **Car Insurance**.
✅ **`createCategory` already exists and is wired** (`category-edit.ts:78` → `actions.ts:119` →
`CategoryManager.tsx:67`) — he can create them from `/categories` today. *(The review claimed no
creation path existed; refuted.)*

Both commitments become `recurring_series` **bound to the Wells Fargo account**, with explicit
`category_id`, `ends_on`, and `amount_basis`: the $559.89 lease and the $369.00 insurance as
**`stated`** (facts he gave me), the post-month-6 insurance as **`estimated`** and visually distinct —
never silently promoted to truth.

### 7.6 What NOT to rebuild — it already ships

Pace projection, today-tick, green/amber/red, `aria-valuetext` narration · "Projected ≈ $X" per row ·
the dashed expected-recurring tail **with a full drill-down popover** · **`6-mo avg ≈ $X` plus a
working `Use` button** (`BudgetAmountEditor.tsx:109-125` — lift these lines) · overdue detection with
tolerance (`recurring-calendar.ts`) · the entire period-nav URL apparatus (`src/lib/period.ts`) ·
per-account coverage grades and honest staleness prose · income-anchored "Free to spend" and savings
rate on the dashboard · category creation (§7.5) · mid-month clamping (§2.2f).

⚠️ `docs/future-ideas.md:387` is **stale** — the per-row projection it asks for is already there.

### 7.7 Wells Fargo — the format, with citations

**CSV: headerless, 5 quoted positional fields** —
`Date MM/DD/YYYY | Amount (signed, debits NEGATIVE, may carry commas) | "*" literal | Check Number | Description`.
Corroborated by three independent open-source implementations. **There is no running-balance
column** — sources claiming one are PDF→CSV vendors describing their own output.

⚠️ **This is the repo's first headerless CSV**, so both guardrails are unavailable: `requireHeader()`
compares line 1 to a literal, and `parseCsv()` uses `header: true` — which would **eat the first
transaction as the header**. `wellsFargoCsv` must parse with `header:false` and make **the shape the
gate**: 5 fields, field 0 matching `/^\d{2}\/\d{2}\/\d{4}$/`, **field 2 the literal `*`** — re-asserted
on every row, not just in `matches()`. Register it **last** among CSV profiles.

Four setup items are required or the import fails/misroutes: add `"Wells Fargo"` to
`INSTITUTION_NAMES` (`seed.ts:12-19`); add it to the **closed union** `AccountHint.institution`
(`types.ts:17`) or it won't typecheck; add a `wells` branch to `guessInstitution` (`service.ts:1138`)
— **its default is `"Chase"`, so today a WF file that fails to parse is archived into the Chase
bucket**; and **do not hand-create the account row** — `resolveAccount` creates it on first import.
Import the **PDF first**, then the CSV, so the account is born with a real name instead of a stub.

⚠️ **Set expectations:** a CSV with no balance column yields no anchor, so the new account will read
unverified/partial no matter how many rows land. Only the PDF (or QFX `LEDGERBAL`) fixes that — say
so, or a correct import will look like a bug.

### 7.8 Open questions for the owner

1. **What date does the lease start?** Every date in the car spec cascades from it. First lease
   payment date, and first insurance premium date — same day or different?
2. **Insurance after month 6** — store `≈$295/mo` tagged `estimated` (plan stays complete, carries a
   guess), or store nothing and prompt at month 6 (nothing unproven stored, but Transport
   under-projects from month 7)?
3. **The Transport number — A or B?** (a) **$1,392.20/mo** = $928.89 + today's full $463.31 (the car
   adds to current life), or (b) **$1,021.20/mo** = $928.89 + $92.31 non-substitutable (the car
   replaces $345.00/mo of Rideshare + Public Transit). Measured either way; which is true is his call.
4. **Rollover** — build it opt-in, or keep the clean single model? His Travel is the strongest case
   (Feb $8.75 → Jul $2,448.88 against a $50 budget).
5. **Gambling: net or gross?** Stakes land in an expense category while payouts land in
   `Income > Other Income`, so the budget grades **gross**. Route payouts back to `Entertainment >
   Games` so it grades net, or split gambling out with a gross-staked / net-result readout?
   ⛔ Do not silently net either way.
6. **Will you also download the Wells Fargo QFX/OFX?** It carries a balance and a declared period;
   the CSV carries neither, so with CSV alone that account can never reconcile. `ofxProfile` already
   ships.

---

## 8. ⭐ DECISIONS LOCKED (2026-08-11, owner, interactive) — SUPERSEDES §1 AND §7.5

⚠️ **Everything above using $369.00, $928.89 or $1,392.20 is SUPERSEDED.** Those came from the
owner's first estimate; he later gave a more specific figure with the billing day attached, and
confirmed it when the conflict was put to him directly.

### 8.1 The car, corrected

| | |
|---|---|
| lease | **$559.89** on the **11th of each month**, **first payment 2026-09-11**, debited from **Wells Fargo** |
| lease term | 24 payments → last on **2028-08-11**. Total $13,437.36 |
| down payment | **$5,000.00, paid IN CASH on 2026-08-11** |
| insurance | **$361.49/mo** (⚠️ NOT $369.00) on the 11th, **6 payments: 2026-08-11 → 2027-01-11** = $2,168.94 |
| insurance #1 | **already paid 2026-08-11 on VENTURE X** |
| insurance #2–6 | **Wells Fargo**, 2026-09-11 … 2027-01-11 |
| after Jan 2027 | **UNKNOWN — renews at a rate he has not been told.** The "~20% lower" is his guess ("hopefully") and must be stored `estimated` or not at all. |
| fixed monthly commitment | **$921.38** ($559.89 + $361.49), Sep 2026 → Jan 2027 |
| all-in 24 months | $18,437.36 lease + $2,168.94 insurance-so-far = **$20,606.30** (+ unknown renewals) |

### 8.2 Where the car lives — TOP-LEVEL `Car`, settled

`Transport > Car > {Car Payment, Car Insurance}` is **structurally impossible** — the category schema
is deliberately one level deep, which is why `moveCategory` threw (⚠️ *not* `IMPORT_HINT_ROOTS`; that
guess in an earlier draft was wrong, and `Transport` is not in that set).

So it is one or the other, and the owner chose **top-level `Car`**:
- **`Car` budget = $921.38/mo** ✅ **CREATED** (`019ff1c6-7893…`, monthly, starts 2026-08-11)
- **`Transport` stays $520/mo** for Uber / transit / gas / parking

The reasoning, which is better than the merged number: a fixed lease and variable getting-around
spend are different questions, and merging them means the budget can answer neither. The earlier
"$1,392.20 single Transport budget" is dead.

### 8.3 Cash on Hand → $0

*"no more cash after i give the 5k"*, and *"1800 i had and ive been saving the cash from getting paid
from work."* So the safe held **exactly $5,000** before today and is **empty now**.

⛔ **NOT YET APPLIED — it needs one decision first.** The recorded balance is $1,800, so $3,200 of the
$5,000 is **cash pay he earned and never deposited, and which the ledger has never seen**. Zeroing
the wallet honestly means recording that $3,200, and that is an income question, not a balance edit:

- **(a)** Record $3,200 as previously-unrecorded cash income, then a −$5,000 Car Payment today →
  wallet $0. Income totals rise $3,200; net worth rises $3,200 then falls $5,000.
- **(b)** Treat the safe as an untracked float: just correct the opening balance to $5,000 and book
  the −$5,000. Net worth unchanged overall, but $3,200 of real earnings stays invisible to income.

⚠️ `docs/income-ground-truth.md` is carefully maintained and pass 15/28 both had to undo income
contamination — do not pick one silently.

### 8.4 Review queue — DONE this pass

The two groups the owner pointed at are categorized and paired (`3dbf3d6`). He described the route:
*"this is just me transfering from sofi saving into robinhood but it goes sofi saving into sofi
checking then into robinhood"* — the reviewed rows are the **second hop**.

- 15 SoFi outflows (−$17,800) + 13 Robinhood inflows (+$17,500) → **13 pairs linked**, lag 0–5 days,
  Robinhood usually crediting *before* SoFi debits (the pass-19 float direction).
- Category came from the shipped `transferCategoryResolver`, not a hand pick: it treats the Robinhood
  settlement-cash sibling as **investment-side**, so the pairs resolve to
  `Transfers > Investment Contribution` — what the SoFi legs already said, and what the Robinhood
  legs (`Internal Transfer`) did not.
- **Review queue 28 → 4 rows.** Net worth unchanged at $91,392.26 (a pairing moves no money).
- ⏸️ Still in review, deliberately not force-fitted: 2 SoFi legs (2025-03-09 −$100, 2025-04-16 −$200
  — exactly the $300 difference) and 2 Robinhood `ACH Deposit` rows (+$187.22).

### 8.5 Still open

1. **§8.3 — the $3,200 of unrecorded cash income.** (a) or (b)?
2. **Wells Fargo**: the previous session recommends *not* creating the account until its first
   statement, because an account with no statement reads permanently unverified on every coverage
   surface. That conflicts with §6's "create it first so the lease series can bind". Since the lease
   does not debit until 2026-09-11, **there is no rush — defer until the statement arrives.**
3. **`recurring_series.category_id` migration** — still the blocker for representing the lease at all
   (§7.2/§7.4). Nothing about the car is *projected* until it exists; the `Car` budget will simply
   read "no data" until Wells Fargo lands.
