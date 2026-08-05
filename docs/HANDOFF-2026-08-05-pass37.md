# Handoff — 2026-08-05, pass 37

> **Your job next pass: make Chase Sapphire reconcile.** That is the owner's explicit choice, and
> it is the single thing blocking his dashboard chart. Start at §3 — it is written as a spec, and
> it already contains the two fixes you would otherwise try first, **both measured and both wrong.**
>
> ⛔ **HOSTING IS DEFERRED AGAIN — owner, verbatim: "no, hosting only when everything is done."**
> The plan is written and the code prerequisite is finished; do not spend time on it, and do not
> propose it.

## 1. Repo state

`main` = run `git rev-parse main` (do not trust a copied hash; this pass ended at `366f935` plus
this handoff). Everything below is pushed.

**Real DB (written this pass, deliberately):** 9,918 txns · 10 accounts · 33 needs_review ·
**83 quarantined** · 0 duplicate_candidates · Chase Sapphire 1,810 → **1,901 rows**.

Net worth **$92,735.98, unchanged** across every write today — verified before and after.

Backups, both `integrity_check ok`:
- `data/backups/pre-sapphire-import-2026-08-05.db` (9,827 txns — before anything today)
- `data/backups/pre-subdollar-fix-2026-08-05.db` (9,876 txns)

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | **146 files / 2,543** (up from 143 / 2,500 at pass 36 start) |
| `next build` | clean (2 pre-existing NFT warnings, trace is `next.config.ts → db/backup.ts → db/boot.ts → instrumentation.ts`, unrelated) |
| `E2E_GATE=1 pnpm e2e:fresh` | **382 passed, 1 failed** — see §5. **Zero baseline churn.** |

---

## 2. 🔴 THE LESSON: the bug you can see is rarely the bug that matters

The owner reported his Sapphire card had only 2 statement periods and asked, angrily and
reasonably, whether statements had been deleted. Three layers came out of that, and **only the
outermost was the one anyone had noticed**:

1. **Nothing was deleted.** Git shows zero deletions under `statements/`; the 16 files were created
   on disk that morning. The card's history had come from Chase **Spending Report** PDFs, which
   carry no balances, so it could never reconcile. *Visible, and true, but not the blocker.*
2. **Two real parser bugs** then surfaced, and both were silent: the **$95 annual fee** folded into
   the purchases section total, and **sub-dollar amounts printed without a leading zero** — Chase
   prints `.78`, never `0.78`. The second had been dropping **71 real charges worth $32.95** across
   his statements for as long as the parser existed. *Fixed. Still not the blocker.*
3. **The actual blocker** is that reconciliation sums by date range while Chase prints the
   transaction date, and the card's rows arrived from two kinds of file that each hold half of every
   period. *Nobody had ever named this.* §3.

**The generalisable rule: when a fix makes a number better but not right, keep going — the
remaining error is a different bug, not a residue of the one you just fixed.** After the parser
fixes, gap days moved 483 → 324 and it would have been easy to call that progress and stop. The
remaining 324 had a completely separate cause.

---

## 3. THE TASK — make card statements reconcile

Full measured diagnosis: **`docs/sapphire-reconciliation-finding.md`. Read it before writing code.**

### 3.1 What is wrong

`reconcileAccounts` (`src/services/import/service.ts:1160-1220`) sums
`postedOn BETWEEN periodStart AND periodEnd`, **with no file filter**, and compares against the
statement's `beginning/ending` balances. Three things break that for a credit card:

1. **The parser stores the transaction date as the posted date.** A Chase card statement prints ONE
   date and it is the *transaction* date (`chase-card-statement-profile.ts` says so in a comment,
   deliberately, because it is what lets dedupe match a post-dated row). A payment made 03/01 and
   posted 03/03 appears on the **March** statement while falling inside **February's** window.
2. **Measured proof:** with statements as the card's ONLY source, the 2025-02-03→03-02 window holds
   **$9,465.98** of credits where that statement counts **$5,249.05** — a difference of
   **$4,216.93, exactly that period's reported gap.**
3. **The two source kinds each hold half a period.** The Chase **Spending Reports contain no
   payments**. Purchases came from them; payments came from the statements.

Result: **16 of 19 periods carry a gap** (−$390 to −$4,216.93). Only 2026-05-03 onward reconciles.

### 3.2 The two fixes you will think of first. Both were tested. Both are wrong.

| Idea | Measured result |
|---|---|
| Scope the sum to the period's own `import_file_id` | **Worse.** Every period still gaps, and the per-file sums come out to *only the credits* — e.g. the 2025-03-03 period's file sum is exactly its printed `Payment, Credits -$2,017.98`. This is what proved the Spending Reports have no payments. |
| Un-import the Spending Reports, keep statements only | **Worse.** 0 reconciled, 16 gaps, known days collapse 226 → 23. It also loses purchase history that the statements' own dedupe had already consumed. |

⚠️ **Do NOT widen the period window "by a few days"** to catch boundary rows — that is guesswork
against real money and will silently double-count a row that legitimately sits near a boundary.
⚠️ **Do NOT loosen the cent-exactness.** It is the entire value of this ledger.

