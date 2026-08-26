# Handoff — nine cards, a bank that prints no minus sign, and three surfaces that were lying quietly

> **Supersedes `HANDOFF-2026-08-26-wells-fargo-and-provenance.md`.**
>
> **`main` = `c379646`**, tree clean, pushed. tsc clean ·
> **197 files / 3,767 unit** · coverage **99.74% stmts, 100% funcs** ·
> `pnpm ledger-check` exit 0, 0 stale verdicts ·
> **E2E_GATE=1: 507 passed** at `maxDiffPixels: 0`.
>
> Live ledger: **10,111 active rows** · net worth **$111,531.75** · income
> **$117,924.62** (unchanged all session) · 12 accounts · **2** flagged for review.
> `daily_balances`: derived 6,362 · carried 785 · anchored 215 ·
> derived_unverified 42 · **gap 0**.

Nine commits. Nothing is half-built.

⚠️ **The previous handoff's headline net worth of `$35,530.89` was stale.** The
figure is and was $109,135.08 before today's import and $111,531.75 after; the
dashboard, `netWorthSeries` and the runway card all agree. Do not carry the old
number forward again.

---

# ⛔ 0. THE JOB — what is next

1. **PHASE III-B — Insights everywhere.** Still the owner's outstanding ask
   (*"i want ai inisghts everywhere . and i really mean everywhere"*).
   ⛔ **Read pass 72a in `docs/program-passes-60-94.md` before writing a line** —
   this failed a review once and the reason is specific: pass 46's validator
   accepted **16 of 17 attack strings**, because slots block fabricated NUMBERS
   and do nothing about fabricated RELATIONSHIPS. Restart from
   `Fact.value?: number` plus a `kind`, not from the top.
2. **More cards, if he wants them.** He asked for "a lot more" and got seven;
   the section now holds nine. Candidates measured but not built: transfers
   between his own accounts ($168,951 moved in 6 complete months), net-worth
   composition, a month-by-month spending shape.
3. **Pass 68 (data health) and pass 69 (neutral notices)** as scheduled.
4. ⚠️ **Importing a statement does not link rows to their recurring series.**
   Today's Wells Fargo import left the August rent payment untagged, which is
   what made rent look lapsed (§2). That gap is general and will recur on the
   next import. Worth a pass.

---

## 1. Wells Fargo is in, and its parser is unlike every other one

The owner uploaded the statement mid-session. **39 rows imported, 0 deduped, 0
quarantined, the period RECONCILED to the cent**, and the account goes
`unknown` → **`verified` through 2026-08-25**.

### 1.1 ⛔ The column carries the sign. There is no minus anywhere.

Every other deposit statement here prints one — Chase writes `- 2.08`, SoFi
writes a minus, the OFX carries one. Wells Fargo's transaction table has two
money columns, `Deposits/Additions` and `Withdrawals/Subtractions`, and **which
column a number sits in is the only thing that says whether money came in or
went out.** Parsed as text a purchase and a deposit are both a bare `7.00`.

A line-based parser cannot get this right *even in principle*: it would post
every purchase as income, and the arithmetic would still close against a
beginning balance of zero.

So the parser reads **x positions**, and reads the boundaries off the printed
column header rather than hardcoding them:

```
Check@124 | Deposits/@404 | Withdrawals/@458 | Ending daily@525
```

Measured across all 39 rows: deposits **406–421**, withdrawals **474–489**,
balances **538–548** — every token inside its band with ~36pt of margin.

Two more traps: the **ending daily balance prints only on the last row of each
day**, so the generic "last two money tokens are amount and balance" rule reads
a balance as an amount on the 9 rows that carry one; and the **`Totals` row
prints in the same two columns** directly under the last transaction.

### 1.2 The export was complete after all

The 39 Rocket Money rows were **superseded, not duplicated** — 39 active + 39
superseded, both summing to $2,396.67 — which is the `PROFILE_FIDELITY` takeover
path working exactly as last session designed it.

⚠️ **The previous handoff recorded "the export is missing rows".** The statement
says otherwise: same 39 rows, same $2,396.67 close. The bank app he checked was
almost certainly showing *today's* balance, not the 8/25 statement close.

---

## 2. 🔴 His rent had fallen out of the forecast, and nothing said so

Found while building the subscriptions card. The runway card published

> Committed bills come to **$782.41** a month

against a true **$3,068.11**. The largest bill in the ledger was missing.

