# Handoff — the confirmations that understated, and a chart that told nine accounts what they never did

> **Supersedes `HANDOFF-2026-09-04b-the-rules-that-had-one-caller.md`.**
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**, `main`, tree clean, pushed
> (`e33c140`).
> tsc clean · **4,677 unit** in ~21s · coverage gate exit 0 ·
> **E2E_GATE=1: 600 passed at `maxDiffPixels: 0`** · `pnpm ledger-check` exit 0.
>
> Ledger: **10,178 active rows · 37 uncategorized — UNCHANGED.**
> **ZERO real-DB writes this session.** `data/moneyapp.db` still has its
> **2026-09-03 15:19** mtime, the same one the last handoff recorded. Nothing was
> imported, attached, recategorised or repaired: every one of the thirteen fixes
> is a defect in what the app SAYS about a ledger that has not moved in five days.
>
> **ZERO baselines regenerated.** Not one of the thirteen changed a pixel — the
> suite went from 598 to 600 only because two assertions were added. That is the
> headline of the session and §1 is about it.

---

# ⛔ 0. THE JOB — what is next

**The judgement call is CLOSED.** §10 of the last handoff (the two "30 day"
windows on `/accounts`) was put to you before any file was opened. You chose
**leave both** — 30 calendar days and 30 covered days are different questions on
a sparse series, and both name their baseline on screen. No code changed for it.

**No new decision is waiting on you.** Everything below is measured and shipped.

1. **⛔⛔ `BTLEServer` at 100% of a core.** Still not rebooted — four handoffs have
   now asked. **Reboot.**
2. **28 merchants are still queued for the paid Claude pass.** Unchanged: the free
   pass changes nothing and the paid button is yours. 37 rows have no category;
   coverage reads 99.6%.
3. **Pass 77 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**

---

## 1. ⭐ THE SHAPE OF THIS SESSION: THE GATE SAW NONE OF IT

Thirteen fixes, **zero baseline churn**. Every defect lived in one of four places
a screenshot cannot reach:

| where it lived | how many | example |
|---|---|---|
| inside a **confirmation dialog** | 4 | "Days that stop being verified: 1 day" — of 8 |
| in an **`aria-label`** | 1 | "Feb 2026: $50.00, 1 transactions", ×115 |
| in a **`<select>`'s options** | 1 | the account picker in no order at all |
| in a **lens the baselines do not open** | 2 | the terrain's Table, nine rows wrong |
| **latent** — true only once you press a button | 2 | an archived account still spending |
| in **prose beside a chart** | 3 | "Chase Sapphire (owed) -$82.72" |

⛔ **The visual gate is at `maxDiffPixels: 0` and it is still blind to most of
what this app says.** Last session's lesson was "read the attributes"; this
session's is **read the dialogs, the pickers and the lenses**. A
`ConfirmActionButton`'s `radius` is a paragraph the owner reads at the moment he
is about to lose something, and nothing screenshots it.

⛔ **AND THE EXTRACTOR WAS THROWING AWAY A WHOLE CLASS OF SENTENCE.**
`scripts/read-surface.mjs` dropped `<svg>…</svg>` for its geometry and took the
opening tag's `aria-label` with it — so `/spending`'s "The largest move is
Government, down $2,250.00", which exists nowhere else in the markup, was
invisible to the tool the last handoff called its highest-yield. Fixed in the
first commit; swept every route afterwards (one component puts its name there,
and no `<svg>` uses a `<title>` child).

---

## 2. ⭐⭐ FOUR DESTRUCTIVE CONFIRMATIONS, THREE OF THEM WRONG

The last handoff's §9 fixed one confirmation that OVERSTATED what leaves. Three
more were wrong in the other direction.

**"Days that stop being verified: 1 day" — the answer is 8.**
`/accounts/<Cash on Hand>`, on its one recorded balance. That anchor's span is
nine days: one `anchored`, seven `carried`, one `derived_unverified`. `carried`
means nothing posted since the anchor, so those seven rest on it and are exactly
what removing it un-verifies — and `/imports` says so in words on the same
ledger: *"closes to the cent through Aug 3, 2026, then carries that balance
forward for 7 days"*.

⛔ **The commit that introduced this wrote "The answer is 8" in its own message.**
It was fixing the opposite error — the count had been 9, including the unverified
day — and shipped a local `VERIFIED_BASIS = {anchored, derived}`, dropping seven
days to remove one. `provenance.ts::BASIS_VERDICT` grades `carried` as `derived`
and its docstring says reading it as weak is *"the first thing this service got
wrong"*; `coverage.ts` had the rule as a closure inside a loop. This page kept a
third opinion. **Measured: 24 of the 220 recorded balances on cash accounts
understated their own blast radius, the worst offering "1 day" for 62.**
`basisIsChecked` is the one home now.

