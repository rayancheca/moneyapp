# Handoff — 2026-08-04, pass 32

> Supersedes `docs/HANDOFF-2026-08-03-pass31.md`. One thread: parser hardening (§4.1 of pass 31),
> which the owner chose explicitly — *"parser has to work"* before the bulk re-download.

## 1. Repo state

| | |
|---|---|
| `main` | see `git rev-parse main` — do not trust this line. Pass 31 ended at `7781c91`. |
| worktree | ⚙️ **removed.** `app-polish-adversarial-review-e80abb` was verified clean and its commit `4d45273` fully contained in `main` (`git merge-base --is-ancestor` → yes), so it was deleted. Unscoped `grep -rn` no longer double-counts. |
| real DB | **NOT written this pass.** Still 9,827 txns / $88,974.73. No import was run. |

**Gate:**

| | pass 31 | now |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| unit | 140 files / 2,423 | **140 files / 2,430** · coverage green |
| `next build` | clean | clean |
| e2e | 380/380 | **380/380** — but see §6, the pass-31 flake reproduced on the clean baseline first |

---

## 2. 🔴 THE LESSON: the fix a handoff proposes can be exactly backwards

Pass 31's §4.1 item 1 said the SoFi routing bug should be fixed by *"route on the account number
inside the sheet"*. **That fix would have misrouted 100% of SoFi exports.**

Measured on the two real inbox files:

| file | own last4 | times own last4 appears in the body | body names |
|---|---|---|---|
| `SOFI-Checking•9067-….csv` | 9067 | **0** | `5791` ×244 |
| `SOFI-Savings•5791-….csv` | 5791 | **0** | `9067` ×244 |

A SoFi export names only the **counterparty** of an internal transfer. Its own account number
appears nowhere in the body — it exists only in the filename. Routing on "the account number
inside the sheet" therefore sends every checking file to savings and vice versa.

Two more premises in that section were also wrong, both in the direction of *understating* the
problem:

- **`statement-pdf` does not "throw on 4 of 5 institutions"** — it throws on **5 of 5, and on
  88 of 88 real archived PDFs**. It succeeds on 148/148 synthetic fixtures. It is a fixture
  parser that has never parsed a real file, not a fallback.
- **The shadowing hazard's culprit is not any of the four profiles the item listed.** It is
  ungated `chase-checking-statement-pdf` at registry index 11, sitting ahead of discover(12),
  robinhood(13) and sofi(14). `selectProfile` returns the first candidate that passes its gate
  **or has no gate at all**, so an ungated profile shadows every gated one after it. Broadening
  only the four listed profiles would not have fixed it.

The one thing the item got *wrong in the other direction*: `capitalone-statement-pdf` is **not**
"too broad, claiming a Chase last4 in Capital One's name shape". Its gate is anchored
`^Statement_\d{6}_\d{4}\.pdf$`; run over all 90 distinct real filenames it matches exactly the 6
Capital One files and 0 of the 27 Chase-shaped ones. The shapes are not confusable.

---

## 3. What shipped

### 3.1 SoFi checking-vs-savings no longer decided by a filename word

`csv-profiles.ts` now derives the side from three signals and **throws when they disagree or when
none exists**, instead of silently defaulting to checking:

- **body** — the counterparty side, inverted. Unanimous-only: a mixed sheet is not evidence.
- **filename word** — `checking`/`savings`.
- **filename last4** — cross-checked against the counterparty numbers, which is what catches the
  inverted reading described above.

Verified: 244/244 unanimous on both real exports, 25/25 on the synthetic fixture, and the inferred
side is correct in all three.

⚠️ **The old behaviour was not merely cosmetic.** `resolveAccount` (service.ts:475-484) matches on
`last4` **absolutely** — type and name are ignored when a last4 is present, and an account created
from a wrong hint is *never corrected afterwards* (the `isStub` gate blocks it). So a first import
under a wrong hint is permanent. `sofi-csv` has never run against the real DB (zero rows in
`import_files`), so there was no working import to break.

### 3.2 PDF routing is now decided by content, not filename — for every profile

Seven profiles gained a `matchesContent` gate and had `matches` broadened to `f.format === "pdf"`:
discover, robinhood-crypto, sofi-combined, capital-one, chase-card, chase-checking, and
chase-spending-report.

