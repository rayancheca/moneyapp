# Handoff — continue where the last session left off, then work the queue

> **Supersedes `HANDOFF-2026-08-25-next-session.md`.** That brief's job (the
> recurring calendar) is done; §1 below records what it got right and what it
> got wrong.
>
> **`main` = `a3a780b`**, tree clean, pushed. tsc clean ·
> **186 files / 3,508 unit** · coverage gate exit 0 · `pnpm ledger-check` exit 0 ·
> **E2E_GATE=1: 458 passed**, zero failed, zero flaky, zero skipped.
>
> Live ledger: 10,072 active rows · **0 flagged for review** · 12 live recurring
> series · 282 tagged rows.
>
> Nothing is half-built. Eight commits shipped and every one is reviewed.

---

# ⛔ 0. THE JOB — work the queue below, in order

The owner approved this queue explicitly and asked that the next session
**continue where this one left off and then proceed with the plan**. Do not
re-litigate the ordering; it is his.

1. **The Wells Fargo importer** (§3) — he asked for it by name.
2. **`Dining & Drinks → Shopping`** — 101 rows his Rocket Money export files as
   food that this ledger files as Shopping. **He is right and the ledger is
   wrong.** (§2.1)
3. **ATM withdrawals categorised by what the cash was spent on** (§2.2).
4. **The 287 `Uncategorized → Reimbursements` rows** — confirm the direction,
   change nothing unless it fails to hold up (§2.3).
5. One decision is **still open and is his**: whether to rename
   `Transfers > Family pass-through` to just `Pass-through` (§2.4).

The Rocket Money export lives at
`/Users/rayankarimcheca/Downloads/2026-08-25T18_34_42.633Z-transactions.csv`
(7,065 rows, 2022-08-25 → 2026-08-24). ⚠️ It is in `~/Downloads`, not the repo,
and it is **not** a source document — see §3.3.

---

## 1. What the last session did, and what it got wrong

### 1.1 The calendar (the previous brief's job) — done, and its premises were wrong

The brief said the calendar was empty because rows were untagged, and that the
fix was mostly a rendering change. Half right:

- ✅ **The rendering fix was real.** `status IN ('detected','confirmed')` erased
  172 of 274 tagged rows — every `ended` series. History now draws
  detected|confirmed|**ended**; the FORECAST still draws detected|confirmed only,
  because an ended series' future is not real. 2026-04 went from **0 entries to
  9**.
- ❌ **`dismissed` must stay hidden**, which the brief did not say. Dismiss is
  labelled "Not recurring" in the UI. Its 45 rows are real transactions that are
  not a series.
- ❌ **The brief said 2 of August's 6 red ✕ were real. All six were false.**
  Both survivors were wrong for reasons the brief never considered — see §1.2.

### 1.2 🔴 Three separate ways this app was asserting failure from absence

All three are fixed. They are listed because the SHAPE keeps recurring:

| what it claimed | why it was wrong |
|---|---|
| "missed" on an unimported day | statements land weeks apart; absence of evidence |
| "missed" on a payday | cash income never touches a bank statement at all |
| "missed" from a date guessed off ONE posting | FPL's due date was extrapolated from a single charge and was **wrong by 13 days** |

The last one has a subtle rule worth keeping: **zero postings is trustworthy,
one or two is not.** A series with no postings had its date typed by a human
(the car lease); one with one or two had it extrapolated by the detector from
too little. `scheduleIsProven` in `recurring-calendar.ts`.

### 1.3 🔴 The defect this session shipped and then caught

Absorption (§1.4) pulled 7 rows into PURA VIDA and YA-FIT and pushed their amount
CV to **0.672 and 0.463 against a gate of 0.2** — three times the bar that
admitted them — and nothing re-checked. The app became more confident and less
right in the same commit. Fixed: a DETECTED series is now held to its own bar on
absorption; CONFIRMED series are exempt because the owner has vouched for them
and several are legitimately variable (rent CV 0.326, FPL a utility bill).

⚠️ **Gap consistency looked like the obvious discriminator and is NOT.** Measured:
PURA VIDA 0.78, Rocket Money 0.73, rent 0.00, Breezeline 0.00. Any threshold
killing the café kills the rent. What separates them is **distinct amounts** —
Rocket Money bills 1 distinct amount in 16 charges, the café 7 in 10.

### 1.4 Detection now absorbs charges that were already its own

