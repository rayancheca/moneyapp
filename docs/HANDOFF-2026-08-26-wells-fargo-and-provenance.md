# Handoff — Wells Fargo is in the ledger, and every figure can be asked to prove itself

> **Supersedes `HANDOFF-2026-08-25-rocket-queue-and-the-blind-gate.md`.**
>
> **`main` = `f9b6920`**, tree clean, pushed. tsc clean ·
> **189 files / 3,564 unit** · coverage gate exit 0 · `pnpm ledger-check` exit 0 ·
> **E2E_GATE=1: 487 passed** at `maxDiffPixels: 0`.
>
> Live ledger: **10,111 active rows** · net worth $35,530.89 · income
> **$117,924.62** (unchanged all session) · 12 accounts · 12 flagged for review.
> `daily_balances`: derived 6,333 · carried 784 · anchored 213 ·
> derived_unverified 42 · **gap 0**.

Eight commits. Nothing is half-built.

---

# ⛔ 0. THE JOB — what is next

1. **Pass 67, the rest of the "prove it" sweep.** The service and the primitive
   exist and four surfaces are wired (dashboard hero, account balance, statement
   periods, transaction sheet). Still to do: **category totals, budget actuals,
   holdings values, recurring amounts, the net-worth chart's scrub readout.**
   Each needs a new `FigureRef` kind; §2.4 has the shape they should share.
2. **PHASE III-B — Insights everywhere**, newly added to
   `docs/program-passes-60-94.md` at the owner's request:
   *"i want ai inisghts everywhere . and i really mean everywhere"*.
   ⛔ **Read pass 72a before writing a line of it** — this failed a review once
   and the reason is specific (§3).
3. **The Wells Fargo balance.** He said *"when i have a statement ill upload
   it"*. Until then the account holds 39 real rows and contributes **$0** to net
   worth, which the dashboard now says out loud.
4. Pass 68 (data health), pass 69 (neutral notices) as scheduled.

---

## 1. Wells Fargo — the account was empty, and that was the wrong call to leave

The owner, mid-session: *"what happened to the wells fargo account? did you not
populate the data from what i gave you from my rocket money…"*

He was right. The prior brief said the Rocket Money export was not a source
document and carried no running balance, and this session had already deferred
the importer at his own instruction — so $10,499.17 of real activity sat
unrecorded while money transferred to Wells Fargo left the tracked ledger with
no destination.

**39 rows imported · 0 deduped · 0 quarantined**, through a real
`ParserProfile` (`rocket-money-csv`), not a one-off script.

### 1.1 ⛔ The allowlist is load-bearing, not a convenience filter

`dedupe_hash` is `sha256(account_id, posted_on, amount_cents, **RAW
description**, occurrence_index)` and this file's raw text is **not the bank's**
— Rocket Money rewrites descriptions (`SQ *YA-FIT SMOOTHI` loses its `SQ *`).
The export carries **7,065 rows across nine accounts**, seven of which the
ledger already holds from real statements, and those rows would hash differently
from the bank's own. Without the allowlist it would have inserted ~7,000
plausible duplicates that **no gate would catch**: reconciliation only runs on
periods carrying printed balances, and this file has none.

### 1.2 🔴 A FORMAT can lie about how much a file can be trusted

`FORMAT_PRIORITY` ranks `csv` (1) **above** `pdf` (2). Ranked by format alone
this third-party re-export was more trustworthy than every PDF statement in the
app — and ownership is decided by `coveredBy.some(r => r.priority < myPriority)`,
so the days it covers would have been OWNED by it and **a real Wells Fargo
statement would have had every row silently dropped as `skippedOwned`.** An
incomplete export would have permanently blocked its own replacement.

`PROFILE_FIDELITY` (`src/services/import/service.ts`) now ranks
`rocket-money-csv` at 9, below everything, which routes it into machinery that
already existed: the **takeover path supersedes a lower-fidelity source's rows**
when a better file covers the same day. When the statement arrives it REPLACES
this export, and nothing has to be deleted by hand first.

> **If you add another fallback source, put it in `PROFILE_FIDELITY` too.** The
> default is its format's rank, and for a secondary export that default is
> exactly backwards.

### 1.3 🔴 The export is INCOMPLETE — and that is why the anchor was refused

The 39 rows sum to **$2,396.67** and the first of them is the account's opening
deposit, so arithmetically that IS the closing balance **if no row is missing**.
Supplying it as a `ledger` anchor would have been a plug: an anchor exists to
PROVE no row is missing, and one derived from the rows it checks proves nothing
(pass 59). So it was refused, and the owner was asked instead.

**His bank app says something else.** The export is missing rows. That is the
strongest possible vindication of refusing to derive the anchor — and it is why
Wells Fargo stays honestly unverified.

