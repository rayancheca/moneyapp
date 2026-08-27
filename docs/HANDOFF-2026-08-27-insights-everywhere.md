# Handoff — insights that can be checked, a deck instead of a scroll, and five things that were wrong

> **Supersedes `HANDOFF-2026-08-27-twelve-cards.md`.**
>
> **`main` = `b84b531`**, tree clean, pushed. tsc clean ·
> **211 files / 4,051 unit** · coverage **99.76% stmts, 100% funcs**, `src/lib`
> at 100% on all four · `pnpm ledger-check` exit 0 ·
> **E2E_GATE=1: 523 passed** at `maxDiffPixels: 0`.
>
> Live ledger: **10,111 active rows** · net worth **$111,531.75** · income
> **$117,924.62** (unchanged across three sessions) · spending **$167,828.49**
> (up exactly $76.60 — see §2.1) · **80 categories** (was 78) · 38 recurring
> series (was 35) · 2 flagged for review · 10 uncategorized.
> `daily_balances`: derived 6,362 · carried 785 · anchored 215 ·
> derived_unverified 42 · **gap 0**.

---

# ⛔ 0. THE JOB — what is next

1. **PHASE III-B is BUILT and SHIPPING on four surfaces** (§1). What is left of
   it is the sweep: `/investments`, `/recurring/[id]`, `/budgets`,
   `/summary/[year]`, `/flow`, `/transactions`, `/imports`, and the dashboard
   hero. Each is now a **fact builder and nothing else** — the loop, the cap,
   the drop-if-unprovable rule and the key scheme all live in
   `services/insights.ts`. Budget one surface per ~30 minutes.
   ⛔ Read `merchant-insights.ts`'s header before writing one: its first version
   restated figures the page already printed, and one of those restatements
   actively misled.
2. **Pass 72d — cost, caching and the kill switch.** Nothing here calls a model
   yet: every sentence is composed by the app from measured facts. That was the
   right order (a vocabulary first, a model second), and it means the model can
   now be introduced as a SELECTOR over already-true claims rather than as a
   writer. `claude-categorize.ts` still has the shape to copy.
3. **Pass 73** (the Robinhood Brokerage arbiter) and **74** as scheduled.
4. Two data questions from the previous handoff: one is **done** (§2.1), one is
   **his** and he has the list (§4.1).

---

## 1. Insights everywhere — the part that is built

### 1.1 The type, because that is where it failed last time

Pass 46 designed this feature, routed every figure through app-computed
`{{f1}}` slots so a model could never emit a digit, and its validator then
**accepted 16 of 17 attack strings**. None of the false ones contained a
fabricated number; they contained fabricated RELATIONSHIPS.

`src/lib/insight-facts.ts` — `Fact` is a discriminated union over
**scalar · count · share · rank · delta · trend · multiple**, each carrying a
machine-readable `value` and DERIVING its own `display`, so the words and the
number cannot drift.

`src/lib/insight-grammar.ts` — a closed table of claims. Each owns its fixed
words, reads every variable word off a fact through a named field
(`name` / `value` / `of`), and declares a predicate over the bound facts.
"is the largest" renders only against a rank of 1.

`src/lib/insight-validator.ts` — a **write gate** (`checkClaim`: a claim id
from an enum plus fact slots; no caller can supply a word) and a **read gate**
(`validateProse`: parses arbitrary prose back against the vocabulary and
refuses anything the app could not itself have written).

### 1.2 🔴 The attack suite went red on its first run, and one failure was real

25 attack strings, each annotated with what pass 46's validator does with it —
**measured, not guessed: it accepts 16**, including all three the record kept
verbatim. The new gates refuse all 25.

The real hole it found:

> **"Groceries is the largest of your 22 spending categories, at $1,963.24."**
> — ACCEPTED.

Groceries really is the largest. $1,963.24 really is a measured total. The rank
belonged to Groceries and the money belonged to Dining. **Every token true, the
sentence false.** Hence `slotsAgree` (the cross-slot rule) and hence the read
gate searching PAIRS rather than resolving each slot independently.

⚠️ **Only 3 of the original 17 attack strings survive anywhere in the record.**
The other 22 here are new. The test file says so rather than implying a list
was restored.

### 1.3 The four surfaces, and what each says

| surface | what it says on his ledger |
|---|---|
| `/spending` | Housing is the largest of your 12 spending categories, at $2,653.58 · 25.9% of everything you spent in Jul 2026 · Travel rose by +$2,225.92 |
| `/categories/[id]` | the SAME builder, centred on a chosen category — a third-place one gets "is the 3rd largest", never "is your largest" |
| `/merchants/[id]` | Uber Eats is the 3rd largest of your 249 regular merchants, at $2,481.87 · 6.1% of what you spent on Food between Mar 2023 and Jul 2026 |
| `/accounts/[id]` | Discover is the largest of your 3 cards and loans, at $557.62 · 60.2% of everything you owe |