**"Owed, leaving the totals: -$82.72"** — archiving Chase Sapphire, over a line
correctly reading "Net worth will read $82.72 lower". Two hundred lines above it
in the same file, the page header calls `balanceHeading` and gets it right.

**The same copy, one card up**, in remove-a-recorded-balance. An anchor is stored
in the NET-WORTH frame, so a card in credit is a POSITIVE `balanceCents` there
and negating it printed a negative amount owed. Only its `statement` source keeps
that dialog off the screen.

---

## 3. THE CARD IN CREDIT, SURFACES SIX THROUGH NINE

`balanceHeading` has now been fixed onto **nine surfaces across three sessions**
and **the e2e gate has never once gone red for it** — `data/e2e.db` holds no card
in credit. This session found four more:

    dashboard chart      "Too small to see beside the rest: … Chase Sapphire (owed) -$82.72 …"
    archive dialog       "Owed, leaving the totals   -$82.72"
    remove-balance       "Owed, as recorded         -$82.72"   (unreachable: statement anchors)
    /accounts/<Sapphire> Recorded balances, column headed "Owed":
                           2026-09-02  statement  -$82.72
                           2026-07-02  statement  -$70.89

⛔ **The chart-legend one is worth understanding, because I nearly left it.** The
account page's own chart readout also says `-$82.72` and that is FINE — it is a
point on an axis that really does go below zero, under a green ▼ and a header
reading "In credit · $82.72". The legend line is different: it exists *because
the chart cannot draw those series*, so it is prose with no axis behind it. **A
figure the reader can see plotted may keep the frame's sign; a figure standing in
for one they cannot must carry the word.**

⛔ **A column header cannot carry a per-row verdict.** The same card owes on some
statements and is in credit on others, so the recorded-balances table keeps
"Owed" as its header and the ROW carries the word, through `BalanceFigure` — the
component both accounts lenses already read.

---

## 4. ⭐ THE TERRAIN TOLD NINE OF ELEVEN ACCOUNTS WHAT THEY NEVER DID

`/?chart=terrain&terrainLens=table`, captioned *"Every account from its first
reconstructed day"* — and the chart's own accessible name sends a reader there:
*"Exact figures for every account are … in the Table lens."*

    SoFi Savings     Oct 2023 · -$8,755.98   $0.10   -$8,755.98
    Cash on Hand     Aug 2026 ·      $0.00   $0.00        $0.00
    Chase Sapphire   Feb 2025 ·   -$490.65  $82.72     +$573.37

SoFi Savings opened at **$0.00** and holds $0.10. Cash on Hand took $5,000 in on
Aug 3 and paid it out on Aug 11 — the row said nothing happened. Chase Sapphire's
first day was $0.00.

`firstCents`/`lastCents`/`deltaCents` read `vertices[0]` and `vertices.at(-1)`,
and a vertex exists only where the account covers one of the **~72 evenly sampled
columns** the terrain draws over four years. An account that opened between two
samples reported the balance on the first sample *after* it opened as its opening
balance. **Cash on Hand is the extreme: its whole life is nine days and the
stride is twenty, so no sample could ever have shown the $5,000.**

They read the account's own points now. Nine of eleven rows changed; the two that
did not are the accounts the sampler happened to catch at both ends. Every total
is untouched — `totalLatestCents` comes from the drawn vertices and the table
still closes at $113,656.08.

⛔ **The DRAWING still samples** — that is what keeps 1,476 days legible. The
caption says so now, so a reader who notices a ribbon starting later than its
stated first day gets the reason instead of a contradiction.

---

## 5. A SEPTEMBER WITH NOTHING DUE, OVER A BUDGET ALREADY SPENT

`/categories/<Housing>`, two cards apart:

    Budget            grading Sep 1 – Sep 30 · $0.00 of $2,291.21 · $2,291.21 left
    Recurring series  Flamingo South Beach (rent)  monthly · next Oct 1  $2,109.00
                      Rent utilities & fees        monthly · next Oct 1  $182.21

Both came due on **Sep 1** and neither posted. That is $2,291.21 — the budget to
the cent — so the page read as a month with nothing due and the whole plan
untouched, when every penny of it was already spoken for. `/budgets` says it in
words on the page this card links to.

`nextExpectedOn` walks FORWARD by construction; the backward half is
`overdueForSeries`. `overdueNote` — the wording /recurring's Next column has used
since the same defect was fixed there on 2026-09-04 — **had exactly one caller.**
Four category pages carry the note now: Housing, Rent, Subscriptions,
Memberships.