### 1.4 🔴 The normalizer could not learn from Wells Fargo AT ALL

Wells Fargo wraps every purchase in `PURCHASE AUTHORIZED ON MM/DD … S<19
digits> CARD <4 digits>`, and **that reference is unique per transaction**. So
every Wells Fargo row normalized to a string nothing else could ever equal —
and **1,741 of the merchant map's 1,802 aliases match `exact`**. 38 of 39 rows
landed uncategorized, and the map could not have learned from them either: every
alias it learned would have been single-use, one dead entry per transaction.

Normalizer **v2** strips the envelope, *before* the processor prefixes it hides.
The result is the string the ledger already knows: `LA PISCINE MIAMI BEACH`,
exactly the alias Chase Sapphire taught it. Blast radius measured before the
change — **29 rows, all Wells Fargo**, nothing else uses that shape.

⚠️ `normalized_description` is stored at import time, so the change did nothing
for existing rows until a guarded backfill. `NORMALIZER_VERSION` is now 2 and
**nothing re-normalizes on a version bump** — a backfill is manual.

### 1.5 What was filed, and what was deliberately not

| | rows | |
|---|---|---|
| he answered himself | 9 | his own Zelles (REF-matched), dad's rent money + a cousin's gift → Gifts received, Flamingo rent, the Capital One payment |
| unanimous precedent elsewhere | 10 | YA-FIT, PURA VIDA, EL COCO LOCO, FLAMINGO FOOD, 6800 BRICKELL CITY (a parking garage) |
| **flagged for review, not guessed** | **10** | see below |

⛔ The third group is deliberate. TACO STAND, THE EMPANADAS, DONUT GALLERY, WRAP
PIT STOP, OCEAN CINEMAS and MOVE FITNESS have **no precedent**, and reading a
category off a merchant NAME is the move that put a $0.42 metro fare in "Dining
& Drinks". CANTEEN and SUFRAT **do** have precedent and it is **split** (39
Groceries vs 14 Dining; 3 Delivery vs 1 Dining) — a coin toss with extra steps.
Only **unanimous** precedent was applied automatically.

---

## 2. Pass 66 — provenance

`src/services/provenance.ts` joins the four tables that already held the chain
(`import_files`, `statement_periods`, `balance_anchors`, `daily_balances`) for
four figure kinds. `<ProvenancePopover>` renders it beside the figure.

Wired: **dashboard hero · account balance · statement periods · transaction
sheet**.

### 2.1 🔴 Four defects it shipped and then caught

| what | how it was caught |
|---|---|
| **`carried` read as weak** → "0 of 12 accounts add up" on a ledger with ZERO gap days | running the probe on real data |
| **the panel inherited `uppercase`** from the `<h1>` it mounts inside — "39 ROWS BUT NO RECORDED BALANCE" | screenshotting it |
| **the badge grew every page by 4px**, turning a 248-pixel annotation into a 60,638-pixel diff | measuring `h1.offsetHeight` |
| **a row from any file read `sourced`** — a green "on a statement" badge on the least trustworthy file in the app | opening the sheet and reading it |

None of the four was visible to tsc, and none to any assertion that existed at
the time. **`carried` is the one to remember**: `deriveForward` writes
`sawTxn ? "derived_unverified" : "carried"`, so `carried` means *nothing has
happened since the last recorded balance* and the number is exactly as proven as
its anchor. Today is almost always after the newest statement with nothing
posted since, so most accounts read `carried` on most days.

### 2.2 The rules the primitive encodes

- **Beside the figure, never around it** — wrapping is axe `nested-interactive`.
  An e2e test asserts the structural rule directly.
- **Popover, not Tooltip, for a mechanical reason** — a Tooltip's body is live
  DOM while closed, so its text collides with page assertions; `Popover` gates
  children on `open`. That is why this panel can name amounts, files and dates.
- **`-my-0.5 py-0.5`** — the negative margin cancels the padding's contribution
  to the line box. An annotation on a figure must not move the figure.
- **`normal-case tracking-normal font-normal`** on the panel — it renders as a
  SIBLING wherever it is mounted, so it inherits the label's typography.
- **A composite figure names its own badge word.** The weakest-verdict rule is
  right about correctness and wrong about vocabulary: net worth took `unknown`
  from one empty account and read "no basis yet" beside a figure where 6 of 12
  accounts add up.
- **An empty account is not a weakness**; an account with rows and no balance is
  a **hole**, and gets named with its amount.

### 2.3 What it says on his real ledger