⚠️ **The window is not the period selector's.** His statements land weeks after
the period they cover, so a rank over the running month would move every time
one arrived. The window is `moversCard`'s — the newest month every live spender
has been imported past — taken rather than re-derived, and **every sentence
names it**. An e2e test pins that changing the period cannot change what the
strip claims.

---

## 2. 🔴 Five things that were wrong, and how each was found

### 2.1 A tax office was mapped as a source of INCOME *(fixed, owner-approved)*

Nine rows — **$2,761.19** — of money paid to a government sat across five
categories, none of which meant "a government charged me this". A $2,250.00
USCIS filing fee under `Education`; three NY DMV fees under `Bank Fees`; and
**$76.60 of state income tax inside `Transfers`**, whose kind is `transfer`, so
it counted as neither spending nor income and appeared nowhere.

⛔ And the live one, which no surface would have shown: the merchant map gave
**New York State Department of Taxation and Finance** a default category of
`Other Income`. The next NYS statement would have been auto-filed as income.

New top-level `Taxes` and `Government`. Spending rises by exactly $76.60 and by
nothing else. 18 guards held; income unchanged at $117,924.62.

### 2.2 A coverage line that was simply untrue *(fixed)*

`/imports` read:

> Cash on Hand · UNVERIFIED
> nothing has checked this account since 2026-08-11 — **1 days** rest on an
> export with no closing balance

That account closes to the cent through 2026-08-03. `verifiedThrough` was
computed, carried on the record, and rendered only inside `case "verified"` —
so the two states that most needed it were the two that could not show it.

Now: *"closes to the cent through Aug 3, 2026 (24 days ago); the first day it
does not is Aug 11, 2026 — 1 day rests on an export with no closing balance"*.
`daysSinceVerified` got the consumer pass 68 asked for.

⚠️ I introduced one fixing it: `formatDayShort` drops the year, so Robinhood
Cash's 2023-12-05 rendered as "Dec 5" and read as THIS December. Dates carry
their year now.

### 2.3 A merchant strip that said the same thing twice, and misled once *(fixed)*

`merchant-insights` first stated the visit count, the total and the median
ticket. Every one is already a figure on that page. Worse: `merchantProfile`
counts a visit as an EXPENSE-KIND OUTFLOW, so **Zelle — 140 rows, nearly all
transfers — read "2 visits" beside a header saying "140 transactions"**, with
nothing reconciling them. A true sentence can mislead because of the true
sentence next to it. Rewritten to state only relationships the cards cannot.

### 2.4 A bill that was paid LESS, described as a rise *(fixed)*

A bill is stored negative, so rent posting $1,100.00 against an expected
$2,285.70 gives a signed difference of **+$1,185.70** — and the first neutral
notice printed *"rose by +$1,185.70"* over a month he paid less.

⛔ **No gate could have caught it.** The vocabulary guarantees the sentence
matches the FACT; it can say nothing about whether the fact matches the world.
Found by reading the output.

### 2.5 A one-pixel flake, caught by the zero-tolerance gate *(fixed)*

`getBoundingClientRect().height` is sub-pixel, so the deck's container height
depended on where the fraction landed: the 768px dark dashboard came out
**3,269px in a full run and 3,270px on its own** — a 5,638-pixel diff from one
pixel. Ceiled; four consecutive runs now byte-identical. This is the second
time the zero tolerance has paid for itself.

---

## 3. The deck — twelve cards in the height of one

Owner, 2026-08-27: *"instead of having the cards take up al the space in teh
world and having to scroll down to see them just stack them on thop of each
other. either make a scrollwheel or a swipe like in tinder."*

| width | before | after | |
|---|---|---|---|
| 320px | 9,528px | 3,674px | **61% shorter** |
| 768px | 7,722px | 3,270px | 58% |
| 1024px | 5,530px | 2,824px | 49% |
| 1440px | 4,855px | 2,780px | 43% |

⛔ **A carousel, not a discard pile.** A Tinder swipe destroys; these are
thirteen readings of one ledger, so the gesture is borrowed and the semantics
are not. It wraps and nothing can be lost.

⛔ **Vertical wheel is not swallowed** — only a horizontal-dominant delta
steers, which is a trackpad's two-finger swipe. A deck that ate the page scroll
would trap a reader halfway down the dashboard.

⛔ **Nothing is unmounted.** Every card stays in the document and in the
accessibility tree; a deck that hid twelve would be a filter wearing an
animation. There is a test that the card count is identical in both lenses.

⚠️ **Two deliberate rule exceptions, documented at the site**: the container's
height is animated (the alternative is empty white inside every short card,
which he objected to twice), and cards behind the front are stretched to the
front card's height and clipped (without it the stack has no visible depth,
because these cards are wildly different heights).

⚠️ Grid is still one switch away, persisted and URL-addressable
(`/?cards=grid`). **That switch PERSISTS, which makes `zz-card-deck.spec.ts` a
fixture mutator** — it is `zz-` prefixed, every navigation names its own
`?cards=`, and the test that clicks the control puts it back. Unprefixed it
sorted before `visual` and would have rebased eight dashboard baselines.

---

## 4. ⛔ What is HIS call