**Cause:** `seriesHasLapsed` (the forecast gate) shared `INACTIVE_MISS_LIMIT =
1.5` with `isSeriesActive` (the UI's active/inactive split). Rent last posted
2026-07-08 — **49 days against a 48-day tolerance, ONE day over** — so
`upcomingOccurrences` dropped it. `FPL` sat at 47 of 48 and would have gone the
same way the next morning.

**It is structural.** Statements arrive monthly and each lands on its own date,
so `last_matched_on` trails reality by up to a full cycle simply because the
evidence has not been imported yet. At 1.5 cycles any monthly bill whose
statement is a fortnight late gets condemned — which is most of them, most of
the time.

**`LAPSED_MISS_LIMIT = 3`** now splits the forecast gate off. The two decisions
cost opposite things when wrong: "is there recent evidence?" is about the past
and 1.5 cycles is fair; "should I keep predicting this?" is about the future,
where being wrong deletes a real bill from a budget. Measured separation on the
live ledger — dead series sit at **7.5, 25.3, 26.0, 27.6** cycles, every live one
is **under 1.7** — so nothing lands near the boundary.

The other half was data: **August's rent WAS paid** (Wells Fargo, 8/4,
$2,237.11, check 043257) and nothing tagged it. Linked via `attachTransactions`
behind a restore point; `last_matched_on` 2026-07-08 → 2026-08-04, income
unchanged, ledger-check exit 0. Owner approved both halves.

---

## 3. Nine decision cards

The section grew from two to nine, all in the Runway/Car mould — one service call
returns the whole card so the words and the numbers cannot drift.

| card | what it says on his ledger |
|---|---|
| Eating out | **$1,963.24/mo**, 10.1× groceries, 502 purchases, $23.46 ticket |
| Earned vs banked | **$1,447 of $12,564** implied reached a bank — 12% |
| On your cards | **$925.61**, three cards each as of its own statement |
| Can you trust this? | **7 of 12** accounts add up against a document |
| Subscriptions | **$3,282.28/mo** still forecast, $1,867.32 no longer |
| What changed | **+$3,053.26** in Jul 2026, Travel +998% |
| What you are riding on | **32.3%** of everything he owns is ETH |

Three things worth keeping:

- ⛔ **Refunds NET, never filtered.** `WHERE amount_cents < 0` is the obvious
  query and it is the bug that understated spending $487.50 in pass 66. Netting
  moved Dining $9,689.53 → $9,609.00.
- ⛔ **The movers card refuses to compare August.** Three candidates were
  measured and *both* obvious ones publish a fall that has not happened: Aug-so-
  far against whole months reads Food "−87%", and matching elapsed days barely
  helps ("−85%") **because the missing days are not at the month's END, they are
  missing from ACCOUNTS** — Chase Sapphire carries 16% of spending and has not
  one August row. It compares the newest complete month every spending account
  has been imported through, and names the laggards.
- ⛔ **The income card separates "you earned nothing" from "the ledger has not
  seen it"** by taking a second `cashEarningsReadings` as of the day the records
  stop. 11 paydays silent, 9 of them on days already covered — so the pay did not
  reach a bank, and whether it was *earned* is a question the card says outright
  it cannot answer.

---

## 4. ⛔ Three surfaces that were lying quietly, all found by looking

### 4.1 A badge inside a `<p>` killed the page's interactivity

`ProvenancePopover` renders its panel as a sibling `<div popover>`, and a `<p>`
may not contain a div — HTML parsing **closes the paragraph** where the div
begins, so the DOM stops matching the server's string and React throws hydration
**#418**, which does not warn: it discards the client tree for that subtree.

One tag in the cards-owed headline failed **nine tests that never mention that
card** — all eight dashboard chart views, and the net-worth drag test whose
`boundingBox()` came back null because the plot never hydrated. A second,
**older** instance was then found in `CadenceSentence`, sitting there since the
Phase 1 commit.

⚠️ The minified `#418` in CI names neither element nor component. **Load the page
on the dev server and read the unminified console** — it names both in one line.

`e2e/hydration.spec.ts` now walks all 17 routes asserting no hydration failure
and no uncaught exception; verified by reintroducing the bug and watching it go
red on the right route.

### 4.2 An empty account warned on 1,464 days out of 1,464

