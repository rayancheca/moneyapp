# Handoff — six rules with a second reader, and one decision closed

> ## ➕ 2026-09-09 — THREE MORE, and the sweep in §9 found the first of them
>
> `main` `5f21ffb`, pushed. **4,711 unit** · tsc clean · coverage gate exit 0 ·
> **E2E_GATE=1: 600 passed at `maxDiffPixels: 0` in 8.6 minutes, ZERO baseline
> churn** · `pnpm ledger-check` exit 0 · ledger still 10,178 active rows and 37
> uncategorized, still no DB writes.
>
> ⭐ **The one-caller sweep is the first thing to run, and it paid again.** It
> surfaced `terrainTableCaption`'s blank-account count, which led straight to
> the chart's own accessible name promising a twelfth ribbon.
>
> 1. **⛔⛔ `/imports` — a destructive button that cannot be aimed.**
>    `20230810-statements-3522-.pdf` is THREE rows and two of them render
>    character for character the same, while their confirmations differ by a
>    statement balance that anchors the Chase Checking chain. One accessible
>    name (`un-import <file>`), one headline, nothing saying which. **112 of
>    330 rows share a name; 34 groups are identical in every visible column.**
>    Names repeat because Chase regenerates the bytes and a re-parse makes a
>    third row. Rows with a repeated name now carry their import date, in the
>    cell, the trigger's name and the headline; the other 218 are untouched.
> 2. **The terrain said "12 account ribbons" of a terrain drawing eleven** — the
>    whole figure, for a reader who cannot see it. Both neighbours on that
>    surface already refuse the claim about that account. `drawnRibbonCount` is
>    the count now, and the table caption reads its blanks from it.
> 3. **"3 of 12 accounts were open" on a day the total is built from 2** — on
>    **every one of the 1,440 days that render the clause**, with no gap to
>    explain the third. `splitMissing` has THREE buckets and both surfaces
>    subtracted one. The denominator is now the completeness rule's own
>    (`activeIds − emptyAccounts`), so the numerator equals `coveredAccounts`
>    wherever there is no interior gap, and the empty account is named rather
>    than dropped.
>
> ⚠️ **The dashboard now opens on Terrain.** `viewPreferences.dashboard.chart`
> went `accounts` → `terrain` between the 09-08 and 09-09 daily backups. Not
> this session: every write of that key is a server ACTION, and this session
> only issued GETs. Your own click — noted because it changes which chart the
> first fix above is read on.
>
> ⚠️ **`scripts/read-surface.mjs` reads only the first flush.** A React-streamed
> list looks SHORT against its own count: `/investments/crypto/ETH` showed six
> sell rows under a "7 sells" header, and the seventh was in a later chunk. Check
> the raw payload before filing a count-vs-list mismatch.
>
> Everything below is the 2026-09-08 session and still stands.

> **Supersedes `HANDOFF-2026-09-08-the-confirmations-that-understated.md`.**
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**, `main`, tree clean, pushed.
> tsc clean · **4,693 unit** in ~25s · coverage gate exit 0 ·
> **E2E_GATE=1: 600 green at `maxDiffPixels: 0`** — 590 in one pass and the
> other 10 on a re-run, all of them load flakes (§9) · `pnpm ledger-check`
> exit 0.
>
> Ledger: **10,178 active rows · 37 uncategorized — UNCHANGED.**
> **ZERO real-DB writes.** Nothing was imported, attached, recategorised or
> repaired. All six fixes are defects in what the app SAYS about a ledger that
> has not moved in five days.
>
> **Seventeen baselines regenerated** — nine `/accounts`, eight `series-detail`
> — and they are the whole visible change of the session. Four of the six fixes
> moved no pixel at all.

---

# ⛔ 0. THE JOB — what is next

**The §9.5 decision is CLOSED.** The `±` band on `/recurring/<id>` was put to
you with the measurement before any file was opened; you chose **name the
posted average**, and that is shipped (§6).

**No new decision is waiting on you.**

1. **⛔⛔ `BTLEServer` at 100% of a core.** Still not rebooted — five handoffs
   have now asked. **Reboot.**