### 4.1 The 25 unpaired transfers — he asked to see the list first

He has it. The measured split, re-derived from the ledger:

```
A. exactly one own-transfer mirror     20 legs   $3,814.64
B. no own-transfer mirror (WF opening)  1 leg       $25.00
C. two identical rival mirrors          4 legs    $1,462.00
                                       25 legs   $5,301.64
```

⛔ **A blind "link the first exact mirror" pass would convert SALARY into a
transfer.** On 2026-05-13 the SoFi Checking −$615.13 Zelle has two exact
mirrors: the Chase arrival, and the **Fordham payroll deposit**.
`transferCandidates` breaks that tie on `id.localeCompare` — arbitrary.

⚠️ The four "rivals" are not coin flips: each has an exact SAME-DAY arrival
available (Feb 4↔Feb 4 and Feb 18↔Feb 18; Mar 30↔Mar 30 and Apr 9↔Apr 9), so a
same-day-first assignment resolves all four uniquely.

Only the three Chase→Wells Fargo legs are provable by document — the Zelle REF
appears on both legs (`Jpm99Cqxlsrm`, `Jpm99Cqxln8W`) plus the card-7782
opening deposit. SoFi truncates its descriptor at "to Rayan", so the ref test is
unavailable for the other 22.

### 4.2 HBO Max is registered as RENEWING

He called it "a one year subscription". If it does not auto-renew, one click on
`/recurring` ends it. Registered rather than guessed at, and flagged rather than
silently forecast into 2027.

---

## 5. His three annual charges, and why they were invisible

⛔ **Not a detection bug.** `MIN_OCCURRENCES = 3` — nothing is called recurring
until it has been seen three times, which for a yearly charge means three years
of statements. Registered by hand, exactly as the car lease was.

| | he said | the ledger says |
|---|---|---|
| HBO Max | "around 200" | **$260.26** (2026-07-18) |
| Venture X annual fee | "325 or 395" | **$395.00** (2026-01-16) |
| Chase Sapphire annual fee | 95 | **$95.00** ✓, twice |

Together **$62.53 a month, $750.26 a year**. The $395 was also misfiled in
`Bank Fees` — the largest card fee he pays, counted as something a bank charged
him. ✅ His last claim checks out: `Interest Charges` holds **0 rows**.

---

## 6. Notes that keep costing time

- ⚠️ **A test that early-returns on an absent element is a silent pass.** Two
  specs this session were written that way and both were made explicit instead.
  The e2e fixture produces **zero notices**, measured — so `NoticesCard` has no
  pixel coverage and the spec says so out loud.
- ⚠️ **SQLite does not enforce a drizzle enum.** Two of my own test fixtures
  inserted invalid values silently (`"credit_card"` for `"credit"`,
  `"imported"` for `"parsed"`); only `tsc` caught them.
- ⚠️ **`data/e2e.db` outside a run holds whatever the last `zz-` mutator left.**
  A probe against it read 62.1% where a fresh seed reads 62.7%. Reseed or read
  the number from a real run.
- ⚠️ **`test.use({ reducedMotion: "reduce" })` does not reach the page** in this
  config — measured, `matchMedia(...).matches` came back false. Use
  `page.emulateMedia`, as `year-summary` already does.
- ⚠️ **A fullPage baseline diff is never a pure insertion.** Splicing the
  inserted band out still leaves ~80k differing pixels; an EMPTY div of the same
  height reproduces it. The control experiment is how you tell re-rasterization
  from a real change — run it, do not assume it.
- ⚠️ **`zz-golden-path.spec.ts` keeps its OWN account-detail snapshots**,
  separate from `visual.spec.ts`. Missed once this session.
- ⚠️ A median in cents is fractional half the time and **`formatCents` refuses
  a fractional cent**. Round it.
- ⛔ **EMPTY IS NOT A WEAKNESS.** Designed in rather than fixed after, twice
  this session: an account with no balance rows is not one holding zero, and an
  account with fewer than two statements has no holes.
- ⛔ Regeneration runs **WITHOUT `E2E_GATE=1`**; verify with it.
- The owner runs his own dev server on **:3000 with REAL data**. Do not kill it.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`

---

## 7. Still open

- **The insight sweep**: `/investments`, `/recurring/[id]`, `/budgets`,
  `/summary/[year]`, `/flow`, `/transactions`, `/imports`, dashboard hero.
- **Pass 72d** — no model is called yet; the vocabulary is ready for one.
- **Discover is missing five statements**, 152 days, named exactly on
  `/imports`. The account still reads VERIFIED, correctly.
- **`docs/income-ground-truth.md:40` still says income ≈ $119,982.68.** The
  measured figure is **$117,924.62**, stable across seven passes.
- **The merchant map calls his rent "Flamingos Restaurant"** — now visible,
  because the notices card names it.
- **`/merchants/[id]` and the notices card have no visual baseline.**
- **`notFound()` returns HTTP 200** app-wide from force-dynamic pages.
- **45 `WEIXIN*` rows, $340.00**, deliberately in bare `Shopping`.