`Capital One 360 Checking` holds zero rows and zero balances, so it has no
first-known day, so `splitMissing` filed it as a hole. The dashboard published
**"no statement for Capital One 360 Checking on this date"** in the warning tone
**every single day**, and **zero of 1,464 days could be `complete`** — the whole
net-worth chart drawn as provisional for as long as that account has existed.

Exactly the failure `splitMissing` exists to prevent, reintroduced by an account
with nothing in it. After: gap days **1,464 → 0**, complete days **0 → 24**.

⛔ The `opensOn: null` **with rows** case is unmoved and pinned in both files —
that half really is a hole, money a total cannot see.

### 4.3 The chart could not tell "covered" from "checked"

`netWorthSeries` skipped only `gap`, so `anchored`, `derived`, `carried` and
`derived_unverified` were folded into "covered" and drawn identically. **41 of
1,464 days** carry a balance nobody has checked. The scrub now says so, faintly —
never in the warning tone, because the money is not missing and the arithmetic
has not failed.

### 4.4 …and two smaller ones

- **`-$0.00`** on a paid-off Chase Sapphire. `-0` formats with the sign, reads as
  a debt rounded down, and is invisible to tsc **and to every total**, because
  `-0 + 0 === 0`. Only looking at the page found it.
- **Provenance counted an empty account among "3 have nothing checking them"**
  while the trust card's own footnote said that account has "nothing to check".
  Five buckets now.

---

## 5. Notes that keep costing time

- ⚠️ **Do not run the gate while agents are working** — their probe scripts churn
  files and the `.next` staleness guard fails the run. Wait for the workflow.
- ⚠️ **`SurfaceCard` renders a `<section>`, not a div.** An e2e locator scoping to
  `div` and taking `.first()` gets the GRID, silently widening every row query to
  every card at once.
- ⚠️ **A grid item stretches to its row's height.** Without `items-start` a short
  card's own box grows to match its neighbour and carries a block of empty white
  inside it — the owner objected to exactly this, twice.
- ⚠️ **`.figures` is typographic** (mono + tabular numerals), not a claim that a
  value is currency. An assertion that every `.figures` value is money aged badly
  the moment a card published a percentage.
- ⚠️ **A mutation that "survives" may be an EQUIVALENT mutant.** One agent proved
  its surviving mutant unreachable rather than papering it over with a test that
  asserts the fixture back to itself. That is the right answer; record it.
- ⛔ Regeneration must run **WITHOUT `E2E_GATE=1`**; verify with it.
- ⛔ **Explain a diff before regenerating it** — `scripts/crop-visual-diff.mjs`.
  Every regeneration this session was cropped and read first.
- The owner runs his own dev server on **:3000 with REAL data**. Do not kill it.
  `data/capture-*.mjs` (gitignored) drive Playwright against it.
- `data/app.db` is a 0-byte stub; the real database is **`data/moneyapp.db`**.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`

---

## 6. Still open

- **PHASE III-B insights** (§0.1) and **more cards** (§0.2).
- **Statement imports do not link rows to recurring series** (§0.4).
- **10 Wells Fargo rows in the review inbox**, deliberately — TACO STAND, THE
  EMPANADAS, DONUT GALLERY, WRAP PIT STOP, OCEAN CINEMAS, MOVE FITNESS have no
  precedent, and CANTEEN/SUFRAT have *split* precedent. Only unanimous precedent
  was applied automatically.
- **45 `WEIXIN*` rows, $340.00**, deliberately in bare `Shopping` — the Chase
  descriptor is hard-truncated at 22 characters.
- ⚠️ **`docs/income-ground-truth.md:40` still says income ≈ $119,982.68.** The
  measured, guarded figure is **$117,924.62** and has been stable across five
  passes. Correcting it means tracing the difference, which is its own job.
- **Capital One 360 Checking is still empty** — the Rocket Money export holds two
  rows for it ($1,047 out, $0.02 interest) with no opening deposit, and importing
  a lone outflow would leave it reading −$1,046.98. It now reads as *empty*
  rather than as a hole, which is the honest state until a statement arrives.
- **69 exact opposite transfer pairs** unlinked; **24 transfer groups with one
  active member**.
- **`notFound()` returns HTTP 200** app-wide from force-dynamic pages.
- **`/merchants/[id]` still has no visual baseline** — the last uncovered route.
- **`provenanceFor` has no `netWorthPoint` kind** — the scrub readout answers in
  the coverage vocabulary instead, deliberately (§4.3), so the app keeps one
  answer per question.