---

## 6. THE COUNTS AND THE ORDERS

**"1 transactions", 115 times.** Under 60 merchant names, and on every bar of
every category's 12-month chart (55 more). **Six sibling call sites in the same
two features had pluralised the same noun since they shipped** — including
`SpendHeatmap`, the other chart on the same page, and
`categories/[id]/page.tsx:210`, twenty lines from the chart that did not.

**The account picker in no order at all.** `/transactions`' Account filter ran its
own `orderBy(displayOrder, name)`. `displayOrder` is an ordinal `reorderAccounts`
writes 0..n across ONE institution's list — its docstring says so — so across the
ledger it listed nine accounts alphabetically and then appended Chase Checking,
Robinhood Cash and Robinhood Crypto (the 1s and the 2) **after Wells Fargo**,
splitting both Chase accounts and all three Robinhood ones apart. The one list
where a reader has to FIND a name was the one list in no order. `listAccountOptions`
is that sort with one home now — deliberately not `listAccounts().map()`, which
also runs `latestBalances`, a full scan a dropdown does not need.

**A tab reading "0" over 71 cards.** `/transactions?view=duplicates` counts OPEN
pairs and there are none — but the page below holds 71 settled ones, each with an
Undo. Every sibling tab says so when its queue is clear ("Review queue is clear",
"Empty is exactly what you want"); the one view that can be simultaneously zero
and full said nothing.

---

## 7. TWO LATENT ONES — TRUE THE DAY HE PRESSES THE BUTTON

Neither is visible today. Both are promises the app makes by name.

**An archived account was still spending its balance.** `/accounts/<x>` promises
*"Archiving takes {name} out of net worth, the assets and owed totals, and every
analytic."* `runwayCard` walked `listAccounts` unfiltered, so an archived balance
kept funding "Cash you can spend today", the runway measured from it, "What
selling investments would add" and the card debt netted off — **all four numbers
the dashboard's first card is built from**. Every other reader already filters:
`latestBridgedNetWorthCents` (so net worth itself is right), `coverage`,
`cards-owed`, `account-insights`, `cash-wallets`, and both of `forecast`'s
EOM-cash walks. `attribution`'s docstring records the same omission being caught
in review once — *"the `isActive` half is not decoration"*.

**The remove-balance dialog on a card in credit** (§3), unreachable only because
every anchor on this ledger is `statement`-sourced.

---

## 8. ✅ WHAT WAS CHECKED AND FOUND RIGHT

Four hours of arithmetic that found nothing, which is worth recording so the next
session does not repeat it:

- **The bridge closes.** $66,469.73 → $113,656.08 over 1 year, and the eight
  bands sum to +$47,186.35 exactly.
- **The flow matrix closes both ways.** Out $415,945.05 = In $415,945.05, every
  row and column sum, all 753 transfer counts, net $0.00 across accounts.
- **Every year summary closes** — 2022 through 2026: earned + investments +
  not-earned = all money in, every row count, every source-document count, and
  the pass-through legs against the DB (2025: 3 rows in $49,100.00, 4 out
  $28,398.22 — exactly what the page prints).
- **The forecast closes.** 24 components sum to the projections; the nine
  committed lines to $3,567.60; running-late $69.86 and never-billed $977.25
  partition it; EOM cash and net worth both derive.
- **The recurring calendar closes.** Expected +$1,869.60, not-yet-known $3,343.20
  over 4 items, month +$620.40, lowest -$2,291.21 on Sep 1.
- **"Worth a look" is exact.** "The Target charge on Jul 22 came to 22.3× what you
  usually pay there" — the median of Target's 76 prior purchases is $16.37, and
  365.35/16.37 = 22.32.
- **The merchant cards close.** MTA's five yearly figures sum to $907.85 and its
  monthly rate matches 1,386 days to the cent; same for New Best Gourmet Deli.
- **The two "arrears" figures that differ are both right.** The dashboard's
  $2,296.20 excludes today and `/budgets`' $2,405.07 includes it, because
  `budgetTail` starts at `today+1` and only the overdue leg can check postings —
  `budgets.ts:845` documents exactly why the two edges differ and why moving
  either breaks something.
- **"Car — trend $0.00 (slope $3,050.00, capped at one typical month)"** looks
  wrong and is not: "typical" is the MEDIAN, and the median of a category that
  spent in one month of three is $0. `trailingPace`'s 36-month backtest argues it.
