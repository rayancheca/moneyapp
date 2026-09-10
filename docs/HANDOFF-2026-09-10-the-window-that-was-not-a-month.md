# Handoff — the window that was not a month, and 1,272 checks that came back clean

> **Supersedes `HANDOFF-2026-09-08b-the-second-reader.md`.**
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**, `main`, tree clean, pushed.
> tsc clean · **4,716 unit** in ~25s · coverage gate exit 0 ·
> **E2E_GATE=1: 600 passed at `maxDiffPixels: 0` in 8.5 min** ·
> `pnpm ledger-check` exit 0.
>
> Ledger: **10,178 active rows · 37 uncategorized — UNCHANGED.**
> **ZERO real-DB writes for four sessions.** Every fix is a defect in what the
> app SAYS about a ledger that has not moved since 2026-08-31.
>
> **Eight baselines regenerated, all `merchant-detail`** — and the gate found
> them, which is the second session running that it has not been blind.

---

# ⛔ 0. THE JOB — what is next

**No decision is waiting on you.** The `±` question closed on 2026-09-08.

1. **⛔⛔ `BTLEServer` at 100% of a core.** Six handoffs have now asked. **Reboot.**
   It is why 2026-09-08's suite took 57.8 minutes instead of 8.5.
2. **28 merchants are still queued for the paid Claude pass.** Unchanged. 37 rows
   have no category; coverage reads 99.6%.
3. **Pass 78 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**

---

## 1. ⭐ THE SHAPE OF THIS SESSION: HARVEST THE SENTENCE FAMILY, THEN CHECK IT

The last two sessions read surfaces one at a time. This one **harvested a whole
family of sentences off every page that carries it and checked them against the
ledger in one pass.** That is what found the headline defect, and it is what
proved seven other families right.

    curl every /merchants/<id> | grep -o 'aria-label="How [^"]*"'

851 merchant pages, 497 distinct sentences, in 46 seconds. Then parse the rank,
the share and the window out of each one and check them against SQL.

**What that found:** 193 (category, window) groups whose named shares should sum
to ≤100%. Three did not — Entertainment/Feb 2026 summed to **347%**. §2.

**What it cleared** — 1,272 mechanical checks, every one exact:

| family | checked | disagreements |
|---|---|---|
| category 12-month trend bars (amount + count) | **877** | 0 |
| spending heatmap day cells (gross, count, "mostly", earned) | **166** | 0 |
| merchant rank claims (250) + share groups (193) | 443 | 3 → §2 |
| holding "value = contributed + gains" identities | 33 | 0 |
| un-import dialogs vs the DB | 296 | 0 |
| provenance verdicts, one per claim | 598 | 2 (generic labels, not claims) |
| account / series / category insight rankings + shares | all | 0 |
| `/summary/<year>` document counts, all five years | 5 | 0 |

⛔ **Write the checker to the app's convention, not yours.** Three of the eight
families "failed" on the first run and every one was my own sign or scope
assumption: income bars are positive, heatmap cells are GROSS outflow not net,
merchant ties get sequential ranks. Re-derive the convention from the page before
filing anything.

---

## 2. ⭐⭐ "100.0% OF WHAT YOU SPENT ON ENTERTAINMENT IN FEB 2026" — OF ONE DAY

`/merchants/<Empire City Entertainment Bar>`:

    Seen                          2026-02-07   2026-02-07
    What the ledger says about Empire City Entertainment Bar
    Feb 2026 – Feb 2026
    Empire City Entertainment Bar is 100.0% of what you spent on
      Entertainment in Feb 2026.

One purchase, one day. Of February that merchant is **1.6%**.

The share is measured over `[firstSeen, lastSeen]` — correctly — and the
module's docstring says naming that window is the whole point: *"A merchant's
span is its own, not the ledger's, so 'of what you spent on Transport' with no
dates would be read as all time on a merchant that ran for a month."* The label
then collapsed the span to a MONTH whenever both ends fell inside one, which is
the same error one level down.

