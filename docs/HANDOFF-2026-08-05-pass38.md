# Handoff — 2026-08-05, pass 38

> **The card reconciles. Every period, to the cent.** Sapphire's chart went from 323 blank days to
> **zero**, and there are now **no gap days anywhere in the ledger**. Net worth never moved.
>
> **Your job next pass: item 3 in §6 — touch emulation.** Every `pointer: coarse` branch in this app
> has never executed once, and the owner's iPhone is the only device that runs them.
>
> ⛔ **HOSTING IS LAST.** Asked directly this pass, the owner chose **"the whole queue first"** over
> two shorter options. Do not propose it until §6 items 3–5 are done.

## 1. Repo state

`main` = `d8b8548` (verify with `git rev-parse --short main` rather than trusting this line).
Two commits: the e2e flake + clock pinning (`9d3200c`), then the reconciliation fix (`d8b8548`).
Both pushed.

**Real DB — written this pass, with approval:** 9,918 txns (unchanged count) · **9,782 active · 65
excluded · 71 superseded · 0 quarantined** (was 83) · 0 gap days ledger-wide (was 323) · 71
`duplicate_candidates` rows, all `confirmed_duplicate` / `card_payment_mirror`.

Net worth **$92,735.98, unchanged** — verified before and after via `netWorthSeries`, not by SQL.

Backup: `data/backups/pre-card-mirror-fix-2026-08-05.db` (9,918 txns, `integrity_check ok`), plus
the script's own `pre-card-payment-mirrors` restore point.

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | **147 files / 2,550** (was 146 / 2,543); `src/lib/**` still 100% |
| `next build` | clean |
| `E2E_GATE=1 pnpm e2e:fresh` | **383 passed, 0 failed. Zero baseline churn.** |

**The pass-37 red test is green, and NOT by regenerating its baseline** — see §3.

---

## 2. 🔴 THE LESSON: a difference that equals the gap is not proof of a mechanism

Pass 37 handed over a written spec for the wrong bug. It was careful, it was measured, and it was
wrong — and every measurement it cited was *true*.

Its story: reconciliation sums by date range while Chase prints the transaction date, so payments
land in the neighbouring window. Its evidence: one window held $9,465.98 of credits where the
statement counted $5,249.05 — a difference of $4,216.93, **exactly that period's gap**.

The real story: **every card payment was in the ledger twice** — once as the line Chase prints, once
as a hand-entered mirror row written by a one-off script on 2026-07-11, months before the card had
any statement. The excess credits in that window were the duplicates, not boundary spill. Boundary
drift explains **4 rows**. The duplicates explain **71**.

Both stories predict the same arithmetic. What separates them is asking *which specific rows* and
*where did they come from* — and `select substr(created_at,1,16), count(*)` settled it in one query:
**all 107 manual rows created inside a single minute.**

Two corollaries worth carrying:

- **The proposed fix was the tell.** Pass 37's declared-set design rests on a predicate that is a
  **tautology** — the parser already throws unless `previous + activity = new`, so "does the ledger
  contain the statement's declared rows" is an identity. It would have flipped all 15 gapped periods
  to `reconciled` and released 70 duplicate payments into balance replay: **the double count made
  worse, reported as success.** When a design's core check cannot fail, it is not a check.
- **The untested function is where the bug lives.** `reconcileAccounts` had **zero** direct test
  coverage — every test drove it through a fixture import, and no fixture had this shape.
  `src/services/import/reconcile.test.ts` now covers it directly, falsification case included.

---

## 3. ⚠️ The pass-37 red e2e test: it was FLAKE, not a regression — and the handoff's claim was wrong

Pass 37 recorded it as failing "deterministically (983px on repeated runs)". **It is not
deterministic.** I reproduced the failure once, then the same spec passed 3/3 unchanged.

**Root cause, measured with a geometry probe rather than reasoned about:**

`if (await load.isVisible())` — `isVisible()` **does not auto-wait**. Called straight after a
re-render it samples the DOM mid-render, so the same run could take either branch, and the two
branches leave the page at different scroll offsets:

| `loadVisible` | scrollY | card top | 56px sticky header over the card? |
|---|---|---|---|
| `true` | 0 | 180 | no → baseline |
| `false` | 180 | **0** | yes → **983px diff** |

Playwright scrolls a locator into view only if it is *not already fully visible*, so the capture
framing silently inherited whatever scroll the preceding clicks left behind.

