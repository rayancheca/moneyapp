# Handoff — twelve decision cards, and five surfaces that were lying quietly

> **Supersedes `HANDOFF-2026-08-26-cards-and-the-empty-account.md`.**
>
> **`main` = `c80a57b`**, tree clean, pushed. tsc clean ·
> **200 files / 3,857 unit** · coverage **99.74% stmts, 100% funcs** ·
> `pnpm ledger-check` exit 0, 0 stale verdicts ·
> **E2E_GATE=1: 507 passed** at `maxDiffPixels: 0`.
>
> Live ledger: **10,111 active rows** · net worth **$111,531.75** · income
> **$117,924.62** (unchanged across two sessions) · 12 accounts ·
> 2 flagged for review · 10 uncategorized.
> `daily_balances`: derived 6,362 · carried 785 · anchored 215 ·
> derived_unverified 42 · **gap 0**.

---

# ⛔ 0. THE JOB — what is next

1. **PHASE III-B — Insights everywhere.** The owner's outstanding ask
   (*"i want ai inisghts everywhere . and i really mean everywhere"*).
   ⛔ **Read pass 72a in `docs/program-passes-60-94.md` before writing a line.**
   It failed a review once for a specific reason: pass 46's validator accepted
   **16 of 17 attack strings**, because slots block fabricated NUMBERS and do
   nothing about fabricated RELATIONSHIPS. Restart from `Fact.value?: number`
   plus a `kind`, not from the top.
2. **Two data questions that are HIS call** — see §3. Neither is a bug in the
   code; both are the ledger being asked to describe something it has no word
   for.
3. **The dashboard is now twelve cards deep in one section.** Nobody has said
   that is too many, but it is worth watching. Cards are not individually
   reorderable — the section is. If he wants them sorted, that is a feature.
4. Pass 68 (data health) and pass 69 (neutral notices) as scheduled.

---

## 1. The twelve cards

| card | what it says on his ledger |
|---|---|
| Runway | **1.3 months of cash**, committed bills $3,073.51/mo |
| The car | **$1,190.45/mo** all in, 12.8% of everything he spends |
| Earned vs banked | **$1,447 of $12,564** implied reached a bank — 12% |
| On your cards | **$925.61**, three cards each as of its own statement |
| Eating out | **$1,963.24/mo**, 10.1× groceries, 502 purchases |
| Subscriptions | **$3,282.28/mo** still forecast, $1,867.32 no longer |
| What changed | **+$3,053.26** in Jul 2026, Travel +998% |
| What the banks charge you | **$286.24 behind** recently, **$1,322.29 ahead** all time |
| Your own money, moving | **$74,980.12** between his own accounts in 6 months |
| How the investments are doing | **$20,937.85 up** since Jul 2024 |
| What you are riding on | **32.3%** of everything he owns is ETH |
| Can you trust this? | **7 of 12** accounts add up against a document |

Each is one service call returning the whole card, so the words and the numbers
cannot drift. `items-start` on the grid — a grid item stretches to its row's
height otherwise, and a short card carries a block of empty white inside its own
box, which the owner objected to twice.

---

## 2. 🔴 Five surfaces that were lying quietly

None was found by a test. All were found by **looking**, or by an agent reading
the code it was told to reuse.

### 2.1 `/investments` published a percentage that beat itself

`PortfolioStats` stacked two percentages with no unit on either:

```
30.42%   time-weighted · since Jul 2024
28.56%   money-weighted · your dollars
```

The first is **cumulative over the whole 2.13-year span**; the second is **a
rate per year**. Read as printed, time-weighted appears to have won —
annualized it is **13.30%/yr**, less than half of the other. Now labelled
"in total since Jul 2024" and "a year, your dollars".

That is also why the new performance card's headline is MONEY, not any of the
three percentages, and why each measure carries its unit inline.

### 2.2 A New York State tax bill was inside "what the banks charge you"

The `Fees` catch-all held **$309.00 of which $0.15 was a bank charge**:

| row | what it actually is |
|---|---|
| −$302.00 `Direct Payment NYS DTF PIT Tax Paymnt` | state **income tax** |
| −$5.16 `IMMIGRATION CANADA ONLI OTTAWA ON` | a **visa** payment |
| −$1.69 `WF4 NYSTAX *SERVICE FEE` | processor fee for paying that tax |
| −$0.15 `FOREIGN EXCHANGE RATE ADJUSTMENT FEE` | an actual bank fee |

⛔ Now **shown but not counted**, which reverses the building agent's deliberate
choice to count them — right about the money, wrong about the sentence. Not a
reclassification either: **the ledger has no `Taxes` category**, which is why
that row is there at all (§3).

### 2.3 An empty account warned on 1,464 days out of 1,464 *(yesterday)*