- **Discover's "closes around Sep 2 … counted as late from Sep 10"** is a
  future-tense sentence about a past date, and deliberate: `statement-cadence`
  names Discover's move from the 2nd to the 9th under Capital One and says why
  twelve closes is the right memory.

---

## 9. ❓ DELIBERATELY LEFT ALONE, WITH THE REASONING

1. **The account chart's readout still says "-$82.72"** for Chase Sapphire, under
   a header saying "In credit · $82.72". That is the chart's own Y value on an
   axis that goes negative, its 3M header is green (`balanceDeltaAccent`), and
   the page header carries the word. See §3 for the line I decided this against.
2. **`/transactions` filtered to an unimported month** says "Nothing matches the
   current filters", not `lib/empty-period`'s sentence. It is a row list
   answering a question about filters, not an analytic reporting a total — and
   the from/to filter takes any range, not just a period. A candidate if you
   disagree.
3. **227 detail pages share five `<title>`s** — "Category — MoneyApp",
   "Merchant — MoneyApp", "Account — MoneyApp", "Recurring series — MoneyApp",
   "Holding — MoneyApp". `/summary/[year]` is the only dynamic route that names
   its subject. Nothing false; a bookmark or a tab strip cannot tell 80 category
   pages apart. Left as a feature, not a defect.
4. **Six local copies of `plural(n, one, many)`** across `coverage-detail`,
   `statement-cadence`, `trust-card`, `transfers-card`, `cards-owed`,
   `movers-card`. DRY debt, and they all agree — no surface disagrees with
   another, so it is not the §1 shape.
5. **`Per charge` on a series page is the forecast amount, not the postings'
   average** — Hoffman LL prints "-$1,786.46 · seen once" over a single charge of
   $1,835.27. Designed: the badge grades the EVIDENCE and the popover's own
   source line names the real posting ("it was $1,835.27").
   ⚠️ The `±` band beside it IS the postings' sample sd while the centre is not
   their mean (YA-FIT: "-$15.39 ± 10.33" over five charges averaging $19.96).
   `recurring-detail.ts` fixed the band last session and its docstring names the
   mismatch. **The nearest thing to an open question in this codebase** — put it
   to him before touching it.

---

## 10. NOTES THAT COST TIME, AND WOULD AGAIN

- ⛔ **A `ConfirmActionButton`'s `radius` is a paragraph nobody screenshots.**
  Four of thirteen lived there. `node scripts/read-surface.mjs /accounts/<id>`
  renders the whole dialog including the `blastRadiusSentence` a screen reader
  hears. Read every one of them on every page.
- ⛔ **`data/e2e.db` AS A RUN LEAVES IT IS A DIFFERENT LEDGER.** The memory says
  this and I still lost half an hour. The fresh seed has **8 accounts, 214
  anchors all `statement`/`ofx_ledger`, and no merchant with fewer than 8 rows**;
  after a full suite it has **17 accounts and two single-row merchants**, because
  the zz-specs create them. I wrote three e2e assertions against the post-suite
  shape and every one of them was untestable. **Reseed (`npx playwright test
  <one read-only spec>`) before measuring the fixture.**
- ⛔ **PROVE A NEW TEST CAN FAIL.** The account-picker assertion passed against
  the broken sort — the fixture's eight accounts all carry `display_order = 0`
  and each name opens with its own institution's, so both sorts give the same
  list. It moved to a unit test that builds the shape. **Revert the fix and run
  the test; if it stays green, the test is decoration.** Two of this session's
  four e2e attempts died this way.
- ⛔ **When a docstring names a defect, grep for the OTHER callers — including
  inside the same file.** `/accounts/[id]/page.tsx` held THREE hand-rolled
  `balanceHeading`s while importing and calling the real one at line 145.
- ⚠️ **`pnpm e2e:fresh -- <spec>` does not filter.** pnpm does not append args to
  a compound script, so it runs all 600. Use `pnpm build` then
  `E2E_GATE=1 npx playwright test <spec>`.
- ⚠️ **A stale `.next` is caught, and a killed background build is not.**
  `global-setup` refuses a stale bundle with a clear message; a backgrounded
  `e2e:fresh` that gets interrupted leaves no `.next` at all and the next run
  dies inside the webServer. `pnpm build` first.
- ⚠️ `npx vitest run --maxWorkers=4` — 4,677 in ~21s. Coverage:
  `npx vitest run --coverage --maxWorkers=4`. Full e2e ≈ 8.4 minutes.
- ⛔ The dev server on :3000 is left running, as it was found.

### The unreachable-in-the-fixture list, again