**Fixed at the cause, not the baseline:** `ensureSessionLoaded` waits for the button *or* a loaded
session before branching, and `scrollHome` pins the page to the top before each card capture. Proven
robust — from a forced prior scroll of 0, 180 and 330 (the maximum), the card lands at 180 every
time, clear of the header. The spec then passed 5/5, and the full suite shows **zero baseline churn**.

**Also done — queue item 2, clock/timezone pinning.** `playwright.config.ts` now pins
`timezoneId: "Pacific/Kiritimati"` + `locale: "en-US"` for the browser and `TZ=Pacific/Kiritimati`
for the webServer. Kiritimati (UTC+14, never observed DST) rather than UTC for the reason
`vitest.config.ts` already uses it: under UTC the local date equals the UTC date on an Eastern box,
so the bug class stays invisible. **Zero baselines moved** — the app's date formatters already
build `new Date(\`${iso}T12:00:00\`)` deliberately, which is why. The wall *clock* is still not
faked in the browser; `MONEYAPP_FAKE_TODAY` pins the server's date and no client render was found to
depend on the time of day.

---

## 4. What shipped

- **`scripts/fix-card-payment-mirrors.ts`** — the migration. Dry-run by default. Refuses to write
  unless it finds exactly 71 pairs totalling exactly $23,983.06 whose sum is the negation of
  `sum(gap_cents)`; a different count means it found different money than was reviewed.
- **`src/services/import/reconcile.test.ts`** — 7 tests, the first direct coverage
  `reconcileAccounts` has ever had.
- **`card_payment_mirror`** added to `DUPLICATE_REASONS` — these pairs are not detector output and
  nothing re-derives them, so they need their own label.
- **e2e determinism + TZ/locale pinning** (§3).
- **`docs/sapphire-reconciliation-finding.md`** rewritten: full diagnosis, the three review-required
  migration fixes and why each naive form was destructive, and §5 — the parser work still open.

**Three defects adversarial review caught in the migration before it ran.** Each would have shipped
in the obvious version:

1. A bare `status='superseded'` **bypasses the repo's only anti-vanish guard**.
   `restoreDuplicatesLosingTheirSurvivor` rescues only rows named by a `confirmed_duplicate`
   candidate, and `unimportFile` hard-deletes behind it — one click would have stranded up to
   **$4,619.92** on zero live rows, silently. Fixed by writing a candidate row per pair in the same
   transaction.
2. "Move the transfer link onto the statement row" **unconditionally** would have overwritten the
   one paired statement row that already had a correct 2-member group, **orphaning the SoFi Savings
   leg**. Fixed: move only onto a row with no link. Gate: two-member group count 708 → 708.
3. Splitting the write in two leaves 26 payments worth **$8,481.48** recorded by zero
   replay-eligible rows. Fixed: one transaction. (`withPreMutationSnapshot` provides **no**
   atomicity — it snapshots, then calls the mutation.)

---

## 5. ⚠️ Do not un-import a Chase Sapphire statement casually

It is safe now — that is the point of fix (1) — but understand what happens: un-importing a card
statement deletes its rows, and `restoreDuplicatesLosingTheirSurvivor` brings the matching mirror
back as `active` with `needs_review` set. The money is preserved. Without the candidate rows it
would not have been.

Second: with those 18 periods `reconciled`, `isProvenByReconciliation`
(`duplicate-resolution.ts:100-108`) now **refuses** to retire any duplicate dated inside
**2025-02-03..2026-08-02** through the UI. A reconciled statement is treated as proof a charge is
real. The owner was told this before approving.

---

## 6. The queue, in the owner's order

1. ~~Reconciliation~~ — **done this pass.**
2. ~~Pin Playwright's clock and timezone~~ — **done** (§3). Browser clock still real; no render was
   found to depend on it.