**Measured: of the 66 merchant pages carrying this sentence, 28 collapse a
single day into a month label and 44 overstate the month's share by 2× or more.**

    Empire City Entertainment Bar  Feb 7 only   claims 100.0%   is  1.6%   64x
    Churreria La Perla             Jan 2 only   claims  45.2%   is  1.0%   46x
    Droguería y Minimarket         Mar 6 only   claims  63.2%   is  1.6%   41x
    230 Fifth                      Feb 23 only  claims  81.5%   is  6.2%   13x
    Wollman Park                   Feb 16–17    claims 100.0%   is 31.0%    3x

⛔ **`dayWindowLabel` is `period.ts`'s own rule**, exported rather than
re-derived: it already drops what genuinely repeats and never a day. "on Feb 7,
2026" / "over Feb 16 – 17, 2026" / "over Sep 20, 2022 – Jul 6, 2026".

⭐ **AND THE GATE CAUGHT IT.** The seed's merchant runs Jul 3, 2024 → Jul **1**,
2026, so "Jul 2024 – Jul 2026" was a month-collapse the fixture could express.
Eight `merchant-detail` baselines went red at `maxDiffPixels: 0`.

---

## 3. A DESTRUCTIVE BUTTON THAT COULD NOT BE AIMED (2026-09-09)

`/imports` → Imported files. Three rows, two of them character for character
identical:

    20230810-statements-3522-.pdf  chase-checking-statement-pdf  0   Parsed  un-import
    20230810-statements-3522-.pdf  chase-checking-statement-pdf  0   Parsed  un-import
    20230810-statements-3522-.pdf  chase-checking-statement-pdf  85  Parsed  un-import

Their confirmations disagree: one removes **1 recorded balance** — a statement
balance anchoring the Chase Checking chain — the other removes nothing.

Names repeat because Chase regenerates statement bytes (pass 39 recorded that
the sha is no guard) and a re-parse at a new `parser_version` makes a third row.
**112 of 330 rows share a name; 55 names are duplicated; 34 groups are identical
in every visible column.**

Rows with a repeated name now carry their import date — in the cell, the
trigger's accessible name, the dialog headline and (one commit later, because I
missed it) the hover `title`. The other 218 are untouched.

⚠️ **The import DATE separates every collision on this ledger** (measured: zero
groups still collide), and the rule falls back to the minute when one day holds
two of a name — a disambiguator that has not checked its own discriminator has
the defect it exists to fix.

---

## 4. TWO COUNTS THAT INCLUDED SOMETHING THE APP HAS NOTHING FOR (2026-09-09)

**"12 account ribbons" of a terrain drawing eleven.** `Capital One 360 Checking`
has no vertices and no runs, so nothing is stroked for it — `ribbonCount` is how
many accounts were fed in. Both neighbours on that surface already refuse the
claim about that account. `drawnRibbonCount` is the count now, and the table
caption reads its blanks from it.

**"3 of 12 accounts were open" on a day the total is built from 2.**
`splitMissing` sorts an uncovered account into THREE buckets and both surfaces
subtracted one, so the empty account fell into the open count — on **every one
of the 1,440 days that render the clause**, with the gap clause correctly
silent because there is no hole. The denominator is the completeness rule's own
now (`activeIds − emptyAccounts`), which makes the numerator equal
`coveredAccounts` wherever there is no interior gap.

---

## 5. "THIS DAY IS CUT BY THE PAGE BOUNDARY" — OF A DAY ENTIRELY ON THE PAGE

`/transactions?page=4`:

    Wed, Jul 29     +$3,948.91   partial
      title: "This day is cut by the page boundary — the subtotal counts
              only the rows shown on this page."

All 21 of Jul 29's rows are on page 4. Page 3 ends on 2026-07-30. The ledger's
own total for Jul 29 is $3,948.91 — the number printed.

