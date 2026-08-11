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

**Consequence for the car:** a $559.89 fixed monthly payment is exactly a recurring series. Register
it as one and the budget page's projection picks it up **with no new machinery**. The temptation to
build a parallel "commitments" concept should be resisted until this path is proven insufficient —
this project has a documented history of specifying work a shipped mechanism already does.

### 2.3 The insurance step-down is the acid test

Any design must record **$369/mo as fact** (he is paying it) and the **−20% at month 6 as a forecast
he stated with "hopefully"** — visibly distinct from a measured amount, and never silently promoted
to truth. If the schema cannot hold that distinction, that is the schema change worth making.

*(The full adversarial review — five refutation-tested lenses plus a ranked build order — is still
running and will be appended as **§7**. Everything in §2 above is already measured and final.)*

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