`data/e2e.db` cannot express **seven** of this session's thirteen: no card in
credit (four surfaces), no `manual`/`live` anchor (so the remove-balance dialog
does not exist), no two accounts covered to different days (so no institution
group can span two), no archived account, no merchant with one row, and an
account picker whose two sorts coincide. **Two got a real e2e gate** — the
category chart's bar labels and the terrain's first-day column, both proven to
fail against the old code. The rest are pinned by unit tests on the rule.

---

## 11. WHAT WAS MEASURED, AND WHEN

Every figure here is **as of 2026-09-08**, read off the running app. Net worth
read $113,656.08 throughout and nothing this session moved it.

Confirmed live after the fixes, read off the page text:

    dashboard              Chase "2 accounts · each as of its own last covered day,
                             2026-08-14 – 2026-09-03 · net of what you owe"
                           Robinhood "…2026-08-28 – 2026-09-03"
                           "Too small to see beside the rest: … Chase Sapphire
                             in credit $82.72 …"
    /?chart=terrain        "03 Cash on Hand  -$5,000.00 since Aug 2026 · 1 unverified  $0.00"
                           "11 SoFi Savings  +$0.10 since Oct 2023 · 5 unverified"
    …&terrainLens=table    "Cash on Hand · Held · Aug 2026 · $5,000.00 · $0.00 · -$5,000.00"
                           "Net worth today $113,656.08"
    /accounts/<Cash on Hand>  remove-balance: "Days that stop being verified — 8 days"
    /accounts/<Sapphire>   Recorded balances: "2026-09-02 · statement · $82.72 in credit"
                           archive: "In credit, leaving the totals · $82.72"
    /accounts/<Discover>   archive: "Amount owed, leaving the totals · $557.62"
                                    "Net worth will read $557.62 higher"
    /categories/<Housing>  "Flamingo South Beach (rent)  monthly · next Oct 1 ·
                             Sep 1 — not posted  $2,109.00"
    /categories/<Utilities...>  "⟨Dec 2025: $0.00, 0 transactions⟩",
                                "⟨Feb 2026: $50.00, 1 transaction⟩"
    /merchants/<Flamingos> "1 transaction"
    /transactions          picker: Capital One 360 Checking · Venture X · Cash on Hand ·
                             Chase Sapphire · Chase Checking · Discover · Robinhood ×3 ·
                             SoFi ×2 · Wells Fargo
    …?view=duplicates      "No duplicate is waiting on a decision — that is the zero
                             on the tab. The 71 pairs below are ones you already
                             settled, and each can be taken back."
    /spending?period=2026-07  ⟨svg⟩ "15 categories moved … The largest move is
                             Government, down $2,250.00."

---

# 📋 THE PROMPT FOR THE NEXT SESSION

> Read `docs/HANDOFF-2026-09-08-the-confirmations-that-understated.md` first — it
> is the brief. §0 of it is the job.
> Repo `/Users/rayankarimcheca/dev/MoneyApp`, `main` clean and pushed. Baseline:
> 4,677 unit in ~21s · tsc clean · coverage gate exit 0 · `E2E_GATE=1`:
> 600 passed at `maxDiffPixels: 0` · `pnpm ledger-check` exit 0.
> Ledger: 10,178 active rows · 37 uncategorized. Zero DB writes for two sessions.
>
> No decision is waiting on me. The job is the same as the last eight sessions:
> find what is wrong. Do not invent features.
>
> 1. ⭐ OPEN THE APP AND READ IT BEFORE YOU GREP IT — and read the parts a
>    screenshot cannot reach. **Thirteen fixes last session, zero pixels
>    changed.** Four lived inside confirmation dialogs, one in a `<select>`, two
>    in a lens no baseline opens. `node scripts/read-surface.mjs /accounts/<id>`
>    renders dialogs, `aria-label`s and `<svg>` names.
> 2. ⭐⭐ When a docstring names a defect, grep for the OTHER callers — **including
>    inside the same file**. `/accounts/[id]/page.tsx` held three hand-rolled
>    copies of `balanceHeading` while calling the real one at line 145.
> 3. **Prove a new test can fail.** Revert the fix, run the test. Two of last
>    session's four e2e attempts were green against the bug.
> 4. ⛔ Do not size the e2e fixture from `data/e2e.db` as a run leaves it — the
>    zz-specs grow it from 8 accounts to 17. Reseed first.
> 5. When a figure is right and a sentence about it is wrong, the sentence is the
>    defect — but VERIFY first: §8 is a list of ten things that looked wrong and
>    were not.
> 6. If you find a decision, put it to me EARLY with the measurement. §9.5 is the
>    one candidate I left.
> 7. HOSTING goes last. Never propose a hosted-DB migration.