`hiddenBefore` was a plain `page > 1` and `hiddenAfter` a plain "rows remain", so
both edges were flagged whenever a neighbouring page existed. **31 of the 203
page boundaries land on a day change, so 62 day headers wore the tag over a
subtotal that was exact.**

⛔ The old docstring said the previous page's last day is *"genuinely not
knowable from this page's rows"* — true, and the wrong place to look. The SERVER
slices the page and can read the row on either side of its own cut;
`neighbourDay` is two indexed lookups addressed by `offset` alone.

⛔ **And the two texts on that tag disagreed about how sure they were.** The
tooltip asserted "This day IS cut" while the `sr-only` sentence beside it hedged
"this day MAY continue on the neighboring page". One element, two confidences,
and the assertion was the false one.

---

## 6. ✅ WHAT WAS CHECKED AND FOUND RIGHT

Beyond the 1,272 in §1 — things that looked wrong and were not:

- **Merchant ranks "out of order".** Four merchants at exactly $120.00 get ranks
  84–87. A stable tiebreak, and mine differed. Not a defect.
- **"your 8 accounts holding money"** counts `Cash on Hand` at $0.00. Deliberate:
  the population is the SIDE, `sideMagnitudeCents` ranks it zero and it gets no
  share, and `/accounts` says "Held — 8 accounts" about the same set.
- **The Honesty check's "1 transaction"** on a month holding 3 uncategorized
  rows. The bucket is outflow-scoped and `flow=out` is carried into the
  drill-down link, so the card and the page it hands you agree.
- **Rows filed on the `Uncategorized` CATEGORY** are counted — the 2026-09-03
  normalisation ("NULL or system-kind, everywhere") is in place; all four months
  report correctly.
- **`Categorized across N parts`** cannot read "1 parts": `MIN_SPLIT_LINES = 2`
  is enforced before any write.
- **The Sep 10 boundary flipped exactly as predicted.** Discover went "On
  schedule" → "Ready to pull" and the heading 6 → 7 statements. The 2026-09-08
  §8 sentence was right.
- **Net worth agrees on every surface** — $113,656.08 / $114,498.97 held, and
  `/recurring`'s $113,229.48 is the labelled EOM projection.
- **`left to allocate` / `over-allocated`** are one definition at two mount
  sites, exactly one of which renders.

---

## 7. ❓ DELIBERATELY LEFT ALONE

1. **The Honesty check's empty state** reads "Everything this period is
   categorized and accounted for" while the bucket is outflow-scoped. An
   uncategorized DEPOSIT in a month with no uncategorized spending would make it
   false. **Not reachable on this ledger today** — every uncategorized row
   outside 2026-08 is an outflow — so there is nothing to quote. A candidate if
   you want the sentence to say what it checked.
2. **`Charged since May 2024`, `since Jul 2024`, `from Aug 2022`** all name a
   month for a window that starts mid-month. Unlike §2 these are soft framings
   over multi-year spans, not denominators, so the number does not move.
3. **§9 of the 2026-09-08 handoff still stands** — the six local `plural`
   copies, the 227 shared `<title>`s, `/transactions`' filter empty state.

---

## 8. NOTES THAT COST TIME, AND WOULD AGAIN