2. **28 merchants are still queued for the paid Claude pass.** Unchanged: the
   free pass changes nothing and the paid button is yours. 37 rows have no
   category; coverage reads 99.6%.
3. **Pass 78 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**

---

## 1. ⭐ THE SHAPE OF THIS SESSION: EVERY ONE HAD A SECOND READER

Last session's lesson was *read the dialogs, the pickers and the lenses*. This
session's is the one the prompt led with: **when a docstring names a defect,
grep for the OTHER callers.** Six defects, and all six are a rule that was
written down, fixed once, and then not read by the surface next to it.

| the rule, already written | who had it | who did not |
|---|---|---|
| `overdueCents` — "money committed but missing" | the bar, its `aria-label`, the projection, the page note | the **deactivate confirmation** |
| `terrainRowFigures` — "ONE ANSWER FOR THE WHOLE ROW" | the terrain's Table lens | the **legend on the same screen**, and the table's own **Verified column** |
| `oldestAsOf` — "a single `as of` is only true when they share one" | the dashboard card, `/accounts`' Table lens | `/accounts`' **Cards lens** |
| `agoPhrase` — "today" / "1 day ago" | `/imports`' coverage row | the dashboard's **trust card** |
| `n === 1 ? "charge" : "charges"` | the fees card's **recent** block | the fees card's **all-time** block |
| `postedAvgCents` — the measured centre | `/recurring?tab=all` | **`/recurring/<id>`**, which had the spread and not the centre |

⛔ **`agoPhrase` and `terrainRowFigures` each had exactly ONE caller.** The
2026-09-04 memory's test — `grep -rn <export> src/ | grep -v test`, and if the
count is 1 the second surface is still broken — found both. **Run the sweep in
§9 FIRST next session**; it took ten seconds and paid for two of the six.

---

## 2. ⭐⭐ "$0.00 SPENT" OVER A MONTH ALREADY $2,291.21 OVERDUE

`/budgets` → Housing → **Deactivate**:

    Budget stopped              $2,291.21 / month
    Spent so far this period    $0.00

Every penny of that budget came due on **Sep 1** and never posted. Four inches
behind the dialog the row says so in warning colour — *"$2,291.21 expected by
now, not imported · Flamingo South Beach (rent) Sep 1, Rent utilities & fees
Sep 1"* — the bar's `aria-label` says it in words, `projectSpend` counts it, and
the page header counts it across three budgets and adds *"That money is
committed, so the room left is smaller than it looks."*

The dialog listed `expectedTailCents` and stopped. That field is the FORWARD
tail by construction; the backward half is `overdueCents`, a first-class field
on the same status object. **Three of the twelve budgets understated** — Housing
by $2,291.21, Utilities by $108.87, and Subscriptions naming $6.00 of a $10.99
month.

`budgetDeactivateLines` is the radius with one home now, pure and unit-tested,
because a `<dialog>` paints no pixels and the seed has no overdue budget.

---

## 3. THE LEGEND THAT PRINTED WHAT THE CAPTION HAD JUST REFUSED

`/?chart=terrain&terrainLens=table`, one screen, two halves:

    the table    Capital One 360 Checking   Held   —   —   —   every span
    the caption  "1 account has no reconstructed day at all, and its row is
                  left blank rather than read as zero"
    the legend   01  Capital One 360 Checking   level since —      $0.00

Two defects. The legend kept its own `deltaCents === 0 ? "level since"`, its own
`firstDay === null ? "—"` and its own `formatCents(r.lastCents)` — a sentence
with its date missing, and the balance the caption had refused. And the table's
own **Verified** column decided separately: `fullyVerified` is *vacuously* true
with nothing drawn (its docstring says so), so a row of three em dashes ended
**"every span"** — the ledger's strongest verdict over no spans at all.

`terrainRowFigures` answers both now (`since`, `verified`). Nine other rows are
byte-identical.

---

## 4. A TOTAL SPANNING AUG 14 AND SEP 3, WITH NO DATE ON IT

`/accounts` (Cards) read **"Chase · net of what you owe · $3,090.32"** — Chase
Checking's $3,007.60 last covered Aug 14 plus Chase Sapphire's $82.72 last
covered Sep 3.