### 3.3 The shape that should work

A statement is **self-proving**: the parser already verifies `previous + activity = new` to the
cent, so a statement that parses carries an internally consistent row list. So the database-level
question is not *"do rows in this date range sum correctly"* but **"does the ledger contain exactly
this statement's declared rows"** — a completeness check, not a range sum.

1. Record which statement each row **belongs to**, separately from which import file happened to
   insert it. A row consumed by `consumeIdentity` from an earlier file still *belongs* to the
   statement that later declared it. (`consumeIdentity`, `import/service.ts:134,162`, matches on
   `(day, amountCents)` with **no description check** — know this before relying on it.)
2. Reconcile a **card** period against its declared row set. Leave **bank** accounts on the current
   date-range behaviour.
3. Only then interpret a gap: with a complete declared set, a gap is a genuinely missing row rather
   than a boundary artifact.

⚠️ **Two things that must survive whatever you build:**
- **The no-file-filter behaviour for bank accounts is load-bearing.** Pass 34 recorded that a period
  reconciling *with no file filter* is what proved two identical `CPI*CANTEEN` charges were both
  real. Do not regress that while fixing cards.
- **This code flips row status** (`service.ts:1205-1219`): a gapped period **quarantines that
  period's file's rows**, and `quarantined` is **not** in `REPLAY_STATUSES`, so those rows stop
  counting toward balances. A wrong version can quarantine real money or un-quarantine bad rows.

### 3.4 Where the 83 quarantined rows came from

They are all Chase Sapphire, and they are **a consequence of this pass's imports, not a defect**:
0 before today → 44 → 83. Importing statements created periods, the periods gapped (§3.1), and the
quarantine policy held those files' rows. **Net worth did not move** ($92,735.98 before and after)
because Sapphire's balance derives from its latest anchor. **Fixing §3 should release them** — that
is a good end-to-end assertion for the work: after the fix, quarantined should fall sharply and net
worth must still not jump.

### 3.5 How to verify

- Work on a **copy** (`sqlite3 data/moneyapp.db ".backup '<tmp>/x.db'"`), never the live file, and
  stop any dev server first — it holds the DB open.
- Target: Sapphire periods reconciled **3 → most of 19**; Sapphire `gap` days (currently 324) fall
  sharply; **net worth stays $92,735.98**; quarantined falls from 83.
- The dashboard chart filling in IS the owner-visible success criterion — screenshot it.
- ⚠️ `netWorthSeries` reports only **2-3 "complete" days** out of 1,442 because the `1800` cash
  wallet has balances on two days only. That is separate from this task; do not chase it.

---

## 4. What shipped this pass

**Two real parser bugs, both silent, both money-affecting.**

1. **Fees/interest folded into purchases.** Chase prints `Purchases +$5,371.57` and `Fees Charged
   +$95.00` as separate summary sections but lists the fee as an ordinary activity row, so the rows
   summed $95.00 higher and the section check **rejected the entire statement**. The check now adds
   fees and interest back rather than being loosened — tests pin both directions (removing a real
   row still throws; inflating the printed fee still throws).
2. **Sub-dollar amounts without a leading zero.** `ROW_RE` required a digit before the decimal;
   Chase prints `.78`. **71 real charges worth $32.95** were being dropped, and the six failing
   statements were short by *exactly* the amount dropped. All 18 parse now. The integer part is
   `(?:\d[\d,]*)?` rather than `[\d,]*` because the loose form admits `,.21`, which throws
   `MoneyParseError` out of the profile instead of a clean `ParseError`.

Independent re-verification across every PDF in the repo: **26 → 38 statements passing, zero
regressions**.

**Also:** the pass-36 work (perimeter → `src/proxy.ts` + `MONEYAPP_ALLOWED_HOSTS` + 24 tests;
three wallet-creation defects; duplicates visible from every route; `TZ` pinned to
`Pacific/Kiritimati`) and two planning docs — `docs/deploy-plan-gcp-firebase-auth.md` and
`docs/sapphire-reconciliation-finding.md`.

---

## 5. ⚠️ ONE E2E TEST IS RED — and it is NOT from this pass's code

`e2e/zz-zz-intraday.spec.ts:215 › the loaded 1D holding chart looks right` — 983 pixels
(ratio 0.01) over a `maxDiffPixelRatio` of 0.001. **Do not regenerate the baseline to make it
green.** It has not been explained yet.

What is established:
- **My change cannot be the cause.** The only non-doc diff since the last green gate is the Chase
  card parser, and I verified **0 of the Chase card fixtures parse differently** under the new
  regex. The e2e seed data is byte-identical.
- The committed baseline is **byte-identical** to the last green commit — the *render* changed, not
  the expectation.
- The chart **data** is identical ($243.22, +$8.38, same line). What moved is **vertical framing**:
  the captured card sits ~14px lower and the sticky page header intrudes at the top, clipping the
  Price/Return/Chart/Table pills.