Three keys were failing at once — the descriptor group carries the ACCOUNT (PURA
VIDA's series lives on Venture X, six of its charges on Chase Sapphire),
hand-created series carry no `merchant_id`, and a single new charge is under
`MIN_OCCURRENCES`. +8 rows on the live ledger; the Breezeline charge the calendar
had been calling *missed* is now `paid`.

### 1.5 The calendar's visuals

Owner: *"i can barely understand it"*. The cell was spending its loudest channel
(colour) on epistemic STATE while the content — money moving — had none.
Direction owns the fill now; state keeps the glyph and the bar treatment.
Merchant tiles carry brand logos (simple-icons, CC0, vendored at BUILD time —
the CSP has no image host and the app promises the data never leaves the Mac)
over category hues. A two-line month strip shows posted vs scheduled, and the
GAP between them is the cash-timing story.

⚠️ `calendar-heat.test` measures the tint's contrast rather than eyeballing it.
The first version shipped at 14% and dropped `--ink-faint` to 4.03:1 in dark.
**Do not raise `HEAT_RANGE_PCT` without re-running it.**

### 1.6 Per-row categorisation in the review inbox

The cluster card offered only "Confirm all N" / "Recategorize all N". His seven
Zelle payments were one cluster and **four different counterparties**. Each row
now has its own picker plus a "show all N".

---

## 2. The queue, measured

The comparison matched **6,689 of 7,065 rows (94.7%)** on (date, amount),
yielding 312 distinct (their category → mine) pairs, 243 disagreeing.

### 2.1 🔴 `Dining & Drinks → Shopping` — 101 rows, $803. HE IS RIGHT.

The rows are **RAM'S VILLAGE** and **CASTAWAYS** — a bodega and a bar — filed as
Shopping. Take his category wholesale here.

⚠️ Match on (date, amount) and require a UNIQUE hit. Of 39 `Weed` rows only 22
matched uniquely; the other 17 collide with same-day same-amount siblings
(several $20 ATM withdrawals on one day) and **picking between them is inventing
a link**. Expect the same rate here.

### 2.2 ATM withdrawals, by what the cash bought

He tagged ATM withdrawals in Rocket Money by purpose — 13 of the 22 `Weed` rows
were ATM withdrawals. His words: **"3. categorise by what i spent on"**.

⚠️ There is a third design he also liked: the withdrawal is a transfer INTO
`Cash on Hand` and the spend is recorded when it leaves. That cannot be applied
retroactively — Cash on Hand is a float tracked only from **2026-08-03** and its
earlier history must never be backfilled. So: purpose-categorise the historical
withdrawals, and raise the wallet design with him for future ones.

### 2.3 `Uncategorized → Transfers > Reimbursements` — 287 rows, $7,965

His export left them blank; this ledger classified them. **Probably nothing to
do.** Confirm a sample holds up and move on.

### 2.4 ⛔ OPEN, and his call: rename `Family pass-through`?

$3,000 across 2026-05-12 and 2026-05-18 sits in `Transfers > Loans`. His account:
*"my girl giving me money to send to her but i had to take it back out cause she
changed her mind."* That is a pass-through and the only category shaped for it is
named **Family** pass-through, which she is not. **Ask before renaming.**

### 2.5 What must NOT be imported from the export

**Their `Income` column.** It totals $231,963 over 254 rows, of which at least
$65,743 is family money and his own inter-account transfers. He agreed: *"i was
categorisng my parent money as income and youre categorising as transfers or
gifts or something else which makes sense"*.

🔴 **The ledger's income figure was never wrong, and this is now proven.** Their
export calls all 51 cash deposits Income ($60,848); this ledger had already split
them six ways and put exactly two into `Income > Salary` — $1,047.00 and $400.00,
both Miami ATMs — totalling **$1,447.00**, which is precisely the banked cash-job
figure measured independently in pass 60 against $12,552 of implied earnings.
A guard on the last write measured total income before and after:
**$117,924.62 both times.**

---

## 3. 🆕 The Wells Fargo importer — he asked for it by name

### 3.1 Why it exists

The export settled that **"Carson Lama" is his own Wells Fargo Zelle handle**:
`EVERYDAY CHECKING ...5481`, opened **2026-07-27**, and the $1.00 and $199.00 he
sent on 07-29 arrive there as *"ZELLE FROM RAYAN KARIM CHECA"* — the exact rows
filed as `Internal Transfer` this session. The account now exists in the ledger
and is **EMPTY**; a guard asserted that.

There are **39 Wells Fargo rows in the export, $10,499.17**, all 2026-07-27
onward. Until they land, money transferred to Wells Fargo leaves the tracked
ledger with no destination and net worth understates.

### 3.2 How to build it

The architecture is `ParserProfile` in `src/services/import/profiles/`, each with
a `matches: (f) => boolean` predicate and a row mapper, registered in `PROFILES`
(`profiles/index.ts`). `capOne360Csv` and `chaseDepositCsv` in `csv-profiles.ts`
are the closest models. Every existing profile has a `*.test.ts` beside it.

Wells Fargo's CSV export is conventionally **headerless**, five columns:

```
"07/29/2026","199.00","*","","ZELLE FROM RAYAN KARIM CHECA"
 date          amount   *  blank  description
```

That headerless shape is distinctive enough to match on, and unlike every other
profile it cannot key off a header string — `matches` will have to sniff the row
shape. ⚠️ **Do not take that format on faith.** It is from general knowledge, not
from a file anyone has looked at. Ask him for a real Wells Fargo export first.

### 3.3 ⚠️ The Rocket Money CSV is NOT the import path

It is tempting — 39 rows are sitting right there. Resist it:

- It is a **secondary export**, not a statement. This app's standing rule is that
  every number traces to a source document, and a re-export of somebody else's
  categorisation of a bank's data is two removes from one.
- It carries **no running balance**, so nothing can reconcile. `daily_balances`,
  the anchor chain and `ledger-check` all rest on balances.
- Its amounts are **sign-inverted** relative to this ledger (positive = money
  out) and it contains visible duplicates (`CAST IRON POT FLUSHING` ×3).

Build the profile, then import a real Wells Fargo statement or CSV through it.

### 3.4 ⛔ Always `pnpm trial-import` first

Pass 52's lesson: a bank changing how it prints a number makes rows
**DISAPPEAR, not fail**. Chase printing `.78` instead of `0.78` silently dropped
71 charges. Only the trial import caught it.

---

## 4. Notes that keep costing time

- ⚠️ **The owner runs his OWN dev server on :3000** — do not kill it, curl it.
  `.claude/launch.json` uses :3111, which is also the port `pnpm e2e` wants, so
  stop any preview server before running the gate.
- ⚠️ **`Desktop/` is iCloud-synced.** It produces `"… 2.png"` conflict copies
  during rapid baseline regeneration and once made `next build` fail with
  `ENOTEMPTY` on `.next/build` (fix: `rm -rf .next`).
- ⚠️ **Never pipe a gate run through `tail`** — capture the whole log.
- ⚠️ **The Bash tool caps `timeout` at 600000ms.** Passing more is silently
  clamped to 10 minutes, which is shorter than a regen + full e2e run.
- ⚠️ **`maxDiffPixelRatio: 0.001` is ~3,800px of allowance.** After any UI
  change set it to **0**, regenerate by DELETING the PNGs, regenerate ALL of a
  route's baselines, and verify determinism with a second run. 26 baselines were
  regenerated this session; the flat-`maxDiffPixels` fix is **still outstanding**
  and is the right next slice for whoever wants it.
- ⚠️ A guarded write's **guard is the riskiest code in the pass**. One written
  this session read `after.startsWith("") && before.split(",").every(p =>
  after.includes(p))` — the first clause is true for every string and the second
  is a substring test. It could not fail. Parse into maps and compare exactly.
- `data/app.db` is a 0-byte stub; the real database is **`data/moneyapp.db`**.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`

---

## 5. Still open

- **§2.4**, the `Family pass-through` rename — his call.
- **The flat `maxDiffPixels` baseline fix** (§4). The 28-stale-baseline backlog
  is down to ~18: `recurring` (16) and `transactions-review` (10) were explained
  and regenerated this session; `flow-spine` and `flow-tower` (5) are untouched.
- **Pass 66 as originally scheduled** — `src/services/provenance.ts` plus a
  `<ProvenancePopover>` — was never started. `docs/program-passes-60-94.md`.
- **17 of 39 `Weed` rows** unmatched on (date, amount) ambiguity.
- **FPL's 2026-07-28 charge is still untagged**, correctly: its descriptor is
  `FPL DIRECT DEBIT ELEC PYMT PPD ID:…` against a tagged
  `ORIG CO NAME:FPL DIRECT DEBIT…`. A human can see they are the same bill; the
  ledger cannot, and a guessed tag corrupts the calendar, the budget tail and the
  overdue detector at once.
- **Chime** is deliberately not an account — opened for a $300 bonus, closed.
- **The $560.54 on 2026-07-29**, self-to-self, routing 021000021.
- **Dad's remaining ~$5k** via Arno Search Capital LLC; the pass-through legs do
  not cancel.
- **69 exact opposite transfer pairs** unlinked; **24 transfer groups with one
  active member**.
- **`notFound()` returns HTTP 200** app-wide from force-dynamic pages.
- **`/summary/[year]` has no visual baseline**, deferred until the tolerance fix.