`InstitutionGroup.oldestAsOf`'s docstring names the two surfaces that already
say so and ends *"This card was the third to ask and the only one still
answering with a single date."* `ManagedAccounts` is a **fourth** reader,
answering with none — and it had already copied the sibling clause beside it
("net of what you owe") and the per-account day-change period from an earlier
pass. Only the as-of clause was left behind.

`asOfSpanTerm` is that clause with one home, beside `dayChangeTerm`. The
dashboard's output is byte-identical.

⚠️ **Nine of the seventeen regenerated baselines are this.** The note moved to its own
line under the institution name — the dashboard card's own layout — because
inline at 320px it broke `as of 2026-07-08` across two lines mid-date.

---

## 5. TWO LATENT ONES THE LEDGER WILL REACH

**"0 days ago", on the day everything is finally checked.** The trust card's
closing sentence is built as `` ` — ${daysSinceChecked} days ago` ``. Import
every account up to date — the state the card exists to push toward — and it
reads "— 0 days ago"; the day after, "— 1 days ago". `agoPhrase` refuses both in
writing, `cards-owed` states the other half (*"'0 days ago' is noise"*), and the
unchecked-days row six lines above already pluralises.

**"1 visits", five times in one card, and one card contradicting itself.**
`EatingOutLine.unit` held the PLURAL, printed as `{count} {unit}`. And the fees
card carries `n === 1 ? "charge" : "charges"` in its recent block and a bare
"charges"/"credits" sixty lines below — one bank fee in the ledger's life and
one card says "1 charge" in its top half and "1 charges" in its bottom.

⛔ **`countPhrase` is the wrong helper here** and the visual gate proved it: it
renders zero as "no credits", which moved eight dashboard baselines for a copy
change nobody asked for. It belongs to a blast radius; a ruled column of figures
keeps its numeral.

---

## 6. ✅ THE DECISION YOU CLOSED — the `±` band

`/recurring/<Flamingo South Beach (rent)>` read **"-$2,109.00 ± 610.65"**. The
± is the sample sd of the four linked charges; their mean is **-$1,739.40**. A
band centred on a number nothing inside it was drawn from.

    Flamingo South Beach (rent)  -$2,109.00 ± 610.65   4 charges, mean -$1,739.40
    Cash job (weekly pay)        +$1,047.00 ± 457.50   $400.00 and $1,047.00
    Breezeline (internet)          -$50.00 ± 5.59      3 charges, mean -$46.77

You chose: **name the posted average and hang the ± on it**, in the wording
`/recurring?tab=all` already uses for the same pair. The headline stays the
forecast amount — it is what the forecast projects and what ANNUALIZED is built
from. Where the two agree there is one number and no line is drawn (Amazon
Prime, Chase Sapphire annual fee).

Live after the fix:

    Flamingo South Beach (rent)   -$2,109.00  posted avg -$1,739.40 ± 610.65
    Cash job (weekly pay)         +$1,047.00  posted avg   +$723.50 ± 457.50
    Breezeline (internet)           -$50.00   posted avg    -$46.77 ± 5.59
    Amazon Prime                     -$4.99   (no sub-line — the two agree)

⭐ **And the visual gate went red for it** — eight `series-detail` baselines.
The seed's rent series is a "1 matched" case, forecast -$1,800.00 against a
single posting of -$2,150.00, so the mismatch was DRAWN in the fixture all
along. After two handoffs whose headline was "the gate saw none of it", this
one it saw first.

---

## 7. ✅ WHAT WAS CHECKED AND FOUND RIGHT

Hours of arithmetic that found nothing, recorded so the next session does not
repeat it. **Every figure below reconciled to the cent.**

- **The whole dashboard closes.** Runway ($5,518.26 cash, −$842.89 cards,
  $4,675.37 net, 1.0 months), the car ($1,310.70 all-in over 24 months), earned
  vs banked (14 paydays, $14,658.00 implied, $1,447.00 banked), cards owed
  (60%/40% of $925.61), eating out (437 purchases, $23.09 a ticket, 2.4 a day),
  subscriptions ($3,753.08 over 13 lines), what changed (six movers summing to
  $3,040.49), fees ($313.45 − $26.00 = $287.45; all-time $2,439.68 − $996.64),
  the flow card (89 of 112 departures, $66,808.98 = routes + $24.27),
  concentration (ETH 33.6% of the portfolio, 32.2% of net worth, 7.8× the rest),
  and the trust card (7+2+2+1 = 12, 53 of 7,476 days).