This is the change that **makes native downloads work**. Ground truth from `import_files`: all 10
Discover, all 8 Robinhood-crypto and all 33 SoFi files were imported under names *coined by hand
at ingest* — names those institutions do not produce. 4 of 9 accounts got their entire history
from a filename their bank never emits. (The counter-example proving the point: Robinhood's
activity CSV arrived as `19f645c5-b6a7-5cc9-b6cb-704104af4792 (1).csv` and imported fine, because
the CSV matchers gate on content.)

**Proof, run over every PDF on disk (`data/verify-routing-2026-08-04.ts`):** 236 files × 4 names
each = **944 routing decisions, 0 violations**. Each file routes to its correct profile under its
archived name, under an opaque UUID, and under *a rival institution's native name shape*.

The gates are disjoint, verified independently (`data/verify-gates-2026-08-04.ts`): 10 discover +
8 rh-crypto + 33 sofi + 6 capone + 27 chase-checking + 2 spending-report + 2 chase-card = 88 real,
and 148 synthetic claimed only by the fallback. **0 cross-claims.**

⚠️ Two gate clauses are load-bearing and must not be "simplified":
- Capital One's `\d+ days in Billing Cycle` — the brand clause **alone** draws 34 false positives,
  because real Chase and SoFi statements name Capital One as a counterparty.
- Chase-checking's `\*start\*` — the bank-name line alone also matches both Spending Reports.

### 3.3 `statement-pdf` stops claiming files it cannot read

It now gates on the one header it actually requires (`Statement Period: MM/DD/YYYY - MM/DD/YYYY`),
which `scripts/fixtures/render-pdf.ts:89` is the sole producer of. Real files now fall through to
"no profile matched" instead of getting a misleading `[statement-pdf] Unknown institution in
header: "Page 1 of 6 Venture X Card…"`.

⛔ **Broadening it instead was measured and rejected.** Moving the institution sniff off `head(6)`
makes `/CHASE/i` match the word "pur**chase**" — true for **81 of 88 real files**, misrouting 50 of
them to Chase. And because `hint.last4` is undefined on 88/88 real files there, `resolveAccount`
would bind them all to **Chase Sapphire 9805**. Worse, in the three cases where broadening
"succeeds" it emits statement periods with balances correct to the cent and **zero transactions**
(0 vs 60, 0 vs 73, 0 vs 13) — and those balances become balance anchors unconditionally at
service.ts:947-948. A fallback that cannot read one real transaction row cannot be rescued by
fixing the two gates in front of the row reader.

### 3.4 Import failures are visible and say which kind

`/imports` rendered only the word "Failed", with the reason hidden in a `title=` tooltip on the
status cell. The error now renders inline under the filename. A failure discoverable only by
hovering the right cell is how 51 latent misroutes stayed invisible.

`selectProfile` also now distinguishes **"no text could be extracted — scanned or image-only
PDF"** from **"no parser profile matched this file"**. Those have different fixes.

⚠️ Deliberately **not** implemented: the "we recognised the institution but no profile could read
it" third bucket. `guessInstitution` cannot support it — for a PDF `file.text` is empty, so it sees
only the filename and **defaults to "Chase"**. It would produce confidently wrong messages, which
is worse than an honest one.

---

## 4. 🔴 Bulk import is NOT order-independent — and one of the two ways costs money

Pass 31 §4.1 item 4 asked to *prove* the permutation-invariance the service claims. **It does not
hold.** Two order-dependencies, both measured:

### 4.1 Quarantined rows are invisible to cross-file dedupe ← **the money one**

`service.ts:111` builds the identity pool from `status IN ('active','excluded')` — omitting
`'quarantined'`, while the five sibling queries (229, 409, 1011, 1180) all include it.

Minimal reproduction (`data/probe-quarantine-dedupe-2026-08-04.ts`) — the same transaction arriving
in two different files:

| first row's status when the second file lands | result |
|---|---|
| `active` | `inserted:1, dedupedCrossFormat:1` → **1** row |
| `quarantined` | `inserted:2, dedupedCrossFormat:0` → **2** rows `[quarantined, active]` |

`acceptGap` then flips the quarantined copy to active and the money is counted twice. On real data
an earlier probe measured the same effect at scale: importing the 2026 spending report while a card
period was quarantined inserted **355 rows with 1 cross-format dedupe**, versus **289 with 67** once
those rows were active — **66 duplicates**.

Note this only bites when the `dedupeHash` differs but the `(date, amount)` identity matches —
i.e. exactly the card-statement-vs-spending-report case, which is the owner's actual corpus.