> 6 of 12 accounts add up against a document, 2 are priced from holdings, 4 have
> nothing checking them. A total is only as proven as its weakest part.
> ⚠️ Wells Fargo Everyday Checking holds 39 rows worth $2,396.67 that this total
> cannot see, because it has no recorded balance.

Verdict spread over the 400 most recent rows: **sourced 233 · derived 124 ·
unknown 39** (exactly the Wells Fargo rows) **· manual 3 · unverified 1**. 89%
read as proven, so the badge is not crying wolf — which is the only way it stays
worth reading.

### 2.4 The shape the remaining pass-67 surfaces should share

Category totals, budget actuals, holdings and recurring amounts are all
**aggregates over transactions**, so they want one helper rather than four:
given a row set, report *"N rows from M source documents; K entered by hand; the
weakest day among them is X"*. `weakestVerdict` and `ProvenanceInput` already
exist for it. Add the `FigureRef` kinds, not a second service.

---

## 3. ⛔ Insights everywhere — read this before starting it

Added as **PHASE III-B** (passes 72a–72d) in `docs/program-passes-60-94.md`.

**It has been attempted and it failed a review.** Pass 46 built exactly this,
routed every figure through app-computed `{{f7}}` slots so the model could never
emit a digit, wrote a validator, and then **ran that validator against 17 attack
strings. SIXTEEN WERE ACCEPTED**:

| accepted | why it is false |
|---|---|
| `"{{f1}} is your largest spending category"` | f1 is the **third** largest |
| `"has been climbing since July"` | invented trend; no trend data exists |
| `"used about ½ of its plan"` | `/\d/` has no `u` flag, so `½` is not a digit |

**Slots block fabricated NUMBERS and do nothing about fabricated
RELATIONSHIPS**, and a denylist of quantity words is unwinnable. The root cause
is that `Fact` carries only `display: string`, so no comparison, ordering, delta
or trend claim is verifiable **even in principle**. Restart from the type
(`Fact.value?: number` plus a `kind`), not from the top. Full plan in 72a.

---

## 4. Notes that keep costing time

- ⚠️ **A guard is the riskiest code in a pass** — three failed before passing
  this session, all mine: `-Math.round(0)` really is `-0`; a guard rebuilt a
  10,111-element string per element and **exhausted the V8 heap after the write
  had landed**; and the review queue is a **SET**, not a counter (filing a row
  clears its flag, and some rows being flagged were already in it).
- ⚠️ **Mutation-test an escape hatch specifically.** The new dynamic-route
  matcher in `overflow.spec.ts` passed its own test while returning `true` for
  everything. Two explicit assertions now pin it in both directions.
- ⚠️ **zsh does not word-split**, and **the Bash cwd persists across calls**.
- ⚠️ **`sharp` is a transitive dep** — `scripts/crop-visual-diff.mjs` resolves
  it out of `node_modules/.pnpm`, and clamps its extract box **per image**
  because a layout shift gives the two PNGs different heights.
- ⚠️ **The owner runs his own dev server on :3000 with REAL data.** It is the
  fastest way to screenshot a change against the real ledger — `data/capture-*.mjs`
  (gitignored) drive Playwright against it. Do not kill it.
- ⚠️ Regeneration must run **WITHOUT `E2E_GATE=1`** (a gate run refuses to write
  a missing baseline). Verify with it.
- `data/app.db` is a 0-byte stub; the real database is **`data/moneyapp.db`**.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`

---

## 5. Still open

- **Pass 67's remaining surfaces** (§0.1) and **PHASE III-B** (§3).
- **The Wells Fargo balance** — his to supply. Until then the account is a named
  hole in net worth, which is at least now visible.
- **10 Wells Fargo rows in the review inbox**, deliberately (§1.5).
- **45 `WEIXIN*` rows, $340.00**, deliberately left in bare `Shopping` — the
  Chase descriptor is hard-truncated at 22 characters, so nothing in the ledger
  can identify them.
- ⚠️ **`docs/income-ground-truth.md:40` still says income ≈ $119,982.68.** The
  measured, guarded figure is **$117,924.62** and has been stable across four
  passes. That line is a dated pass-18 annotation; correcting it means tracing
  the difference, which is its own job.
- **Capital One 360 Checking is empty** — the export holds two rows for it
  ($1,047 out, $0.02 interest) with no opening deposit, and importing a lone
  outflow would leave it reading −$1,046.98.
- **FPL's 2026-07-28 charge is still untagged**, correctly.
- **69 exact opposite transfer pairs** unlinked; **24 transfer groups with one
  active member**.
- **`notFound()` returns HTTP 200** app-wide from force-dynamic pages.
- **`/merchants/[id]` still has no visual baseline** — the last uncovered route
  now that `/imports`, `/categories` and `/summary/[year]` have landed.