- **`/accounts?view=table` closes both ways.** Eight held + three owed =
  $114,498.97 − $842.89 = $113,656.08; every share, every 30-covered-day window,
  every high/low, and the change column summing to +$19,364.30.
- **The forecast closes.** 24 components → −$4,149.52; nine committed lines →
  $3,567.60; running-late $69.86 and never-billed $977.25 partition it; EOM cash
  $5,091.66 and EOM net worth $113,229.48 both derive.
- **The recurring calendar closes.** Expected +$1,869.60, not-yet-known
  $3,343.20 over 4 items (a MAGNITUDE sum: the signed total is −$1,249.20, which
  is what makes the month +$620.40), lowest −$2,291.21 on Sep 1.
- **The flow matrix closes.** 20 routes, 753 transfers, out = in = $415,945.05,
  net $0.00, round-trip 25.9%, plus 24 unmatched groups of 12,697.00 = 777.
- **The bridge closes.** Eight bands summing to +$47,186.35; the table lens'
  "share of movement" is each band over the sum of ABSOLUTE bands ($209,034.63),
  which is why they do not sum to 100.
- **The relief closes.** "8 category blocks" over 12 categories — the eighth is
  "5 smaller categories, −$490.24, 13 entries, $571.87", and the 8 heights do
  sum to +$588.75. 181 entries.
- **`/summary/2026` closes.** 10,832.79 + 1,583.05 + 21,595.03 = $34,010.87, and
  11 named documents.
- **The transfers card's "163 more transfer rows"** is a real windowed count
  (Reimbursements 84 + Transfers 55 + Pass-through 18 + Gifts 5 + Loans 1), not
  the coincidence it looks like beside the Transfers parent's 163 lifetime rows.
- **"26 days unchecked, of 52 in all"** is the OPEN RUN and the total, and
  `/imports` says the same pair in its own words.
- **The un-import dialogs are per-file.** Three Robinhood PDFs with 0
  transactions really do each carry 4 balances and 2 periods.
- **"Capital One" missing from the Add-an-account picker** is deliberate and
  documented — picking it would anchor a wallet on today.
- **`/recurring`'s "4 running late and 3 never charged"** lists all seven; I
  miscounted a `sed` range first.
- **`/investments/crypto/ETH` "7 sells" over 6 rows** is a STREAMED seventh row
  (`$201.87 − $201.31`, +$0.56) — see §10.

---

## 8. ❓ DELIBERATELY LEFT ALONE, WITH THE REASONING

1. **The account-page balance TABLE is headed "Balance" for a credit card**,
   whose page header says "Amount owed" / "In credit", and its values are in the
   owed frame (Aug 23 `$1,160.68`, Sep 3 `-$82.72`) — the opposite sign to
   `/accounts?view=table`'s "Balance" column for the same account. Both are
   standard: a card statement's balance IS positive-when-owed, and the accounts
   table names its own frame in the caption *and* says "Elsewhere a card reads
   as what you owe". Same family as the last handoff's §9.1, which you left.
2. **`/recurring/<Parking>` shows no category chip** although the series carries
   `user_category_id = Parking & Tolls` and `/categories/<Parking & Tolls>`
   lists it. The chip is the **modal category of the linked charges** by design
   (`recurring-detail.ts`), and Parking has none. A gap, not a false sentence.
3. **`/recurring/<Hoffman LL>` says "charges monthly around the 8th"** over its
   one charge, dated the 2nd. The day comes from a stored `next_expected_on` of
   2026-02-08 on an ENDED series. Nothing else reads it; touching it means
   deciding what an ended series' cadence sentence should say at all.
4. **Six local copies of `plural(n, one, many)`** — now seven, with `counted` in
   two dashboard cards. Still the last handoff's §9.4 reasoning: they all agree,
   so no surface disagrees with another. Consolidating them is a refactor.
