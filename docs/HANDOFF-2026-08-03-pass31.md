# Handoff — 2026-08-03, pass 31

> Supersedes `docs/HANDOFF-2026-08-03-pass30.md`. Two threads: the Phase 2 perf item turned out to
> be diagnosed wrong in the backlog, and Chase statements became a real ingest path.

## 1. Repo state

| | |
|---|---|
| `main` | `9b6d955`, pushed, clean. Verify with `git rev-parse main` rather than trusting this line. |
| worktree | `.claude/worktrees/app-polish-adversarial-review-e80abb` **still stale at `4d45273`** — four passes untouched. Remove or reset it; it duplicates chart AND import files, so an unscoped `grep -rn` double-counts. Scope every grep to `src e2e scripts data`. |
| real DB | **written twice this pass, both verified.** Backups: `data/backups/pre-chase-statements-2026-08-03.db` (before the checking import) and `data/backups/pre-sapphire-2026-08-03.db` (before the Sapphire one). |

**Gate, measured on a fresh build:**

| | pass 30 | now |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| unit | 139 files / 2,385 · coverage green | **140 files / 2,423** · coverage green (100% on `src/lib`) |
| `next build` | clean | clean |
| e2e | 380/380 | **380/380** under `E2E_GATE=1` |
| visual baselines | 146 | 146, unmoved |