`Capital One 360 Checking` has zero rows and zero balances, so it had no
`opensOn`, so `splitMissing` filed it as a hole — a warning every single day,
and **zero of 1,464 days could be `complete`**. After: gap days **1,464 → 0**,
complete **0 → 24**.

### 2.4 A badge inside a `<p>` killed the page's interactivity *(yesterday)*

Hydration #418 discards the client tree. One tag failed **nine tests that never
mention that card**. `e2e/hydration.spec.ts` now sweeps all 17 routes; verified
by reintroducing the bug.

### 2.5 His rent had fallen out of the forecast *(yesterday)*

One day past a 48-day tolerance → runway published **$782.41** against a true
**$3,068.11**. `LAPSED_MISS_LIMIT = 3` split the forecast gate from the
active/inactive one.

---

## 3. ⛔ Two data questions that are the owner's call

Neither is a code bug. Both are the ledger having no word for something real.

1. **There is no `Taxes` category.** He paid $302.00 of New York State income
   tax and it had nowhere to go, so it sits in the `Fees` catch-all. Creating a
   `Taxes` top-level category and moving that row (plus the $1.69 processor fee,
   and probably the $5.16 immigration charge under something like `Government`)
   is a taxonomy + data change. **Ask before doing it.**
2. **25 unpaired transfers already sit opposite an exact-amount row** in another
   account — **$5,301.64** that one link each would account for. `transferFlow`
   and `linkTransferPair` already exist; what is missing is a decision to run
   them. This is the same shape as yesterday's rent link: a guarded write that
   makes an existing figure honest.

⚠️ **Correction to the previous handoff.** It said "10 Wells Fargo rows in the
review inbox". They are **not** in the review queue — only 2 rows are flagged
ledger-wide. The 9 uncategorized Wells Fargo rows surface as
**"Uncategorized $158.27 (9 rows)"** on `/spending`, which is by design:
`categorize.ts:263` force-flags only big inbound deposits and lets everything
else "surface via coverage".

---

## 4. Notes that keep costing time

- ⚠️ **Do not run the gate while agents are working.** Their probe scripts churn
  files and the `.next` staleness guard fails the run every time.
- ⚠️ **`getByRole(name:)` matches on SUBSTRING.** A locator for "Investments"
  also hits a card headed "How the investments are doing". Scope to an id.
- ⚠️ **A `position: fixed` toast lands inside an ELEMENT screenshot** when the
  shot beats its auto-dismiss. Dismiss explicitly; a fixed wait only moves the
  race, and regenerating freezes a toast that is not always there.
- ⚠️ **Widen a test assertion from MEASURED shapes, never guessed ones.** Dump
  what the page actually renders first — `.figures` now legitimately holds
  `+66.22% in total`, and the unit is the load-bearing part.
- ⚠️ **`.figures` is typographic** (mono + tabular numerals), not "this is money".
- ⚠️ **`-0` formats as `-$0.00`** and is invisible to tsc AND every total.
- ⛔ **EMPTY IS NOT A WEAKNESS.** This distinction has now bitten **four**
  services. Something with no data is not unproven and not missing.
- ⛔ Regeneration runs **WITHOUT `E2E_GATE=1`**; verify with it. **Explain a diff
  before regenerating** — `scripts/crop-visual-diff.mjs`.
- The owner runs his own dev server on **:3000 with REAL data**. Do not kill it.
  `data/capture-*.mjs` (gitignored) drive Playwright against it.
- `data/app.db` is a 0-byte stub; the real database is **`data/moneyapp.db`**.
- ⚠️ `data/e2e-originals` can be left behind non-empty and break a rerun with
  `ENOTEMPTY`; it is gitignored and safe to clear.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`

---

## 5. Still open

- **PHASE III-B insights** (§0.1) and the **two data questions** (§3).
- **Statement imports do not link rows to recurring series** — that gap is
  general and will recur on the next import.
- **45 `WEIXIN*` rows, $340.00**, deliberately in bare `Shopping` — the Chase
  descriptor is hard-truncated at 22 characters.
- ⚠️ **`docs/income-ground-truth.md:40` still says income ≈ $119,982.68.** The
  measured, guarded figure is **$117,924.62**, stable across six passes.
- **Capital One 360 Checking is still empty** — and now reads as *empty* rather
  than as a hole, which is the honest state until a statement arrives.
- **The merchant map calls his rent "Flamingos Restaurant"** — cosmetic only,
  the CATEGORY is correctly `Rent`/`Housing`, but `/merchants` would show it.
- **69 exact opposite transfer pairs** unlinked; **24 transfer groups with one
  active member**.
- **`notFound()` returns HTTP 200** app-wide from force-dynamic pages.
- **`/merchants/[id]` still has no visual baseline** — the last uncovered route.