5. **The merchant "Flamingos Restaurant" is the RENT**, default category Rent,
   one charge of $2,285.70 on Jul 8 — and it is what the dashboard's "Worth a
   look" card names as a first sighting. `scripts/rename-flamingo-merchant.ts`
   exists. **This is a DB write and therefore yours**, not a code defect.

---

## 9. NOTES THAT COST TIME, AND WOULD AGAIN

- ⛔ **`scripts/read-surface.mjs` READS THE FIRST FLUSH, NOT THE STREAM.** A
  list rendered inside a Suspense boundary arrives as a later RSC chunk and is
  simply absent. `/investments/crypto/ETH` printed "7 sells" over six rows and I
  nearly filed it; the seventh is in the payload as `$L265`. **Any "count over a
  shorter list" must be checked against `curl | grep` before it is a defect.**
- ⛔ **A `sed` range is not a reading.** `/recurring`'s evidence note looked
  short by two for the same reason. Print to a file and `grep -c`.
- ⛔ **Do not run `npx prettier` in this repo.** There is no config, so it
  reflows at printWidth 80 against a house style of ~100 and turns a 40-line
  edit into 328. Hand-indent instead.
- ⛔ **`countPhrase` is for a blast radius.** It renders zero as "no credits";
  using it in a ruled column moved eight dashboard baselines for a copy change
  that was not the defect. The visual gate caught it — one of the few times it
  has had something to catch.
- ⚠️ **The visual gate is only blind where the fixture is thin.** It went red for
  the `/accounts` fix immediately, and for the `countPhrase` slip. Read what it
  says before regenerating: `node scripts/crop-visual-diff.mjs <test-results
  dir> <baseline-name>` writes cropped expected/actual pairs to `/tmp`, and both
  diffs here were legible in one glance.
- ⚠️ `pnpm build` cannot run beside `next dev` — both own `.next`. Kill the dev
  server first (standing permission), rebuild, gate, restart.
- ⛔ **THE MAC IS THE BOTTLENECK, and it shows up as e2e "failures".** Measured
  today: load average 8–15, with `mediaanalysisd` at 103%, **`BTLEServer` at
  98%** and `fseventsd` at 85%. The full suite took **57.8 minutes instead of
  8.7** and reported eighteen failures; a re-run reported **ten, and a
  DIFFERENT ten**. Every one of them passed alone. The tells are in the log:
  *"Failed to take two consecutive stable screenshots"*, *"Timeout 5000ms
  exceeded"*, and a spec that normally takes 2s taking 15.3 minutes. **A
  multi-minute duration is a load flake, not a regression** — re-run the subset
  before believing it, and crop any visual diff before regenerating (the four
  that looked like content were the net-worth chart still animating in).
- ⚠️ `npx vitest run --maxWorkers=4` — 4,693 in ~25s. Coverage:
  `npx vitest run --coverage --maxWorkers=4`. Full e2e ≈ 9 minutes on a quiet
  machine, and the machine was not quiet.
- ⚠️ **`--update-snapshots` on the CLI overrides `updateSnapshots: "none"`.**
  `E2E_GATE=1 npx playwright test <spec> --grep <name> --update-snapshots`
  writes the PNGs and passes. The standing note about regenerating without
  `E2E_GATE=1` applies to the config default, not to the flag.
- ⚠️ **`data/moneyapp.db`'s mtime moves without a logical write.** It now reads
  2026-09-08 15:10, which is when the dev server was killed and SQLite
  checkpointed the WAL. Row counts are the invariant, not the timestamp:
  10,178 active and 37 uncategorized, both unchanged.
- ⛔ The dev server on :3000 was restarted at the end, as it was found.

### The rule-with-one-caller sweep, as a script

Paste this to find every exported function whose docstring names a defect and
that has one caller or none — it is what found `agoPhrase` and
`terrainRowFigures` in ten seconds:

```bash
python3 - <<'PY'
import os, re, subprocess
names = {}
for root in ["src/lib", "src/services", "src/components"]:
    for dp, _, fs in os.walk(root):
        for f in fs:
            if not f.endswith((".ts", ".tsx")) or ".test." in f: continue
            p = os.path.join(dp, f); src = open(p).read()
            for m in re.finditer(r"^export function ([A-Za-z0-9_]+)", src, re.M):
                pre = src[:m.start()].rstrip(); doc = ""
                if pre.endswith("*/"):
                    i = pre.rfind("/**")
                    if i >= 0: doc = pre[i:]
                names[m.group(1)] = (p, doc)
for n, (p, doc) in sorted(names.items()):
    if "🔴" not in doc and "⛔" not in doc: continue
    hits = subprocess.run(["grep","-rln",r"\b%s\b" % n,"src/"],
                          capture_output=True, text=True).stdout.split()
    callers = [f for f in hits if f != p and ".test." not in f]
    if len(callers) <= 1: print(len(callers), n, p, "->", callers)
PY
```

---

## 10. WHAT WAS MEASURED, AND WHEN

Every figure here is **as of 2026-09-08**, read off the running app. Net worth
read $113,656.08 throughout and nothing this session moved it.

Confirmed live after the fixes, read off the page text:

    /budgets               Housing deactivate: "Spent so far this period: $0.00.
                             Already due this period, not imported: $2,291.21."
                           Subscriptions: "…$4.99. Recurring still expected
                             this period: $6.00."
                           Utilities: "…Already due this period, not imported:
                             $108.87."
    /?chart=terrain        legend "01 Capital One 360 Checking · no reconstructed
      &terrainLens=table     day yet · —"
                           table  "Capital One 360 Checking · Held · — · — · — · —"
                           the other nine rows byte-identical
    /accounts              "Capital One  as of 2026-08-17 · net of what you owe"
                           "Chase  each as of its own last covered day,
                             2026-08-14 – 2026-09-03 · net of what you owe"
                           "Robinhood  each as of its own last covered day,
                             2026-08-28 – 2026-09-03"
                           "SoFi  as of 2026-08-05" · "Wells Fargo  as of 2026-08-26"
    /recurring/<rent>      "-$2,109.00  posted avg -$1,739.40 ± 610.65"
    /recurring/<Cash job>  "+$1,047.00  posted avg +$723.50 ± 457.50"
    /recurring/<Breezeline> "-$50.00  posted avg -$46.77 ± 5.59"
    /recurring/<Amazon Prime> "-$4.99" — no sub-line, the two agree
    /  (dashboard)         unchanged, byte for byte, in both the deck and grid lenses

---

# 📋 THE PROMPT FOR THE NEXT SESSION

> Read `docs/HANDOFF-2026-09-08b-the-second-reader.md` first — it is the brief.
> §0 of it is the job.
> Repo `/Users/rayankarimcheca/dev/MoneyApp`, `main` clean and pushed. Baseline:
> 4,693 unit in ~25s · tsc clean · coverage gate exit 0 · `E2E_GATE=1`:
> 600 green at `maxDiffPixels: 0` (10 of them needed a re-run — the Mac, §9) ·
> `pnpm ledger-check` exit 0.
> Ledger: 10,178 active rows · 37 uncategorized. Zero DB writes for three
> sessions.
>
> No decision is waiting on me. The job is the same as the last nine sessions:
> find what is wrong. Do not invent features.
>
> 1. ⭐⭐ **RUN THE ONE-CALLER SWEEP FIRST** — §9 of the handoff has it as a
>    paste-able script. Two of this session's six defects were a rule with
>    exactly one caller and a second surface still printing its own answer.
> 2. ⭐ OPEN THE APP AND READ IT BEFORE YOU GREP IT.
>    `node scripts/read-surface.mjs <route>` renders dialogs, `aria-label`s and
>    `<svg>` names — but it reads the FIRST FLUSH ONLY. A list that looks short
>    against its own count may be streamed; check `curl | grep` before filing it.
> 3. **Prove a new test can fail.** Revert the fix, run the test.
> 4. ⛔ Do not size the e2e fixture from `data/e2e.db` as a run leaves it —
>    reseed first.
> 5. When a figure is right and a sentence about it is wrong, the sentence is
>    the defect — but VERIFY first: §7 is a list of twenty things that looked
>    wrong and were not.
> 6. If you find a decision, put it to me EARLY with the measurement.
> 7. HOSTING goes last. Never propose a hosted-DB migration.