⚠️ **One unreproduced e2e flake.** `zz-zz-intraday.spec.ts:215` ("the loaded 1D holding chart looks
right") failed once in a full run, then passed in isolation (8/8) and in a second full run
(380/380). Not diagnosed, not fixed. This repo has a documented history of ordering leaks in this
exact spec — if it recurs, that is the first place to look, not a baseline refresh.

---

## 2. 🔴 THE LESSON: the backlog named the right symptom and the wrong cause

Pass 30's item 27 said `forecast.ts:360` "burns a measured 659ms to read one number" and proposed
skipping the series build. **The 659ms replicated. The diagnosis did not.** Measured against the
real DB:

| | before |
|---|---|
| `netWorthSeries` (the thing item 27 blamed) | **17.0 ms** |
| `transferFloats` | **437.7 ms** |
| `inFlightDeltaByDay` | **147.2 ms** |

Inside both of the big ones the cost was not the algorithm — it was `compareDates`, called
**~910,000 times per forecast at 535 ns each**. `toEpochDay` ran a regex, then
`new Date(Date.UTC(...))` plus three `getUTC*` accessors to reject `2026-02-30`, then `split` and
re-parsed; `compareDates` did all of that twice. A CPU profile put **92.7% of all time inside
`src/lib/dates.ts`**.

The rewrite reads digits by char code and does the calendar arithmetic by hand (Hinnant's
`days_from_civil`) — no regex, no split, no `Date` allocation:

```
forecastCurrentMonth   609.66ms -> 37.20ms  (16.4x)
bridgedNetWorthSeries  603.57ms -> 32.57ms  (18.5x)
transferFloats         437.69ms -> 21.18ms  (20.7x)
/recurring TTFB           796ms -> ~120ms   (live dev server)
/                       ~1450ms ->  328ms   (it built the series TWICE)
```

**Equivalence was proven, not argued:** 4,651,032 strings checked against the old implementation
with zero mismatches — all 3,615,900 valid dates in range, every ASCII substitution at all ten
positions, leap boundaries across every century.

⚠️ **Years 0000-0099 must stay invalid.** `Date.UTC` maps them into 1900-1999, so the old
round-trip rejected them, and `isValidIsoDate` is the zod refinement guarding user input in five
server actions. The boundary is deliberate and commented; do not "fix" it.

Item 27 itself still shipped as `latestBridgedNetWorthCents` (in-flight.ts). Three details are
load-bearing — active-accounts-only, `basis <> 'gap'` in the MAX, and the half-open end test —
and **all five wrong variants were mutated in and every one was caught by a test.**

---

## 3. Chase statements are now a real ingest path

### 3.1 What was imported (real DB)

**Checking (3522)** — `20260610` and `20260710`. **0 transactions inserted** (129 recognised as
already owned from a CSV), net worth **unchanged** at $87,549.47, and `derived_unverified`
**729 → 0**: two years of guessed daily balances became statement-verified. Pure gain, no risk.

**Sapphire (9805)** — `20260702` and `20260802`, after two remediations the owner approved:
- deleted the `2026-07-09 = -142526` **manual** anchor (no import file behind it; contradicted the
  statements' own chain by $1,129.13)
- backfilled `transacted_on='2026-06-30'` on the checking-side payment mirror posted `2026-07-01`

Result, matching the dry run to the row: txns 9,753 → **9,827**; both statement periods
**`reconciled`**; the two genuinely-missing June refunds inserted; 67 new rows from 2026-07-10 on;
the card reads **$0.00** (owner confirmed he paid it off before close); net worth
**$87,549.47 → $88,974.73**.

### 3.2 ⚠️ The Sapphire's 483 gap days are CORRECT, not a regression

`daily_balances` for 9805 went 520 `derived` → 59 `derived` + **483 `gap`**. This is the deriver
being honest, not breaking. The card's entire pre-June-2026 history came from two
**"Spending Report"** PDFs — a year-to-date *spend summary*, not monthly statements — and that
export emitted **0 positive rows out of 1,629**. Every refund since Feb 2025 is missing, so the
stored history cannot chain to a real printed balance. Those old daily balances were never right;
they only looked right.

**Do not "fix" this by re-anchoring or interpolating.** The fix is real monthly statements: the
owner is re-downloading statements across all accounts. The parser now exists to read them.

### 3.3 What was built

**`chase-card-statement-profile.ts`.** Chase ships checking and card statements under the SAME
download name (`<YYYYMMDD>-statements-<last4>-.pdf`), so `chase-checking-statement-pdf` was
claiming the Sapphire files and killing them with "No 'Month D, YYYY through…' period found",
then archiving them into `data/statements/chase/` instead of the account folder.

⚠️ **`matches()` is SYNCHRONOUS and a PDF's `SniffedFile.text` is EMPTY** — `sniff.ts` only decodes
text formats, and these streams are Flate-compressed **and** RC4-encrypted **and** EBCDIC-encoded,
so no raw-buffer scan will ever work either. Profiles may now declare
**`matchesContent(text)`**; `selectProfile` keeps first-match-wins, extracts the document text at
most once, and only when some candidate asks for it. **This is the seam the other narrow matchers
should be moved onto.**

Rows are classified by **the sign they print**, not by the section header — measured, not assumed:
positives sum exactly to Purchases, negatives to Payments, zero crossover, so the mid-section page
break cannot strand a row. Two independent reconcile checks backstop the row regex and the
2-digit-year expansion. Verified byte-exact against ground truth built by **three independent PDF
engines** (unpdf, macOS PDFKit, and a from-scratch RC4-decrypt + content-stream interpreter):
73 and 90 rows, **row multiset diff ZERO**.

**Dedupe by transaction date.** The identity pool keyed only on `posted_on`. A card statement
prints the **transaction** date; the stored Spending Report rows carry the **post** date, 1-3 days
later. Importing would have inserted **67 of 73** June rows a second time — **$1,484.86 of
spending that never happened**. The pool is now row-level, indexed by amount under *both* dates a
row carries, one slot per row taken at most once however it was found, posted-vs-posted tried
first so nothing changes where sources already agreed.

⚠️ **Deliberately NOT a fuzzy date window.** ±3 days would merge genuinely distinct charges —
measured: **43 same-amount different-merchant pairs within that window on this one card.**

---

## 4. Open work, in the owner's stated order

### 4.1 Parser hardening ← **NEXT, owner chose this explicitly**

The owner is re-downloading statements for **all** accounts. His words: *"parser has to work."*

1. **🔴 SoFi checking-vs-savings is decided by FILENAME** (`/savings/i.test(name)`,
   `csv-profiles.ts` ~:220 routing). This is the only finding that **misfiles money silently, with
   no error**. Route on the account number inside the sheet, or fail loudly. Do this first.
2. **Move the narrow PDF matchers onto `matchesContent`.** Measured as too narrow for native
   downloads: `discover-statement-pdf` (`/discover-it-\d{4}.*statement.*\.pdf$/i` — a hand-coined
   name), `robinhood-crypto-statement-pdf`, `sofi-combined-statement-pdf`
   (`/sofi-statement-\d{4}-\d{2}/i` — native is an opaque UUID; the file self-documents this at
   L233). `capitalone-statement-pdf` is **both** too narrow (4-digit docid) and too broad (claims
   a Chase last4 in Capital One's name shape).
3. **`statement-pdf` is a false safety net** — it advertises itself as the fallback and throws on
   4 of 5 institutions. Either broaden its header sniffer or make `service.ts` say
   "recognised the institution, no profile could parse it".
4. **Bulk import** — the owner will drop many PDFs at once. Verify order-independence and
   idempotency at that scale (the service claims permutation-invariance as an invariant; prove it).
5. **Excel: DEPRIORITISED** — owner says "none really, mostly PDF/CSV". Note the trap for later: an
   `.xlsx` is a ZIP, `sniff.ts`'s 3-way branch has `csv` as its `else`, so it misroutes and fails
   with a generic "No parser profile matched" rather than "unsupported format".

**4 of 9 accounts got their history from a filename their institution does not produce.** That is
the size of this problem.

### 4.2 Phase 2 perf backlog — **RE-MEASURE BEFORE STARTING**
Item 27 is done, and the 16× date fix moved what is actually slow. Items 24, 26, 32, 30, 29, 25
were prioritised against the OLD profile and their premises may no longer hold — item 24's
`cache()` argument in particular rested on the dashboard building the series twice, which is now
half as expensive and one call site lighter. **Re-profile first.** Note items 32/30/29 still need
a touch-emulation Playwright project that does not exist (`playwright.config.ts:41` is a single
desktop chromium with no `hasTouch`, so every `pointer-coarse:` branch has never executed).

### 4.3 Smaller things still open
- **The income double-count check** (pass 28 §6.2) — two projection paths over one quantity, still
  unverified, still cheap, still touches the number the owner cares most about.
- **Tighten `maxDiffPixelRatio`** — pass 29 proved removing a visible pill moved no baseline.
- **Pin `TZ` in the test configs** so a UTC run is exercised (pass 30 §3.1); the source-text guard
  is currently the only local defence.
- **107 hand-injected payment mirrors** on 9805 (`import_file_id IS NULL`) will start colliding
  with real statements' `PAYMENTS AND OTHER CREDITS` rows as more get imported. One is already
  backfilled; the rest are unaudited.

### 4.4 Hosting — ⛔ still NOT YET, by explicit instruction
> *"hosting is only at the end when im sure the final product is complete"*

Do not start it and do not propose it. Analysis is in `docs/hosting-and-auth-plan.md`.

---

## 5. How to work on this repo

```bash
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run --coverage --reporter=dot   # coverage is GREEN — keep it there
node_modules/.bin/next build
E2E_GATE=1 node_modules/.bin/playwright test --reporter=line
```

`pnpm e2e` serves a **stale `.next`** — always `pnpm e2e:fresh`. `--reporter=basic` does not exist
in vitest 4; use `dot`. `data/e2e-originals` can fail `global-setup` with `ENOTEMPTY` — `rm -rf` it.

**Two databases — do not mix them.** DEMO/e2e (synthetic): `data/e2e.db`, reseeded by
`e2e/global-setup.ts`. REAL: `data/moneyapp.db` — now **9,827 txns**, net worth **$88,974.73**.
Read the real one with raw `better-sqlite3` in `{readonly:true}`; **never `createDatabase()`**
against it — that runs migrations and writes, and defaults to the real path.

**Importing into the real DB: drive the real `/imports` UI** (Playwright `setInputFiles` against
the running dev server, `chromium` from `@playwright/test`). The dev server already owns the DB, so
there is no lock fight, the production path archives the file with its content-hash prefix into the
right account folder, and `un-import` remains available as rollback. Always: `VACUUM INTO` a
backup, dry-run the import on the copy, compare deltas, then apply.

⚠️ The dev server will not appear under a `next dev` process-name grep — it renames itself to
`next-server (vX)`. Kill by port: `kill -9 $(lsof -ti tcp:3000)`.

**Never `git add -A`** — `node_modules` and `.env` are symlinks. Stage paths explicitly.

**A passing test proves nothing until you have seen it fail.** Both real defects this pass were
caught that way: five wrong dedupe variants mutated in (all caught), and two of my own guard tests
that turned out to pin nothing — their fixtures did not produce the boundary shape their names
claimed, and I only found out by building the shape and watching them fail.