- It was **green at ~00:05 and fails at ~13:00 the same day**, deterministically (983px on repeated
  runs).

Prime suspect: the spec conditionally clicks *"Load today's session"*
(`spec:219-222`) — `SessionNote.tsx` renders a **two-line** block with that button when no intraday
prices exist and a **one-line** note when they do, and clicking also fires a toast. Combined with
`scrollIntoView` on an element that sits under a sticky header, the capture can settle differently
depending on time of day. **That would make this spec time-of-day dependent** — the same class of
defect as pass 30's timezone bug, and directly related to §6 item 2 (Playwright's clock is NOT
pinned; only vitest's is).

**Next pass: prove or disprove that before touching the baseline.** A cheap test is to run the spec
with the system clock (or the app's notion of "now") at a market hour vs a non-market hour.

---

## 6. The rest of the queue, in the owner's priority order

1. **Reconciliation (§3)** — the owner's chosen next task.
2. **Pin Playwright's clock and timezone.** `vitest.config.ts` now pins
   `TZ=Pacific/Kiritimati` (UTC+14, no DST — **UTC is the wrong pin**, it makes local date equal UTC
   date on an Eastern box and hides the bug class). Playwright pins neither TZ nor the wall clock;
   §5 may be the first bill for that.
3. **Touch emulation.** `playwright.config.ts` is one desktop chromium with no `hasTouch`, so every
   `pointer: coarse` branch has **never executed** — and the owner's iPhone is the only device that
   runs them. He asked for this ("test everything then"). ⚠️ Hazard: `fullyParallel: false,
   workers: 1` and all specs share ONE database with the golden-path spec mutating it last, so a
   second project must **not** double-run. Scope it to a subset or give it its own DB.
4. **Chart-gap UX** — say plainly which account is starving the chart. Lower value once §3 lands.
   Frame it as the normal monthly statement rhythm, **never** as an error (see §7).
5. **Duplicate/review leftovers** from pass 35 §5 — nothing re-flags a duplicate after one side is
   categorized; a cross-account double count is undetectable by construction.
6. ⛔ **Hosting — LAST.** `docs/deploy-plan-gcp-firebase-auth.md`. Decided: Always Free GCP
   `e2e-micro` VM keeping SQLite + **Firebase Auth, Google sign-in, his account only**. Firebase App
   Hosting was ruled out on measurement (Blaze required; Cloud Run's filesystem is ephemeral, so the
   DB and statement archive die on every deploy). **Never point public DNS at the VM before auth is
   tested** — that is the one irreversible step in the whole plan.

---

## 7. Owner facts learned this pass — do not re-litigate

- ⭐ **"Claude always has to ask me questions when its not sure of anything."** A standing rule, now
  in memory. Ask **at the moment** of uncertainty, near the top, short, as a concrete either/or with
  a recommendation. Measure first if the repo can answer it; ask only what is genuinely his call.
- **Stale accounts are EXPECTED**, not a defect: statements arrive monthly and **each account closes
  on a different date**, so some are always weeks behind. Do not report it as a finding.
- **Foreign and sub-dollar micro-charges are normal.** He travels (China, Spain) and **drives an
  EV**. Three charges were flagged as "textbook card-testing probes"; **all three were legitimate**
  — Iberdrola was charging his car in Bilbao, and the 1¢/2¢ Met pair was him paying a cent to get
  in. An agent asserted confidently that the Met has a **$1 pay-what-you-wish floor** and built a
  fraud case on it. **That was simply false.**
- He does not read long output. Lead with the answer.

---

## 8. Process notes

**24 agents across two workflows, every diagnosis adversarially refuted.** The refutations paid for
themselves three times:

- They killed **three owner questions built on a false premise** — identical rows from the SAME file
  can never reach the duplicates queue, because `duplicate-flags.ts` `IDENTITY_JOIN` requires
  `t1.import_file_id IS NOT t2.import_file_id`. Asking would have wasted the owner's attention on a
  non-problem.
- They caught a **fabricated citation**: a scout cited `src/lib/state-contrast.test.ts` as an
  existing gate. **That file does not exist** — the path came from a stale comment in
  `Badge.tsx:5-6` that the scout never opened. This repo's signature failure mode, again.
- They corrected the headline number: **71 rows / $32.95**, not the 142 originally claimed (that
  double-counted archived copies).

⚠️ **But a refuter also asserted the false Met "$1 floor" (§7).** Adversarial review catches
sloppiness inside the repo; it does not make an agent's claims about the outside world true. Treat
external facts as unverified regardless of which agent says them.

⚠️ **Verification traps hit this session, all previously recorded and all still real:** `fetch()`
rewrites `Host` and gives a false 200 against a working perimeter (use `curl`); a root-level
`proxy.ts` builds clean with **no warning** and serves `evil.com` a 200; `git worktree` does **not**
link `node_modules`, so a worktree cannot run the suite without an install; and `sqlite3
"file:...?mode=ro"` failed on a freshly-written backup that opened fine unquoted — verify a backup
by **reading it**, not by its file size.