⛔ **Do not just add `'quarantined'` to the IN list.** Deduping against a quarantined row keeps the
**untrusted** copy and drops the trusted incoming one — money goes *missing* instead of doubling.
The likely correct answer is a supersede/takeover, and `FileOutcome` already carries a
`supersededTakeover` counter. This is the most money-sensitive path in the repo (pass 31's dedupe
bug was worth $1,484.86) and it needs adversarial verification, which was unavailable this pass
(§6). Left unfixed deliberately.

### 4.2 Identity-pool tie-break depends on file order
Two files, same two amounts, dates straddling posted/transacted: `Q→P` leaves rows on
`{06-01:1, 06-03:1}` while `P→Q` leaves `{06-01:2}`. The *count* is invariant; *which* rows
survive is not, so per-day balances differ.

### 4.3 What IS order-independent (verified, keep these)
- **daily_balances re-derivation**: all 6 permutations of three adjacent Chase statements →
  **1 distinct state**.
- **shared boundary-day anchors**: 25 real adjacent periods → **0 value conflicts**.

---

## 5. Open work, in priority order

1. **§4.1 — the quarantine dedupe gap.** Money-affecting, reproducible, and directly in the path of
   the owner's imminent bulk drop. Needs a semantics decision (dedupe vs takeover), not a one-line
   edit. **Operational safeguard until then: after a bulk import, check for quarantined periods and
   do not blind-`acceptGap` — accepting a gap is what promotes a duplicate to active.**
2. **§4.2 — the tie-break.** Lower impact, same area; fix alongside 1.
3. **Bulk-import scale test.** Still not written. The owner will drop many PDFs at once; §4.1/§4.2
   are exactly what a permutation test would have caught.
4. **Excel/`.xlsx`** — deprioritised by the owner ("none really, mostly PDF/CSV"). Trap for later:
   an `.xlsx` is a ZIP and `sniff.ts`'s 3-way branch has `csv` as its `else`, so it misroutes and
   fails with a generic message rather than "unsupported format".
5. Carried from pass 31, untouched: the income double-count check, tightening
   `maxDiffPixelRatio`, pinning `TZ` in the test configs, and the 107 hand-injected payment
   mirrors on 9805.
6. **Hosting — ⛔ still NOT YET, by explicit instruction.** *"only at the end when im sure the final
   product is complete."* Do not propose it.

---

## 6. Two things about this pass's process

**The weekly model limit was hit mid-pass.** The investigation workflow completed 3 of 4 agents;
the 4th and **all 10 adversarial verifiers died**. Every finding above was therefore re-verified by
hand, against the real corpus, before any code was written — which is how §2's inverted fix and the
`chase-card` gap in §3.2 were caught. The one place that verification was *not* available is
§4.1, which is why it ships as a documented defect rather than a fix.

**The pass-31 e2e flake reproduced — and it is confirmed a flake.** `zz-zz-intraday.spec.ts:215`
("the loaded 1D holding chart looks right") failed on a **clean `main`, before any change of this
pass** (379 passed, 1 failed), and then **passed** in the final gate on the changed tree
(380/380). So it is genuinely intermittent, it is **not** caused by this pass's work, and pass
31's "unreproduced" note is now two occurrences. Still undiagnosed. Running the baseline gate
*before* touching anything is what made this attributable — worth keeping as a habit. This spec has
a documented history of ordering leaks; that is the first place to look.

---

## 7. How to work on this repo

Unchanged from pass 31 §5, and still all true. The load-bearing ones:

```bash
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run --coverage --reporter=dot
E2E_GATE=1 pnpm e2e:fresh --reporter=line
```

`pnpm e2e` serves a **stale `.next`** — always `e2e:fresh`. Two databases, never mix them: real is
`data/moneyapp.db` (read with raw better-sqlite3 `{readonly:true}`; **never `createDatabase()`**,
it migrates and writes). Import into the real DB by driving the real `/imports` UI. **Never
`git add -A`** — `node_modules` and `.env` are symlinks.

⚠️ **When a probe script "proves" something, check it exercised the path you think.** The first
quarantine reproduction here showed no bug — because after `.trim()` the second file was
byte-identical to the first and was skipped as a duplicate *file*. The second showed no bug either
— because identical rows hit the exact `dedupeHash` match, which is status-blind. Only the third,
with the same date and amount but different wording, reached the identity pool at all.