3. ⛔ **NEXT — touch emulation.** `playwright.config.ts` is one desktop chromium with no `hasTouch`,
   so every `pointer: coarse` branch has **never executed**, and the owner's iPhone is the only
   device that runs them. He asked for this explicitly ("test everything then").

   **Scope, measured this pass — it is far smaller than "test everything".** There are exactly
   **two** `pointer-coarse:` call sites in the whole app:

   | file | class |
   |---|---|
   | `src/components/ui/DataTable.tsx:66` | `pointer-coarse:opacity-100` |
   | `src/components/transactions/TransactionsLedger.tsx:71` | `pointer-coarse:opacity-100` |

   Both do the same job: **reveal row controls that are otherwise hover-only.** On a device with no
   hover, that rule is the *only* thing that makes those controls reachable — so if it is broken or
   dropped, the owner's phone shows rows he cannot act on, and nothing in the suite would say so.
   Confirmed shipped: `@media (pointer:coarse){…opacity:1}` is present in the built CSS. (A
   `pointer-coarse:min-h-11` also appears in a built chunk with **no source anywhere in `src`** —
   almost certainly a stale chunk; verify against a fresh build before treating it as live.)

   So the useful test is narrow: a touch-emulated project that loads `/transactions`, asserts the
   row controls are visible **without hovering**, and checks their hit targets. ⚠️ Hazard:
   `fullyParallel: false, workers: 1` and all specs share ONE database with the golden-path spec
   mutating it last, so a second project must **not** double-run — scope it to a subset or give it
   its own DB.
4. **Chart-gap UX** — say plainly which account is starving the chart. **Re-scope before building:**
   Sapphire's 323 gap days are gone and there are now **0 gap days ledger-wide**, so the original
   motivation is largely spent. What remains is that `netWorthSeries` reports only **3 "complete"
   days out of 1,443**, because the `1800` cash wallet has balances on two days only — a different
   problem with a different fix. Measure before writing code. Frame staleness as the normal monthly
   statement rhythm, **never** as an error.
5. **Duplicate/review leftovers** from pass 35 §5 — nothing re-flags a duplicate after one side is
   categorized; a cross-account double count is undetectable by construction.
6. **The Chase card parser clamp** — measured, deliberately not shipped, full write-up in
   `docs/sapphire-reconciliation-finding.md` §5. **Do not ship it without its mitigation**: clamping
   moves 60 rows onto `consumeIdentity`'s posted lens, which runs first and has no description check,
   and one already lands on a different merchant. That is the `3e5a7fc` failure class.
7. ⛔ **Hosting — LAST**, after 3–5. `docs/deploy-plan-gcp-firebase-auth.md`. Decided: Always Free
   GCP `e2e-micro` VM keeping SQLite + Firebase Auth, Google sign-in. Measured this pass: the only
   real code work is server-side verification in `src/proxy.ts` plus a shared `requireSession()` on
   **103 exported server actions across 14 `use server` files** (0 API routes — every mutation is a
   Server Action). **Never point public DNS at the VM before auth is tested.**

---

## 7. Owner facts learned this pass

- **Hosting gate, asked and answered: the WHOLE queue first.** Not "after reconciliation".
- **Auth allowlist: his primary account PLUS a backup**, so he cannot lock himself out. He chose the
  two-identity option explicitly. ⚠️ **The backup address was never given — ask for it before
  wiring auth.**
- ⭐ **"whenever its open cause im browsing just stop it if you need to use it"** — standing
  permission to kill the dev server on :3000. Previous passes worked *around* a running server when
  simply stopping it was allowed all along.
- He approved a real-money write after being shown the two consequences (historical net worth drops
  on 323 days; the reconciled-period retire refusal). **State consequences before asking, not after.**

---

## 8. Process notes

**11 agents, three adversarial lenses, and the review paid for itself three times over** — it
overturned the incoming diagnosis, then found three destructive defects in its own winning design
(§4). All three lenses returned SOUND-WITH-FIXES; none of them blessed the design as written.

⚠️ **But do not outsource belief.** Before writing anything I re-derived the headline independently:
my own from-scratch matcher, the gap total, the `created_at` burst, and the count of already-linked
statement rows. Every number held — *and it was still the right thing to do*, because pass 37's spec
was also built on numbers that held.

**Verification notes from this session:**
- A geometry probe (a temporary spec printing `scrollY` / `getBoundingClientRect` / sticky-header
  boxes) settled in one run what two passes of reasoning had not. **When a screenshot diff is about
  framing rather than content, measure the geometry — do not reason about the layout.**
- Running the same spec 5× is how "deterministic failure" was exposed as flake. A single red run is
  never evidence of determinism.
- The migration was proven end-to-end on a **copy** (`trial.db`) — 18/18, 0 gaps, 0 quarantined, net
  worth identical — before the real DB was touched at all.
- `pnpm tsx` on a script **outside** the repo root cannot resolve `../src/...`; put throwaway scripts
  inside the repo and delete them.