- ⭐ **RUN THE ONE-CALLER SWEEP FIRST.** It is in §9 of the previous handoff and
  it paid on 2026-09-09 (`terrainTableCaption` → the chart's own ribbon count).
  Ten seconds.
- ⭐ **THEN HARVEST A SENTENCE FAMILY.** §1. The single highest-yield technique
  found this session: one `curl` loop, one parser, and 1,272 assertions the eye
  cannot make.
- ⛔ **`scripts/read-surface.mjs` reads only the first flush.** A React-streamed
  list looks SHORT against its own count — `/investments/crypto/ETH` shows six
  sell rows under a "7 sells" header and the seventh is in a later chunk. Check
  the raw RSC payload before filing a count-vs-list mismatch.
- ⚠️ **A GET cannot write a view preference.** `viewPreferences.dashboard.chart`
  moved `accounts` → `terrain` between the 09-08 and 09-09 backups; every write
  of that key is a server ACTION, and browsing with `curl` fires none. That was
  the owner's own click. **The dashboard now opens on Terrain.**
- ⚠️ `E2E_GATE=1 npx playwright test <spec> --grep <name> --update-snapshots`
  writes the PNGs and passes — the CLI flag overrides `updateSnapshots: "none"`.
- ⚠️ `npx vitest run --maxWorkers=4` — 4,716 in ~25s. Coverage:
  `npx vitest run --coverage --maxWorkers=4`. Full e2e ≈ 8.5 minutes on a quiet
  machine.
- ⛔ `pnpm build` needs the dev server stopped; the e2e webServer runs on 3111,
  so it does not clash with :3000. The dev server is left running, as found.

---

## 9. WHAT WAS MEASURED, AND WHEN

Every figure here is **as of 2026-09-10**, read off the running app. Net worth
read $113,656.08 throughout.

Confirmed live after the fixes:

    /merchants/<Empire City>   "100.0% of what you spent on Entertainment
                                 on Feb 7, 2026" · strip caption "Feb 7, 2026"
    /merchants/<MTA>           "13.6% … over Sep 20, 2022 – Jul 6, 2026"
    /imports                   three 20230810 rows, "imported 2026-07-13",
                                 "imported 2026-07-15", "imported 2026-08-05",
                                 in the cell, the title and the trigger
    /                          "11 account ribbons … 1 account has no
                                 reconstructed day at all and is not drawn"
    /transactions?page=4       "Wed, Jul 29 · +$3,948.91" — no "partial"
    /transactions?page=2       "Wed, Aug 12 · -$1,549.20 · partial", and both
                                 texts now say "continues"
    /imports                   Discover "Ready to pull · one closed 8 days ago,
                                 not imported" — the Sep 10 flip

---

# 📋 THE PROMPT FOR THE NEXT SESSION

> Read `docs/HANDOFF-2026-09-10-the-window-that-was-not-a-month.md` first — it is
> the brief. §0 of it is the job.
> Repo `/Users/rayankarimcheca/dev/MoneyApp`, `main` clean and pushed. Baseline:
> 4,716 unit in ~25s · tsc clean · coverage gate exit 0 · `E2E_GATE=1`:
> 600 passed at `maxDiffPixels: 0` · `pnpm ledger-check` exit 0.
> Ledger: 10,178 active rows · 37 uncategorized. Zero DB writes for four sessions.
>
> No decision is waiting on me. The job is the same as the last ten sessions:
> find what is wrong. Do not invent features.
>
> 1. ⭐ **Run the two sweeps FIRST, before opening anything.** (a) the one-caller
>    sweep in §9 of the 2026-09-08 handoff — ten seconds, and it found two of
>    that session's six. (b) §1 of this one: harvest a whole SENTENCE FAMILY off
>    every page that carries it with one `curl` loop, then check it against SQL.
>    That is 1,272 assertions the eye cannot make, and it found the headline.
> 2. ⭐⭐ **A label must describe the window MEASURED, never a container it fits
>    inside.** A share taken over one day was captioned with the month around it
>    on 28 merchant pages. Look for the same shape wherever a span is collapsed.
> 3. **Prove a new test can fail.** Revert the fix, run the test.
> 4. ⛔ Do not size the e2e fixture from `data/e2e.db` as a run leaves it —
>    reseed first. And `read-surface.mjs` reads only the first flush: a streamed
>    list looks short against its own count.
> 5. When a figure is right and a sentence about it is wrong, the sentence is the
>    defect — but VERIFY first: §6 is eight things that looked wrong and were not,
>    and three of my own checkers were wrong before the app was.
> 6. If you find a decision, put it to me EARLY with the measurement.
> 7. HOSTING goes last. Never propose a hosted-DB migration.
